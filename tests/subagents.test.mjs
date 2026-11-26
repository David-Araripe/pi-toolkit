import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTypeScript } from "./pi-runtime.mjs";

// Fake CLIs speak each protocol; the real worker runs as a detached process.
const root = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
const fake = fileURLToPath(new URL("./fixtures/subagents/fake-cli.mjs", import.meta.url));
for (const backend of ["pi", "claude", "codex"]) {
	const bin = join(root, `fake-${backend}`);
	writeFileSync(bin, `#!/bin/sh\nFAKE_BACKEND=${backend} exec "${process.execPath}" "${fake}" "$@"\n`);
	chmodSync(bin, 0o755);
	process.env[`PI_SUBAGENTS_BIN_${backend.toUpperCase()}`] = bin;
}
process.env.PI_SUBAGENTS_ROOT = join(root, "state");
process.env.PI_SUBAGENTS_POLL_MS = "50";
process.env.PI_AGENT_COMM_ROOT = join(root, "comm");
delete process.env.PI_SUBAGENT;

const { default: install } = await loadTypeScript(fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url)));
const store = await loadTypeScript(fileURLToPath(new URL("../extensions/subagents/store.ts", import.meta.url)));
const nesting = await loadTypeScript(fileURLToPath(new URL("../extensions/subagents/nesting.ts", import.meta.url)));
const comm = await loadTypeScript(fileURLToPath(new URL("../extensions/agent-comm/store.ts", import.meta.url)));

function setup(t, { confirm = true, sessionId = `session-${Math.random().toString(16).slice(2)}` } = {}) {
	const tools = new Map(), commands = new Map(), handlers = new Map(), listeners = new Map();
	const sent = [], notices = [], ui = { widget: undefined, idle: true };
	let hpcGrants = [{ host: "cluster-a", remoteCwd: "/home/u", home: "/home/u", username: "u" }];
	let exposed = false;
	const events = {
		on: (name, fn) => listeners.set(name, fn),
		emit: (name, payload) => {
			if (name === "hpc-mode:grants-query") payload.reply(hpcGrants);
			if (name === "agent-comm:exposure-query" && exposed) payload.reply({ exposed: true, senders: ["peer (p1)"], waived: false });
			listeners.get(name)?.(payload);
		},
	};
	install({
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		on: (name, fn) => handlers.set(name, fn),
		events,
		sendMessage: (message, options) => sent.push({ message, options }),
		getThinkingLevel: () => "medium",
	}, () => undefined); // the suite itself may run under a subagent worker
	const ctx = {
		cwd: root,
		hasUI: true,
		model: { provider: "anthropic", id: "claude-opus-5-5" },
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, `${sessionId}.jsonl`) },
		isIdle: () => ui.idle,
		ui: {
			setStatus() {}, notify: (...args) => notices.push(args), confirm: async () => confirm, select: async () => undefined,
			setWidget: (key, lines, options) => { ui.widget = { key, lines, options }; },
		},
	};
	handlers.get("session_start")({}, ctx);
	t.after(async () => {
		for (const run of store.listRuns()) if (run.spec.parentSessionId === sessionId && store.processAlive(run.state.workerPid)) store.enqueue(run.dir, { type: "stop" });
		handlers.get("session_shutdown")({}, ctx);
		await new Promise((r) => setTimeout(r, 300));
	});
	const call = (name, params) => tools.get(name).execute("id", params, undefined, undefined, ctx);
	const command = (name, args) => commands.get(name).handler(args, ctx);
	const setHpc = (grants) => { hpcGrants = grants; events.emit("hpc-mode:grants-changed", grants); };
	const expose = () => { exposed = true; };
	return { tools, commands, handlers, sent, notices, ui, ctx, call, command, setHpc, expose, sessionId };
}

async function until(check, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.fail("timed out waiting for condition");
}

const idOf = (result) => result.content[0].text.match(/\(id ([a-f0-9]{8})\)/)[1];
const reportFor = (sent, id, pattern) => sent.find(({ message }) => message.details?.id === id && pattern.test(message.content));
const watchReports = (sent) => sent.filter(({ message }) => message.details?.watch);
const release = (id) => writeFileSync(join(store.runDir(id), "release"), "");
const shown = (h, entry) => h.handlers.get("message_start")({ message: { role: "custom", customType: "subagent-report", details: entry.message.details } });

