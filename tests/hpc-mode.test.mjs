import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { resolve, join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir as systemTmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Hosts come from machine-local config; tests use placeholder aliases and an
// isolated agent directory so a developer's own hpc-hosts.json is never read.
process.env.PI_HPC_HOSTS = "cluster-a,cluster-b,cluster-c";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(systemTmpdir(), "pi-hpc-agent-"));
delete process.env.PI_HPC_CONFIG;

// Exercise Pi's real isolated extension loader and tool implementations.
// PI_TEST_AGENT_ROOT can point at an alternative installed Pi package.
const agentRoot = process.env.PI_TEST_AGENT_ROOT || resolve(
  childProcess.execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const { loadExtensions } = await import(pathToFileURL(resolve(agentRoot, "dist/core/extensions/loader.js")));
const { createEventBus } = await import(pathToFileURL(resolve(agentRoot, "dist/core/event-bus.js")));

async function harness(t, hasUI = true, cwd = process.cwd(), withGoal = false) {
  const calls = [];
  let schedulerState = "PENDING";
  let confirm = async () => true;
  let canonicalOverride;
  let clientVersion = "OpenSSH_9.9p1";
  let failedSchedulerHost;
  t.mock.method(childProcess, "spawn", (client, args) => {
    assert.ok(client === "ssh" || client === "scp");
    calls.push({ client, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    queueMicrotask(() => {
      const command = args.at(-1);
      if (client === "ssh" && command.startsWith("squeue") && args.at(-2) === failedSchedulerHost) {
        child.stderr.end("mock scheduler unavailable");
        child.stdout.end();
        child.emit("close", 1);
        return;
      }
      let output = "mock command output\n";
      if (client === "scp") output = "";
      else if (command === "-V") output = clientVersion;
      else if (command.includes("long-output")) output = "long log line\n".repeat(2100);
      else if (command.includes("__PI_HPC_METADATA__")) output = "__PI_HPC_METADATA__HOME=/home/test\n__PI_HPC_METADATA__USER=test\n__PI_HPC_METADATA__PWD=/home/test\n";
      else if (command.startsWith("realpath -m")) output = canonicalOverride || "/scratch/test/file\n";
      else if (command.startsWith("squeue")) output = `123|${schedulerState}\n`;
      else if (command.includes("sbatch")) output = "Submitted batch job 999\n";
      else if (command.startsWith("cd --") && command.endsWith("pwd -P")) output = "/scratch/test\n";
      child.stdout.end(output);
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  const statuses = new Map();
  const notifications = [];
  const messages = [];
  let aborts = 0;
  const ctx = {
    cwd, hasUI,
    sessionManager: {
      getSessionId: () => `test-${cwd}`,
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
    ui: {
      confirm: (...args) => confirm(...args),
      notify: (message) => notifications.push(message),
      setStatus: (key, value) => statuses.set(key, value),
      theme: { fg: (_color, text) => text },
    },
    waitForIdle: async () => {},
    isIdle: () => true,
    abort: () => { aborts++; },
    hasPendingMessages: () => false,
  };
  const bus = createEventBus();
  const loaded = await loadExtensions([
    resolve("extensions/hpc-mode.ts"), resolve("extensions/safety-guard.ts"),
    ...(withGoal ? [resolve("extensions/goal.ts")] : []),
  ], process.cwd(), bus);
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.appendEntry = () => {};
  loaded.runtime.sendMessage = (...args) => messages.push(args);
  loaded.runtime.sendUserMessage = (...args) => messages.push(args);
  const extensions = loaded.extensions;
  async function event(name, value = {}) {
    let result;
    for (const ext of extensions) for (const handler of ext.handlers.get(name) || []) {
      const next = await handler(value, ctx);
      if (next?.block) return next;
      if (next?.systemPrompt) value = { ...value, systemPrompt: next.systemPrompt };
      if (next !== undefined) result = next;
    }
    return result;
  }
  const command = (args) => extensions[0].commands.get("hpc").handler(args, ctx);
  const removal = (args = "") => extensions[1].commands.get("rm-rights").handler(args, ctx);
  const tool = async (name, params, signal) => {
    const blocked = await event("tool_call", { toolName: name, input: params });
    if (blocked?.block) throw new Error(blocked.reason);
    return extensions.find((ext) => ext.tools.has(name)).tools.get(name).definition.execute("test", params, signal, undefined, ctx);
  };
  await event("session_start");
  t.after(() => event("session_shutdown"));
  return { calls, ctx, command, removal, tool, event, statuses, notifications, messages, bus, aborts: () => aborts,
    confirm: (fn) => { confirm = fn; },
    scheduler: (state) => { schedulerState = state; },
    canonical: (path) => { canonicalOverride = path; },
    clientVersion: (version) => { clientVersion = version; },
    schedulerFailure: (host) => { failedSchedulerHost = host; },
  };
}

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test("HPC authorization, routing, transfers, and watches", async (t) => {
  await t.test("permission is opt-in, host-scoped, and confirmed before connecting", async (t) => {
    const h = await harness(t);
    await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "pwd" }), /user-authorized/);
    await h.command("allow unknown");
    assert.equal(h.calls.length, 0);
    h.confirm(async () => false);
    await h.command("allow cluster-a");
    assert.equal(h.calls.length, 0);
    h.confirm(async () => { assert.equal(h.calls.length, 0); return true; });
    await h.command("allow cluster-a");
    h.confirm(() => { throw new Error("repeat grant must not ask again"); });
    await h.command("allow cluster-a");
    assert.equal(h.calls.length, 1);
    assert.match(h.statuses.get("hpc-mode"), /Local.*cluster-a/);
    await assert.rejects(h.tool("hpc_exec", { host: "cluster-b", command: "pwd" }), /cluster-b is not authorized/);
    await h.tool("hpc_exec", { host: "cluster-a", command: "pwd", cwd: "/scratch/test" });
    assert.match(h.calls.at(-1).args.at(-1), /cd -- '\/scratch\/test'/);
    assert.ok(h.calls.at(-1).args.includes("ControlMaster=auto"));
    assert.ok(!h.calls.at(-1).args.some((arg) => arg.startsWith("ControlPath=")));
    const prompt = await h.event("before_agent_start", { systemPrompt: "base", systemPromptOptions: { skills: [] }, prompt: "hello" });
    assert.match(prompt.systemPrompt, /Authorized hosts: cluster-a/);
    assert.match(prompt.systemPrompt, /Selected workspace: local:/);
  });

  await t.test("workspace switches preserve access, saved cwd, and shorthand expansion", async (t) => {
    const h = await harness(t);
    await h.command("cluster-a /commit");
    assert.deepEqual(h.messages.at(-1), ["/commit", { expandPromptTemplates: true }]);
    await h.command("cd /scratch/test");
    await h.tool("bash", { command: "pwd" });
    assert.match(h.calls.at(-1).args.at(-1), /cd -- '\/scratch\/test'/);
    await h.command("local");
    const count = h.calls.length;
    const result = await h.tool("read", { path: "package.json" });
    assert.match(result.content[0].text, /"name": "pi-toolkit"/);
    assert.equal(h.calls.length, count);
    await h.tool("hpc_exec", { host: "cluster-a", command: "pwd" });
    assert.match(h.calls.at(-1).args.at(-1), /cd -- '\/scratch\/test'/);
    await h.command("allow cluster-b");
    await h.command("revoke cluster-a");
    await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "pwd" }), /no longer authorized/);
    await h.tool("hpc_exec", { host: "cluster-b", command: "pwd" });
    await h.command("revoke all");
    assert.equal(h.statuses.get("hpc-mode"), undefined);
  });

  await t.test("headless sessions and stale confirmations cannot authorize", async (t) => {
    const h = await harness(t, false);
    await h.command("allow cluster-a");
    assert.equal(h.calls.length, 0);
    h.ctx.hasUI = true;
    let complete;
    h.confirm(() => new Promise((resolve) => { complete = resolve; }));
    const grant = h.command("allow cluster-a");
    await flush();
    await h.command("revoke all");
    complete(true);
    await grant;
    assert.equal(h.calls.length, 0);
    h.confirm(async () => true);
    await h.command("cluster-a");
    await h.event("session_start");
    await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "pwd" }), /user-authorized/);
    assert.equal(h.statuses.get("hpc-mode"), undefined);
  });

  await t.test("transfers use literal file endpoints independent of routing", async (t) => {
    const h = await harness(t);
    await h.command("allow cluster-a");
    const localPath = resolve("README.md");
    await h.tool("hpc_transfer", { host: "cluster-a", direction: "upload", local_path: "README.md", remote_path: "~/$USER/file with 'quotes'.txt" });
    assert.equal(h.calls.at(-1).client, "scp");
    assert.deepEqual(h.calls.at(-1).args.slice(-2), [localPath, "cluster-a:/home/test/test/file with 'quotes'.txt"]);
    await h.command("cluster-a");
    await h.tool("hpc_transfer", { host: "cluster-a", direction: "download", local_path: "README.md", remote_path: "/scratch/test/result.txt" });
    assert.deepEqual(h.calls.at(-1).args.slice(-2), ["cluster-a:/scratch/test/result.txt", localPath]);
    for (const remote_path of ["~/.ssh/config", "/scratch/*.pt"]) {
      await assert.rejects(h.tool("hpc_transfer", { host: "cluster-a", direction: "upload", local_path: "README.md", remote_path }));
    }
    await assert.rejects(h.tool("hpc_transfer", { host: "cluster-a", direction: "upload", local_path: "extensions", remote_path: "/scratch/test/data" }), /regular file/);
    h.canonical("/home/test/.ssh/config\n");
    const count = h.calls.filter((call) => call.client === "scp").length;
    await assert.rejects(h.tool("hpc_transfer", { host: "cluster-a", direction: "download", local_path: "README.md", remote_path: "/scratch/test/alias" }), /SSH|ssh/);
    assert.equal(h.calls.filter((call) => call.client === "scp").length, count);
  });

  await t.test("legacy shell-based transfer clients are rejected", async (t) => {
    const h = await harness(t);
    await h.command("allow cluster-a");
    h.clientVersion("OpenSSH_8.9p1");
    await assert.rejects(h.tool("hpc_transfer", { host: "cluster-a", direction: "upload", local_path: "README.md", remote_path: "/scratch/test/file" }), /OpenSSH 9/);
    assert.ok(h.calls.every((call) => call.client !== "scp"));
  });

  await t.test("truncated remote command logs remain locally readable in remote mode", async (t) => {
    const h = await harness(t);
    await h.command("cluster-a");
    const output = await h.tool("hpc_exec", { host: "cluster-a", command: "printf long-output" });
    assert.ok(output.details.fullOutputPath);
    const count = h.calls.length;
    const log = await h.tool("read", { path: output.details.fullOutputPath, limit: 2 });
    assert.match(log.content[0].text, /long log line/);
    assert.equal(h.calls.length, count);
  });

  await t.test("remote commands respect separately granted removal rights", async (t) => {
    const h = await harness(t);
    await h.command("cluster-a");
    const count = h.calls.length;
    for (const command of ["rm result", "cat ~/.ssh/config", "ssh other-host"]) {
      await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command }));
    }
    assert.equal(h.calls.length, count);
    await h.removal();
    await h.tool("hpc_exec", { host: "cluster-a", command: "rm result" });
    await h.tool("bash", { command: "rm result" });
    await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "rm ~/.ssh/config" }));
    await h.removal("off");
    await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "rm result" }));
    const signal = AbortSignal.abort();
    await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "pwd" }, signal), /abort/i);
  });

  await t.test("one failed scheduler does not hide another host's completion, and polling backs off", async (t) => {
    const h = await harness(t);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    for (const host of ["cluster-a", "cluster-b"]) {
      await h.command(`allow ${host}`);
      await h.tool("hpc_job_watch", { action: "watch", host, job_id: "123", until: "finished" });
    }
    h.scheduler("COMPLETED");
    h.schedulerFailure("cluster-a");
    t.mock.timers.tick(0);
    await flush();
    const watches = (await h.tool("hpc_job_watch", { action: "list" })).details.watches;
    assert.deepEqual(watches.map((watch) => watch.host), ["cluster-a"]);
    assert.match(h.messages.at(-1)[0].content, /cluster-b.*COMPLETED/);
    const queries = () => h.calls.filter((call) => call.args.at(-1).startsWith("squeue")).length;
    t.mock.timers.tick(119_000);
    await flush();
    assert.equal(queries(), 2);
    h.schedulerFailure(undefined);
    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(queries(), 3);
    assert.equal((await h.tool("hpc_job_watch", { action: "list" })).details.watches.length, 0);
  });

  await t.test("watches are host-scoped and survive local routing with conservative polling", async (t) => {
    const h = await harness(t);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    await h.command("cluster-a");
    await h.command("allow cluster-b");
    for (const host of ["cluster-a", "cluster-b"]) await h.tool("hpc_job_watch", { action: "watch", host, job_id: "123", until: "finished" });
    await h.command("local");
    assert.equal((await h.tool("hpc_job_watch", { action: "list" })).details.watches.length, 2);
    t.mock.timers.tick(0);
    await flush();
    assert.equal(h.calls.filter((call) => call.args.at(-1).startsWith("squeue")).length, 2);
    await h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "123", until: "finished" });
    t.mock.timers.tick(44_000);
    await flush();
    assert.equal(h.calls.filter((call) => call.args.at(-1).startsWith("squeue")).length, 2);
    await h.command("revoke cluster-a");
    const watches = (await h.tool("hpc_job_watch", { action: "list" })).details.watches;
    assert.deepEqual(watches.map((watch) => watch.host), ["cluster-b"]);
    h.scheduler("COMPLETED");
    t.mock.timers.tick(50_000);
    await flush();
    assert.equal((await h.tool("hpc_job_watch", { action: "list" })).details.watches.length, 0);
    assert.match(h.messages.at(-1)[0].content, /cluster-b.*COMPLETED/);
  });
});

