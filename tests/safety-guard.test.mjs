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

test("bg_shell start gets the same local shell checks as bash; other actions pass", async () => {
  const h = harness();
  const bg = (input) => h.event("tool_call", { toolName: "bg_shell", input });
  for (const command of ["rm -rf target", "cat ~/.ssh/config", "ssh host", "codex exec hi"]) {
    assert.ok((await bg({ action: "start", command })).block, command);
  }
  assert.ok((await bg({ action: "start" })).block);
  assert.equal(await bg({ action: "start", command: "cargo test --release" }), undefined);
  assert.equal(await bg({ action: "list" }), undefined);
  assert.equal(await bg({ action: "watch", pid: 123 }), undefined);
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

test("Claude Code and Codex run only through subagents; subagent state is not writable", async () => {
  const h = harness();
  for (const command of ["claude -p hi", "codex exec x", "cd w && nohup codex exec x &", "env A=1 claude --bg x", "/Users/x/.local/bin/claude -p", "y=$(codex exec z)"]) {
    assert.match((await h.shell(command))?.reason ?? "", /\/cc-agent or \/codex-agent/, command);
  }
  for (const command of ["claude --version", "codex --help", "ls ~/.claude/projects", "grep -r codex src", "git log --grep claude"]) {
    assert.equal(await h.shell(command), undefined, command);
  }
  // Mentions in quoted text and here-documents are not invocations.
  for (const command of ['git commit -m "docs: run claude -p; codex exec"', "grep -n 'a\\|claude -p' README.md", 'rg -e "codex|claude" src | head',
    "cat > notes.md <<'EOF'\nclaude -p hi\ncodex exec x\nEOF", "cat <<EOF >> notes.md\ncodex exec x\nEOF", 'echo "use: claude --resume" | tee x']) {
    assert.equal(await h.shell(command), undefined, command);
  }
  for (const command of ['bash -c "claude -p hi"', "zsh -c 'cd w; codex exec x'", 'echo "$(claude -p hi)"', "sh <<EOF\ncodex exec x\nEOF", "cat <<EOF\n`claude -p x`\nEOF",
    'git commit -m "x" && claude -p hi']) {
    assert.match((await h.shell(command))?.reason ?? "", /\/cc-agent or \/codex-agent/, command);
  }
  assert.equal(await h.shell("cat ~/.pi/agent/subagents/runs/abcd1234/state.json"), undefined);
  for (const command of ["echo '{}' > ~/.pi/agent/subagents/runs/abcd1234/inbox/1.json", "PI_SUBAGENT_RUN_DIR=/tmp pi -p x", "cp x $HOME/.pi/agent/subagents/runs/a/hpc-grants.json"]) {
    assert.match((await h.shell(command))?.reason ?? "", /subagent state/, command);
  }
  for (const toolName of ["write", "edit"]) {
    const result = await h.event("tool_call", { toolName, input: { path: "~/.pi/agent/subagents/runs/abcd1234/hpc-grants.json" } });
    assert.match(result?.reason ?? "", /subagent state/, toolName);
  }
  // Read-only loops and pipelines over run folders are fine, even with quoted ">".
  const R = "~/.pi/agent/subagents/runs";
  for (const command of [
    `for id in a b; do echo "== $id"; ls ${R}/$id/reports ${R}/$id/reports/delivered | tr '\\n' ' '; echo; done`,
    `for f in ${R}/*/x.html; do echo "== $(basename $f): $(wc -c <$f) bytes"; grep -o 'class="entry [a-z]*"' $f | sort | uniq -c; grep -oE 'Native</th><td>[^<]*' $f; done`,
    `ls ${R} 2>/dev/null | head`, `find ${R} -name '*.json' | wc -l`,
  ]) assert.equal(await h.shell(command), undefined, command);
  for (const command of [
    `for f in ${R}/*; do cat x > $f/inbox/1.json; done`, `ls ${R} | tee ${R}/a`, `cp x ${R}/a/hpc-grants.json`,
    `python3 -c 'print(1)' ${R}`, `sed -i '' s/a/b/ ${R}/a/state.json`, `echo $(cp a ${R}/b)`, `find ${R} -fprint ${R}/x`,
    `cd ${R} && mv a b`, `X=1 cat ${R}/a`,
  ]) assert.match((await h.shell(command))?.reason ?? "", /subagent state/, command);
  // hpc_exec runs remotely; local CLI rules do not apply there.
  assert.equal(await h.shell("codex --version; ls", "hpc_exec"), undefined);
});

test("delegated agents cannot start nested pi sessions; root sessions can", async (t) => {
  const h = harness();
  const launches = [
    "pi -p hi", "pi", "cd w && pi --mode rpc", "env -i HOME=$HOME PATH=$PATH pi -p hi", "env -u FOO pi -p hi", "FOO=1 pi -p hi",
    "/opt/homebrew/bin/pi -p hi", "nohup pi -p hi &", "x=$(pi -p hi)", "echo hi | pi -p", "pi --session other.jsonl --help me",
    "./node_modules/.bin/pi -p hi", "exec pi", "timeout 30 pi -p hi", "echo x | xargs -n1 pi -p", "time pi -p hi", "sudo env A=1 /usr/local/bin/pi -p hi",
    "npx pi -p hi", "npx -y @earendil-works/pi-coding-agent -p hi", "node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js -p hi",
  ];
  const harmless = ["pi --help", "pi --version; ls", "cat pi.txt", "ls ~/.pi/agent/skills", "python3 pi.py", "./pi.sh", "grep -r pi src", "echo pi", "cd pi && ls", "pip install x",
    "pipx run x", "pino --version", "api --list", "ls /pi/x", "./pi/run.sh", "cat src/pi/a.ts", "node pi.js", "npx pip-tools", "npx pino", "timeout 5 ls pi",
    "cat /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md", "ls node_modules/@earendil-works/pi-coding-agent/docs | head"];
  for (const command of [...launches, ...harmless]) assert.equal(await h.shell(command), undefined, `root: ${command}`);
  const saved = process.env.PI_SUBAGENT;
  process.env.PI_SUBAGENT = "1";
  t.after(() => { if (saved === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = saved; });
  for (const command of launches) assert.match((await h.shell(command))?.reason ?? "", /cannot start pi sessions/, command);
  assert.match((await h.event("tool_call", { toolName: "bg_shell", input: { action: "start", command: "pi -p hi" } }))?.reason ?? "", /cannot start pi sessions/);
  for (const command of harmless) assert.equal(await h.shell(command), undefined, command);
  // Text that only mentions pi is data: messages, patterns, written files.
  const mentions = [
    'git commit -m "fix (pi -p) flag"', "git commit -m 'pi; pi -p hi'", 'echo "run: pi -p hi" >> notes.md', "grep -rn 'x\\|pi -p' src",
    'printf "%s\\n" "a; pi --mode rpc"', "cat > doc.md <<'EOF'\npi -p hi\nnpx pi\nEOF", "cat <<EOF >> README.md\nRun:\npi --mode rpc\nEOF\nls",
    'python3 - <<PY\nprint("""\npi -p hi\n""")\nPY', 'gh pr create --title "pi" --body "$(cat <<\'EOF\'\npi -p hi\nEOF\n)"',
  ];
  for (const command of mentions) assert.equal(await h.shell(command), undefined, command);
  // Quoted or here-document text that a shell runs is still code.
  for (const command of ['bash -c "pi -p hi"', "sh -lc 'cd w && pi -p hi'", 'eval "pi -p hi"', 'echo "$(pi -p hi)"', "bash <<EOF\npi -p hi\nEOF",
    "cat <<'EOF' | sh\npi -p hi\nEOF", "cat <<EOF\n$(pi -p hi)\nEOF", "cat <<'EOF'\nx\nEOF\npi -p hi", 'echo "it\'s"; pi -p hi; echo \'x\'']) {
    assert.match((await h.shell(command))?.reason ?? "", /cannot start pi sessions/, command);
  }
  // The environment rules still hold on their own.
  for (const command of ["PI_SUBAGENT= node x.mjs", "env -u PI_SUBAGENT node x.mjs", "PI_AGENT_COMM_ID=abc node x.mjs", "unset PI_SUBAGENT"]) {
    assert.match((await h.shell(command))?.reason ?? "", /subagent state/, command);
  }
});

test("agent-comm member records, mailboxes and identity variables are not writable by agents", async () => {
  const h = harness();
  const C = "~/.pi/agent/agent-comm";
  assert.equal(await h.shell(`ls ${C}/mail/abcd1234/new | wc -l`), undefined);
  for (const command of [
    `echo '{}' > ${C}/members/abcd1234.json`, `cp x ${C}/mail/abcd1234/new/1.json`, `mv ${C}/mail/a/new/x ${C}/mail/a/cur/`,
    "PI_AGENT_COMM_ID=deadbeef pi -p hi", "export PI_AGENT_COMM_SCOPE=team; pi", "env -u PI_AGENT_COMM_ID pi",
  ]) assert.match((await h.shell(command))?.reason ?? "", /agent-comm state/, command);
  for (const toolName of ["write", "edit"]) {
    const result = await h.event("tool_call", { toolName, input: { path: `${C}/members/abcd1234.json` } });
    assert.match(result?.reason ?? "", /agent-comm state/, toolName);
  }
});
