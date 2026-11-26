import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTypeScript } from "./pi-runtime.mjs";

// Transport and permission logic only; no model requests.
const root = mkdtempSync(join(tmpdir(), "pi-agent-comm-test-"));
process.env.PI_AGENT_COMM_ROOT = root;
for (const name of ["PI_SUBAGENT", "PI_AGENT_COMM_ID", "PI_AGENT_COMM_SCOPE"]) delete process.env[name];

const storePath = fileURLToPath(new URL("../extensions/agent-comm/store.ts", import.meta.url));
const store = await loadTypeScript(storePath);
const { default: extension } = await loadTypeScript(fileURLToPath(new URL("../extensions/agent-comm/index.ts", import.meta.url)));

let counter = 0;
const uid = (prefix) => `${prefix}-${process.pid}-${++counter}`;

// pi.events: several extensions share one bus in a real session.
function createBus() {
	const listeners = new Map();
	return {
		on: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
		emit: (name, payload) => { for (const fn of listeners.get(name) ?? []) fn(payload); },
	};
}

const freshDir = () => mkdtempSync(join(tmpdir(), "pi-agent-comm-cwd-"));

// Installs the extension the way pi would, for a root session or a delegated child.
function install({ sessionId, child, scopeEnv, cwd = freshDir(), bus = createBus(), branch = [] } = {}) {
	const saved = { ...process.env };
	if (child) Object.assign(process.env, { PI_SUBAGENT: "1", PI_AGENT_COMM_ID: child });
	if (scopeEnv) process.env.PI_AGENT_COMM_SCOPE = scopeEnv;
	const tools = new Map(), commands = new Map(), handlers = new Map(), listeners = new Map();
	const events = { on: (name, fn) => { listeners.set(name, fn); bus.on(name, fn); }, emit: bus.emit };
	const sent = [], notices = [], statuses = new Map();
	try {
		extension({
			registerTool: (tool) => tools.set(tool.name, tool),
			registerCommand: (name, command) => commands.set(name, command),
			on: (name, fn) => handlers.set(name, fn),
			events,
			sendMessage: (...args) => sent.push(args),
			sendUserMessage: (...args) => sent.push(args),
		});
	} finally {
		for (const key of ["PI_SUBAGENT", "PI_AGENT_COMM_ID", "PI_AGENT_COMM_SCOPE"]) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
	const ctx = {
		cwd,
		hasUI: true,
		model: { provider: "anthropic", id: "claude-test" },
		ui: { setStatus: (key, value) => statuses.set(key, value), notify: (...args) => notices.push(args), select: async () => undefined },
		sessionManager: { getSessionId: () => sessionId ?? child, getSessionName: () => undefined, getBranch: () => branch },
	};
	handlers.get("session_start")?.({}, ctx);
	const active = () => tools.has("agent_comm") && tools.get("agent_comm").exposure !== "hidden";
	const callRaw = (params) => tools.get("agent_comm").execute("call", params);
	const call = async (params) => (await callRaw(params)).content[0].text;
	const exposure = (toolCallId = "tc") => {
		let value;
		bus.emit("agent-comm:exposure-query", { toolCallId, reply: (v) => { value = v; } });
		return value;
	};
	const command = (name, args) => commands.get(name).handler(args, ctx);
	const shutdown = () => handlers.get("session_shutdown")?.({}, ctx);
	return { tools, commands, handlers, listeners, sent, notices, statuses, ctx, bus, active, call, callRaw, exposure, command, shutdown };
}

// A root session with children registered by its (trusted) harness.
function tree(children) {
	const rootId = uid("root");
	store.ensureRoot(rootId, "coordinator");
	const ids = {};
	for (const [name, mode, group] of children) {
		const id = uid(name);
		// Children start running: their presence names this (live) process.
		if (store.registerChild({ id, name, parentId: rootId, mode, group })) store.markPresence(id);
		ids[name] = id;
	}
	return { rootId, ids };
}

// A git repository with a linked worktree, plus an unrelated clone-like repo.
function repos() {
	const base = freshDir();
	const main = join(base, "app"), worktree = join(base, "app-featureB"), other = join(base, "other");
	const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
	for (const dir of [main, other]) {
		mkdirSync(dir);
		git(dir, "init", "-q", "-b", "main");
		git(dir, "commit", "-q", "--allow-empty", "-m", "init");
	}
	git(main, "worktree", "add", "-q", "-b", "featureB", worktree);
	mkdirSync(join(main, "src"));
	return { main, worktree, other, sub: join(main, "src") };
}

test("1a. root sessions of one repository, worktrees included, reach each other by default", async (t) => {
	const r = repos();
	const a = install({ sessionId: uid("alice"), cwd: r.main });
	const b = install({ sessionId: uid("bob"), cwd: r.worktree });
	const c = install({ sessionId: uid("carol"), cwd: r.sub });
	const stranger = install({ sessionId: uid("eve"), cwd: r.other });
	const loose = install({ sessionId: uid("loose") }); // not a git repo
	t.after(() => [a, b, c, stranger, loose].forEach((s) => s.shutdown()));
	assert.ok(a.active() && b.active() && stranger.active() && loose.active(), "on by default");
	const bobId = b.ctx.sessionManager.getSessionId();
	const list = await a.call({ action: "list" });
	assert.match(list, new RegExp(`\\(${bobId}\\) · peer · idle · .*app-featureB \\[featureB\\] · anthropic/claude-test`));
	assert.match(list, /carol.*src \[main\]/);
	assert.doesNotMatch(list, /eve|loose/);
	await a.call({ action: "send", to: bobId, message: "please implement the retry fix" });
	assert.match(await b.call({ action: "inbox" }), /please implement the retry fix/);
	const strangerId = stranger.ctx.sessionManager.getSessionId();
	await assert.rejects(a.call({ action: "send", to: strangerId, message: "hi" }), /No permitted recipient/);
	assert.equal(await stranger.call({ action: "list" }), "No reachable agents.");
	// Busy/idle follows the agent loop.
	b.handlers.get("agent_start")({}, b.ctx);
	assert.match(await a.call({ action: "list" }), new RegExp(`\\(${bobId}\\) · peer · busy`));
	// /comm leave is remembered across resume; /comm project undoes it.
	await c.command("comm", "leave");
	assert.doesNotMatch(await a.call({ action: "list" }), /carol/);
	c.handlers.get("session_start")({}, c.ctx);
	assert.doesNotMatch(await a.call({ action: "list" }), /carol/, "explicit choice survives resume");
	await c.command("comm", "project");
	assert.match(await a.call({ action: "list" }), /carol/);
	// PI_AGENT_COMM_SCOPE=off: no tool for a fresh session.
	const off = install({ sessionId: uid("off"), cwd: r.main, scopeEnv: "off" });
	assert.equal(off.active(), false);
	assert.doesNotMatch(await a.call({ action: "list" }), /off-/);
});

test("1c. only live root sessions are listed or messaged; parent and child mail still queues", async (t) => {
	const r = repos();
	const a = install({ sessionId: uid("alice"), cwd: r.main });
	const b = install({ sessionId: uid("bob"), cwd: r.main });
	t.after(() => a.shutdown());
	const bobId = b.ctx.sessionManager.getSessionId();
	assert.match(await a.call({ action: "list" }), /bob/);
	await a.call({ action: "send", to: bobId, message: "while you are live" });
	b.shutdown(); // closed session: record stays, process gone
	assert.equal(await a.call({ action: "list" }), "No reachable agents.", "closed sessions are not listed");
	for (const to of [bobId, bobId.slice(0, 8), store.readMember(bobId).name]) {
		await assert.rejects(a.call({ action: "send", to, message: "do this" }), /is not running; nothing was sent/);
	}
	assert.throws(() => store.send(a.ctx.sessionManager.getSessionId(), bobId, "x"), /not running/);
	store.markPresence(bobId, { pid: 999_999_999 }); // crashed: stale pid
	assert.throws(() => store.send(a.ctx.sessionManager.getSessionId(), bobId, "x"), /not running/);
	assert.equal(store.unreadCount(bobId), 1, "only the message sent while live");
	// Resumed: it reads what arrived while it was live, and is reachable again.
	const resumed = install({ sessionId: bobId, cwd: r.main });
	t.after(() => resumed.shutdown());
	assert.match(await resumed.call({ action: "inbox" }), /while you are live/);
	assert.match(await a.call({ action: "list" }), /bob/);
	// A stopped child is still listed and can receive mail for when it is resumed.
	const { rootId, ids } = tree([["paused", "supervisor"]]);
	assert.match(store.send(rootId, ids.paused, "for later").body, /for later/);
	assert.deepEqual(store.partners(store.readMember(rootId)).map((m) => m.name), ["paused"]);
	assert.match(store.send(ids.paused, rootId, "to an offline parent").body, /offline parent/);
	// A stopped sibling is like a closed session: not listed, not messaged.
	const peers = tree([["x", "peers"], ["y", "peers"]]);
	store.clearPresence(peers.ids.y);
	assert.throws(() => store.send(peers.ids.x, peers.ids.y, "x"), /not running/);
	assert.deepEqual(store.partners(store.readMember(peers.ids.x)).map((m) => m.name), ["coordinator"]);
});

test("1b. root sessions anywhere can opt into a shared named scope", async (t) => {
	const a = install({ sessionId: uid("alice") });
	const b = install({ sessionId: uid("bob") });
	const outsider = install({ sessionId: uid("eve") });
	t.after(() => [a, b, outsider].forEach((s) => s.shutdown()));
	assert.equal(await a.call({ action: "list" }), "No reachable agents.", "different directories: isolated");
	await a.command("comm", "join team");
	await b.command("comm", "join team");
	const bobId = b.ctx.sessionManager.getSessionId();
	assert.match(await a.call({ action: "list" }), new RegExp(`\\(${bobId}\\) · peer · idle`));
	assert.match(await a.call({ action: "send", to: bobId, message: "main moved; rebase" }), /^Sent [a-f0-9]{8} to /);
	const inbox = await b.call({ action: "inbox" });
	assert.match(inbox, /main moved; rebase/);
	const messageId = inbox.match(/^\[([a-f0-9]{8})\]/)[1];
	await b.call({ action: "send", reply_to: messageId, message: "done" });
	assert.match(await a.call({ action: "inbox" }), new RegExp(`reply to ${messageId}\\ndone`));
	// An independent session that has not joined sees nothing.
	await outsider.command("comm", "join other");
	assert.equal(await outsider.call({ action: "list" }), "No reachable agents.");
	await assert.rejects(outsider.call({ action: "send", to: bobId, message: "hi" }), /No permitted recipient/);
	// Headless roots opt in through the environment.
	const headless = install({ sessionId: uid("ci"), scopeEnv: "team" });
	assert.ok(headless.active());
	assert.match(await headless.call({ action: "list" }), /peer/);
	headless.shutdown();
});

test("2. parent and child communicate in supervisor mode", async (t) => {
	const { rootId, ids } = tree([["worker", "supervisor"]]);
	const child = install({ child: ids.worker });
	t.after(() => child.shutdown());
	assert.ok(child.active());
	assert.match(await child.call({ action: "list" }), /coordinator \(.*\) · supervisor/);
	await child.call({ action: "send", to: "coordinator", message: "halfway; tests pass" });
	const parent = install({ sessionId: rootId });
	t.after(() => parent.shutdown());
	assert.ok(parent.active(), "an existing member record re-enables the tool on resume");
	assert.match(await parent.call({ action: "inbox" }), /from worker \(.*, child\)[^\n]*\nhalfway; tests pass/);
	await parent.call({ action: "send", to: "worker", message: "also update the README" });
	assert.match(await child.call({ action: "inbox" }), /also update the README/);
});

test("3/4. authorized siblings talk in peers mode; supervisor-only agents cannot reach siblings", async () => {
	const { ids } = tree([["a", "peers"], ["b", "peers"], ["c", "peers", "other"], ["s", "supervisor"]]);
	store.send(ids.a, ids.b, "hello b");
	assert.equal(store.takeInbox(ids.b, 5).messages[0].body, "hello b");
	assert.throws(() => store.send(ids.a, ids.c, "x"), /No permitted recipient/, "different peer group");
	assert.throws(() => store.send(ids.s, ids.a, "x"), /No permitted recipient/);
	assert.throws(() => store.send(ids.a, ids.s, "x"), /No permitted recipient/);
	const names = (id) => store.partners(store.readMember(id)).map((m) => m.name).sort();
	assert.deepEqual(names(ids.a), ["b", "coordinator"]);
	assert.deepEqual(names(ids.s), ["coordinator"]);
	assert.deepEqual(names(ids.c), ["coordinator"]);
});

test("5/6/7/10. an isolated reviewer has no tool, no prompt text and cannot be discovered or reached", async (t) => {
	const { rootId, ids } = tree([["implementer", "peers"], ["reviewer", "none"]]);
	assert.equal(store.readMember(ids.reviewer), undefined, "no member record for none");
	const reviewer = install({ child: ids.reviewer });
	t.after(() => reviewer.shutdown());
	assert.equal(reviewer.tools.size, 0, "no tool (not even hidden/deferred)");
	assert.equal(reviewer.commands.size, 0, "no /comm command");
	assert.equal(reviewer.handlers.size, 0, "no prompt or lifecycle hooks");
	assert.equal(reviewer.listeners.size, 0);
	// Implementer cannot list or message the reviewer, by name or id.
	const impl = install({ child: ids.implementer });
	t.after(() => impl.shutdown());
	assert.doesNotMatch(await impl.call({ action: "list" }), /reviewer/);
	for (const to of ["reviewer", ids.reviewer]) await assert.rejects(impl.call({ action: "send", to, message: "be gentle" }), /No permitted recipient/);
	assert.throws(() => store.send(ids.implementer, ids.reviewer, "x"), /No permitted recipient/);
	assert.throws(() => store.send(ids.reviewer, rootId, "x"), /No permitted recipient/, "none cannot send either");
	assert.throws(() => store.send(rootId, ids.reviewer, "x"), /No permitted recipient/, "even the parent cannot use messaging with none");
	assert.equal(existsSync(join(root, "mail", ids.reviewer)), false, "nothing was ever queued");
});

test("8. nested agents cannot escalate", async () => {
	const { rootId, ids } = tree([["lead", "supervisor"], ["sib", "peers"]]);
	// A grandchild asking for peers is capped at its parent's mode and namespaced under it.
	const grand = store.registerChild({ id: uid("grand"), name: "grand", parentId: ids.lead, mode: "peers" });
	assert.equal(grand.mode, "supervisor");
	assert.ok(store.canTalk(grand, store.readMember(ids.lead)));
	assert.equal(store.canTalk(grand, store.readMember(ids.sib)), false);
	assert.equal(store.canTalk(grand, store.readMember(rootId)), false, "no skipping a level");
	// A delegated agent cannot turn itself into a root or join a scope.
	assert.throws(() => store.registerRoot(ids.lead, "lead", { named: "team" }), /cannot register as a root/);
	const lead = install({ child: ids.lead, scopeEnv: "team" });
	assert.equal(lead.commands.has("comm"), false);
	assert.equal(store.readMember(ids.lead).scope, store.readMember(rootId).scope, "scope env ignored in children");
	lead.shutdown();
	// Records cannot be re-registered with more permissions.
	assert.throws(() => store.registerChild({ id: ids.lead, name: "lead", parentId: rootId, mode: "peers" }), /already registered/);
	// Model input never sets the sender: there is no from parameter.
	assert.equal("from" in (install({ child: ids.sib }).tools.get("agent_comm").parameters.properties), false);
});

test("9. unrelated trees and scopes are isolated by default", () => {
	const one = tree([["x", "peers"]]);
	const two = tree([["x", "peers"]]);
	assert.equal(store.canTalk(store.readMember(one.ids.x), store.readMember(two.ids.x)), false, "same default group name, different parents");
	assert.equal(store.canTalk(store.readMember(one.rootId), store.readMember(two.rootId)), false, "private root scopes");
	assert.equal(store.canTalk(store.readMember(one.rootId), store.readMember(two.ids.x)), false);
	store.registerRoot(one.rootId, "one", { named: "alpha" });
	store.registerRoot(two.rootId, "two", { named: "beta" });
	assert.equal(store.canTalk(store.readMember(one.rootId), store.readMember(two.rootId)), false, "different named scopes");
	store.registerRoot(two.rootId, "two", { named: "alpha" });
	assert.ok(store.canTalk(store.readMember(one.rootId), store.readMember(two.rootId)));
	assert.equal(store.canTalk(store.readMember(one.ids.x), store.readMember(two.ids.x)), false, "children do not inherit their roots' peering");
});

test("9b. siblings started before and after their parent changes scope still talk; other trees stay closed", () => {
	const [p1, p2] = [uid("p1"), uid("p2")];
	for (const id of [p1, p2]) store.registerRoot(id, id, { named: "before" });
	const child = (parentId, name, group) => store.registerChild({ id: uid(name), name, parentId, mode: "peers", group });
	const early = child(p1, "early"), foreign = child(p2, "foreign");
	store.registerRoot(p1, p1, { named: "after" }, true);
	const late = child(p1, "late"), otherGroup = child(p1, "other", "g2");
	assert.notEqual(early.scope, late.scope);
	assert.ok(store.canTalk(early, late), "same parent and group");
	for (const member of [early, late, foreign]) store.markPresence(member.id);
	assert.match(store.send(early.id, late.id, "hi").body, /hi/);
	assert.equal(store.canTalk(late, otherGroup), false, "groups still separate siblings");
	// Same scope string and same group name as p1's children, different parent.
	for (const mine of [early, late]) assert.equal(store.canTalk(mine, foreign), false);
	assert.throws(() => store.send(foreign.id, early.id, "hi"), /No permitted recipient/);
	// Roots stay scope-checked, and a child never reaches another root.
	assert.equal(store.canTalk(store.readMember(p1), store.readMember(p2)), false);
	assert.equal(store.canTalk(early, store.readMember(p2)), false);
	assert.equal(store.canTalk(foreign, store.readMember(p1)), false);
	for (const member of [early, late, foreign]) store.clearPresence(member.id);
});

test("10. overhead is measured; opted-out roots and none children pay nothing", async (t) => {
	const plain = install({ sessionId: uid("plain"), scopeEnv: "off" });
	t.after(() => plain.shutdown());
	assert.equal(plain.tools.size, 0);
	assert.deepEqual([...plain.commands.keys()], ["comm"], "a slash command only, never sent to the model");
	const { ids } = tree([["m", "supervisor"]]);
	const child = install({ child: ids.m });
	t.after(() => child.shutdown());
	const tool = child.tools.get("agent_comm");
	const declared = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
	const guidelines = tool.promptGuidelines.join("\n");
	const tokens = Math.ceil((declared.length + guidelines.length) / 4);
	console.log(`agent_comm overhead when enabled: ~${tokens} tokens (${declared.length} chars schema+description, ${guidelines.length} chars guideline); none: 0`);
	assert.equal(tool.promptSnippet, undefined, "no extra <tools> line");
	assert.ok(tokens < 300, `overhead ${tokens} tokens`);
});

test("11. incoming messages never enter the context or start a turn by themselves", async (t) => {
	const { rootId, ids } = tree([["w", "supervisor"]]);
	const parent = install({ sessionId: rootId });
	const child = install({ child: ids.w });
	t.after(() => [parent, child].forEach((s) => s.shutdown()));
	for (let i = 0; i < 3; i += 1) store.send(ids.w, rootId, `note ${i}`);
	parent.bus.emit("agent-comm:enable", {});
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(parent.sent.length + child.sent.length, 0, "no sendMessage / sendUserMessage");
	assert.equal(parent.statuses.get("agent-comm"), "✉ 3 unread", "TUI-only indicator");
	assert.match(await parent.call({ action: "inbox", limit: 2 }), /note 0[\s\S]*note 1[\s\S]*1 more unread/);
});

test("12. concurrent senders in separate processes lose and corrupt nothing", async () => {
	const { rootId, ids } = tree([["p1", "supervisor"], ["p2", "supervisor"], ["p3", "supervisor"], ["p4", "supervisor"]]);
	const perSender = 20;
	const script = `const s = await import(${JSON.stringify(storePath)}); for (let i = 0; i < ${perSender}; i++) s.send(process.argv[1], ${JSON.stringify(rootId)}, process.argv[1] + ":" + i);`;
	await Promise.all(Object.values(ids).map((id) => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, id], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr.on("data", (d) => { err += d; });
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
	})));
	const bodies = [];
	for (;;) {
		const { messages, remaining } = store.takeInbox(rootId, 20);
		bodies.push(...messages.map((m) => m.body));
		if (!remaining) break;
	}
	assert.equal(bodies.length, 4 * perSender);
	assert.equal(new Set(bodies).size, bodies.length);
	assert.equal(readdirSync(join(root, "mail", rootId, "new")).length, 0);
	assert.equal(readdirSync(join(root, "mail", rootId, "cur")).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("13. terminated agents leave no waits or presence behind; their mail stays queued", async () => {
	const { rootId, ids } = tree([["gone", "supervisor"]]);
	const child = install({ child: ids.gone });
	assert.ok(store.online(ids.gone));
	child.shutdown();
	assert.equal(store.online(ids.gone), false);
	store.markPresence(ids.gone, { pid: 999_999_999 }); // a crashed process: stale pid
	assert.equal(store.online(ids.gone), false);
	store.send(rootId, ids.gone, "for when you resume");
	assert.equal(store.unreadCount(ids.gone), 1);
	const parent = install({ sessionId: rootId });
	assert.match(await parent.call({ action: "list" }), /gone .* offline/);
	parent.shutdown();
	assert.equal(parent.statuses.get("agent-comm"), undefined, "indicator cleared, timer stopped");
	// Old read and unread mail is swept.
	store.takeInbox(ids.gone, 5);
	store.sweep(ids.gone, Date.now() + 15 * 24 * 3600_000);
	assert.equal(readdirSync(join(root, "mail", ids.gone, "cur")).length, 0);
});

test("limits: message size, backlog and permission re-check on read", () => {
	const { rootId, ids } = tree([["a", "peers"], ["b", "peers"]]);
	assert.throws(() => store.send(ids.a, ids.b, "x".repeat(store.MESSAGE_LIMIT + 1)), /limit/);
	for (let i = 0; i < store.BACKLOG_LIMIT; i += 1) store.send(ids.a, rootId, `m${i}`);
	assert.throws(() => store.send(ids.b, rootId, "one more"), /not accepting more/);
	assert.equal(store.takeInbox(rootId, 500).messages.length, store.BACKLOG_LIMIT);
	// Mail from a sender that is no longer permitted is filed, not shown.
	const [r1, r2] = [uid("r1"), uid("r2")];
	store.registerRoot(r1, "r1", { named: "z" });
	store.registerRoot(r2, "r2", { named: "z" });
	store.markPresence(r2);
	store.send(r1, r2, "before leaving");
	store.registerRoot(r2, "r2", "private");
	const taken = store.takeInbox(r2, 5);
	assert.deepEqual([taken.messages.length, taken.remaining], [0, 0]);
});

test("PI_AGENT_COMM_SCOPE=off also opts out a resumed session that was registered before", async (t) => {
	const r = repos();
	const id = uid("resumed");
	install({ sessionId: id, cwd: r.main }).shutdown();
	const peer = install({ sessionId: uid("peer"), cwd: r.worktree });
	const off = install({ sessionId: id, cwd: r.main, scopeEnv: "off" });
	t.after(() => [peer, off].forEach((s) => s.shutdown()));
	assert.equal(off.active(), false, "no tool");
	assert.doesNotMatch(await peer.call({ action: "list" }), new RegExp(id));
	await assert.rejects(peer.call({ action: "send", to: id, message: "hi" }), /No permitted recipient/);
	// A communicating child turns the tool on, but does not reopen the session to project peers.
	const kid = uid("kid");
	store.registerChild({ id: kid, name: "kid", parentId: id, mode: "supervisor" });
	off.bus.emit("agent-comm:enable", {});
	assert.equal(off.active(), true);
	assert.doesNotMatch(await peer.call({ action: "list" }), new RegExp(id));
	// The next normal launch is back in the project scope.
	off.shutdown();
	const back = install({ sessionId: id, cwd: r.main });
	t.after(() => back.shutdown());
	assert.match(await peer.call({ action: "list" }), new RegExp(id));
});

test("a session renamed after it started is addressable by the name that list shows", async (t) => {
	const r = repos();
	const a = install({ sessionId: uid("a"), cwd: r.main });
	const b = install({ sessionId: uid("b"), cwd: r.worktree });
	t.after(() => [a, b].forEach((s) => s.shutdown()));
	b.ctx.sessionManager.getSessionName = () => "docs-writer";
	b.handlers.get("agent_settled")({}, b.ctx);
	assert.match(await a.call({ action: "list" }), /docs-writer/);
	assert.match(await a.call({ action: "send", to: "Docs-Writer", message: "hi" }), /Sent \w+ to docs-writer/);
	assert.match(await b.call({ action: "inbox" }), /hi/);
});

test("member records of long-closed root sessions are pruned; live, explicit and parent records stay", async () => {
	const old = new Date(Date.now() - 90 * 24 * 3600_000);
	const age = (id) => utimesSync(join(root, "members", `${id}.json`), old, old);
	const [stale, live, chosen, parent, fresh] = ["stale", "live", "chosen", "parent", "fresh"].map((n) => uid(n));
	for (const id of [stale, live, fresh, parent]) store.registerRoot(id, id, { named: "prune" });
	store.registerRoot(chosen, chosen, { named: "prune" }, true);
	const kid = uid("kid");
	store.registerChild({ id: kid, name: "kid", parentId: parent, mode: "supervisor" });
	store.markPresence(live);
	store.markPresence(stale);
	store.send(live, stale, "never read");
	store.clearPresence(stale);
	for (const id of [stale, live, chosen, parent, kid]) age(id);
	store.sweepMembers();
	assert.equal(store.readMember(stale), undefined);
	assert.equal(existsSync(join(root, "mail", stale)), false, "its mailbox goes too");
	for (const id of [live, chosen, parent, kid, fresh]) assert.ok(store.readMember(id), id);
	// Presence left by a crashed process (dead pid) is dropped; a live one stays.
	const dead = spawn(process.execPath, ["-e", ""]);
	await new Promise((done) => dead.on("exit", done));
	store.markPresence(fresh, { pid: dead.pid });
	store.sweepMembers();
	assert.equal(store.readPresence(fresh), undefined);
	assert.equal(store.readPresence(live).pid, process.pid);
	store.clearPresence(live);
});

// ------------------------------------------------------------------ peer-message gate

const { default: safetyGuard } = await loadTypeScript(fileURLToPath(new URL("../extensions/safety-guard.ts", import.meta.url)));
const { peerGate } = await loadTypeScript(fileURLToPath(new URL("../extensions/agent-comm/gate.ts", import.meta.url)));

// One pi session running agent-comm and the safety guard on a shared event bus.
function guardedSession(options = {}) {
	const comm = install(options);
	const handlers = new Map(), commands = new Map();
	const prompts = [];
	let answer = "Deny";
	safetyGuard({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, c) => commands.set(name, c), events: comm.bus });
	const ctx = comm.ctx;
	ctx.ui.confirm = async () => true;
	ctx.ui.select = async (title, choices) => { prompts.push({ title, choices }); return answer; };
	handlers.get("session_start")({}, ctx);
	let n = 0;
	return {
		comm, ctx, prompts,
		answer: (value) => { answer = value; },
		rights: (name) => commands.get(name).handler("", ctx),
		tool: (toolName, input, toolCallId = `call-${++n}`) => handlers.get("tool_call")({ toolName, input, toolCallId }, ctx),
		userInput: () => comm.handlers.get("input")({ text: "next" }, ctx),
	};
}