test("web sessions resolve local tools relative to their own workspace", async (t) => {
  const base = process.env.PI_TEST_ARTIFACTS || systemTmpdir();
  const root = mkdtempSync(join(base, "hpc-cwd-"));
  const cwdA = join(root, "project-a");
  const cwdB = join(root, "project-b");
  for (const dir of [cwdA, cwdB]) mkdirSync(dir);
  writeFileSync(join(cwdA, "marker.txt"), "project A\n");
  writeFileSync(join(cwdB, "marker.txt"), "project B\n");
  const a = await harness(t, true, cwdA);
  const b = await harness(t, true, cwdB);
  assert.match((await a.tool("read", { path: "marker.txt" })).content[0].text, /project A/);
  assert.match((await b.tool("read", { path: "marker.txt" })).content[0].text, /project B/);
  await a.tool("write", { path: "written.txt", content: "A only\n" });
  await b.tool("write", { path: "written.txt", content: "B only\n" });
  await a.tool("edit", { path: "written.txt", edits: [{ oldText: "A only", newText: "A edited" }] });
  assert.equal(readFileSync(join(cwdA, "written.txt"), "utf8"), "A edited\n");
  assert.equal(readFileSync(join(cwdB, "written.txt"), "utf8"), "B only\n");
  assert.equal(a.calls.length + b.calls.length, 0);
  // Fixtures are deliberately retained: this environment disallows file removal.
});

