// Subagents: delegate work to persistent pi, Claude Code and Codex children.
//
// Each child runs under a detached worker (worker.ts) that owns the native CLI
// over structured stdio, so children survive this pi session quitting and are
// re-attached when it resumes. Pi children are always allowed and inherit the
// parent's live HPC grants. Claude Code and Codex children need the user's
// session-only /cc-agent or /codex-agent grant; their permission modes are
// fixed to non-bypass values.
//
// Design inspired by pi-cli-subagents (joshua-zyy, MIT) and Mario Zechner's
// pi-subagent. See THIRD_PARTY_NOTICES.md.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { peerGate } from "../agent-comm/gate.ts";
import { COMM_MODES, ensureRoot, registerChild, type CommMode } from "../agent-comm/store.ts";
import { renderHtml } from "./export.ts";
import { nestedSessionReason } from "./nesting.ts";
import {
	allReports, BACKENDS, createRun, enqueue, lastTranscriptEntry, listRuns, markDelivered, newRunId, pendingReports, processAlive,
	readSpec, readState, readTranscript, readWatches, runDir, updateState, validateMode, writeHpcGrants, writeWatches,
	type Backend, type InheritedHpcGrant, type Report, type RunSpec, type RunState, type Watch,
} from "./store.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "worker.ts");
const DELIVERY_POLL_MS = 1500;
const REPORT_TEXT_LIMIT = 12_000;
const WATCH_DEFAULT_SECONDS = 1800;
const WATCH_MAX_SECONDS = 86_400;
const WIDGET_MAX_ROWS = 6;
const WIDGET_ROW_WIDTH = 110;
const STATUS_ICON: Record<string, string> = { starting: "◌", running: "●", waiting: "?", idle: "✓", failed: "✗", stopped: "■" };
const GRANTED_BACKENDS = ["claude", "codex"] as const;
type GrantedBackend = (typeof GRANTED_BACKENDS)[number];
const GRANT_COMMAND: Record<GrantedBackend, string> = { claude: "cc-agent", codex: "codex-agent" };
const BACKEND_LABEL: Record<Backend, string> = { pi: "pi", claude: "Claude Code", codex: "Codex" };

const SubagentParams = Type.Object({
	action: StringEnum(["start", "send", "wait", "interrupt", "stop", "reply"] as const, {
		description: "start a child; send a message; wait registers a watch for reports and returns at once (only when your next step depends on them); interrupt the current turn; stop (release processes, keep the session); reply to a permission request",
	}),
	ids: Type.Optional(Type.Array(Type.String(), { description: "wait: several subagent ids (or use id)" })),
	wait_for: Type.Optional(StringEnum(["all", "any"] as const, { description: "wait: resume when all (default) or any of the children reported" })),
	timeout_seconds: Type.Optional(Type.Number({ description: "wait: stop watching after this many seconds (default 1800, max 86400); reports still arrive later" })),
	backend: Type.Optional(StringEnum(["pi", "claude", "codex"] as const, { description: "start: which harness (default pi)" })),
	name: Type.Optional(Type.String({ description: "start: short descriptive name" })),
	prompt: Type.Optional(Type.String({ description: "start: the task. send: the message" })),
	files: Type.Optional(Type.Array(Type.String(), { description: "start: files the child should read first (paths)" })),
	cwd: Type.Optional(Type.String({ description: "start: existing directory, e.g. a git worktree you created (default: current directory)" })),
	model: Type.Optional(Type.String({ description: "start: model id; pi accepts provider/id. Default: pi inherits the parent model, others use their own default" })),
	effort: Type.Optional(Type.String({ description: "start: reasoning effort / thinking level for the backend" })),
	mode: Type.Optional(Type.String({ description: "start: Claude permission mode (auto, default, acceptEdits, plan; default auto) or Codex sandbox (workspace-write, read-only; default workspace-write). Bypass/full-access modes are refused" })),
	goal: Type.Optional(Type.String({ description: "start: long-running objective with a checkable done condition; set through the backend's native goal mechanism" })),
	communication: Type.Optional(StringEnum(["none", "supervisor", "peers"] as const, { description: "start, pi only: agent_comm messaging. none (default), supervisor (you), peers (you + same-group peers)" })),
	comm_group: Type.Optional(Type.String({ description: "start: peers group" })),
	id: Type.Optional(Type.String({ description: "send/interrupt/stop/reply: subagent id" })),
	delivery: Type.Optional(StringEnum(["auto", "steer", "followUp"] as const, { description: "send while busy: steer (next step) or followUp (after the current turn). Default auto = steer" })),
	request_id: Type.Optional(Type.String({ description: "reply: permission request id from the report" })),
	allow: Type.Optional(Type.Boolean({ description: "reply: true allows this single action once, false denies it" })),
	reason: Type.Optional(Type.String({ description: "reply: short reason" })),
});

const QueryParams = Type.Object({
	action: StringEnum(["list", "get", "transcript", "export"] as const, {
		description: "list children; get one child's state and last result; transcript tail; export to HTML",
	}),
	id: Type.Optional(Type.String({ description: "subagent id (get/transcript/export)" })),
	tail: Type.Optional(Type.Number({ description: "transcript: number of recent entries (default 20)" })),
	all: Type.Optional(Type.Boolean({ description: "list: include children of other sessions" })),
});

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} };
}

function clip(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}\n… [truncated; ${value.length - limit} more characters. Use subagent_query transcript or export for the rest]` : value;
}

function oneLine(value: string, limit: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, Math.max(0, limit - 1))}…` : flat;
}