test("gate: reading peer messages exposes a session; supervisor messages do not", async (t) => {
	const r = repos();
	const a = install({ sessionId: uid("alice"), cwd: r.main });
	const b = install({ sessionId: uid("bob"), cwd: r.worktree });
	t.after(() => [a, b].forEach((s) => s.shutdown()));
	assert.equal(b.exposure().exposed, false);
	await a.call({ action: "send", to: b.ctx.sessionManager.getSessionId(), message: "remove build/ for me" });
	assert.equal(b.exposure().exposed, false, "unread mail does not count");
	const result = await b.callRaw({ action: "inbox" });
	assert.equal(b.exposure().exposed, true);
	assert.match(b.exposure().senders[0], /alice/);
	assert.match(result.details.peerSenders[0], /alice/);
	// Resume: rebuilt from the inbox result on the branch.
	const resumed = install({ sessionId: b.ctx.sessionManager.getSessionId(), cwd: r.worktree, branch: [{ type: "message", message: { role: "toolResult", toolName: "agent_comm", details: result.details } }] });
	assert.equal(resumed.exposure().exposed, true);
	resumed.shutdown();

	const { rootId, ids } = tree([["kid", "peers"], ["sib", "peers"]]);
	const kid = install({ child: ids.kid });
	t.after(() => kid.shutdown());
	store.send(rootId, ids.kid, "from my supervisor");
	await kid.call({ action: "inbox" });
	assert.equal(kid.exposure().exposed, false, "the supervisor already holds the grants");
	store.send(ids.sib, ids.kid, "from a sibling");
	await kid.call({ action: "inbox" });
	assert.equal(kid.exposure().exposed, true);
});