test("HPC watchers hold a web liveness lease only while work is outstanding", async (t) => {
  const key = Symbol.for("@agegr/pi-web/session-liveness/v1");
  const previous = globalThis[key];
  const providers = new Set();
  let releases = 0;
  globalThis[key] = {
    version: 1,
    register(provider) {
      providers.add(provider);
      return () => { if (providers.delete(provider)) releases++; };
    },
  };
  t.after(() => { globalThis[key] = previous; });
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  assert.equal(providers.size, 1);
  const first = [...providers][0];
  assert.equal(first.isActive(), false);
  await h.command("allow cluster-a");
  await h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "123", until: "finished" });
  assert.equal(first.isActive(), true);
  await h.command("local");
  assert.equal(first.isActive(), true);
  h.scheduler("COMPLETED");
  t.mock.timers.tick(0);
  await flush();
  assert.equal(first.isActive(), false);
  await h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "124" });
  assert.equal(first.isActive(), true);
  await h.command("revoke all");
  assert.equal(first.isActive(), false);
  await h.event("session_start");
  assert.equal(releases, 1);
  assert.equal(providers.size, 1);
  assert.notEqual([...providers][0], first);
  await h.event("session_shutdown");
  await h.event("session_shutdown");
  assert.equal(providers.size, 0);
  assert.equal(releases, 2);
});