test("pi child runs, reports back automatically, and inherits live HPC grants", async (t) => {
	const h = setup(t);
	const id = idOf(await h.call("subagent", { action: "start", name: "explore", prompt: "List files", files: ["notes.md"] }));
	const report = await until(() => reportFor(h.sent, id, /pi done:/));
	assert.match(report.message.content, /Read these files first:\n- .*notes\.md/);
	assert.deepEqual(report.options, { triggerTurn: true, deliverAs: "steer" });

	const dir = store.runDir(id);
	const argv = JSON.parse(readFileSync(join(dir, "fake-argv.jsonl"), "utf8").split("\n")[0]);
	assert.deepEqual(argv.slice(0, 2), ["--mode", "rpc"]);
	assert.ok(argv.includes("anthropic/claude-opus-5-5"), "inherits the parent model");
	assert.equal(store.readHpcGrants(dir)[0].host, "cluster-a");

	// The real worker and process listing: its child passes the nesting check;
	// anything that child starts is refused, with or without the environment.
	const { workerPid, childPid } = store.readState(dir);
	const childEnv = { PI_SUBAGENT: "1", PI_SUBAGENT_RUN_DIR: dir };
	assert.equal(nesting.processTable().find((p) => p.pid === childPid)?.ppid, workerPid);
	assert.equal(nesting.nestedSessionReason(childEnv, workerPid), undefined);
	assert.ok(nesting.nestedSessionReason(childEnv, childPid));
	assert.ok(nesting.nestedSessionReason({}, childPid));
	h.setHpc([]);
	assert.deepEqual(store.readHpcGrants(dir), []);

	const roles = store.readTranscript(dir).map((e) => e.role);
	for (const role of ["user", "tool", "result", "assistant"]) assert.ok(roles.includes(role), `transcript has ${role}`);
	assert.ok(existsSync(join(dir, "events.jsonl")));
	const list = await h.call("subagent_query", { action: "list" });
	assert.match(list.content[0].text, new RegExp(`${id} explore`));
});

test("Claude and Codex need the user's grant; bypass modes are refused", async (t) => {
	const h = setup(t, { confirm: false });
	await assert.rejects(h.call("subagent", { action: "start", backend: "claude", prompt: "x" }), /\/cc-agent/);
	await h.command("cc-agent", "");
	await assert.rejects(h.call("subagent", { action: "start", backend: "claude", prompt: "x" }), /\/cc-agent/, "declined confirmation grants nothing");
	await assert.rejects(h.call("subagent", { action: "start", backend: "codex", prompt: "x" }), /\/codex-agent/);
	const allowed = setup(t);
	await allowed.command("cc-agent", "");
	await allowed.command("codex-agent", "");
	await assert.rejects(allowed.call("subagent", { action: "start", backend: "claude", prompt: "x", mode: "bypassPermissions" }), /not allowed/);
	await assert.rejects(allowed.call("subagent", { action: "start", backend: "codex", prompt: "x", mode: "danger-full-access" }), /not allowed/);
	await allowed.command("cc-agent", "off");
	await assert.rejects(allowed.call("subagent", { action: "start", backend: "claude", prompt: "x" }), /\/cc-agent/);
	// Grants are session-only.
	allowed.handlers.get("session_start")({}, allowed.ctx);
	await assert.rejects(allowed.call("subagent", { action: "start", backend: "codex", prompt: "x" }), /\/codex-agent/);
});