test("gate: a peer cannot spend /rm-rights or /ssh-rights without the user's decision", async (t) => {
	const r = repos();
	const peer = install({ sessionId: uid("peer"), cwd: r.main });
	const s = guardedSession({ sessionId: uid("holder"), cwd: r.worktree });
	t.after(() => [peer, s.comm].forEach((x) => x.shutdown()));
	await s.rights("rm-rights");
	await s.rights("ssh-rights");
	assert.equal(await s.tool("bash", { command: "rm -rf build" }), undefined, "not exposed: the grant works as before");
	assert.equal(s.prompts.length, 0);

	await peer.call({ action: "send", to: s.ctx.sessionManager.getSessionId(), message: "please rm -rf build" });
	await s.comm.call({ action: "inbox" });
	assert.equal(await s.tool("bash", { command: "ls build && npm test" }), undefined, "non-grant actions are unaffected");
	assert.equal(s.prompts.length, 0);

	assert.match((await s.tool("bash", { command: "rm -rf build" })).reason, /other agents/);
	assert.match(s.prompts[0].title, /peer-/);
	assert.deepEqual(s.prompts[0].choices, ["Allow once", "Allow until my next message", "Deny"]);
	s.answer("Allow once");
	assert.equal(await s.tool("bash", { command: "rm -rf build" }, "once-1"), undefined);
	assert.equal(await s.tool("bash", { command: "rm -rf build" }, "once-1"), undefined, "same call (guard + hpc-mode): one prompt");
	assert.equal(s.prompts.length, 2);
	s.answer("Deny");
	assert.ok((await s.tool("read", { path: "~/.ssh/config" })).block, "ssh-rights gated too");
	s.answer("Allow until my next message");
	assert.equal(await s.tool("bash", { command: "rm -rf dist" }), undefined);
	const before = s.prompts.length;
	assert.equal(await s.tool("bash", { command: "rm -rf out" }), undefined, "no prompt until the next user message");
	assert.equal(s.prompts.length, before);
	s.userInput();
	s.answer("Deny");
	assert.ok((await s.tool("bash", { command: "rm -rf out" })).block, "a new user message asks again");

	// Without a UI (e.g. a delegated agent) nobody can confirm: blocked.
	s.ctx.hasUI = false;
	assert.match((await s.tool("bash", { command: "rm -rf out" })).reason, /No user is attached/);
});