test("custom watcher turns do not require a user prompt string", async (t) => {
  const h = await harness(t);
  await assert.doesNotReject(h.event("before_agent_start", {
    messageType: "custom", systemPrompt: "base", systemPromptOptions: { skills: [] },
  }));
});


test("a watch enters wait mode: work may continue briefly, polling and sleep are refused, and the run settles", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  await h.command("allow cluster-a");
  const watch = await h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "123", until: "finished" });
  assert.notEqual(watch.terminate, true);
  // Same batch: more submissions are fine; manual polling and sleep are refused without stopping.
  await h.tool("hpc_exec", { host: "cluster-a", command: "sbatch next.sbatch" });
  for (const command of ["squeue -j 123", "sleep 600 && tail run.log"]) {
    const blocked = await h.event("tool_call", { toolName: "hpc_exec", input: { host: "cluster-a", command } });
    assert.equal(blocked.block, true);
    assert.notEqual(blocked.terminate, true);
    assert.match(blocked.reason, /end your turn/i);
  }
  assert.equal(await h.event("turn_end", { entries: [] }), undefined);
  assert.equal(h.aborts(), 0);
  assert.equal(h.messages.length, 0);
  let waiting;
  h.bus.emit("hpc-mode:waiting-query", { reply: (value) => { waiting = value; } });
  assert.equal(waiting, true);
  assert.deepEqual(await h.event("agent_before_settle"), { continue: false });
  // The watcher wakes the conversation and resets wait mode.
  h.scheduler("COMPLETED");
  t.mock.timers.tick(0);
  await flush();
  const message = h.messages.at(-1)[0];
  assert.equal(message.customType, "hpc-job-watch");
  await h.event("before_agent_start", { messageType: "custom", message, systemPrompt: "base", systemPromptOptions: { skills: [] } });
  await h.tool("hpc_exec", { host: "cluster-a", command: "sacct -j 123" });
  assert.equal(await h.event("turn_end"), undefined);
  assert.equal(await h.event("agent_before_settle"), undefined);
});

