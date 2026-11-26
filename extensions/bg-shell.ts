// Background shell processes the agent can start (or attach to), keep working
// beside, and be woken by when they exit. Output streams straight to a log file,
// so long test suites cost no tokens until the agent looks. The command runs in
// a subshell that records its exit status in a file, so a watcher re-attached
// after /reload or a resumed session still learns the real exit code.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getShellConfig, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_TYPE = "bg-shell-state";
const MESSAGE_TYPE = "bg-shell";
const STATUS_KEY = "bg-shell";
const MAX_ACTIVE = 4;
const MAX_KEPT = 20;
const DEFAULT_CHECK_MINUTES = 60;
const MAX_CHECK_MINUTES = 24 * 60;
const NOTIFY_TAIL_LINES = 40;
const MAX_TAIL_LINES = 400;
const MAX_LINE_CHARS = 400;
const TAIL_READ_BYTES = 256 * 1024;
const KILL_GRACE_MS = 3000;
const POLL_MS = 2000;
// A gap between polls longer than this means the machine slept (lid closed): that time does not count towards check-ins.
const MAX_AWAKE_TICK_MS = 30_000;
const MIN_POLLING_SLEEP_SECONDS = 15;

type Status = "running" | "exited" | "ended" | "stopped" | "lost";

/** Persisted per process; plain data only. */
export interface BgRecord {
	id: string;
	kind: "started" | "attached";
	label: string;
	command?: string;
	cwd?: string;
	pid: number;
	logPath?: string;
	exitPath?: string;
	startedAt: number;
	/** Awake time (machine sleep not counted) at which the agent gets a check-in; the process is never killed for time. */
	checkAtMs?: number;
	awakeMs?: number;
	/** Log size at the previous check-in, to report growth. */
	checkLogBytes?: number;
	keep: boolean;
	status: Status;
	endedAt?: number;
	exitCode?: number;
	notified: boolean;
	stopReason?: "stop";
}

const BgShellParams = Type.Object({
	action: StringEnum(["start", "watch", "list", "output", "extend", "stop"] as const, {
		description: "start a command; watch an already running pid; list; output shows a log tail; extend schedules the next check-in; stop kills a process",
	}),
	command: Type.Optional(Type.String({ description: "start: shell command, e.g. cargo test --release" })),
	label: Type.Optional(Type.String({ description: "start/watch: short name for the footer and notifications" })),
	cwd: Type.Optional(Type.String({ description: "start: working directory (default: session cwd)" })),
	check_after_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_CHECK_MINUTES, description: `start/watch/extend: wake you for a check-in after this many awake minutes, without killing the process (start default ${DEFAULT_CHECK_MINUTES}; watch default none)` })),
	keep: Type.Optional(Type.Boolean({ description: "start: keep running if the session is quit or replaced (it always survives /reload); re-attached when the session is resumed. Default false" })),
	pid: Type.Optional(Type.Number({ description: "watch: pid of an existing local process (e.g. one started with nohup)" })),
	log_path: Type.Optional(Type.String({ description: "watch: log file that process writes, to include its tail in the notification" })),
	id: Type.Optional(Type.String({ description: "output/extend/stop: process id such as bg1" })),
	tail: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_TAIL_LINES, description: `output: number of trailing lines (default ${NOTIFY_TAIL_LINES})` })),
});

export function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

/** Last `lines` lines of a log: ANSI removed, progress-bar carriage returns collapsed, long lines cut. */
export function readTail(path: string | undefined, lines: number): string {
	if (!path) return "";
	let bytes: number;
	try { bytes = statSync(path).size; } catch { return ""; }
	const length = Math.min(bytes, TAIL_READ_BYTES);
	const buffer = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try { readSync(fd, buffer, 0, length, bytes - length); } finally { closeSync(fd); }
	let all = stripAnsi(buffer.toString("utf8")).split("\n");
	if (length < bytes) all = all.slice(1); // probably a partial line
	if (all.at(-1) === "") all.pop();
	return all.slice(-lines).map((line) => {
		const trimmed = line.replace(/\r+$/, "");
		const visible = trimmed.slice(trimmed.lastIndexOf("\r") + 1);
		return visible.length > MAX_LINE_CHARS ? `${visible.slice(0, MAX_LINE_CHARS)}… [${visible.length - MAX_LINE_CHARS} chars cut]` : visible;
	}).join("\n");
}