test("Claude child uses auto mode with deny rules and relays permission prompts", async (t) => {
	const h = setup(t);
	await h.command("cc-agent", "");
	const id = idOf(await h.call("subagent", { action: "start", backend: "claude", name: "impl", prompt: "Needs PERMISSION" }));
	const dir = store.runDir(id);
	await until(() => existsSync(join(dir, "fake-argv.jsonl")));
	const argv = JSON.parse(readFileSync(join(dir, "fake-argv.jsonl"), "utf8").split("\n")[0]);
	assert.equal(argv[argv.indexOf("--permission-mode") + 1], "auto");
	assert.ok(!argv.some((a) => /dangerously|bypass/i.test(a)));
	const settings = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1], "utf8"));
	for (const rule of ["Bash(rm:*)", "Bash(ssh:*)", "Bash(codex:*)"]) assert.ok(settings.permissions.deny.includes(rule), rule);

	const ask = await until(() => reportFor(h.sent, id, /Permission requested \(perm-1\)/));
	assert.match(ask.message.content, /request_id=perm-1/);
	assert.equal(store.readState(dir).status, "waiting");
	await assert.rejects(h.call("subagent", { action: "reply", id, request_id: "nope", allow: true }), /No pending request/);
	await h.call("subagent", { action: "reply", id, request_id: "perm-1", allow: true, reason: "in scope" });
	await until(() => reportFor(h.sent, id, /claude permission allow/));
	assert.equal(store.readState(dir).status, "idle");
});