test("HPC turns after a watch are bounded: wrap-up request first, then a stop; local work is free", async (t) => {
  const h = await harness(t);
  await h.command("allow cluster-a");
  await h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "123" });
  await h.event("turn_end");
  for (let turn = 1; turn <= 3; turn++) {
    await h.tool("hpc_exec", { host: "cluster-a", command: "tail run.log" });
    await h.tool("read", { path: "README.md" }); // Local workspace: not an HPC turn.
    assert.equal(await h.event("turn_end"), undefined);
    await h.tool("read", { path: "README.md" });
    assert.equal(await h.event("turn_end"), undefined);
  }
  const wrapUp = await h.event("tool_call", { toolName: "hpc_exec", input: { host: "cluster-a", command: "tail run.log" } });
  assert.equal(wrapUp.block, true);
  assert.notEqual(wrapUp.terminate, true);
  assert.match(wrapUp.reason, /reply to the user.*end your turn/);
  assert.equal(await h.tool("read", { path: "README.md" }).then(() => "ok"), "ok");
  assert.equal(await h.event("turn_end"), undefined);
  await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "tail run.log" }), /reply to the user/);
  const boundary = await h.event("turn_end", { entries: [{ type: "custom_message", customType: "other" }] });
  assert.equal(boundary.continue, false);
  assert.equal(h.aborts(), 1);
  assert.equal(boundary.entries[0].customType, "other"); // Other extensions' entries are kept.
  assert.match(boundary.entries[1].content, /wrap-up request was refused.*watches remain active/);
  await h.event("input", { source: "interactive" });
  assert.equal((await h.tool("hpc_job_watch", { action: "list" })).details.watches.length, 1);
  await h.tool("hpc_exec", { host: "cluster-a", command: "tail run.log" }); // Fresh budget after user input.
});

test("a watcher update queued as a follow-up resets wait mode, and watch registration is never refused", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  await h.command("allow cluster-a");
  await h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "123", until: "finished" });
  await h.event("turn_end");
  // The job ends while the agent is still busy: the update joins the running
  // agent as a follow-up, so no before_agent_start fires for it.
  h.ctx.isIdle = () => false;
  h.scheduler("COMPLETED");
  t.mock.timers.tick(0);
  await flush();
  const [message, options] = h.messages.at(-1);
  assert.equal(options.deliverAs, "followUp");
  await h.event("message_start", { message: { role: "custom", ...message } });
  assert.equal(await h.event("agent_before_settle"), undefined);
  // Read the log, upload a fix, resubmit: no watch is pending, so nothing is counted.
  for (let turn = 1; turn <= 4; turn++) {
    await h.tool("hpc_exec", { host: "cluster-a", command: "tail run.log" });
    assert.equal(await h.event("turn_end"), undefined);
  }
  // With a watch pending and the follow-up budget spent, another watch still registers.
  h.scheduler("PENDING");
  await h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "123", until: "finished" });
  await h.event("turn_end");
  for (let turn = 1; turn <= 3; turn++) {
    await h.tool("hpc_exec", { host: "cluster-a", command: "sbatch next.sbatch" });
    assert.equal(await h.event("turn_end"), undefined);
  }
  await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "tail run.log" }), /reply to the user/);
  const watch = await h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "999", until: "finished" });
  assert.deepEqual(watch.details.job_ids, ["999"]);
  assert.equal(h.aborts(), 0);
});

test("scheduler guidance steers toward hpc_job_watch before the breaker fires", async (t) => {
  const h = await harness(t);
  await h.command("allow cluster-a");
  // sbatch submissions surface the job id and a watch reminder to the agent.
  const submit = await h.tool("hpc_exec", { host: "cluster-a", command: "sbatch run.sbatch" });
  const submitText = submit.content.map((item) => item.text).join("\n");
  assert.match(submitText, /job 999 was submitted/);
  assert.match(submitText, /register hpc_job_watch/i);
  // The first manual poll nudges toward a watch instead of silently counting down.
  const first = await h.tool("hpc_exec", { host: "cluster-a", command: "squeue -j 999" });
  assert.match(first.content.map((item) => item.text).join("\n"), /prefer hpc_job_watch/i);
  // The last allowed poll escalates to an explicit warning before the hard stop.
  await h.tool("hpc_exec", { host: "cluster-a", command: "squeue -j 999" });
  const third = await h.tool("hpc_exec", { host: "cluster-a", command: "squeue -j 999" });
  assert.match(third.content.map((item) => item.text).join("\n"), /manual scheduler check.*left/i);
});