/** The user command in a subshell (so `exit` cannot skip the bookkeeping), then its status written to exitPath. */
export function wrapCommand(command: string, exitPath: string): string {
	const quoted = `'${exitPath.replace(/'/g, `'\\''`)}'`;
	return `(\n${command}\n)\n__pi_bg_status=$?\nprintf '%s\\n' "$__pi_bg_status" > ${quoted}\nexit "$__pi_bg_status"`;
}

/** Longest `sleep N` in a command, in seconds. */
export function sleepSeconds(command: string): number {
	let max = 0;
	for (const [, value, unit] of command.matchAll(/(?:^|[;&|()\n]|\b(?:then|do)\b)\s*sleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g)) {
		max = Math.max(max, Number(value) * ({ m: 60, h: 3600, d: 86400 }[unit] ?? 1));
	}
	return max;
}

function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function formatBytes(n: number): string {
	return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function readExitCode(path: string | undefined): number | undefined {
	if (!path) return undefined;
	try {
		const value = readFileSync(path, "utf8").trim();
		return /^\d+$/.test(value) ? Number(value) : undefined;
	} catch { return undefined; }
}

function signalGroup(record: BgRecord, signal: NodeJS.Signals) {
	// Started processes lead their own process group; attached ones are signalled alone.
	if (record.kind === "started" && process.platform !== "win32") {
		try { process.kill(-record.pid, signal); return; } catch { /* fall through */ }
	}
	try { process.kill(record.pid, signal); } catch { /* already gone */ }
}

export default function (pi: ExtensionAPI) {
	const records = new Map<string, BgRecord>();
	let nextId = 1;
	let currentCtx: ExtensionContext | undefined;
	let remoteHost: string | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let lastTick: number | undefined;
	let live = false;

	pi.events.on("hpc-mode:workspace-changed", (value: { host?: string }) => { remoteHost = value?.host; });

	const active = () => [...records.values()].filter((r) => r.status === "running");

	function persist() {
		if (!live) return;
		pi.appendEntry(STATE_TYPE, { nextId, records: [...records.values()] });
	}

	function updateStatus(ctx = currentCtx) {
		if (!ctx?.hasUI) return;
		const running = active();
		const text = running.length === 0 ? undefined
			: running.length === 1 ? `${running[0].id} ${running[0].label} (${formatDuration(Date.now() - running[0].startedAt)})`
			: `${running.length} running: ${running.map((r) => r.id).join(", ")}`;
		ctx.ui.setStatus(STATUS_KEY, text && ctx.ui.theme.fg("accent", `⏵ bg ${text}`));
	}

	function describe(r: BgRecord): string {
		const runtime = formatDuration((r.endedAt ?? Date.now()) - r.startedAt);
		const outcome = {
			running: `running for ${runtime}`,
			exited: `exited with code ${r.exitCode} after ${runtime}`,
			ended: `ended after at least ${runtime} (exit code unknown: process was not started by bg_shell)`,
			stopped: `stopped after ${runtime}`,
			lost: `ended after at most ${runtime} without recording an exit code (killed, or the machine restarted)`,
		}[r.status];
		const check = r.status === "running" && r.checkAtMs !== undefined ? `  next check-in: after ${formatDuration(r.checkAtMs)} awake (${formatDuration(r.awakeMs ?? 0)} so far; machine sleep not counted)` : undefined;
		let size = "";
		try { if (r.logPath) size = ` (${formatBytes(statSync(r.logPath).size)})`; } catch { /* not created */ }
		return [
			`${r.id} (${r.label}), pid ${r.pid}: ${outcome}`,
			r.command && `  command: ${r.command.length > 300 ? `${r.command.slice(0, 300)}…` : r.command}`,
			r.cwd && `  cwd: ${r.cwd}`,
			check,
			`  log: ${r.logPath ? `${r.logPath}${size}` : "none"}`,
		].filter(Boolean).join("\n");
	}

	function deliver(r: BgRecord) {
		const ctx = currentCtx;
		if (!ctx || r.notified) return;
		r.notified = true;
		const tail = readTail(r.logPath, NOTIFY_TAIL_LINES);
		const ok = r.status === "exited" && r.exitCode === 0;
		const content = [
			`Background shell ${describe(r)}`,
			"",
			tail ? `Last ${NOTIFY_TAIL_LINES} log lines:\n\`\`\`\n${tail}\n\`\`\`` : "(no log output)",
			"",
			ok || !r.logPath ? "Read or grep the log for details if needed."
				: "Read or grep the full log (for example grep -n -E 'FAILED|panicked|error' <log>) before changing code.",
		].join("\n");
		if (ctx.hasUI) ctx.ui.notify(`Background shell ${r.id} (${r.label}): ${ok ? "succeeded" : r.status === "exited" ? `exit ${r.exitCode}` : r.status}`, ok ? "info" : "warning");
		send(ctx, content, { kind: "exit", id: r.id, status: r.status, exitCode: r.exitCode, logPath: r.logPath });
	}

	function send(ctx: ExtensionContext, content: string, details: Record<string, unknown>) {
		try {
			const message = { customType: MESSAGE_TYPE, content, display: true, details };
			// Steer while busy: it arrives before the next model call without aborting current work.
			if (ctx.isIdle()) pi.sendMessage(message, { triggerTurn: true });
			else pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not deliver background shell message: ${(error as Error).message}`, "error");
		}
	}

	/** One-shot check-in: the process keeps running; the agent decides whether to extend or stop. */
	function checkIn(r: BgRecord) {
		const ctx = currentCtx;
		r.checkAtMs = undefined;
		if (!ctx) return;
		let bytes = 0, idle = "";
		try {
			const stat = statSync(r.logPath ?? "");
			bytes = stat.size;
			idle = `last log write ${formatDuration(Date.now() - stat.mtimeMs)} ago`;
		} catch { idle = "no log file"; }
		const growth = r.checkLogBytes === undefined ? `${formatBytes(bytes)} so far` : `+${formatBytes(Math.max(0, bytes - r.checkLogBytes))} since the last check-in`;
		r.checkLogBytes = bytes;
		const tail = readTail(r.logPath, NOTIFY_TAIL_LINES);
		const content = [
			`Background shell check-in (still running, not killed): ${describe(r)}`,
			`  activity: ${idle}; log ${growth}; ${formatDuration(r.awakeMs ?? 0)} awake`,
			"",
			tail ? `Last ${NOTIFY_TAIL_LINES} log lines:\n\`\`\`\n${tail}\n\`\`\`` : "(no log output)",
			"",
			`Judge whether it is progressing. If so: bg_shell extend (id ${r.id}, check_after_minutes) or do nothing (no further check-ins; its exit is still reported). If stuck: bg_shell stop (id ${r.id}).`,
		].join("\n");
		if (ctx.hasUI) ctx.ui.notify(`Background shell ${r.id} (${r.label}): check-in after ${formatDuration(r.awakeMs ?? 0)}`, "info");
		send(ctx, content, { kind: "check", id: r.id, logPath: r.logPath });
	}

	function settle(r: BgRecord, exitCode?: number) {
		if (r.status !== "running") return;
		r.endedAt = Date.now();
		r.exitCode = exitCode ?? readExitCode(r.exitPath);
		r.status = r.stopReason === "stop" ? "stopped"
			: r.kind === "attached" ? "ended"
			: r.exitCode !== undefined ? "exited" : "lost";
		// An explicit stop was the agent's or user's own decision; nothing to report.
		if (r.stopReason === "stop") r.notified = true;
		else deliver(r);
		const finished = [...records.values()].filter((x) => x.status !== "running");
		for (const old of finished.slice(0, Math.max(0, records.size - MAX_KEPT))) records.delete(old.id);
		persist();
		updateStatus();
	}

	function poll() {
		const now = Date.now();
		const tick = lastTick === undefined ? 0 : now - lastTick;
		lastTick = now;
		const awake = tick >= 0 && tick <= MAX_AWAKE_TICK_MS ? tick : 0;
		let changed = false;
		for (const r of active()) {
			r.awakeMs = (r.awakeMs ?? 0) + awake;
			const code = readExitCode(r.exitPath);
			if (code !== undefined || !isAlive(r.pid)) settle(r, code);
			else if (r.checkAtMs !== undefined && r.awakeMs >= r.checkAtMs && !r.stopReason) { checkIn(r); changed = true; }
		}
		if (changed) persist();
		if (active().length === 0) stopPolling();
		else updateStatus();
	}

	function ensurePolling() {
		if (pollTimer || !live) return;
		lastTick = Date.now();
		pollTimer = setInterval(poll, POLL_MS);
		pollTimer.unref?.();
	}

	function stopPolling() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		lastTick = undefined;
	}

	function stop(r: BgRecord) {
		if (r.status !== "running") return;
		r.stopReason = "stop";
		signalGroup(r, "SIGTERM");
		setTimeout(() => { if (r.status === "running" && isAlive(r.pid)) signalGroup(r, "SIGKILL"); }, KILL_GRACE_MS).unref?.();
		persist();
	}

	function checkCapacity() {
		if (active().length >= MAX_ACTIVE) throw new Error(`At most ${MAX_ACTIVE} background processes may be active at once; stop one or wait for its notification.`);
	}

	function start(params: { command?: string; label?: string; cwd?: string; check_after_minutes?: number; keep?: boolean }, ctx: ExtensionContext): BgRecord {
		const command = params.command?.trim();
		if (!command) throw new Error("start requires a command");
		if (remoteHost) throw new Error(`HPC workspace ${remoteHost} is selected, but bg_shell runs locally. Use Slurm with hpc_job_watch on the cluster, or /hpc local first.`);
		checkCapacity();
		const cwd = resolve(ctx.cwd, params.cwd ?? ".");
		if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
		const dir = join(tmpdir(), "pi-bg-shell", ctx.sessionManager.getSessionId());
		mkdirSync(dir, { recursive: true });
		const id = `bg${nextId++}`;
		const logPath = join(dir, `${id}.log`);
		const exitPath = join(dir, `${id}.exit`);
		const shell = getShellConfig();
		const script = wrapCommand(command, exitPath);
		const viaStdin = shell.commandTransport === "stdin";
		const fd = openSync(logPath, "a");
		let child;
		try {
			// Output goes to the file, not a pipe, so the process outlives this Pi instance if kept.
			child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, script], {
				cwd, detached: process.platform !== "win32",
				// Python block-buffers stdout into files; unbuffered keeps the log current. An explicit user setting wins.
				env: { ...process.env, PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? "1" },
				stdio: [viaStdin ? "pipe" : "ignore", fd, fd], windowsHide: true,
			});
		} finally {
			closeSync(fd);
		}
		if (viaStdin) { child.stdin?.on("error", () => {}); child.stdin?.end(script); }
		if (!child.pid) throw new Error(`Could not start ${shell.shell}`);
		child.unref();
		const now = Date.now();
		const r: BgRecord = {
			id, kind: "started", label: (params.label?.trim() || command.split("\n")[0]).slice(0, 40), command, cwd,
			pid: child.pid, logPath, exitPath, startedAt: now,
			checkAtMs: (params.check_after_minutes ?? DEFAULT_CHECK_MINUTES) * 60_000, awakeMs: 0,
			keep: params.keep ?? false, status: "running", notified: false,
		};
		records.set(id, r);
		// Prompt notification for our own child; polling covers everything else.
		child.once("exit", () => { if (live && records.get(id) === r) settle(r); });
		child.once("error", () => { if (live && records.get(id) === r) settle(r, 127); });
		persist();
		ensurePolling();
		updateStatus(ctx);
		return r;
	}

	function attach(params: { pid?: number; label?: string; log_path?: string; check_after_minutes?: number }, ctx: ExtensionContext): BgRecord {
		const pid = params.pid;
		if (!pid || !Number.isInteger(pid) || pid <= 1) throw new Error("watch requires the pid of a running local process");
		if (pid === process.pid) throw new Error("Cannot watch Pi itself");
		if (!isAlive(pid)) throw new Error(`No running process with pid ${pid}`);
		const existing = active().find((r) => r.pid === pid);
		if (existing) return existing;
		checkCapacity();
		const logPath = params.log_path ? resolve(ctx.cwd, params.log_path) : undefined;
		const id = `bg${nextId++}`;
		const r: BgRecord = {
			id, kind: "attached", label: (params.label?.trim() || `pid ${pid}`).slice(0, 40), pid, logPath,
			startedAt: Date.now(), keep: true, status: "running", notified: false, awakeMs: 0,
			checkAtMs: params.check_after_minutes ? params.check_after_minutes * 60_000 : undefined,
		};
		records.set(id, r);
		persist();
		ensurePolling();
		updateStatus(ctx);
		return r;
	}

	function find(id: string | undefined): BgRecord {
		const key = id?.trim();
		const r = key ? records.get(key) : undefined;
		if (!r) throw new Error(`Unknown background process${key ? `: ${key}` : " (id required)"}. Known: ${[...records.keys()].join(", ") || "none"}`);
		return r;
	}

	const text = (value: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: value }], details });

	pi.registerTool({
		name: "bg_shell",
		label: "Background Shell",
		description: `Run a local shell command in the background (e.g. a long test suite) while you keep working, or watch an already running local pid. Output streams to a log file you can read or grep at any time. When the process exits, the harness wakes the conversation with a bg-shell message holding the exit status and the last ${NOTIFY_TAIL_LINES} log lines; do not poll. Nothing is killed for time: after check_after_minutes of awake time (start default ${DEFAULT_CHECK_MINUTES}) a check-in message wakes you with the log tail; then extend or stop. Actions: start (command, label, cwd, check_after_minutes, keep), watch (pid, label, log_path, check_after_minutes), list, output (id, tail), extend (id, check_after_minutes), stop (id). PYTHONUNBUFFERED=1 is set (prefix PYTHONUNBUFFERED= to disable). At most ${MAX_ACTIVE} are active at once. Processes survive /reload; on quit or session replacement they are killed unless keep is true, and kept ones are re-attached when the session resumes.`,
		promptSnippet: "Run long local commands (test suites, builds) in the background, or watch a running pid, and get woken when they exit",
		promptGuidelines: [
			"Use bg_shell for long local commands such as full test suites or builds when there is other useful work to do meanwhile, and bg_shell watch instead of nohup plus polling loops for a process that is already running; use bash for quick commands whose result you need right away.",
			"After starting or watching a bg_shell process, continue with other work or end your turn. Do not sleep or poll; a bg-shell message arrives when it exits. Use bg_shell output only to check progress deliberately.",
		],
		parameters: BgShellParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			switch (params.action) {
				case "start": {
					const r = start(params, ctx);
					return text(`Started ${r.id} (${r.label}), pid ${r.pid}.\nLog: ${r.logPath}\nCheck-in after ${params.check_after_minutes ?? DEFAULT_CHECK_MINUTES} awake minutes if still running (not killed)${r.keep ? "; kept running if the session ends" : ""}. A bg-shell message arrives when it exits: continue other work or end your turn meanwhile, without sleeping or polling.`, { id: r.id, pid: r.pid, logPath: r.logPath });
				}
				case "watch": {
					const r = attach(params, ctx);
					return text(`Watching ${r.id} (${r.label}), pid ${r.pid}${r.logPath ? `, log ${r.logPath}` : ""}. Its exit code is unknown because bg_shell did not start it; check the log when the bg-shell message arrives. Continue other work or end your turn meanwhile.`, { id: r.id, pid: r.pid });
				}
				case "list":
					return text(records.size ? [...records.values()].map(describe).join("\n\n") : "No background processes in this session.", { ids: [...records.keys()] });
				case "output": {
					const r = find(params.id);
					const lines = Math.min(params.tail ?? NOTIFY_TAIL_LINES, MAX_TAIL_LINES);
					return text(`${describe(r)}\n\nLast ${lines} lines:\n${readTail(r.logPath, lines) || "(no output yet)"}`, { id: r.id, status: r.status });
				}
				case "extend": {
					const r = find(params.id);
					if (r.status !== "running") return text(`${r.id} is not running.\n${describe(r)}`, { id: r.id, status: r.status });
					const minutes = params.check_after_minutes ?? DEFAULT_CHECK_MINUTES;
					r.checkAtMs = (r.awakeMs ?? 0) + minutes * 60_000;
					persist();
					return text(`Next check-in for ${r.id} (${r.label}) after ${minutes} more awake minutes. Continue other work or end your turn.`, { id: r.id });
				}
				case "stop": {
					const r = find(params.id);
					if (r.status !== "running") return text(`${r.id} is not running.\n${describe(r)}`, { id: r.id, status: r.status });
					stop(r);
					return text(`Sent SIGTERM to ${r.id} (${r.label}); SIGKILL follows after ${KILL_GRACE_MS / 1000}s if needed. Stopped processes send no exit message.`, { id: r.id });
				}
			}
		},
	});

	// While something runs in the background, long sleeps are polling: refuse them.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" || active().length === 0 || typeof event.input.command !== "string") return;
		if (sleepSeconds(event.input.command) >= MIN_POLLING_SLEEP_SECONDS) {
			return { block: true, reason: `Background process(es) ${active().map((r) => r.id).join(", ")} will send a bg-shell message on exit. Do not sleep to wait: continue other work, check progress with bg_shell output, or end your turn.` };
		}
	});

	pi.registerCommand("bg", {
		description: "List background processes; /bg log <id>; /bg stop <id|all>",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const [sub, id] = args.trim().split(/\s+/);
			if (sub === "stop") {
				const targets = id === "all" ? active() : active().filter((r) => r.id === id);
				targets.forEach((r) => stop(r));
				ctx.ui.notify(targets.length ? `Stopping ${targets.map((r) => r.id).join(", ")}.` : "Nothing to stop. Usage: /bg stop <id|all>", targets.length ? "info" : "warning");
			} else if (sub === "log") {
				const r = records.get(id ?? "");
				ctx.ui.notify(r ? `${describe(r)}\n\n${readTail(r.logPath, 20) || "(no output)"}` : "Usage: /bg log <id>", r ? "info" : "warning");
			} else {
				ctx.ui.notify(records.size ? [...records.values()].map(describe).join("\n\n") : "No background processes in this session.", "info");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		live = true;
		records.clear();
		nextId = 1;
		// Processes are physical, not per-branch: restore from the latest state entry anywhere in the session.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as { nextId?: number; records?: BgRecord[] } | undefined;
			nextId = data?.nextId ?? nextId;
			records.clear();
			for (const r of data?.records ?? []) {
				records.set(r.id, { ...r });
			}
		}
		const before = JSON.stringify([...records.values()]);
		for (const r of records.values()) {
			if (r.status !== "running") continue;
			const code = readExitCode(r.exitPath);
			// Ended while no Pi instance was watching: report it now (reload, resume after quit with keep).
			if (code !== undefined || !isAlive(r.pid)) settle(r, code);
		}
		for (const r of records.values()) if (r.status !== "running" && !r.notified) deliver(r);
		if (JSON.stringify([...records.values()]) !== before) persist();
		if (active().length) ensurePolling();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (event, ctx) => {
		stopPolling();
		// Keep the awake time used so far; time while no Pi instance watches is not counted.
		persist();
		// /reload rebinds this same session: leave everything running for the next instance.
		if (event.reason !== "reload") {
			for (const r of active()) if (!r.keep) { r.stopReason = "stop"; signalGroup(r, "SIGTERM"); r.status = "stopped"; r.endedAt = Date.now(); r.notified = true; }
			persist();
			const kept = active();
			if (kept.length && ctx.hasUI) ctx.ui.notify(`Left running: ${kept.map((r) => `${r.id} (pid ${r.pid})`).join(", ")}. Resume this session to be notified when they exit.`, "info");
		}
		live = false;
		currentCtx = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