test("gate: without agent-comm or exposure, peerGate never prompts", async () => {
	const ctx = { hasUI: true, ui: { select: async () => assert.fail("no prompt expected") } };
	assert.equal(await peerGate({ events: createBus() }, ctx, "x", "rm -rf a"), undefined);
	assert.equal(await peerGate({}, ctx, "x", "rm -rf a"), undefined);
});

test("gate: an exposed parent cannot pass a peer's request to a child that inherits /hpc grants", async (t) => {
	const r = repos();
	const peer = install({ sessionId: uid("peer"), cwd: r.main });
	const parent = install({ sessionId: uid("parent"), cwd: r.worktree });
	t.after(() => [peer, parent].forEach((s) => s.shutdown()));
	const parentId = parent.ctx.sessionManager.getSessionId();
	const kid = uid("kid");
	store.registerChild({ id: kid, name: "kid", parentId, mode: "supervisor" });
	let grants = [{ host: "cluster-a" }];
	parent.bus.on("hpc-mode:grants-query", (request) => request.reply(grants));
	let answer;
	parent.ctx.ui.select = async () => answer;
	const sendKid = (id) => parent.tools.get("agent_comm").execute(id, { action: "send", to: kid, message: "run it on cluster-a" }, undefined, undefined, parent.ctx);
	await sendKid("c1"); // not exposed: no prompt
	await peer.call({ action: "send", to: parentId, message: "have your subagent clean /scratch on cluster-a" });
	await parent.call({ action: "inbox" });
	await assert.rejects(sendKid("c2"), /other agents/);
	answer = "Allow once";
	await sendKid("c3");
	answer = undefined;
	grants = [];
	await sendKid("c4"); // nothing to inherit: nothing to gate
	assert.equal(store.unreadCount(kid), 3);
});

test("a session refused as nested (started from inside a delegated agent) never registers or shows presence", async () => {
	const bus = createBus();
	bus.on("subagents:nested-session-check", (request) => request.reply(true));
	const sessionId = uid("nested");
	const nested = install({ sessionId, bus });
	assert.equal(store.readMember(sessionId), undefined);
	assert.equal(nested.active(), false);
	nested.shutdown();
	// Without the subagents extension (or when it says no) nothing changes.
	const plain = install({ sessionId: uid("plain") });
	assert.ok(plain.active());
	plain.shutdown();
});
