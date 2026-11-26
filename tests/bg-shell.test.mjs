import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTypeScript } from "./pi-runtime.mjs";

const mod = await loadTypeScript(fileURLToPath(new URL("../extensions/bg-shell.ts", import.meta.url)));
const install = mod.default;

// One fake session file shared across "reloads": entries persist, extension instances do not.
function session(sessionId = `t${Math.random().toString(36).slice(2)}`) {
  const entries = [];
  return { entries, sessionId };
}

function instance(store, { idle = true } = {}) {
  const tools = new Map(), commands = new Map(), handlers = new Map(), sent = [], notices = [], statuses = new Map();
  const ctx = {
    cwd: process.cwd(), hasUI: true, isIdle: () => idle,
    sessionManager: { getSessionId: () => store.sessionId, getEntries: () => store.entries },
    ui: { notify: (...a) => notices.push(a), setStatus: (k, v) => statuses.set(k, v), theme: { fg: (_c, t) => t } },
  };
  install({
    registerTool: (t) => tools.set(t.name, t), registerCommand: (n, c) => commands.set(n, c),
    on: (n, h) => handlers.set(n, h), events: { on() {} },
    appendEntry: (customType, data) => store.entries.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage: (message, options) => sent.push({ message, options }),
  });
  const call = (params) => tools.get("bg_shell").execute("id", params, undefined, undefined, ctx);
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  emit("session_start", { reason: "startup" });
  return { call, emit, sent, notices, statuses, ctx, toolCall: (input) => handlers.get("tool_call")({ toolName: "bash", input }, ctx) };
}

const until = async (fn, ms = 10_000) => {
  const end = performance.now() + ms; // tests fake Date.now
  while (!fn()) { if (performance.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); }
};

test("a started command streams to a log and wakes the agent with exit code and tail", async () => {
  const bg = instance(session());
  const result = await bg.call({ action: "start", command: "for i in 1 2 3; do echo line $i; done; printf '\\033[31mred\\033[0m\\n'; echo oops >&2; exit 3", label: "suite" });
  assert.match(result.content[0].text, /Started bg1 \(suite\)/);
  assert.match(bg.statuses.get("bg-shell"), /bg1 suite/);
  await until(() => bg.sent.length === 1);
  const { message, options } = bg.sent[0];
  assert.equal(message.customType, "bg-shell");
  assert.equal(message.details.exitCode, 3);
  assert.match(message.content, /exited with code 3/);
  assert.match(message.content, /line 3\nred\noops/); // stderr captured, ANSI stripped
  assert.deepEqual(options, { triggerTurn: true });
  assert.equal(bg.statuses.get("bg-shell"), undefined);
});

test("busy sessions get the result as a steer, so ongoing work is not aborted", async () => {
  const bg = instance(session(), { idle: false });
  await bg.call({ action: "start", command: "true" });
  await until(() => bg.sent.length === 1);
  assert.deepEqual(bg.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(bg.sent[0].message.content, /exited with code 0/);
});

test("output shows progress; stop kills the process group silently", async () => {
  const bg = instance(session());
  await bg.call({ action: "start", command: "echo started; sleep 30 & wait" });
  const output = async () => (await bg.call({ action: "output", id: "bg1", tail: 5 })).content[0].text;
  let out = "";
  await until(() => { void output().then((t) => { out = t; }); return /started/.test(out); });
  assert.match(out, /running for/);
  await bg.call({ action: "stop", id: "bg1" });
  await until(() => bg.statuses.get("bg-shell") === undefined);
  assert.match((await bg.call({ action: "list" })).content[0].text, /bg1 .*stopped/);
  assert.equal(bg.sent.length, 0);
});

test("watch attaches to an existing pid and reports its log when it ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bg-shell-test-"));
  const log = join(dir, "suite.log");
  writeFileSync(log, "test result: ok. 366 passed; 0 failed\n");
  const child = spawn("sleep", ["1"], { stdio: "ignore" });
  const bg = instance(session());
  const result = await bg.call({ action: "watch", pid: child.pid, log_path: log, label: "nohup suite" });
  assert.match(result.content[0].text, /Watching bg1 \(nohup suite\)/);
  await until(() => bg.sent.length === 1);
  assert.match(bg.sent[0].message.content, /exit code unknown/);
  assert.match(bg.sent[0].message.content, /366 passed/);
  await assert.rejects(bg.call({ action: "watch", pid: child.pid }), /No running process/);
});

