import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Reuse Pi's TypeScript loader instead of relying on Node's native TS support,
// without requiring node_modules in this configuration repository.
const agentRoot = process.env.PI_TEST_AGENT_ROOT || resolve(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const { createJiti } = createRequire(resolve(agentRoot, "package.json"))("jiti");
const { default: safetyGuard, shellSafetyReason } = await createJiti(import.meta.url).import("../extensions/safety-guard.ts");

function harness(hasUI = true) {
  const events = new Map();
  const commands = new Map();
  const statuses = new Map();
  let confirm = async () => true;
  const ctx = {
    cwd: process.cwd(), hasUI,
    ui: {
      notify() {},
      setStatus: (key, value) => statuses.set(key, value),
      confirm: (...args) => confirm(...args),
    },
  };
  safetyGuard({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  });
  return {
    ctx, statuses, commands,
    confirm: (fn) => { confirm = fn; },
    command: (args = "") => commands.get("rm-rights").handler(args, ctx),
    ssh: (args = "") => commands.get("ssh-rights").handler(args, ctx),
    event: (name, event = {}) => events.get(name)(event, ctx),
    shell: (command, toolName = "bash") => events.get("tool_call")({ toolName, input: { command } }, ctx),
    prompt: () => events.get("before_agent_start")({ systemPrompt: "base" }, ctx).systemPrompt,
  };
}

const destructive = [
  "rm -rf target", "unlink target", "rmdir target", "shred target", "trash target",
  "find target -delete", "find target -exec rm {} \\;", "echo target | xargs rm",
  "git clean -fd", "git reset --hard", "rsync --delete src/ dest/",
  'python3 -c "import os; os.remove(\'target\')"',
  'node -e "fs.rmSync(\'target\')"',
];

test("removal patterns default to blocked and only removal checks can be relaxed", () => {
  for (const command of destructive) {
    assert.ok(shellSafetyReason(command), command);
    assert.equal(shellSafetyReason(command, true), undefined, command);
  }
  assert.equal(shellSafetyReason("git status"), undefined);
  for (const command of ["cat ~/.ssh/config", "rm ~/.ssh/config", "ssh host", "scp a host:b"]) {
    assert.ok(shellSafetyReason(command, true), command);
  }
});

test("explicit command and confirmation enable removal, off revokes immediately", async () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["rm-rights", "ssh-rights"]);
  assert.ok((await h.shell("rm target")).block);
  assert.match(h.prompt(), /Do not remove/);
  await h.command("status");
  await h.command("invalid");
  assert.ok((await h.shell("rm target")).block);
  await h.command();
  assert.equal(h.statuses.get("rm-rights"), "rm-rights: ON");
  assert.match(h.prompt(), /only when explicitly requested/);
  for (const command of destructive) {
    assert.equal(await h.shell(command), undefined);
    assert.equal(await h.shell(command, "hpc_exec"), undefined);
  }
  assert.ok((await h.shell("rm ~/.ssh/config")).block);
  assert.ok((await h.shell("ssh host")).block);
  await h.command("off");
  assert.equal(h.statuses.get("rm-rights"), undefined);
  assert.ok((await h.shell("rm target", "hpc_exec")).block);
  assert.match(h.prompt(), /Do not remove/);
});

test("declined confirmation and non-UI mode cannot grant rights", async () => {
  const h = harness();
  h.confirm(async () => false);
  await h.command("on");
  assert.ok((await h.shell("rm target")).block);
  const headless = harness(false);
  headless.confirm(() => { throw new Error("must not request UI"); });
  await headless.command();
  assert.ok((await headless.shell("rm target")).block);
});

test("session lifecycle and a new runtime reset permission", async () => {
  const h = harness();
  for (const event of ["session_start", "session_shutdown"]) {
    await h.command("on");
    assert.equal(await h.shell("rm target"), undefined);
    await h.event(event);
    assert.ok((await h.shell("rm target")).block);
    assert.equal(h.statuses.get("rm-rights"), undefined);
  }
  await h.command();
  assert.ok((await harness().shell("rm target")).block);
});

test("pending confirmation cannot regrant after revocation or session change", async () => {
  for (const reset of ["off", "session_start", "session_shutdown"]) {
    const h = harness();
    let resolveConfirmation;
    h.confirm(() => new Promise((resolve) => { resolveConfirmation = resolve; }));
    const pending = h.command();
    if (reset === "off") await h.command("off");
    else await h.event(reset);
    resolveConfirmation(true);
    await pending;
    assert.ok((await h.shell("rm target")).block);
  }
});

const sshCommands = ["cat ~/.ssh/config", "ssh-keygen -t ed25519 -f ~/.ssh/id_vps", "ssh host", "scp a host:b", "sudo ssh host"];
const sshFileCall = (h, toolName) => h.event("tool_call", { toolName, input: { path: "~/.ssh/config", pattern: "*" } });
const fileTools = ["read", "ls", "write", "edit", "find", "grep"];