test("manual scheduler breaker shares a bounded budget across command variants and remote tools", async (t) => {
  const h = await harness(t, false);
  h.ctx.hasUI = true;
  await h.command("cluster-a");
  h.ctx.hasUI = false; // Guard behavior must not depend on a UI.
  for (const command of ["squeue -j 123", "sacct --jobs=123", "scontrol show job 123"]) {
    await h.tool(command.startsWith("sacct") ? "bash" : "hpc_exec", { host: "cluster-a", command });
  }
  const count = h.calls.length;
  const blocked = await h.event("tool_call", { toolName: "bash", input: { command: 'echo status; squeue -u "$USER"; tail -20 run.log' } });
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, true);
  assert.equal(h.calls.length, count);
  await h.event("turn_end");
  assert.equal(h.aborts(), 1);
  await h.event("input", { source: "extension" });
  await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "squeue -j 123" }), /Stopped repeated/);
  await h.event("before_agent_start", { messageType: "custom", message: { customType: "goal-continuation" }, systemPrompt: "base", systemPromptOptions: { skills: [] } });
  await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "squeue -j 123" }), /Stopped repeated/);
  await h.event("input", { source: "rpc" });
  await h.tool("hpc_exec", { host: "cluster-a", command: "squeue -j 123" });
  assert.equal(await h.event("turn_end"), undefined);
});

test("manual budgets are host scoped; unrelated work, list, stop, and invalid watches do not terminate", async (t) => {
  const h = await harness(t);
  for (const host of ["cluster-a", "cluster-b"]) await h.command(`allow ${host}`);
  for (let i = 0; i < 3; i++) await h.tool("hpc_exec", { host: "cluster-a", command: "squeue -j 123" });
  await h.tool("hpc_exec", { host: "cluster-b", command: "squeue -j 123" });
  await h.tool("hpc_exec", { host: "cluster-a", command: "cat results.json" });
  await assert.rejects(h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "invalid" }));
  for (const action of ["list", "stop"]) assert.notEqual((await h.tool("hpc_job_watch", { action })).terminate, true);
  assert.equal(await h.event("turn_end"), undefined);
  await h.event("input", { source: "interactive" });
  await h.tool("hpc_exec", { host: "cluster-a", command: "squeue -j 123" });
});


test("active goals do not restart guard-stopped or watch-waiting runs; the watcher resumes them", async (t) => {
  const h = await harness(t, true, process.cwd(), true);
  await h.command("allow cluster-a");
  await h.tool("create_goal", { objective: "Interpret experiment results" });
  await h.event("agent_start");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  await h.tool("hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "123", until: "finished" });
  await h.event("turn_end");
  h.confirm(() => { throw new Error("A watcher wait must not ask to pause the goal"); });
  await h.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(h.messages.length, 0);
  // User input while the watch is pending does not make the goal poll.
  await h.event("input", { source: "interactive" });
  const goal = await h.tool("get_goal", {});
  assert.match(goal.content[0].text, /"status": "active"/);
  await h.event("agent_start");
  await h.event("agent_end", { messages: [] });
  assert.equal(h.messages.length, 0);
  // Once the watcher reports completion, the goal continues as usual.
  h.scheduler("COMPLETED");
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.messages.at(-1)[0].customType, "hpc-job-watch");
  await h.event("agent_start");
  await h.event("agent_end", { messages: [] });
  assert.equal(h.messages.at(-1)[0].customType, "goal-continuation");
});

test("unauthorized HPC operations stop the batch before transport, including without a UI", async (t) => {
  for (const [name, params] of [
    ["hpc_exec", { host: "cluster-a", command: "sacct -j 123" }],
    ["hpc_transfer", { host: "cluster-a", direction: "download", local_path: "result.txt", remote_path: "result.txt" }],
    ["hpc_job_watch", { action: "watch", host: "cluster-a", job_id: "123" }],
  ]) await t.test(name, async (t) => {
    const h = await harness(t, false);
    const blocked = await h.event("tool_call", { toolName: name, input: params });
    assert.equal(blocked.block, true);
    assert.equal(blocked.terminate, true);
    assert.match(blocked.reason, /user-authorized.*Stopped autonomous HPC work/);
    assert.equal(h.calls.length, 0);
    // Local siblings finish; a mixed batch still stops at its boundary.
    assert.equal(await h.event("tool_call", { toolName: "read", input: { path: "README.md" } }), undefined);
    const boundary = await h.event("turn_end");
    assert.equal(boundary.continue, false);
    assert.match(boundary.entries[0].content, /\/hpc allow/);
    assert.equal(h.aborts(), 1);
    assert.equal((await h.event("agent_before_settle")).continue, false);
    for (let i = 0; i < 5; i++) {
      await h.event("input", { source: "extension" });
      await assert.rejects(h.tool(name, params), /Stopped autonomous HPC work/);
    }
    assert.equal(h.calls.length, 0);
    assert.deepEqual((await h.event("turn_end")).entries, []);
  });
});