function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function liveWorker(state: RunState | undefined): boolean {
	return processAlive(state?.workerPid);
}

function describe(spec: RunSpec, state: RunState): string {
	const bits = [`${spec.id} ${spec.name}`, BACKEND_LABEL[spec.backend], state.status];
	if (spec.model) bits.push(spec.model);
	if (spec.communication && spec.communication !== "none") bits.push(`comm: ${spec.communication}`);
	if (state.status !== "stopped" && state.status !== "failed" && !liveWorker(state)) bits.push("(worker not running; send relaunches it)");
	if (state.approval) bits.push(`waiting on ${state.approval.requestId}`);
	return `${bits.join(" · ")}\n  cwd: ${spec.cwd}`;
}

function startWorker(dir: string): void {
	const log = openSync(join(dir, "worker.log"), "a");
	const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", WORKER, dir], {
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env },
	});
	child.unref();
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return check();
}

// `nested` is a test seam; pi calls the factory with one argument.
export default function subagentsExtension(pi: ExtensionAPI, nested: () => string | undefined = nestedSessionReason) {
	// No recursive spawning: a session started from inside a delegated agent ends
	// here, before its first prompt (see nesting.ts). Checked once per instance.
	let nestedReason: string | undefined | null = null;
	function refuseNested(ctx: ExtensionContext): boolean {
		if (nestedReason !== null) return Boolean(nestedReason);
		nestedReason = nested();
		if (!nestedReason) return false;
		if (ctx.mode === "tui") {
			// Graceful, so the terminal is restored; input is swallowed meanwhile.
			ctx.ui.notify(nestedReason, "error");
			ctx.shutdown();
		} else {
			process.stderr.write(`${nestedReason}\n`);
			process.exit(1);
		}
		return true;
	}
	pi.on("input", () => (nestedReason ? { action: "handled" as const } : undefined));
	// Extensions whose session_start writes shared state ask first; load order is not fixed.
	pi.events.on("subagents:nested-session-check", (request: { ctx: ExtensionContext; reply: (refused: boolean) => void }) => {
		request.reply(refuseNested(request.ctx));
	});

	// Children never delegate further: no tools, no commands, no delivery loop.
	if (process.env.PI_SUBAGENT) {
		pi.on("session_start", (_event, ctx) => { refuseNested(ctx); });
		pi.on("before_agent_start", (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n# Subagent\nYou are a delegated subagent working for a coordinating pi session. Work autonomously on the task you were given and finish each turn with a concise report of what you did, the evidence, and anything left open. You cannot start further subagents. Questions you end a turn with are relayed to the coordinator.`,
		}));
		return;
	}

	// Runtime-only: never restored from settings or session history.
	const grants = new Set<GrantedBackend>();
	let grantGeneration = 0;
	let sessionId: string | undefined;
	let sessionFile: string | undefined;
	let currentCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let hpcGrants: InheritedHpcGrant[] = [];

	function myRuns() {
		return listRuns().filter((run) => run.spec.parentSessionId === sessionId);
	}

	function queryHpcGrants(): InheritedHpcGrant[] {
		let result: InheritedHpcGrant[] = [];
		pi.events.emit("hpc-mode:grants-query", { reply: (value: InheritedHpcGrant[]) => { result = value; } });
		return result;
	}

	// Pi children follow the parent's HPC authorization live.
	function syncHpcGrants(next = queryHpcGrants()): void {
		hpcGrants = next;
		for (const run of myRuns()) if (run.spec.backend === "pi") writeHpcGrants(run.dir, hpcGrants);
	}

	function revokeChildHpcGrants(): void {
		for (const run of myRuns()) if (run.spec.backend === "pi") writeHpcGrants(run.dir, []);
	}

	pi.events.on("hpc-mode:grants-changed", (value: InheritedHpcGrant[]) => {
		if (sessionId) syncHpcGrants(Array.isArray(value) ? value : []);
	});

	// Registered waits (subagent action=wait); persisted per session.
	let watches: Watch[] = [];
	let shownWidget = "";

	function setWatches(next: Watch[]): void {
		watches = next;
		if (sessionId) writeWatches(sessionId, watches);
	}

	function widgetLines(): string[] {
		const watched = new Set(watches.flatMap((w) => w.ids));
		const runs = listRuns().filter((r) => watched.has(r.spec.id)
			|| (r.spec.parentSessionId === sessionId && ["starting", "running", "waiting"].includes(r.state.status)));
		if (!runs.length) return [];
		const now = Date.now();
		const rows = runs.slice(0, WIDGET_MAX_ROWS).map(({ dir, spec, state }) => {
			let activity: string | undefined;
			if (state.approval) activity = `needs permission ${state.approval.requestId}: ${state.approval.summary}`;
			else if (state.status === "failed") activity = state.error;
			else if (state.status === "starting" || state.status === "running") {
				const last = lastTranscriptEntry(dir);
				activity = last && `${last.role}${last.tool ? `(${last.tool})` : ""}: ${last.text}`;
			} else activity = state.lastText;
			const age = duration(now - (Date.parse(state.updatedAt) || now));
			return oneLine(`${STATUS_ICON[state.status] ?? "·"} ${spec.id} ${spec.name} · ${state.status} ${age}${activity ? ` · ${activity}` : ""}`, WIDGET_ROW_WIDTH);
		});
		if (runs.length > WIDGET_MAX_ROWS) rows.push(`… ${runs.length - WIDGET_MAX_ROWS} more (/agents)`);
		for (const watch of watches) {
			const n = watch.ids.length;
			const when = n === 1 ? `${watch.ids[0]} reports` : watch.mode === "any" ? `the first of ${n} reports` : n === 2 ? "both report" : `all ${n} report`;
			rows.push(`watching: the agent resumes when ${when} · expires in ${duration(Date.parse(watch.expiresAt) - now)} · you can keep chatting`);
		}
		return rows;
	}

	// Footer: grants. Widget below the editor: live children and watches.
	function updateStatus(ctx = currentCtx): void {
		if (!ctx?.hasUI) return;
		const grantText = [...grants].map((g) => GRANT_COMMAND[g]).join(", ");
		ctx.ui.setStatus("subagents", grantText ? `allowed: ${grantText}` : undefined);
		const lines = widgetLines();
		const next = lines.join("\n");
		if (next === shownWidget) return;
		shownWidget = next;
		ctx.ui.setWidget?.("subagents", lines.length ? lines : undefined, { placement: "belowEditor" });
	}

	// Report files handed to pi but not yet seen in the conversation. They are
	// marked delivered on message_start, so a crash in between re-sends them.
	type Queued = { dir: string; file: string; approval: boolean };
	const inFlight = new Map<string, Queued[]>();
	// Runs a blocking subagent wait call (no UI) is collecting; their reports go to the tool result.
	const awaited = new Set<string>();

	function formatReports(run: { dir: string; spec: RunSpec }, reports: Report[]): string {
		const state = readState(run.dir);
		const parts = reports.map((report) => {
			const head = `[${report.kind}] ${report.status}${report.error ? ` (${report.error})` : ""}`;
			return report.text ? `${head}\n${report.text}` : head;
		});
		const hint = state?.approval
			? `\nAnswer with subagent action=reply id=${run.spec.id} request_id=${state.approval.requestId} allow=true|false. Allow only single actions within the user's request; deny anything destructive, credential-related or outside the task.`
			: "";
		return `Subagent ${run.spec.name} (${run.spec.id}, ${BACKEND_LABEL[run.spec.backend]}) is ${state?.status ?? "unknown"}.\n\n${clip(parts.join("\n\n"), REPORT_TEXT_LIMIT)}${hint}`;
	}

	function markShown(key: string): void {
		const entries = inFlight.get(key);
		if (!entries) return;
		inFlight.delete(key);
		for (const { dir, file } of entries) if (existsSync(join(dir, "reports", file))) markDelivered(dir, file);
	}

	function queuedFor(dir: string): Queued[] {
		return [...inFlight.values()].flat().filter((entry) => entry.dir === dir);
	}

	function unsentReports(dir: string) {
		const queued = new Set(queuedFor(dir).map((entry) => entry.file));
		return pendingReports(dir).filter(({ file }) => !queued.has(file));
	}

	type Run = { dir: string; spec: RunSpec };

	// A watched child is done when it has a turn or exit report, or cannot
	// produce one. A child waiting on a permission is not: its request goes out
	// at once and the watch continues.
	function inspect(run: Run) {
		const state = readState(run.dir);
		const pending = unsentReports(run.dir);
		const news = pending.some(({ report }) => report.kind !== "approval");
		const queued = queuedFor(run.dir).some((entry) => !entry.approval);
		const busy = Boolean(state && ["starting", "running", "waiting"].includes(state.status) && liveWorker(state));
		const settled = !busy && !pending.length && !hasPendingInbox(run.dir);
		return { run, state, pending, news, queued, settled, done: news || queued || settled };
	}
	type View = ReturnType<typeof inspect>;

	function satisfied(views: View[], mode: "all" | "any"): boolean {
		const done = views.filter((view) => view.done).length;
		return mode === "any" ? done > 0 : done === views.length;
	}

	function section({ run, state, pending, news, queued, settled }: View): string {
		const who = `Subagent ${run.spec.name} (${run.spec.id})`;
		const sentNote = queued ? `${who}: a report was already queued as a message; it arrives shortly (queued messages are released one per step).` : "";
		if (news) return [formatReports(run, pending.map((p) => p.report)), sentNote].filter(Boolean).join("\n\n");
		if (sentNote) return sentNote;
		if (settled) return `${who} is ${state?.status} with no new report since the last one you received.${state?.lastText ? `\nLast result:\n${clip(state.lastText, 2000)}` : ""}`;
		const approval = state?.approval ? ` It is waiting on permission request ${state.approval.requestId}; answer with subagent action=reply.` : "";
		return `${who} is still ${state?.status}; its report will arrive automatically.${approval}`;
	}

	function consumed(views: View[]): Queued[] {
		return views.filter((view) => view.news).flatMap(({ run, pending }) => pending.map(({ file, report }) => ({ dir: run.dir, file, approval: report.kind === "approval" })));
	}

	function watchedRuns(watch: Watch): Run[] {
		return watch.ids.flatMap((id) => {
			try {
				return [resolveRun(id)];
			} catch {
				return [];
			}
		});
	}

	// A watch result must not cut into a turn the user started: it follows the
	// current turn when the coordinator is busy and starts one when it is idle.
	function fireWatches(): void {
		for (const watch of [...watches]) {
			const views = watchedRuns(watch).map(inspect);
			const expired = Date.now() >= Date.parse(watch.expiresAt);
			const complete = satisfied(views, watch.mode);
			if (views.length && !expired && !complete) continue;
			setWatches(watches.filter((w) => w !== watch));
			if (!views.length) continue;
			const key = `watch:${watch.id}`;
			const files = consumed(views);
			if (files.length) inFlight.set(key, files);
			const head = !complete
				? `Subagent watch expired after ${duration(Date.parse(watch.expiresAt) - Date.parse(watch.createdAt))}; the children below that are still working report automatically when they finish.`
				: watch.mode === "all" ? "Subagent watch finished: all watched children reported." : "Subagent watch finished: a watched child reported.";
			const idle = currentCtx?.isIdle?.() ?? true;
			pi.sendMessage({
				customType: "subagent-report",
				content: `${head}\n\n${views.map(section).join("\n\n---\n\n")}\n\nRead files and diffs before relying on these reports.`,
				display: true,
				details: { ids: views.map((v) => v.run.spec.id), watch: watch.id, expired: !complete, key },
			}, idle ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" });
		}
	}

	function deliverReports(): void {
		if (!sessionId) return;
		fireWatches();
		const held = new Set(watches.flatMap((w) => w.ids));
		for (const run of myRuns()) {
			if (awaited.has(run.spec.id)) continue;
			// Watched children: turn reports are held for the watch, permission requests are not.
			const pending = unsentReports(run.dir).filter(({ report }) => !held.has(run.spec.id) || report.kind === "approval");
			if (!pending.length) continue;
			const key = `${run.spec.id}:${pending.map((p) => p.file).join(",")}`;
			inFlight.set(key, pending.map(({ file, report }) => ({ dir: run.dir, file, approval: report.kind === "approval" })));
			// steer: a busy coordinator sees it between tool calls; an idle one wakes up.
			pi.sendMessage({
				customType: "subagent-report",
				content: `${formatReports(run, pending.map((p) => p.report))}\n\nRead files and diffs before relying on this report.`,
				display: true,
				details: { id: run.spec.id, status: readState(run.dir)?.status, key },
			}, { triggerTurn: true, deliverAs: "steer" });
		}
		updateStatus();
	}

	// The normal wait: nothing blocks, so the user can keep talking to the
	// coordinator. Reports that are already there come back in the tool result.
	function registerWatch(ids: string[], mode: "all" | "any", timeoutSeconds: number): string {
		const views = ids.map((id) => resolveRun(id)).map(inspect);
		const overlapping = watches.filter((w) => w.ids.some((id) => ids.includes(id)));
		if (overlapping.length) setWatches(watches.filter((w) => !overlapping.includes(w)));
		if (satisfied(views, mode)) {
			for (const { dir, file } of consumed(views)) markDelivered(dir, file);
			updateStatus();
			return `${views.map(section).join("\n\n---\n\n")}\n\nNothing left to wait for, so no watch was registered. Read files and diffs before relying on these reports.`;
		}
		const now = Date.now();
		setWatches([...watches, { id: newRunId(), ids, mode, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + timeoutSeconds * 1000).toISOString() }]);
		updateStatus();
		const names = views.map(({ run }) => `${run.spec.name} (${run.spec.id})`).join(", ");
		const asking = views.filter((v) => v.state?.approval).map((v) => `\n${v.run.spec.name} (${v.run.spec.id}) is waiting on permission request ${v.state!.approval!.requestId}; answer it with subagent action=reply.`).join("");
		return `Watch registered for ${names}${overlapping.length ? " (replacing the earlier watch)" : ""}. The conversation resumes with ${mode === "all" && ids.length > 1 ? "one combined message once all of them have reported" : "a message as soon as one reports"}, or after ${duration(timeoutSeconds * 1000)} at the latest. Permission requests are delivered at once. Do not poll, sleep or call wait again: end your turn now, or continue with independent work. The user can keep talking to you meanwhile.${asking}`;
	}

	function hasPendingInbox(dir: string): boolean {
		try {
			return readdirSync(join(dir, "inbox")).some((f) => f.endsWith(".json"));
		} catch {
			return false;
		}
	}

	// Without a UI (print or JSON mode) nothing can resume the conversation after
	// the turn ends, so the wait blocks and returns the reports itself.
	async function waitForReports(ids: string[], mode: "all" | "any", timeoutSeconds: number, signal: AbortSignal | undefined): Promise<string> {
		const runs = ids.map((id) => resolveRun(id));
		for (const run of runs) awaited.add(run.spec.id);
		const collected = new Map<string, Report[]>();
		const settledWithoutNews = new Set<string>();
		const alreadySent = new Set<string>();
		const deadline = Date.now() + timeoutSeconds * 1000;
		try {
			for (;;) {
				for (const run of runs) {
					// Reports already handed to pi cannot be recalled; they arrive as a
					// message, so the wait only points at them instead of duplicating them.
					const queued = new Set(queuedFor(run.dir).map((entry) => entry.file));
					if (queued.size) alreadySent.add(run.spec.id);
					const pending = pendingReports(run.dir).filter(({ file }) => !queued.has(file));
					if (pending.length) {
						collected.set(run.spec.id, [...(collected.get(run.spec.id) ?? []), ...pending.map((p) => p.report)]);
						for (const { file } of pending) markDelivered(run.dir, file);
					}
					const state = readState(run.dir);
					const busy = state && ["starting", "running"].includes(state.status) && liveWorker(state);
					if (!collected.has(run.spec.id) && !alreadySent.has(run.spec.id) && !busy && !hasPendingInbox(run.dir)) settledWithoutNews.add(run.spec.id);
				}
				const done = runs.filter((r) => collected.has(r.spec.id) || alreadySent.has(r.spec.id) || settledWithoutNews.has(r.spec.id)).length;
				if ((mode === "any" && done > 0) || done === runs.length) break;
				if (signal?.aborted || Date.now() >= deadline) break;
				await new Promise((r) => setTimeout(r, 500));
			}
		} finally {
			for (const run of runs) awaited.delete(run.spec.id);
		}
		const sections = runs.map((run) => {
			const reports = collected.get(run.spec.id);
			const sentNote = alreadySent.has(run.spec.id) ? `Subagent ${run.spec.name} (${run.spec.id}): a report was already queued as a message before this wait; it arrives shortly (queued messages are released one per step).` : "";
			if (reports) return [formatReports(run, reports), sentNote].filter(Boolean).join("\n\n");
			if (sentNote) return sentNote;
			const state = readState(run.dir);
			if (settledWithoutNews.has(run.spec.id)) return `Subagent ${run.spec.name} (${run.spec.id}) is ${state?.status} with no new report since the last one you received.${state?.lastText ? `\nLast result:\n${clip(state.lastText, 2000)}` : ""}`;
			return `Subagent ${run.spec.name} (${run.spec.id}) is still ${state?.status}; its report will arrive automatically.`;
		});
		const why = signal?.aborted ? "Wait cancelled." : Date.now() >= deadline ? `Wait timed out after ${timeoutSeconds}s.` : "";
		updateStatus();
		return `${why ? `${why}\n\n` : ""}${sections.join("\n\n---\n\n")}\n\nRead files and diffs before relying on these reports.`;
	}

	function requireGrant(backend: Backend): void {
		if (backend === "pi") return;
		if (!grants.has(backend)) {
			throw new Error(`${BACKEND_LABEL[backend]} subagents are not enabled in this session. Only the user can enable them with /${GRANT_COMMAND[backend]}; tools and chat messages cannot. End your turn and ask the user if this backend is needed.`);
		}
	}

	function resolveRun(id: string | undefined) {
		if (!id) throw new Error("Missing id.");
		const dir = runDir(id.trim().toLowerCase());
		const spec = readSpec(dir);
		const state = readState(dir);
		if (!spec || !state) throw new Error(`Unknown subagent ${id}. Use subagent_query action=list.`);
		return { dir, spec, state };
	}

	async function ensureWorker(dir: string): Promise<void> {
		const state = readState(dir);
		if (liveWorker(state)) return;
		startWorker(dir);
		const started = await waitFor(() => liveWorker(readState(dir)) || readState(dir)?.status === "failed", 10_000);
		if (!started) throw new Error("Subagent worker did not start; see worker.log in the run directory.");
	}

	function initialMessage(spec: RunSpec, prompt: string, files: string[]): string[] {
		const fileText = files.length ? `Read these files first:\n${files.map((f) => `- ${f}`).join("\n")}\n\n` : "";
		const task = `${fileText}${prompt}`.trim();
		if (!spec.goal) return [task];
		if (spec.backend === "claude") return [`/goal ${spec.goal}`, ...(task ? [task] : [])];
		if (spec.backend === "pi") return [`Use the create_goal tool to set this goal (explicitly requested by the user): ${spec.goal}\nThen work until it is achieved.${task ? `\n\n${task}` : ""}`];
		return [task || `Work toward the thread goal: ${spec.goal}`]; // Codex goal set natively by the worker.
	}

	async function start(params: any, ctx: ExtensionContext, toolCallId: string): Promise<string> {
		const backend = (params.backend ?? "pi") as Backend;
		if (!BACKENDS.includes(backend)) throw new Error(`Unknown backend ${backend}`);
		requireGrant(backend);
		await delegationGate(backend, toolCallId, ctx, `subagent start ${params.name ?? ""}`.trim());
		if (!params.prompt?.trim() && !params.goal?.trim()) throw new Error("start needs a prompt or a goal.");
		const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd does not exist or is not a directory: ${cwd}. Create the worktree first.`);
		const mode = validateMode(backend, params.mode);
		const communication = (params.communication ?? "none") as CommMode;
		if (!COMM_MODES.includes(communication)) throw new Error(`Unknown communication mode ${communication}. Use none, supervisor or peers.`);
		if (communication !== "none" && backend !== "pi") throw new Error("communication is available for pi children only.");
		const files = (params.files ?? []).map((f: string) => (isAbsolute(f) ? f : resolve(ctx.cwd, f)));
		let model = params.model;
		let effort = params.effort;
		if (backend === "pi" && !model && ctx.model) {
			model = `${ctx.model.provider}/${ctx.model.id}`;
			effort ??= pi.getThinkingLevel();
		}
		const id = newRunId();
		const spec: RunSpec = {
			id,
			name: (params.name ?? "").trim() || `${backend}-${id}`,
			backend,
			cwd,
			model,
			effort,
			mode,
			goal: params.goal?.trim() || undefined,
			parentSessionId: sessionId!,
			parentSessionFile: sessionFile,
			createdAt: new Date().toISOString(),
			bin: process.env[`PI_SUBAGENTS_BIN_${backend.toUpperCase()}`] || undefined,
			...(communication !== "none" ? { communication } : {}),
		};
		if (communication !== "none") {
			// Trusted registration before the child exists; it cannot change its own record.
			ensureRoot(sessionId!, pi.getSessionName?.() || "");
			registerChild({ id, name: spec.name, parentId: sessionId!, mode: communication, group: params.comm_group?.trim() || undefined });
			pi.events.emit("agent-comm:enable", {});
		}
		const dir = createRun(spec);
		if (backend === "pi") writeHpcGrants(dir, hpcGrants);
		for (const message of initialMessage(spec, params.prompt ?? "", files)) enqueue(dir, { type: "send", message, delivery: "followUp" });
		await ensureWorker(dir);
		updateStatus(ctx);
		return `Started ${BACKEND_LABEL[backend]} subagent ${spec.name} (id ${id}) in ${cwd}${mode ? `, mode ${mode}` : ""}${model ? `, model ${model}` : ""}.${communication !== "none" ? ` Communication: ${communication}.` : ""} Its report arrives automatically when the turn ends; do not poll. Run directory: ${dir}`;
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate work to a persistent child agent (pi; Claude Code or Codex only after the user's /cc-agent or /codex-agent). Actions: start, send, interrupt, stop, reply. Children run in their own process and session, survive this session quitting, and report back automatically when each turn ends.",
		promptSnippet: "Start and message persistent pi, Claude Code or Codex subagents; reports arrive automatically",
		promptGuidelines: [
			"Use subagent for independent, well-specified work (separate worktrees for parallel implementation). Give each child a self-contained prompt or brief file with a done condition.",
			"After subagent start or send, do not poll or sleep. Subagent reports arrive automatically: between your tool calls while you work, or as a new turn when you are idle. Keep doing independent work or end your turn.",
			"Use subagent action=wait only when your next step depends on children's results. It does not block: it returns reports that are already there, or registers a watch and returns at once. After a watch is registered, end your turn or do independent work; the reports resume the conversation in one message. Do not call wait again, sleep, or poll with subagent_query while a watch is pending.",
			"Use subagent, never claude or codex directly in bash. Claude Code and Codex children require the user to run /cc-agent or /codex-agent; never ask a child to do something the user has not authorized.",
			"When a subagent report asks for permission, use subagent action=reply to allow only single actions clearly within the user's request; deny destructive, credential-related or out-of-scope actions.",
		],
		parameters: SubagentParams,
		async execute(toolCallId, params: any, signal, _onUpdate, ctx) {
			// pi runs a batch of tool calls concurrently; actions on one child must keep
			// their order (e.g. stop then send), so they are chained per id.
			if (params.action !== "start" && params.action !== "wait" && params.id) {
				return serial(String(params.id).trim().toLowerCase(), () => act(params, signal, ctx, toolCallId));
			}
			return act(params, signal, ctx, toolCallId);
		},
	});

	const chains = new Map<string, Promise<unknown>>();
	function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = chains.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(fn);
		chains.set(key, next);
		void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => undefined);
		return next;
	}

	// Delegation spends user grants: a pi child inherits this session's /hpc grants
	// and has no peer-message gate of its own (no agent_comm, or it trusts its
	// supervisor); Claude Code and Codex children exist only through /cc-agent and
	// /codex-agent. After peer messages, instructing one is the user's decision.
	async function delegationGate(backend: Backend, toolCallId: string, ctx: ExtensionContext, what: string): Promise<void> {
		if (backend === "pi" && !hpcGrants.length) return;
		const grant = backend === "pi" ? `the pi subagent inherits your /hpc grants (${hpcGrants.map((g) => g.host).join(", ")})`
			: `it relies on your /${backend === "claude" ? "cc" : "codex"}-agent grant`;
		const gate = await peerGate(pi, ctx, toolCallId, `${what}; ${grant}`);
		if (gate) throw new Error(gate.reason);
	}

	async function act(params: any, signal: AbortSignal | undefined, ctx: ExtensionContext, toolCallId: string) {
		{
			if (params.action === "start") return text(await start(params, ctx, toolCallId));
			if (params.action === "wait") {
				const ids = [...(params.ids ?? []), ...(params.id ? [params.id] : [])].map((i: string) => i.trim().toLowerCase());
				if (!ids.length) throw new Error("wait needs id or ids.");
				const unique = [...new Set<string>(ids)];
				const mode = params.wait_for === "any" ? "any" : "all";
				if (!ctx.hasUI) return text(await waitForReports(unique, mode, Math.max(1, Math.min(3600, params.timeout_seconds ?? 600)), signal));
				return text(registerWatch(unique, mode, Math.max(1, Math.min(WATCH_MAX_SECONDS, params.timeout_seconds ?? WATCH_DEFAULT_SECONDS))));
			}
			const run = resolveRun(params.id);
			if (params.action === "stop") {
				if (!liveWorker(run.state)) {
					updateState(run.dir, { status: "stopped", workerPid: undefined, childPid: undefined });
					return text(`Subagent ${run.spec.id} was not running; marked stopped. Its session is kept.`);
				}
				enqueue(run.dir, { type: "stop" });
				await waitFor(() => readState(run.dir)?.status === "stopped", 20_000);
				updateStatus(ctx);
				return text(`Stop requested for ${run.spec.id}; status: ${readState(run.dir)?.status}. The native session is kept; send relaunches it.`);
			}
			requireGrant(run.spec.backend);
			if (run.spec.parentSessionId !== sessionId) {
				// Adopt: reports follow the session that is now coordinating this child.
				const spec = { ...run.spec, parentSessionId: sessionId!, parentSessionFile: sessionFile };
				writeFileSync(join(run.dir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
			}
			if (params.action === "send") {
				if (!params.prompt?.trim()) throw new Error("send needs prompt (the message).");
				await delegationGate(run.spec.backend, toolCallId, ctx, `subagent send to ${run.spec.name}`);
				enqueue(run.dir, { type: "send", message: params.prompt, delivery: params.delivery ?? "auto" });
				const relaunched = !liveWorker(readState(run.dir));
				await ensureWorker(run.dir);
				// A relaunch resumes the native session first; wait briefly so the status is real.
				await waitFor(() => readState(run.dir)?.status !== "starting", relaunched ? 20_000 : 2_000);
				const status = readState(run.dir)?.status;
				const how = relaunched ? (status === "failed" ? "relaunch failed" : status === "starting" ? "relaunching, resuming its session" : "relaunched with its session") : status;
				return text(`Message queued for ${run.spec.id} (${how}). The report arrives automatically; register a watch with action=wait only if your next step depends on it.`);
			}
			if (!liveWorker(run.state)) throw new Error(`Subagent ${run.spec.id} is not running (${run.state.status}).`);
			if (params.action === "interrupt") {
				enqueue(run.dir, { type: "interrupt" });
				return text(`Interrupt requested for ${run.spec.id}.`);
			}
			if (params.action === "reply") {
				if (!params.request_id || typeof params.allow !== "boolean") throw new Error("reply needs request_id and allow.");
				if (run.state.approval?.requestId !== params.request_id) throw new Error(`No pending request ${params.request_id} on ${run.spec.id}.`);
				if (params.allow) await delegationGate(run.spec.backend, toolCallId, ctx, `subagent reply allowing ${params.request_id} for ${run.spec.name}`);
				enqueue(run.dir, { type: "reply", requestId: params.request_id, allow: params.allow, reason: params.reason });
				return text(`${params.allow ? "Allowed" : "Denied"} ${params.request_id} once.`);
			}
			throw new Error(`Unknown action ${params.action}`);
		}
	}

	async function exportRun(id: string, output?: string, cwd?: string): Promise<string> {
		const run = resolveRun(id);
		const target = output ? resolve(cwd ?? process.cwd(), output) : join(run.dir, `${run.spec.name.replace(/[^A-Za-z0-9._-]+/g, "-")}-${run.spec.id}.html`);
		mkdirSync(dirname(target), { recursive: true });
		const nativeFile = run.state.nativeTranscript;
		if (run.spec.backend === "pi" && nativeFile && existsSync(nativeFile)) {
			await new Promise<void>((done, fail) => execFile(run.spec.bin || "pi", ["--export", nativeFile, target], (error) => (error ? fail(error) : done())));
		} else {
			writeFileSync(target, renderHtml(run.spec, run.state, readTranscript(run.dir), allReports(run.dir), { events: join(run.dir, "events.jsonl"), native: nativeFile }));
		}
		return target;
	}

	pi.registerTool({
		name: "subagent_query",
		label: "Subagent query",
		description: "Read-only view of subagents: list, get (state and last result), transcript (recent entries), export (HTML). Never starts processes.",
		parameters: QueryParams,
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const runs = params.all ? listRuns() : myRuns();
				return text(runs.length ? runs.map((r) => describe(r.spec, r.state)).join("\n") : "No subagents for this session. Use all=true to include other sessions.");
			}
			const run = resolveRun(params.id);
			if (params.action === "get") {
				const state = run.state;
				return text([
					describe(run.spec, state),
					state.error && `error: ${state.error}`,
					state.approval && `pending permission ${state.approval.requestId}: ${state.approval.summary}`,
					`turns: ${state.turns}`,
					`native session: ${state.nativeSessionId ?? "unknown"}`,
					`run directory: ${run.dir}`,
					state.lastText && `last result:\n${state.lastText}`,
				].filter(Boolean).join("\n"));
			}
			if (params.action === "transcript") {
				const entries = readTranscript(run.dir).slice(-Math.max(1, Math.min(200, params.tail ?? 20)));
				return text(clip(entries.map((e) => `[${e.at}] ${e.role}${e.tool ? `(${e.tool})` : ""}: ${e.text}`).join("\n\n") || "No transcript yet.", 30_000));
			}
			if (params.action === "export") return text(`Exported to ${await exportRun(run.spec.id, undefined, ctx.cwd)}`);
			throw new Error(`Unknown action ${params.action}`);
		},
	});

	for (const backend of GRANTED_BACKENDS) {
		const command = GRANT_COMMAND[backend];
		pi.registerCommand(command, {
			description: `Allow ${BACKEND_LABEL[backend]} subagents for this session; off revokes, status reports`,
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase();
				if (action === "off") {
					grantGeneration += 1;
					grants.delete(backend);
					updateStatus(ctx);
					ctx.ui.notify(`${BACKEND_LABEL[backend]} subagents disabled. Running children continue; they cannot be messaged until re-enabled.`, "info");
					return;
				}
				if (action === "status") {
					ctx.ui.notify(`${BACKEND_LABEL[backend]} subagents: ${grants.has(backend) ? "ON" : "OFF"}.`, "info");
					return;
				}
				if (action !== "" && action !== "on") {
					ctx.ui.notify(`Usage: /${command} [on|off|status]`, "info");
					return;
				}
				if (!ctx.hasUI) return; // Fail closed without confirmation UI.
				if (grants.has(backend)) {
					ctx.ui.notify(`${BACKEND_LABEL[backend]} subagents already enabled. Use /${command} off to revoke.`, "info");
					return;
				}
				const generation = grantGeneration;
				const detail = backend === "claude"
					? "Children run Claude Code in its own permission system (default --permission-mode auto; bypassPermissions is never used) with deny rules for file removal, SSH and nested claude/codex."
					: "Children run Codex with the workspace-write sandbox (default) and on-request approvals routed to its auto reviewer; danger-full-access is never used.";
				const ok = await ctx.ui.confirm(`Enable ${BACKEND_LABEL[backend]} subagents?`,
					`The agent may start and message ${BACKEND_LABEL[backend]} children without per-run confirmation. ${detail} The pi safety guard and HPC grants do not apply inside these children. Permission prompts the child still raises are relayed to the coordinating agent, which may allow single in-scope actions. Use /${command} off to revoke; reload and session replacement reset it.`);
				if (!ok || generation !== grantGeneration) return;
				grants.add(backend);
				updateStatus(ctx);
				ctx.ui.notify(`${BACKEND_LABEL[backend]} subagents enabled for this session.`, "info");
			},
		});
	}

	pi.registerCommand("agents", {
		description: "List, inspect, export or stop subagents: /agents [list|show <id>|export <id> [file]|stop <id>|all]",
		getArgumentCompletions: (prefix: string) => {
			const words = prefix.trimStart().split(/\s+/);
			if (words.length <= 1) return ["list", "show", "export", "stop", "all"].filter((o) => o.startsWith(words[0] ?? "")).map((value) => ({ value, label: value }));
			return listRuns().map((r) => r.spec.id).filter((id) => id.startsWith(words[1] ?? "")).map((id) => ({ value: `${words[0]} ${id}`, label: id }));
		},
		handler: async (args, ctx) => {
			const [action = "list", id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (action === "list" || action === "all") {
					const runs = action === "all" ? listRuns() : myRuns();
					if (!runs.length) return ctx.ui.notify(action === "all" ? "No subagents." : "No subagents for this session. /agents all lists every session's.", "info");
					if (!ctx.hasUI) return;
					const choice = await ctx.ui.select("Subagents", runs.map((r) => describe(r.spec, r.state).split("\n")[0]));
					if (!choice) return;
					return showRun(choice.split(" ")[0], ctx);
				}
				if (action === "show") return showRun(id, ctx);
				if (action === "export") return ctx.ui.notify(`Exported to ${await exportRun(id, rest.join(" ") || undefined, ctx.cwd)}`, "info");
				if (action === "stop") {
					const run = resolveRun(id);
					if (liveWorker(run.state)) enqueue(run.dir, { type: "stop" });
					else updateState(run.dir, { status: "stopped", workerPid: undefined, childPid: undefined });
					return ctx.ui.notify(`Stop requested for ${run.spec.id}.`, "info");
				}
				ctx.ui.notify("Usage: /agents [list|all|show <id>|export <id> [file]|stop <id>]", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	function showRun(id: string | undefined, ctx: ExtensionContext): void {
		const run = resolveRun(id);
		const tail = readTranscript(run.dir).slice(-12).map((e) => `${e.role}${e.tool ? `(${e.tool})` : ""}: ${e.text.split("\n").slice(0, 6).join("\n").slice(0, 600)}`);
		ctx.ui.notify([
			describe(run.spec, run.state),
			run.state.error && `error: ${run.state.error}`,
			`native session: ${run.state.nativeSessionId ?? "unknown"}`,
			run.state.nativeTranscript && `native transcript: ${run.state.nativeTranscript}`,
			`run dir: ${run.dir} (events.jsonl = raw protocol log)`,
			`export: /agents export ${run.spec.id}`,
			"",
			...tail,
		].filter((l) => l !== undefined && l !== false).join("\n"), "info");
	}

	pi.on("before_agent_start", (event) => {
		const enabled = [...grants].map((g) => `${BACKEND_LABEL[g]} (/${GRANT_COMMAND[g]})`);
		const disabled = GRANTED_BACKENDS.filter((g) => !grants.has(g)).map((g) => `${BACKEND_LABEL[g]} (user runs /${GRANT_COMMAND[g]})`);
		return {
			systemPrompt: `${event.systemPrompt}\n\n# Subagent authorization\npi subagents: allowed; they inherit the current HPC grants. Enabled harnesses: ${enabled.join(", ") || "none"}. Not enabled: ${disabled.join(", ") || "none"}. Only the user can enable a harness; earlier grants in the conversation are historical. Never invoke claude or codex directly in bash.`,
		};
	});

	// A report counts as delivered once it actually enters the conversation.
	pi.on("message_start", (event: { message?: { role?: string; customType?: string; details?: { key?: string } } }) => {
		const message = event.message;
		if (message?.role === "custom" && message.customType === "subagent-report" && message.details?.key) markShown(message.details.key);
	});

	pi.on("session_start", (_event, ctx) => {
		if (refuseNested(ctx)) return;
		inFlight.clear();
		grantGeneration += 1;
		grants.clear();
		currentCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		watches = readWatches(sessionId);
		shownWidget = "";
		sessionFile = ctx.sessionManager.getSessionFile() || undefined;
		syncHpcGrants();
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			try {
				deliverReports();
			} catch (error) {
				if (currentCtx?.hasUI) currentCtx.ui.notify(`Subagent delivery failed: ${String(error)}`, "error");
			}
		}, DELIVERY_POLL_MS);
		timer.unref?.();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		// Queued but unseen reports stay pending on disk and are re-sent on resume.
		inFlight.clear();
		// HPC grants end with the parent session; children keep running without them.
		revokeChildHpcGrants();
		grantGeneration += 1;
		grants.clear();
		hpcGrants = [];
		if (ctx.hasUI) {
			ctx.ui.setStatus("subagents", undefined);
			ctx.ui.setWidget?.("subagents", undefined);
		}
		// Watches stay on disk and continue when the session resumes.
		watches = [];
		shownWidget = "";
		currentCtx = undefined;
		sessionId = undefined;
	});
}