test("processes survive /reload and the next instance reports the real exit code", async () => {
  const store = session();
  const first = instance(store);
  await first.call({ action: "start", command: "sleep 1; echo done; exit 4" });
  first.emit("session_shutdown", { reason: "reload" });
  const second = instance(store);
  assert.match(second.statuses.get("bg-shell"), /bg1/);
  await until(() => second.sent.length === 1);
  assert.equal(first.sent.length, 0);
  assert.match(second.sent[0].message.content, /exited with code 4[\s\S]*done/);
  // A third instance does not repeat the notification.
  second.emit("session_shutdown", { reason: "reload" });
  const third = instance(store);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(third.sent.length, 0);
  assert.match((await third.call({ action: "start", command: "true" })).content[0].text, /bg2/);
});

test("quitting kills non-kept processes but leaves kept ones for the resumed session", async () => {
  const store = session();
  const first = instance(store);
  await first.call({ action: "start", command: "sleep 30" });
  await first.call({ action: "start", command: "sleep 1; exit 0", keep: true });
  first.emit("session_shutdown", { reason: "quit" });
  assert.match(first.notices.at(-1)[0], /Left running: bg2/);
  const resumed = instance(store);
  await until(() => resumed.sent.length === 1);
  assert.equal(resumed.sent[0].message.details.id, "bg2");
  assert.match((await resumed.call({ action: "list" })).content[0].text, /bg1 .*stopped[\s\S]*bg2 .*exited with code 0/);
});

test("long sleeps are refused while something runs; short ones are allowed", async () => {
  const bg = instance(session());
  assert.equal(bg.toolCall({ command: "sleep 60" }), undefined);
  await bg.call({ action: "start", command: "sleep 3" });
  assert.equal(bg.toolCall({ command: "sleep 2 && curl localhost" }), undefined);
  for (const command of ["sleep 60", "sleep 1m; tail log", "cd x && sleep 20"]) {
    assert.equal(bg.toolCall({ command })?.block, true, command);
  }
  await bg.call({ action: "stop", id: "bg1" });
});

test("check-in after awake time wakes the agent without killing; extend schedules the next one", async (t) => {
  const bg = instance(session());
  await bg.call({ action: "start", command: "echo working; sleep 30", check_after_minutes: 1 });
  // Fast clock: about 10 s of awake time per real second, well below the 30 s sleep threshold per 2 s tick.
  const realNow = Date.now, start = realNow();
  t.after(() => { Date.now = realNow; });
  Date.now = () => start + (realNow() - start) * 10;
  await until(() => bg.sent.length === 1, 15_000);
  const { message } = bg.sent[0];
  assert.equal(message.details.kind, "check");
  assert.match(message.content, /still running, not killed[\s\S]*last log write[\s\S]*working[\s\S]*bg_shell extend/);
  assert.match((await bg.call({ action: "list" })).content[0].text, /bg1 .*running for/); // still alive
  // No repeat without extend.
  await new Promise((r) => setTimeout(r, 7000));
  assert.equal(bg.sent.length, 1);
  assert.match((await bg.call({ action: "extend", id: "bg1", check_after_minutes: 1 })).content[0].text, /Next check-in/);
  await until(() => bg.sent.length === 2, 15_000);
  assert.match(bg.sent[1].message.content, /\+0 B since the last check-in/);
  await bg.call({ action: "stop", id: "bg1" });
});

test("machine sleep (a long gap between polls) does not count towards the check-in", async (t) => {
  const bg = instance(session());
  await bg.call({ action: "start", command: "sleep 6", check_after_minutes: 1 });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 2 * 3_600_000; // lid closed for two hours
  await until(() => bg.sent.length === 1, 15_000);
  assert.match(bg.sent[0].message.content, /exited with code 0/);
});

test("Python output is unbuffered by default", async () => {
  const bg = instance(session());
  await bg.call({ action: "start", command: "echo \"PYTHONUNBUFFERED=$PYTHONUNBUFFERED\"" });
  await until(() => bg.sent.length === 1);
  assert.match(bg.sent[0].message.content, /PYTHONUNBUFFERED=1/);
});

test("helpers: exit wrapper survives exit in the command; sleep parsing; tail cleanup", () => {
  assert.match(mod.wrapCommand("exit 3", "/tmp/a'b"), /^\(\nexit 3\n\)[\s\S]*'\/tmp\/a'\\''b'/);
  assert.equal(mod.sleepSeconds("echo; sleep 2m"), 120);
  assert.equal(mod.sleepSeconds("sleepy 100"), 0);
  const dir = mkdtempSync(join(tmpdir(), "bg-shell-test-"));
  writeFileSync(join(dir, "l"), `a\nprogress 10%\rprogress 100%\n${"x".repeat(500)}\n`);
  assert.equal(mod.readTail(join(dir, "l"), 2), `progress 100%\n${"x".repeat(400)}… [100 chars cut]`);
});
