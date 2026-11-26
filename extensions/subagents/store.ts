// On-disk state shared by the parent extension and detached workers.
// Plain Node APIs and erasable TypeScript only: workers run with `node worker.ts`.
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Backend = "pi" | "claude" | "codex";
export const BACKENDS: Backend[] = ["pi", "claude", "codex"];

// "stopped" releases processes but keeps the native session; send relaunches it.
export type RunStatus = "starting" | "running" | "idle" | "waiting" | "failed" | "stopped";

export interface RunSpec {
	id: string;
	name: string;
	backend: Backend;
	cwd: string;
	model?: string;
	effort?: string;
	// Claude permission mode or Codex sandbox; validated by the extension and again by the worker.
	mode?: string;
	goal?: string;
	parentSessionId: string;
	parentSessionFile?: string;
	createdAt: string;
	// Test hook only: set from PI_SUBAGENTS_BIN_<BACKEND>, never from tool input.
	bin?: string;
	// agent_comm mode for pi children (absent = none). The authoritative record is the agent-comm member file.
	communication?: string;
}

export interface Approval {
	requestId: string;
	tool: string;
	summary: string;
	at: string;
}

export interface RunState {
	status: RunStatus;
	workerPid?: number;
	childPid?: number;
	nativeSessionId?: string;
	nativeTranscript?: string;
	turns: number;
	approval?: Approval;
	error?: string;
	lastText?: string;
	updatedAt: string;
}

export interface Report {
	seq: number;
	kind: "turn" | "approval" | "exit";
	status: string;
	text: string;
	error?: string;
	at: string;
}

export type InboxCommand =
	| { type: "send"; message: string; delivery: "auto" | "steer" | "followUp" }
	| { type: "interrupt" }
	| { type: "stop" }
	| { type: "reply"; requestId: string; allow: boolean; reason?: string }
	| { type: "hpc-grants" };

export interface TranscriptEntry {
	at: string;
	role: "user" | "assistant" | "thinking" | "tool" | "result" | "system" | "approval" | "error";
	text: string;
	tool?: string;
}

// Claude permission modes and Codex sandboxes a child may use. Bypass and
// full-access modes are intentionally absent.
export const CLAUDE_MODES = ["auto", "default", "acceptEdits", "plan"];
export const CODEX_SANDBOXES = ["workspace-write", "read-only"];
export const DEFAULT_MODE: Record<Backend, string | undefined> = { pi: undefined, claude: "auto", codex: "workspace-write" };

export function validateMode(backend: Backend, mode: string | undefined): string | undefined {
	if (mode === undefined || mode === "") return DEFAULT_MODE[backend];
	if (backend === "claude" && CLAUDE_MODES.includes(mode)) return mode;
	if (backend === "codex" && CODEX_SANDBOXES.includes(mode)) return mode;
	const allowed = backend === "claude" ? CLAUDE_MODES : backend === "codex" ? CODEX_SANDBOXES : [];
	throw new Error(`Mode "${mode}" is not allowed for ${backend}. Allowed: ${allowed.join(", ") || "none (pi has no mode)"}. Permission-bypass and full-access modes are never used.`);
}

export function subagentsRoot(): string {
	return process.env.PI_SUBAGENTS_ROOT || join(homedir(), ".pi", "agent", "subagents");
}

export function runsDir(): string {
	return join(subagentsRoot(), "runs");
}

export function runDir(id: string): string {
	if (!/^[a-f0-9]{8}$/.test(id)) throw new Error(`Invalid subagent id: ${id}`);
	return join(runsDir(), id);
}