test("ssh-rights unlocks local SSH files and clients only, with confirmation", async () => {
  const h = harness();
  for (const command of sshCommands) assert.ok((await h.shell(command)).block, command);
  assert.match(h.prompt(), /ask them to run \/ssh-rights/);
  await h.ssh("invalid");
  h.confirm(async () => false);
  await h.ssh();
  assert.ok((await h.shell("ssh host")).block);
  h.confirm(async () => true);
  await h.ssh("on");
  assert.equal(h.statuses.get("ssh-rights"), "ssh-rights: ON");
  assert.match(h.prompt(), /enabled \/ssh-rights/);
  for (const command of sshCommands) assert.equal(await h.shell(command), undefined, command);
  for (const toolName of fileTools) assert.equal(await sshFileCall(h, toolName), undefined, toolName);
  // Remote execution and removal keep their own gates.
  for (const command of sshCommands) assert.ok((await h.shell(command, "hpc_exec")).block, command);
  assert.ok((await h.shell("rm ~/.ssh/old_key")).block);
  await h.command();
  assert.equal(await h.shell("rm ~/.ssh/old_key"), undefined);
  await h.ssh("off");
  assert.equal(h.statuses.get("ssh-rights"), undefined);
  assert.equal(h.statuses.get("rm-rights"), "rm-rights: ON");
  assert.ok((await h.shell("rm ~/.ssh/old_key")).block);
  for (const toolName of fileTools) assert.ok((await sshFileCall(h, toolName)).block, toolName);
});

test("ssh-rights fails closed without UI and resets with the session", async () => {
  const headless = harness(false);
  headless.confirm(() => { throw new Error("must not request UI"); });
  await headless.ssh();
  assert.ok((await headless.shell("ssh host")).block);
  for (const event of ["session_start", "session_shutdown"]) {
    const h = harness();
    await h.ssh();
    assert.equal(await h.shell("ssh host"), undefined);
    await h.event(event);
    assert.ok((await h.shell("ssh host")).block);
    assert.equal(h.statuses.get("ssh-rights"), undefined);
  }
  // A confirmation pending across revocation cannot grant rights.
  const h = harness();
  let release;
  h.confirm(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.ssh();
  await h.ssh("off");
  release(true);
  await pending;
  assert.ok((await h.shell("ssh host")).block);
});

test("SSH file access stays blocked while removal permission is enabled", async () => {
  const h = harness();
  await h.command();
  for (const toolName of ["read", "ls", "write", "edit", "find", "grep"]) {
    const result = await h.event("tool_call", {
      toolName, input: { path: "~/.ssh", pattern: "*" },
    });
    assert.ok(result.block, toolName);
  }
});

// Native Windows: Pi may run bash through Git Bash or expose the optional `powershell` tool.
const windowsDestructive = [
  "Remove-Item -Recurse -Force target",
  "Get-ChildItem target | Remove-Item",
  "del /s /q target",
  "erase target.txt",
  "rd /s /q target",
  "ri target",
  "cmd /c rmdir /s /q target",
  "[System.IO.File]::Delete('target')",
  "[IO.Directory]::Delete('target', $true)",
  "robocopy empty target /MIR",
  "& rm target",
];

test("Windows removal commands are blocked like their Unix equivalents", () => {
  for (const command of windowsDestructive) {
    assert.ok(shellSafetyReason(command), command);
    assert.equal(shellSafetyReason(command, true), undefined, command);
  }
  for (const command of ["Get-ChildItem", "git status", "echo ${HOME}", "dir /s", "Write-Output 'rd'", "terraform plan"]) {
    assert.equal(shellSafetyReason(command), undefined, command);
  }
});

test("Windows SSH clients and home spellings are blocked", () => {
  for (const command of [
    "ssh.exe host", "C:\\Windows\\System32\\OpenSSH\\ssh.exe host", "& 'C:/Program Files/Git/usr/bin/scp.exe' a host:b",
    "wsl ssh host", "Start-Process ssh host", "Get-Content $env:USERPROFILE\\.ssh\\config",
    "type %USERPROFILE%\\.ssh\\id_ed25519", "cat $HOME/.SSH/config", "Get-ChildItem .ssh\\",
  ]) {
    assert.ok(shellSafetyReason(command), command);
  }
});

test("the PowerShell tool is guarded like bash", async () => {
  const h = harness();
  assert.ok((await h.shell("Remove-Item target", "powershell")).block);
  assert.ok((await h.shell("ssh.exe host", "powershell")).block);
  await h.ssh();
  assert.equal(await h.shell("ssh.exe host", "powershell"), undefined);
  assert.ok((await h.shell("ssh host", "hpc_exec")).block);
});