test("Codex child uses workspace-write, sets a native goal, and relays approvals", async (t) => {
	const h = setup(t);
	await h.command("codex-agent", "");
	const id = idOf(await h.call("subagent", { action: "start", backend: "codex", name: "perf", prompt: "Needs APPROVAL", goal: "PR opened", effort: "high" }));
	const dir = store.runDir(id);
	await until(() => reportFor(h.sent, id, /Approval requested|Permission requested/));
	const calls = readFileSync(join(dir, "fake-codex-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const start = calls.find((c) => c.method === "thread/start").params;
	assert.equal(start.sandbox, "workspace-write");
	assert.equal(start.approvalPolicy, "on-request");
	assert.equal(start.config.model_reasoning_effort, "high");
	assert.equal(calls.find((c) => c.method === "thread/goal/set").params.objective, "PR opened");
	const requestId = store.readState(dir).approval.requestId;
	await h.call("subagent", { action: "reply", id, request_id: requestId, allow: false, reason: "no pushes" });
	await until(() => reportFor(h.sent, id, /codex approval decline/));
});

test("stop releases the process; send resumes the same native session; export writes HTML", async (t) => {
	const h = setup(t);
	await h.command("codex-agent", "");
	const id = idOf(await h.call("subagent", { action: "start", backend: "codex", prompt: "first" }));
	const dir = store.runDir(id);
	await until(() => reportFor(h.sent, id, /codex done: first/));
	await h.call("subagent", { action: "stop", id });
	assert.equal(store.readState(dir).status, "stopped");
	assert.equal(store.processAlive(store.readState(dir).workerPid), false);
	const sent = await h.call("subagent", { action: "send", id, prompt: "second" });
	assert.match(sent.content[0].text, /relaunched with its session/);
	await until(() => reportFor(h.sent, id, /codex done: second/));
	const calls = readFileSync(join(dir, "fake-codex-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(calls.at(-1).method, "thread/resume");
	assert.equal(calls.at(-1).params.threadId, "codex-thread");

	const exported = await h.call("subagent_query", { action: "export", id });
	const file = exported.content[0].text.replace("Exported to ", "");
	const html = readFileSync(file, "utf8");
	assert.match(html, /codex done: second/);
	assert.match(html, /events\.jsonl/);
	assert.doesNotMatch(html, /<script/);
});

test("reports for a session that is not running wait until it resumes", async (t) => {
	const first = setup(t, { sessionId: "resumable-session" });
	const id = idOf(await first.call("subagent", { action: "start", prompt: "hello" }));
	first.handlers.get("session_shutdown")({}, first.ctx);
	await until(() => store.pendingReports(store.runDir(id)).length > 0);
	assert.equal(first.sent.length, 0);
	const resumed = setup(t, { sessionId: "resumable-session" });
	await until(() => reportFor(resumed.sent, id, /pi done: hello/));
});

test("reports count as delivered only once shown; unseen ones are re-sent after a restart", async (t) => {
	const h = setup(t, { sessionId: "delivery-session" });
	const id = idOf(await h.call("subagent", { action: "start", prompt: "one" }));
	const dir = store.runDir(id);
	const report = await until(() => reportFor(h.sent, id, /pi done: one/));
	await new Promise((r) => setTimeout(r, 1700));
	assert.equal(h.sent.filter((s) => s.message.details?.id === id).length, 1, "not re-sent while in flight");
	assert.equal(store.pendingReports(dir).length, 1, "still pending until shown");
	// Simulate pi dropping the queued message: a new session re-sends it.
	h.handlers.get("session_shutdown")({}, h.ctx);
	h.handlers.get("session_start")({}, h.ctx);
	const again = await until(() => h.sent.filter((s) => s.message.details?.id === id).length === 2 && h.sent.at(-1));
	h.handlers.get("message_start")({ message: { role: "custom", customType: "subagent-report", details: again.message.details } });
	assert.equal(store.pendingReports(dir).length, 0);
	assert.equal(report.message.customType, "subagent-report");
});

test("wait registers a watch at once, holds reports, and resumes with one combined message", async (t) => {
	const h = setup(t, { sessionId: "watch-all-session" });
	h.ui.idle = false;
	const a = idOf(await h.call("subagent", { action: "start", name: "a", prompt: "HOLD alpha" }));
	const b = idOf(await h.call("subagent", { action: "start", name: "b", prompt: "HOLD beta" }));
	const started = Date.now();
	const result = (await h.call("subagent", { action: "wait", ids: [a, b] })).content[0].text;
	assert.ok(Date.now() - started < 2000, "does not block");
	assert.match(result, /Watch registered for a \(.*\), b \(.*one combined message.*end your turn/s);
	assert.equal(store.readWatches(h.sessionId).length, 1);

	// The watch survives a reload.
	h.handlers.get("session_shutdown")({}, h.ctx);
	h.handlers.get("session_start")({}, h.ctx);
	release(a);
	await until(() => store.pendingReports(store.runDir(a)).length > 0);
	await new Promise((r) => setTimeout(r, 1700));
	assert.equal(h.sent.length, 0, "the first report is held");
	assert.deepEqual([h.ui.widget.key, h.ui.widget.options], ["subagents", { placement: "belowEditor" }]);
	assert.match(h.ui.widget.lines.join("\n"), new RegExp(`${b} b · running .*\\n.*watching: the agent resumes when both report · expires in`, "s"));

	release(b);
	const [combined] = await until(() => watchReports(h.sent).length && watchReports(h.sent));
	assert.match(combined.message.content, /all watched children reported.*pi done: HOLD alpha.*pi done: HOLD beta/s);
	assert.deepEqual(combined.options, { triggerTurn: true, deliverAs: "followUp" }, "a busy coordinator finishes its turn first");
	assert.equal(store.readWatches(h.sessionId).length, 0);
	shown(h, combined);
	for (const id of [a, b]) assert.equal(store.pendingReports(store.runDir(id)).length, 0);
	await new Promise((r) => setTimeout(r, 1700));
	assert.equal(h.sent.length, 1, "no duplicate delivery");
	assert.equal(h.ui.widget.lines, undefined, "widget cleared when nothing runs");

	// Nothing to wait for: the answer comes back in the tool result, without a watch.
	const idle = (await h.call("subagent", { action: "wait", id: a })).content[0].text;
	assert.match(idle, /no new report.*Last result:\npi done: HOLD alpha.*no watch was registered/s);
	assert.equal(store.readWatches(h.sessionId).length, 0);
});

test("wait_for=any resumes an idle coordinator with the first report; the rest arrive as usual", async (t) => {
	const h = setup(t);
	const a = idOf(await h.call("subagent", { action: "start", name: "a", prompt: "HOLD alpha" }));
	const b = idOf(await h.call("subagent", { action: "start", name: "b", prompt: "HOLD beta" }));
	assert.match((await h.call("subagent", { action: "wait", ids: [a, b], wait_for: "any" })).content[0].text, /as soon as one reports/);
	release(a);
	const [first] = await until(() => watchReports(h.sent).length && watchReports(h.sent));
	assert.match(first.message.content, /a watched child reported.*pi done: HOLD alpha.*b \(.*\) is still running/s);
	assert.deepEqual(first.options, { triggerTurn: true });
	shown(h, first);
	release(b);
	const later = await until(() => reportFor(h.sent, b, /pi done: HOLD beta/));
	assert.deepEqual(later.options, { triggerTurn: true, deliverAs: "steer" });
	assert.equal(watchReports(h.sent).length, 1);
});

test("permission requests of watched children are delivered at once; the watch continues", async (t) => {
	const h = setup(t);
	await h.command("cc-agent", "");
	const asker = idOf(await h.call("subagent", { action: "start", backend: "claude", name: "asker", prompt: "Needs PERMISSION" }));
	const slow = idOf(await h.call("subagent", { action: "start", name: "slow", prompt: "HOLD on" }));
	await h.call("subagent", { action: "wait", ids: [asker, slow] });
	const ask = await until(() => reportFor(h.sent, asker, /Permission requested \(perm-1\)/));
	shown(h, ask);
	release(slow);
	await until(() => store.pendingReports(store.runDir(slow)).length > 0);
	await new Promise((r) => setTimeout(r, 1700));
	assert.equal(watchReports(h.sent).length, 0, "an unanswered request keeps the watch open");
	await h.call("subagent", { action: "reply", id: asker, request_id: "perm-1", allow: true });
	const [combined] = await until(() => watchReports(h.sent).length && watchReports(h.sent));
	assert.match(combined.message.content, /claude permission allow.*pi done: HOLD on/s);
});

test("an expired watch reports what it has and what is still running", async (t) => {
	const h = setup(t);
	const done = idOf(await h.call("subagent", { action: "start", name: "done", prompt: "HOLD quick" }));
	const slow = idOf(await h.call("subagent", { action: "start", name: "slow", prompt: "HOLD forever" }));
	await h.call("subagent", { action: "wait", ids: [done, slow], timeout_seconds: 2 });
	release(done);
	const [expired] = await until(() => watchReports(h.sent).length && watchReports(h.sent));
	assert.match(expired.message.content, /watch expired after 2s.*pi done: HOLD quick.*slow \(.*\) is still running; its report will arrive automatically/s);
	assert.equal(expired.message.details.expired, true);
	shown(h, expired);
	release(slow);
	await until(() => reportFor(h.sent, slow, /pi done: HOLD forever/));
});

test("without a UI, wait blocks and returns reports directly, without a duplicate message", async (t) => {
	const h = setup(t);
	h.ctx.hasUI = false;
	const a = idOf(await h.call("subagent", { action: "start", name: "a", prompt: "alpha" }));
	const b = idOf(await h.call("subagent", { action: "start", name: "b", prompt: "beta" }));
	const result = (await h.call("subagent", { action: "wait", ids: [a, b], timeout_seconds: 20 })).content[0].text;
	assert.match(result, /pi done: alpha/);
	assert.match(result, /pi done: beta/);
	await new Promise((r) => setTimeout(r, 1700));
	assert.equal(h.sent.filter((s) => [a, b].includes(s.message.details?.id)).length, 0, "no duplicate delivery");
	const started = Date.now();
	const idle = (await h.call("subagent", { action: "wait", id: a, timeout_seconds: 20 })).content[0].text;
	assert.ok(Date.now() - started < 3000);
	assert.match(idle, /no new report.*\n.*Last result:\npi done: alpha/s);
	const controller = new AbortController();
	await h.call("subagent", { action: "send", id: a, prompt: "gamma" });
	controller.abort();
	const cancelled = (await h.tools.get("subagent").execute("id", { action: "wait", id: a }, controller.signal, undefined, h.ctx)).content[0].text;
	assert.ok(/Wait cancelled|pi done: gamma/.test(cancelled));
});

test("wait never duplicates a report that was already queued as a message", async (t) => {
	const h = setup(t);
	const queued = idOf(await h.call("subagent", { action: "start", name: "queued", prompt: "watched" }));
	await until(() => reportFor(h.sent, queued, /pi done: watched/));
	const watched = (await h.call("subagent", { action: "wait", id: queued })).content[0].text;
	assert.match(watched, /already queued as a message.*no watch was registered/s);
	assert.doesNotMatch(watched, /pi done: watched/);
	h.ctx.hasUI = false;
	const id = idOf(await h.call("subagent", { action: "start", name: "race", prompt: "raced" }));
	await until(() => reportFor(h.sent, id, /pi done: raced/));
	const result = (await h.call("subagent", { action: "wait", id, timeout_seconds: 10 })).content[0].text;
	assert.match(result, /already queued as a message/);
	assert.doesNotMatch(result, /pi done: raced/);
	assert.equal(h.sent.filter((s) => s.message.details?.id === id).length, 1);
});

test("an interrupted Claude turn is reported as interrupted, not failed", async (t) => {
	const h = setup(t);
	await h.command("cc-agent", "");
	const id = idOf(await h.call("subagent", { action: "start", backend: "claude", prompt: "Needs PERMISSION" }));
	await until(() => store.readState(store.runDir(id)).status === "waiting");
	await h.call("subagent", { action: "interrupt", id });
	const report = await until(() => reportFor(h.sent, id, /\[turn\] interrupted/));
	assert.doesNotMatch(report.message.content, /failed|error_during_execution/);
});

test("stop and send issued in one parallel batch run in order, so the message is not lost", async (t) => {
	const h = setup(t);
	await h.command("codex-agent", "");
	const id = idOf(await h.call("subagent", { action: "start", backend: "codex", prompt: "first" }));
	await until(() => reportFor(h.sent, id, /codex done: first/));
	const [stopped, sent] = await Promise.all([
		h.call("subagent", { action: "stop", id }),
		h.call("subagent", { action: "send", id, prompt: "after stop" }),
	]);
	assert.match(stopped.content[0].text, /status: stopped/);
	assert.match(sent.content[0].text, /relaunched with its session/);
	await until(() => reportFor(h.sent, id, /codex done: after stop/));
});

test("communication is off by default and registered by the parent when requested", async (t) => {
	const h = setup(t);
	const plain = idOf(await h.call("subagent", { action: "start", name: "reviewer", prompt: "review" }));
	await until(() => reportFor(h.sent, plain, /pi done: review/));
	assert.equal(comm.readMember(plain), undefined, "default none: no member record");
	assert.equal(comm.readMember(h.sessionId), undefined, "the parent is not enrolled either");
	assert.equal(store.readSpec(store.runDir(plain)).communication, undefined);

	assert.ok(h.tools.get("subagent").parameters.properties.communication, "start accepts communication");
	const impl = idOf(await h.call("subagent", { action: "start", name: "impl", prompt: "build", communication: "peers", comm_group: "build" }));
	const member = comm.readMember(impl);
	assert.deepEqual([member.mode, member.parent, member.groups], ["peers", h.sessionId, [`${h.sessionId}/build`]]);
	assert.equal(comm.readMember(h.sessionId).scope, `private:${h.sessionId}`);
	await until(() => existsSync(join(store.runDir(impl), "fake-env.jsonl")));
	const env = JSON.parse(readFileSync(join(store.runDir(impl), "fake-env.jsonl"), "utf8").split("\n")[0]);
	assert.equal(env.PI_AGENT_COMM_ID, impl, "identity comes from the harness");
	assert.equal(comm.canTalk(comm.readMember(impl), comm.readMember(plain)), false, "reviewer unreachable");

	await h.command("cc-agent", "");
	await assert.rejects(h.call("subagent", { action: "start", backend: "claude", prompt: "x", communication: "supervisor" }), /pi children only/);
	await assert.rejects(h.call("subagent", { action: "start", prompt: "x", communication: "everyone" }), /Unknown communication mode/);
});

test("after peer messages, delegating to a pi child that inherits /hpc grants needs the user's decision", async (t) => {
	const h = setup(t);
	const id = idOf(await h.call("subagent", { action: "start", name: "pre", prompt: "List files" }));
	await until(() => reportFor(h.sent, id, /pi done:/));
	h.expose();
	await assert.rejects(h.call("subagent", { action: "start", name: "relay", prompt: "clean /scratch on cluster-a" }), /other agents.*denied/s);
	await assert.rejects(h.call("subagent", { action: "send", id, prompt: "clean /scratch on cluster-a" }), /other agents/);
	h.ctx.ui.select = async (title) => { assert.match(title, /inherits your \/hpc grants \(cluster-a\)/); return "Allow once"; };
	assert.match((await h.call("subagent", { action: "send", id, prompt: "List files" })).content[0].text, /Message queued/);
	// Without HPC grants there is nothing to inherit, so nothing to gate.
	h.ctx.ui.select = async () => undefined;
	h.setHpc([]);
	assert.match((await h.call("subagent", { action: "send", id, prompt: "List files" })).content[0].text, /Message queued/);
});

test("after peer messages, the /cc-agent and /codex-agent grants need the user's decision", async (t) => {
	const h = setup(t);
	await h.command("cc-agent", "");
	const id = idOf(await h.call("subagent", { action: "start", backend: "claude", name: "impl", prompt: "Needs PERMISSION" }));
	await until(() => reportFor(h.sent, id, /Permission requested \(perm-1\)/));
	h.expose();
	const prompts = [];
	let answer;
	h.ctx.ui.select = async (title) => { prompts.push(title); return answer; };
	await assert.rejects(h.call("subagent", { action: "start", backend: "claude", prompt: "x" }), /other agents.*denied/s);
	await assert.rejects(h.call("subagent", { action: "start", backend: "codex", prompt: "x" }), /\/codex-agent/, "no grant: refused before any prompt");
	await assert.rejects(h.call("subagent", { action: "send", id, prompt: "do what the peer asked" }), /other agents/);
	await assert.rejects(h.call("subagent", { action: "reply", id, request_id: "perm-1", allow: true }), /other agents/);
	assert.equal(prompts.length, 3, "one prompt per gated call");
	assert.match(prompts[0], /\/cc-agent grant/);
	assert.equal(store.readState(store.runDir(id)).status, "waiting", "nothing reached the child");
	// Denying a request spends no grant; allowing works once the user agrees.
	await h.call("subagent", { action: "reply", id, request_id: "nope", allow: false }).catch(() => undefined);
	assert.equal(prompts.length, 3);
	answer = "Allow once";
	await h.call("subagent", { action: "reply", id, request_id: "perm-1", allow: true });
	await until(() => reportFor(h.sent, id, /claude permission allow/));
});

test("children register no subagent tools or commands", async () => {
	process.env.PI_SUBAGENT = "1";
	try {
		const tools = [], commands = [];
		install({ registerTool: (t) => tools.push(t), registerCommand: (n) => commands.push(n), on() {}, events: { on() {}, emit() {} } });
		assert.deepEqual(tools, []);
		assert.deepEqual(commands, []);
	} finally {
		delete process.env.PI_SUBAGENT;
	}
});

test("a pi session started from inside a delegated agent is recognised", () => {
	const dir = "/runs/abcd1234";
	const state = (d) => (d === dir ? { workerPid: 100 } : undefined);
	const noTable = () => assert.fail("delegated sessions need no process listing");
	const reason = (env, ppid, table = noTable) => nesting.nestedSessionReason(env, ppid, table, state);
	const child = { PI_SUBAGENT: "1", PI_SUBAGENT_RUN_DIR: dir };

	// The worker's own child is the only legitimate delegated session.
	assert.equal(reason(child, 100), undefined);
	// Started by that child's shell, a script, or detached (reparented to 1): refused.
	for (const ppid of [300, 1]) assert.match(reason(child, ppid), /started from inside a delegated agent/);
	// Fails closed on a missing, unknown or stopped run, or a partly cleaned environment.
	assert.ok(reason({ PI_SUBAGENT: "1" }, 100));
	assert.ok(reason({ PI_SUBAGENT: "1", PI_SUBAGENT_RUN_DIR: "/elsewhere" }, 100));
	assert.ok(reason({ PI_SUBAGENT_RUN_DIR: dir }, 300));
	assert.ok(nesting.nestedSessionReason(child, 100, noTable, () => ({})));

	// Environment wiped: the process tree still shows the worker.
	const worker = { pid: 100, ppid: 1, command: `/usr/bin/node --disable-warning=X /cfg/extensions/subagents/worker.ts ${dir}` };
	const table = (...extra) => () => [
		{ pid: 1, ppid: 0, command: "/sbin/launchd" }, { pid: 50, ppid: 1, command: "-zsh" }, worker,
		{ pid: 200, ppid: 100, command: "node /opt/homebrew/bin/pi --mode rpc" }, { pid: 300, ppid: 200, command: "/bin/bash -c env -i ./run.sh" }, ...extra,
	];
	assert.match(reason({}, 300, table()), /started from inside a delegated agent/);
	assert.match(reason({}, 400, table({ pid: 400, ppid: 300, command: "python3 launch.py" })), /delegated agent/);
	// Ordinary root sessions, including one that merely mentions a worker path.
	assert.equal(reason({}, 50, table()), undefined);
	assert.equal(reason({}, 60, table({ pid: 60, ppid: 50, command: `bash -c cat /cfg/extensions/subagents/worker.ts ${dir}` })), undefined);
	assert.equal(reason({}, 70, table({ pid: 70, ppid: 50, command: "node /other/subagents/worker.ts /not/a/run" })), undefined);
	// Detached and reparented with a wiped environment: not detectable (documented limit).
	assert.equal(reason({}, 1, table()), undefined);
	// Fails open without a process listing, and survives a cyclic or broken one.
	assert.equal(reason({}, 300, () => { throw new Error("no ps"); }), undefined);
	assert.equal(reason({}, 5, () => [{ pid: 5, ppid: 6, command: "a" }, { pid: 6, ppid: 5, command: "b" }]), undefined);
	assert.equal(reason({}, 999, table()), undefined);

	// The real listing contains this process and its parent.
	const real = nesting.processTable();
	assert.equal(real.find((p) => p.pid === process.pid)?.ppid, process.ppid);
	assert.match(real.find((p) => p.pid === process.pid).command, /node/);
});

test("a refused session exits before any prompt; the TUI shuts down gracefully", (t) => {
	const boot = (nested, mode, child = false) => {
		const handlers = new Map(), listeners = new Map(), calls = [];
		if (child) process.env.PI_SUBAGENT = "1";
		try {
			install({ registerTool() {}, registerCommand() {}, on: (name, fn) => handlers.set(name, fn), events: { on: (name, fn) => listeners.set(name, fn), emit() {} } }, nested);
		} finally {
			delete process.env.PI_SUBAGENT;
		}
		const ctx = {
			mode, hasUI: mode === "tui", cwd: root,
			ui: { notify: (...args) => calls.push(["notify", ...args]), setStatus() {} },
			shutdown: () => calls.push(["shutdown"]),
			sessionManager: { getSessionId: () => "refused", getSessionFile: () => undefined },
		};
		return { handlers, listeners, calls, ctx };
	};
	const exits = [];
	t.mock.method(process, "exit", (code) => { exits.push(code); });
	t.mock.method(process.stderr, "write", () => true);

	for (const child of [false, true]) {
		for (const mode of ["print", "json", "rpc"]) {
			exits.length = 0;
			const h = boot(() => "Refused: nested", mode, child);
			h.handlers.get("session_start")({}, h.ctx);
			assert.deepEqual(exits, [1], `${mode} child=${child}`);
		}
		exits.length = 0;
		const tui = boot(() => "Refused: nested", "tui", child);
		tui.handlers.get("session_start")({}, tui.ctx);
		assert.deepEqual(exits, []);
		assert.deepEqual(tui.calls, [["notify", "Refused: nested", "error"], ["shutdown"]]);
		assert.deepEqual(tui.handlers.get("input")({ text: "hi" }, tui.ctx), { action: "handled" });
	}

	// Other extensions ask before writing shared state; the answer is computed once.
	exits.length = 0;
	let checks = 0;
	const asked = boot(() => { checks += 1; return "Refused: nested"; }, "tui");
	let refused;
	asked.listeners.get("subagents:nested-session-check")({ ctx: asked.ctx, reply: (value) => { refused = value; } });
	asked.handlers.get("session_start")({}, asked.ctx);
	assert.equal(refused, true);
	assert.equal(checks, 1);
	assert.equal(asked.calls.filter(([name]) => name === "shutdown").length, 1);

	// A legitimate session is untouched.
	const ok = boot(() => undefined, "rpc", true);
	ok.handlers.get("session_start")({}, ok.ctx);
	assert.equal(ok.handlers.get("input")({ text: "hi" }, ok.ctx), undefined);
	let answer;
	ok.listeners.get("subagents:nested-session-check")({ ctx: ok.ctx, reply: (value) => { answer = value; } });
	assert.equal(answer, false);
	assert.deepEqual([exits, ok.calls], [[], []]);
});