export function newRunId(): string {
	for (;;) {
		const id = randomBytes(4).toString("hex");
		if (!existsSync(join(runsDir(), id))) return id;
	}
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

// Write-then-rename so readers never see a partial file.
export function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

export function readSpec(dir: string): RunSpec | undefined {
	return readJson<RunSpec>(join(dir, "spec.json"));
}

export function readState(dir: string): RunState | undefined {
	return readJson<RunState>(join(dir, "state.json"));
}

export function updateState(dir: string, patch: Partial<RunState>): RunState {
	const current = readState(dir) ?? { status: "starting", turns: 0, updatedAt: "" };
	const next = { ...current, ...patch, updatedAt: new Date().toISOString() } as RunState;
	for (const key of Object.keys(patch) as Array<keyof RunState>) if (patch[key] === undefined) delete next[key];
	writeJsonAtomic(join(dir, "state.json"), next);
	return next;
}

export function createRun(spec: RunSpec): string {
	const dir = runDir(spec.id);
	for (const sub of ["inbox/done", "reports/delivered"]) mkdirSync(join(dir, sub), { recursive: true });
	writeJsonAtomic(join(dir, "spec.json"), spec);
	writeJsonAtomic(join(dir, "state.json"), { status: "starting", turns: 0, updatedAt: new Date().toISOString() });
	return dir;
}

export function listRuns(): Array<{ dir: string; spec: RunSpec; state: RunState }> {
	if (!existsSync(runsDir())) return [];
	const runs = [];
	for (const id of readdirSync(runsDir())) {
		if (!/^[a-f0-9]{8}$/.test(id)) continue;
		const dir = join(runsDir(), id);
		const spec = readSpec(dir);
		const state = readState(dir);
		if (spec && state) runs.push({ dir, spec, state });
	}
	return runs.sort((a, b) => a.spec.createdAt.localeCompare(b.spec.createdAt));
}

let sequence = 0;
function stamp(): string {
	sequence += 1;
	return `${Date.now().toString().padStart(15, "0")}-${process.pid}-${String(sequence).padStart(6, "0")}-${randomBytes(2).toString("hex")}`;
}

export function enqueue(dir: string, command: InboxCommand): void {
	writeJsonAtomic(join(dir, "inbox", `${stamp()}.json`), command);
}

// Processed commands move to inbox/done/ (kept as an audit trail, never deleted).
export function takeInbox(dir: string): InboxCommand[] {
	const inbox = join(dir, "inbox");
	if (!existsSync(inbox)) return [];
	const commands: InboxCommand[] = [];
	for (const file of readdirSync(inbox).filter((f) => f.endsWith(".json")).sort()) {
		const command = readJson<InboxCommand>(join(inbox, file));
		renameSync(join(inbox, file), join(inbox, "done", file));
		if (command) commands.push(command);
	}
	return commands;
}

export function writeReport(dir: string, report: Omit<Report, "seq" | "at">): Report {
	const reports = join(dir, "reports");
	const existing = [...readdirSync(reports), ...readdirSync(join(reports, "delivered"))].filter((f) => f.endsWith(".json")).length;
	const full: Report = { ...report, seq: existing + 1, at: new Date().toISOString() };
	writeJsonAtomic(join(reports, `${String(full.seq).padStart(6, "0")}.json`), full);
	return full;
}

export function pendingReports(dir: string): Array<{ file: string; report: Report }> {
	const reports = join(dir, "reports");
	if (!existsSync(reports)) return [];
	return readdirSync(reports).filter((f) => f.endsWith(".json")).sort().flatMap((file) => {
		const report = readJson<Report>(join(reports, file));
		return report ? [{ file, report }] : [];
	});
}

export function allReports(dir: string): Report[] {
	const reports: Report[] = [];
	for (const sub of ["reports/delivered", "reports"]) {
		const path = join(dir, sub);
		if (!existsSync(path)) continue;
		for (const file of readdirSync(path).filter((f) => f.endsWith(".json"))) {
			const report = readJson<Report>(join(path, file));
			if (report) reports.push(report);
		}
	}
	return reports.sort((a, b) => a.seq - b.seq);
}

export function markDelivered(dir: string, file: string): void {
	renameSync(join(dir, "reports", file), join(dir, "reports", "delivered", file));
}

export function appendTranscript(dir: string, entry: Omit<TranscriptEntry, "at">): void {
	appendFileSync(join(dir, "transcript.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export function readTranscript(dir: string): TranscriptEntry[] {
	const path = join(dir, "transcript.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").flatMap((line) => {
		if (!line.trim()) return [];
		try {
			return [JSON.parse(line) as TranscriptEntry];
		} catch {
			return [];
		}
	});
}

// Last transcript entry without reading the whole file (widget refresh).
export function lastTranscriptEntry(dir: string): TranscriptEntry | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(join(dir, "transcript.jsonl"), "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, 16_384);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split("\n").filter((line) => line.trim());
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			try {
				return JSON.parse(lines[i]) as TranscriptEntry;
			} catch {
				// A cut first line or a line still being written.
			}
		}
	} catch {
		// No transcript yet.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return undefined;
}

// A coordinator's registered wait: reports of the watched children are held
// and delivered together. Kept per parent session so it survives /reload.
export interface Watch {
	id: string;
	ids: string[];
	mode: "all" | "any";
	createdAt: string;
	expiresAt: string;
}

function watchesPath(sessionId: string): string {
	return join(subagentsRoot(), "watches", `${sessionId.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

export function readWatches(sessionId: string): Watch[] {
	const value = readJson<{ watches?: Watch[] }>(watchesPath(sessionId));
	return Array.isArray(value?.watches) ? value.watches.filter((w) => w && Array.isArray(w.ids) && typeof w.expiresAt === "string") : [];
}

export function writeWatches(sessionId: string, watches: Watch[]): void {
	const path = watchesPath(sessionId);
	if (!watches.length && !existsSync(path)) return;
	mkdirSync(join(subagentsRoot(), "watches"), { recursive: true });
	writeJsonAtomic(path, { watches });
}

// Raw protocol record in either direction: the forensic log for investigating failures.
export function appendEvent(dir: string, direction: "in" | "out" | "err" | "worker", record: unknown): void {
	appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), dir: direction, record })}\n`);
}

export function processAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// HPC grants inherited by pi children. The parent rewrites this file on every
// /hpc allow or revoke and empties it when the parent session ends.
export interface InheritedHpcGrant {
	host: string;
	remoteCwd: string;
	home: string;
	username: string;
}

export function hpcGrantsPath(dir: string): string {
	return join(dir, "hpc-grants.json");
}

export function readHpcGrants(dir: string): InheritedHpcGrant[] {
	const value = readJson<{ grants?: InheritedHpcGrant[] }>(hpcGrantsPath(dir));
	return Array.isArray(value?.grants) ? value.grants : [];
}

export function writeHpcGrants(dir: string, grants: InheritedHpcGrant[]): void {
	writeJsonAtomic(hpcGrantsPath(dir), { grants, updatedAt: new Date().toISOString() });
}