test("a new user message resets the stop, not authorization; explicit reauthorization resumes work", async (t) => {
  const h = await harness(t);
  await h.command("allow cluster-a");
  await h.command("revoke cluster-a");
  const connections = h.calls.length;
  await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "pwd" }), /no longer authorized.*Stopped autonomous/);
  await h.event("turn_end");
  await h.event("input", { source: "rpc", text: "access is granted" });
  await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "pwd" }), /no longer authorized.*Stopped autonomous/);
  await h.event("turn_end");
  assert.equal(h.calls.length, connections);
  await h.command("allow cluster-a");
  await h.event("input", { source: "rpc", text: "continue" });
  await h.tool("hpc_exec", { host: "cluster-a", command: "pwd" });
  assert.equal(await h.event("turn_end"), undefined);
});

test("permission denials retain goal state and suppress automatic continuation", async (t) => {
  const h = await harness(t, true, process.cwd(), true);
  await h.tool("create_goal", { objective: "Interpret experiment results" });
  await h.event("agent_start");
  await assert.rejects(h.tool("hpc_exec", { host: "cluster-a", command: "sacct -j 123" }), /user-authorized/);
  await h.event("turn_end");
  h.confirm(() => { throw new Error("Do not ask to pause or grant access from the agent"); });
  await h.event("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
  assert.equal(h.messages.length, 0);
  await h.event("input", { source: "interactive" });
  assert.match((await h.tool("get_goal", {})).content[0].text, /"status": "active"/);
});

test("no-auth prompts are explicit; harmless watch management and authorized validation errors do not stop", async (t) => {
  const h = await harness(t);
  const prompt = await h.event("before_agent_start", { systemPrompt: "base", systemPromptOptions: { skills: [] }, prompt: "continue" });
  assert.match(prompt.systemPrompt, /Authorized hosts: none/);
  for (const action of ["list", "stop"]) await h.tool("hpc_job_watch", { action });
  assert.equal(await h.event("turn_end"), undefined);
  await h.command("allow cluster-a");
  // An omitted watch host resolves the sole authorized host, as before.
  await assert.rejects(h.tool("hpc_job_watch", { action: "watch", job_id: "invalid" }), /numeric Slurm/);
  assert.equal(await h.event("turn_end"), undefined);
});

test("one watch call registers several jobs atomically and explains the harness lifecycle", async (t) => {
  const h = await harness(t);
  await h.command("allow cluster-a");
  await assert.rejects(h.tool("hpc_job_watch", { action: "watch", job_ids: ["123", "bad"] }), /numeric Slurm/);
  assert.equal((await h.tool("hpc_job_watch", { action: "list" })).details.watches.length, 0);
  const watch = await h.tool("hpc_job_watch", { action: "watch", job_id: "123", job_ids: ["124", "123"], until: "finished" });
  assert.deepEqual(watch.details.job_ids, ["123", "124"]);
  const text = watch.content[0].text;
  assert.match(text, /jobs 123, 124 until finished/);
  assert.match(text, /still in the queue does not wake you/);
  assert.match(text, /scheduler checks and sleep on cluster-a are now refused/);
  assert.match(text, /end your turn with a short summary/);
  assert.deepEqual((await h.tool("hpc_job_watch", { action: "list" })).details.watches.map((w) => w.job_id), ["123", "124"]);
  const prompt = await h.event("before_agent_start", { systemPrompt: "base", systemPromptOptions: { skills: [] }, prompt: "go" });
  assert.match(prompt.systemPrompt, /waiting happens between turns, not inside one/);
});

test("host mistakes are recoverable once; revoked or missing grants stop at once", async (t) => {
  const h = await harness(t);
  for (const host of ["cluster-a", "cluster-b"]) await h.command(`allow ${host}`);
  // Ambiguous: no host while two are authorized and the workspace is local.
  const ambiguous = await h.event("tool_call", { toolName: "hpc_exec", input: { command: "pwd" } });
  assert.equal(ambiguous.block, true);
  assert.notEqual(ambiguous.terminate, true);
  assert.match(ambiguous.reason, /(cluster-a, cluster-b).*pass host explicitly/);
  assert.equal(await h.event("turn_end"), undefined);
  // The corrected call works; a second mistake in the same run escalates.
  await h.tool("hpc_exec", { host: "cluster-a", command: "pwd" });
  const typo = await h.event("tool_call", { toolName: "hpc_exec", input: { host: "habork", command: "pwd" } });
  assert.equal(typo.terminate, true);
  assert.match(typo.reason, /not a known HPC alias.*after repeated host errors/);
  assert.equal((await h.event("turn_end")).continue, false);
  // Fresh user input forgives again.
  await h.event("input", { source: "interactive" });
  const wrong = await h.event("tool_call", { toolName: "hpc_job_watch", input: { action: "watch", host: "cluster-c", job_id: "1" } });
  assert.notEqual(wrong.terminate, true);
  assert.match(wrong.reason, /cluster-c is not authorized.*\/hpc allow cluster-c/);
  // A revoked host needs the user, even with the forgiveness budget unused.
  await h.event("input", { source: "interactive" });
  await h.command("revoke cluster-b");
  const revoked = await h.event("tool_call", { toolName: "hpc_exec", input: { host: "cluster-b", command: "pwd" } });
  assert.equal(revoked.terminate, true);
  assert.match(revoked.reason, /cluster-b is no longer authorized.*Stopped autonomous HPC work\./);
  assert.equal(h.calls.filter((call) => call.args.at(-1) === "pwd" || call.args.at(-1).endsWith("pwd\n}")).length, 1);
});

test("host allowlist comes from machine-local config, never the package", async (t) => {
  const { loadTypeScript } = await import(pathToFileURL(resolve("tests/pi-runtime.mjs")));
  const { loadHpcConfig, mapLocalPathToRemote } = await loadTypeScript(resolve("extensions/hpc-mode.ts"));
  const saved = { hosts: process.env.PI_HPC_HOSTS, config: process.env.PI_HPC_CONFIG };
  t.after(() => {
    process.env.PI_HPC_HOSTS = saved.hosts;
    if (saved.config === undefined) delete process.env.PI_HPC_CONFIG; else process.env.PI_HPC_CONFIG = saved.config;
  });
  const dir = mkdtempSync(join(systemTmpdir(), "pi-hpc-config-"));
  const file = join(dir, "hosts.json");
  process.env.PI_HPC_CONFIG = file;
  delete process.env.PI_HPC_HOSTS;

  assert.deepEqual(loadHpcConfig().hosts, [], "no file and no env means no hosts");
  writeFileSync(file, JSON.stringify({
    hosts: ["Cluster-A", "cluster-a", "-oProxyCommand=x", "all", "b.example"],
    guidance: ["Use module load."],
    connectionSharing: false,
  }));
  const loaded = loadHpcConfig();
  assert.deepEqual(loaded.hosts, ["cluster-a", "b.example"]);
  assert.deepEqual(loaded.guidance, ["Use module load."]);
  assert.equal(loaded.connectionSharing, false);
  assert.equal(loaded.errors.length, 2);
  process.env.PI_HPC_HOSTS = " x1 ,x2,";
  assert.deepEqual(loadHpcConfig().hosts, ["x1", "x2"], "env overrides the file");
  delete process.env.PI_HPC_HOSTS;
  writeFileSync(file, "{not json");
  assert.deepEqual(loadHpcConfig().hosts, []);
  assert.match(loadHpcConfig().errors[0], /Could not read/);

  // Windows: Pi resolves remote absolute paths against the local drive.
  assert.equal(mapLocalPathToRemote("C:\\scratch\\x.txt", "C:\\work", "/home/u", true), "/scratch/x.txt");
  assert.equal(mapLocalPathToRemote("/scratch/x.txt", "/work", "/home/u", false), "/scratch/x.txt");
  assert.equal(mapLocalPathToRemote(resolve("/work/a/b.txt"), resolve("/work"), "/home/u"), "/home/u/a/b.txt");
});

test("site guidance from config reaches the system prompt; no config means no hosts", async (t) => {
  const dir = mkdtempSync(join(systemTmpdir(), "pi-hpc-guidance-"));
  const file = join(dir, "hosts.json");
  writeFileSync(file, JSON.stringify({ hosts: ["cluster-a"], guidance: ["- SITE-NOTE-42"] }));
  const saved = { hosts: process.env.PI_HPC_HOSTS, config: process.env.PI_HPC_CONFIG };
  t.after(() => {
    process.env.PI_HPC_HOSTS = saved.hosts;
    if (saved.config === undefined) delete process.env.PI_HPC_CONFIG; else process.env.PI_HPC_CONFIG = saved.config;
  });
  delete process.env.PI_HPC_HOSTS;
  process.env.PI_HPC_CONFIG = file;
  const h = await harness(t);
  await h.command("allow cluster-a");
  const prompt = (await h.event("before_agent_start", { systemPrompt: "base", systemPromptOptions: {}, prompt: "" })).systemPrompt;
  assert.match(prompt, /SITE-NOTE-42/);

  process.env.PI_HPC_CONFIG = join(dir, "missing.json");
  const empty = await harness(t);
  await empty.command("allow cluster-a");
  assert.equal(empty.calls.length, 0);
  assert.ok(empty.notifications.some((message) => /No hosts are configured/.test(message)));
});
