import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, posix, sep } from "node:path";
import { shellSafetyReason } from "./safety-guard.js";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import {
	getAgentDir,
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	parseSkillBlock,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATUS_KEY = "hpc-mode";
const IS_WINDOWS = process.platform === "win32";
// Default macOS and Windows file systems are case-insensitive, so .SSH is .ssh.
const CASE_INSENSITIVE_FS = IS_WINDOWS || process.platform === "darwin";

/**
 * Machine-local configuration, never committed with the package:
 * - PI_HPC_HOSTS: comma-separated SSH aliases (overrides `hosts` in the file)
 * - PI_HPC_CONFIG: path to a JSON file, default <agent dir>/hpc-hosts.json
 *
 * {
 *   "hosts": ["cluster-a", "cluster-b"],
 *   "guidance": ["Extra system-prompt lines, e.g. module or environment setup"],
 *   "ssh": "ssh", "scp": "scp",
 *   "connectionSharing": true
 * }
 *
 * Add only manually verified SSH aliases; the extension never reads SSH configuration.
 */
interface HpcConfig {
	hosts: string[];
	guidance: string[];
	ssh: string;
	scp: string;
	connectionSharing: boolean;
	source: string;
}

// Aliases become ssh/scp arguments, so they must not look like options or contain separators.
const HOST_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function hpcConfigPath(): string {
	return process.env.PI_HPC_CONFIG?.trim() || join(getAgentDir(), "hpc-hosts.json");
}

export function loadHpcConfig(): HpcConfig & { errors: string[] } {
	const errors: string[] = [];
	const path = hpcConfigPath();
	let file: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
			else errors.push(`${path} must contain a JSON object`);
		} catch (error) {
			errors.push(`Could not read ${path}: ${formatError(error)}`);
		}
	}
	const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
	const envHosts = process.env.PI_HPC_HOSTS;
	const rawHosts = envHosts !== undefined ? envHosts.split(",") : strings(file.hosts);
	const hosts: string[] = [];
	for (const raw of rawHosts) {
		const host = raw.trim().toLowerCase();
		if (!host) continue;
		if (!HOST_ALIAS_PATTERN.test(host) || host === "all") errors.push(`Ignored invalid HPC alias: ${JSON.stringify(raw)}`);
		else if (!hosts.includes(host)) hosts.push(host);
	}
	const command = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.trim() : fallback;
	return {
		hosts,
		guidance: strings(file.guidance),
		ssh: command(file.ssh, "ssh"),
		scp: command(file.scp, "scp"),
		// Windows OpenSSH has no Unix-socket connection multiplexing.
		connectionSharing: typeof file.connectionSharing === "boolean" ? file.connectionSharing : !IS_WINDOWS,
		source: envHosts !== undefined ? "PI_HPC_HOSTS" : path,
		errors,
	};
}

let config: HpcConfig = { hosts: [], guidance: [], ssh: "ssh", scp: "scp", connectionSharing: !IS_WINDOWS, source: "" };
let allowedHostSet = new Set<string>();

function sshOptions(): string[] {
	const options = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${SSH_TIMEOUT_SECONDS}`];
	// Respect the alias's configured ControlPath so external MFA masters remain reusable.
	// Without a configured ControlPath, OpenSSH uses ordinary independent connections.
	if (config.connectionSharing) options.push("-o", "ControlMaster=auto", "-o", "ControlPersist=60");
	return options;
}
const SSH_TIMEOUT_SECONDS = 15;
const SCHEDULER_QUERY_TIMEOUT_SECONDS = 30;
const MAX_JOB_WATCHES = 20;
// Bound manual monitoring even when elapsed times/log tails change on every call.
const MAX_MANUAL_SCHEDULER_CHECKS = 3;
const SCHEDULER_CHECK_PATTERN = /\b(?:squeue|sacct)\b|\bscontrol\s+(?:-\S+\s+)*show\s+jobs?\b/i;
const DEFAULT_WATCH_MAX_MINUTES = 24 * 60;
const PENDING_POLL_MS = 60_000;
const RUNNING_POLL_MS = 3 * 60_000;
const UNKNOWN_POLL_MS = 90_000;
const MIN_SCHEDULER_POLL_MS = 45_000;
const MAX_ERROR_BACKOFF_MS = 10 * 60_000;
const POLL_JITTER_FRACTION = 0.15;
const JOB_ID_PATTERN = /^\d+(?:[_+]\d+)?$/;
// Host-argument mistakes the model can fix itself. One is forgiven per
// user/watcher update; the next stops the run like a missing grant.
const MAX_RECOVERABLE_HOST_DENIALS = 1;
// After registering a watch the model may keep working (submit more jobs,
// summarize) for this many HPC-touching turns. The next turn's HPC calls are
// refused with a wrap-up request; HPC calls after that stop the run.
const MAX_POST_WATCH_HPC_TURNS = 3;
const SLEEP_PATTERN = /\bsleep\s+[\d$]/;
const TERMINAL_JOB_STATES = new Set([
	"BOOT_FAIL",
	"CANCELLED",
	"COMPLETED",
	"DEADLINE",
	"FAILED",
	"NODE_FAIL",
	"OUT_OF_MEMORY",
	"PREEMPTED",
	"REVOKED",
	"SPECIAL_EXIT",
	"TIMEOUT",
]);

const HPC_GUIDANCE = `# Authorized HPC access

The user authorized the listed hosts for this session. Authorization and workspace routing are separate. Use hpc_exec for commands on an authorized host and hpc_transfer for explicit local/remote file transfers without changing routing. These tools cannot authorize another host or change the workspace. Local paths in hpc_transfer always refer to the original local workspace, regardless of routing.

- Normal tools follow the workspace shown below. In a remote workspace, write, edit, bash and user ! commands are remote, as are ordinary project reads. Pi-advertised skill files, directory-form resources, and exact harness-generated bash output files remain locally readable as narrow harness exceptions.
- Treat the selected workspace directory as the current working directory. Remote absolute paths under home, /scratch, and /project are allowed when the account has access.
- Load and follow relevant skills exactly as in local mode. In a remote workspace, do not pass local skill helper-script paths directly to bash; inspect and adapt helpers for remote execution.
- Never inspect, print, copy, modify, or otherwise expose remote SSH configuration or key material, including any remote .ssh directory.
- The login/head node is only for lightweight work: navigation, small file inspection, editing, Git operations, environment setup, scheduler inspection, and job submission.
- Do not run CPU-heavy, memory-heavy, highly parallel, GPU, or long-running workloads directly on the login/head node. Use srun for work in an interactive Slurm allocation and sbatch for batch jobs, with suitable resource and partition options.
- Prefer squeue and sacct for monitoring Slurm jobs. Do not cancel jobs unless the user explicitly asks.
- Use hpc_job_watch instead of remote sleep commands when waiting for a job to start or finish. It performs conservative, aggregated scheduler polling in the Pi harness.
- How watches affect this conversation:
  - The harness polls Slurm in the background without model requests. It resumes the conversation with an hpc-job-watch message only when a watched job reaches the requested state, ends, or the watch expires. A job that is still queued does not wake you.
  - After registering a watch you may keep working briefly: submit further jobs, register more watches (job_ids accepts several IDs), or do local work. You then must end your turn with a short summary for the user; waiting happens between turns, not inside one.
  - While a watch is pending on a host, manual scheduler checks on that host and sleep commands are refused. Check job state before registering the watch if you need it.
  - At most ${MAX_POST_WATCH_HPC_TURNS} further HPC-touching turns are allowed after the first watch. HPC calls in the next turn are refused with a request to wrap up, and HPC calls after that stop the run. Local work is not counted.
- At most three manual scheduler-check commands per host are allowed between user requests or watcher updates. A fourth stops the run before execution. Changing command formatting or log tails does not reset this budget.
- Only the user can grant/revoke access or change workspace routing with /hpc. /hpc local retains access and watches; /hpc revoke <host|all> revokes permission without cancelling submitted jobs. Reload and session replacement reset all permissions.`;

interface RemoteState {
	host: string;
	remoteCwd: string;
	home: string;
	username: string;
}

interface SshRunOptions {
	input?: string | Buffer;
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutSeconds?: number;
}

interface SshRunResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
}

interface LocalSkillReadCapability {
	filePath: string;
	realFilePath: string;
	directory?: string;
	realDirectory?: string;
}

type JobWatchTarget = "running" | "finished";

interface JobWatch {
	host: string;
	jobId: string;
	until: JobWatchTarget;
	createdAt: number;
	expiresAt: number;
	lastState?: string;
}

const HpcJobWatchParams = Type.Object({
	host: Type.Optional(Type.String({ description: "Authorized host; defaults to selected workspace or sole authorized host" })),
	action: StringEnum(["watch", "list", "stop"] as const, {
		description: "watch a job, list active watches, or stop one/all watches",
	}),
	job_id: Type.Optional(Type.String({ description: "Slurm job ID; for watch, give job_id or job_ids; optional for stop" })),
	job_ids: Type.Optional(Type.Array(Type.String(), {
		minItems: 1,
		description: "Several Slurm job IDs on the same host to watch with one call (watch only)",
	})),
	until: Type.Optional(
		StringEnum(["running", "finished"] as const, {
			description: "State transition to wait for; defaults to running",
		}),
	),
	max_wait_minutes: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 7 * 24 * 60,
			description: "Automatically expire the watch after this many minutes; defaults to 1440",
		}),
	),
});

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// "none"/"revoked" need the user; the other kinds are fixable by changing arguments.
type HostDenialKind = "none" | "revoked" | "ambiguous" | "unknown" | "wrong-host";

class HostAuthorizationError extends Error {
	constructor(readonly kind: HostDenialKind, message: string) {
		super(message);
	}

	get requiresUser(): boolean {
		return this.kind === "none" || this.kind === "revoked";
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeSlurmState(value: string): string {
	return value.trim().toUpperCase().split(/[|\s]+/, 1)[0]?.replace(/\+$/, "") || "UNKNOWN";
}

function isTerminalJobState(state: string): boolean {
	return TERMINAL_JOB_STATES.has(normalizeSlurmState(state));
}

function pollIntervalFor(state: string | undefined, until: JobWatchTarget): number {
	const normalized = state ? normalizeSlurmState(state) : "UNKNOWN";
	const base = until === "finished" && (normalized === "RUNNING" || normalized === "COMPLETING")
		? RUNNING_POLL_MS
		: normalized === "UNKNOWN"
			? UNKNOWN_POLL_MS
			: PENDING_POLL_MS;
	const jitter = 1 + (Math.random() * 2 - 1) * POLL_JITTER_FRACTION;
	return Math.round(base * jitter);
}

function parseSlurmStates(output: string, requestedIds: readonly string[]): Map<string, string> {
	const requested = new Set(requestedIds);
	const states = new Map<string, string>();
	for (const line of output.split(/\r?\n/)) {
		const separator = line.indexOf("|");
		if (separator < 0) continue;
		const rawId = line.slice(0, separator).trim();
		const state = normalizeSlurmState(line.slice(separator + 1));
		if (requested.has(rawId) && !states.has(rawId)) {
			states.set(rawId, state);
			continue;
		}
		for (const id of requested) {
			if (!states.has(id) && rawId.startsWith(`${id}_[`)) states.set(id, state);
		}
	}
	return states;
}

function remotePathTouchesSsh(path: string): boolean {
	return path.split(/[\\/]/).includes(".ssh");
}

function assertRemotePathAllowed(path: string) {
	if (remotePathTouchesSsh(path)) {
		throw new Error("Remote .ssh access is blocked. Ask the user directly for any SSH-related information.");
	}
}

function assertLocalPathAllowed(path: string) {
	const parts = path.split(/[\\/]/);
	if ((CASE_INSENSITIVE_FS ? parts.map((part) => part.toLowerCase()) : parts).includes(".ssh")) {
		throw new Error("Local .ssh access is blocked. Ask the user directly for any SSH-related information.");
	}
}

function expandLocalHome(path: string): string {
	return path.replace(/^~(?=[\\/]|$)/, homedir());
}

function isPathWithin(path: string, directory: string): boolean {
	const rel = relative(directory, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function tryRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

export function mapLocalPathToRemote(path: string, localCwd: string, remoteCwd: string, windows = IS_WINDOWS): string {
	const rel = relative(localCwd, path);
	if (rel === "") return remoteCwd;
	if (!rel.startsWith("..") && !isAbsolute(rel)) return `${remoteCwd}/${rel.split(sep).join("/")}`;
	// Pi resolves tool paths with the local path module before calling remote
	// operations, so on Windows a remote "/scratch/x" arrives as "C:\scratch\x".
	if (windows) {
		const drive = /^[A-Za-z]:[\\/]/.exec(path);
		if (drive) return path.slice(2).replace(/\\/g, "/");
	}
	return path;
}

function expandKnownRemotePath(path: string, state: Pick<RemoteState, "home" | "username">): string {
	return path
		.replace(/^~(?=\/|$)/, state.home)
		.replace(/^\$HOME(?=\/|$)/, state.home)
		.replace(/^\$\{HOME\}(?=\/|$)/, state.home)
		.replace(/\$\{USER\}|\$USER\b/g, state.username);
}

function stripOuterQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === "'" && last === "'") || (first === '"' && last === '"')) return trimmed.slice(1, -1);
	}
	return trimmed;
}

function runSsh(host: string, command: string, options: SshRunOptions = {}): Promise<SshRunResult> {
	return runClient("ssh", [...sshOptions(), "--", host, command], options);
}

function runClient(client: "ssh" | "scp", args: string[], options: SshRunOptions & { cwd?: string } = {}): Promise<SshRunResult> {
	if (options.signal?.aborted) return Promise.reject(new Error("HPC operation aborted"));
	return new Promise((resolve, reject) => {
		const hasInput = options.input !== undefined;
		const child = spawn(config[client], args, {
			stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
			...(options.cwd ? { cwd: options.cwd } : {}),
			windowsHide: true,
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let settled = false;
		let timedOut = false;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => child.kill();
		const timer = options.timeoutSeconds
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeoutSeconds * 1000)
			: undefined;

		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (data: Buffer) => {
			stdoutChunks.push(data);
			options.onData?.(data);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderrChunks.push(data);
			options.onData?.(data);
		});
		child.once("error", fail);
		child.once("close", (exitCode) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (options.signal?.aborted) {
				reject(new Error("SSH command aborted"));
				return;
			}
			if (timedOut) {
				reject(new Error(`SSH command timed out after ${options.timeoutSeconds} seconds`));
				return;
			}
			resolve({
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
				exitCode,
			});
		});

		if (hasInput) {
			child.stdin.on("error", fail);
			child.stdin.end(options.input);
		}
	});
}

async function sshExec(host: string, command: string, options: SshRunOptions = {}): Promise<Buffer> {
	const result = await runSsh(host, command, options);
	if (result.exitCode !== 0) {
		const detail = Buffer.concat([result.stderr, result.stdout]).toString().trim().slice(-4000);
		throw new Error(`SSH command failed (${result.exitCode})${detail ? `: ${detail}` : ""}`);
	}
	return result.stdout;
}

async function querySlurmStates(state: RemoteState, jobIds: readonly string[]): Promise<Map<string, string>> {
	if (jobIds.length === 0) return new Map();
	const requested = shellQuote(jobIds.join(","));
	const squeueOutput = await sshExec(
		state.host,
		`squeue --noheader --jobs ${requested} --format='%i|%T' 2>/dev/null || squeue --noheader --user "$USER" --format='%i|%T'`,
		{ timeoutSeconds: SCHEDULER_QUERY_TIMEOUT_SECONDS },
	);
	const states = parseSlurmStates(squeueOutput.toString(), jobIds);
	const missing = jobIds.filter((jobId) => !states.has(jobId));
	if (missing.length === 0) return states;

	try {
		const sacctOutput = await sshExec(
			state.host,
			`sacct --allocations --noheader --parsable2 --jobs ${shellQuote(missing.join(","))} --format=JobIDRaw,State`,
			{ timeoutSeconds: SCHEDULER_QUERY_TIMEOUT_SECONDS },
		);
		for (const [jobId, jobState] of parseSlurmStates(sacctOutput.toString(), missing)) {
			states.set(jobId, jobState);
		}
	} catch {
		// Accounting may be disabled or lagging. Missing jobs remain UNKNOWN and are retried conservatively.
	}
	return states;
}

async function inspectRemote(host: string): Promise<RemoteState> {
	const marker = "__PI_HPC_METADATA__";
	const output = await sshExec(
		host,
		`printf '${marker}HOME=%s\\n${marker}USER=%s\\n${marker}PWD=%s\\n' "$HOME" "$(id -un)" "$(pwd -P)"`,
		{ timeoutSeconds: SSH_TIMEOUT_SECONDS },
	);
	const values = new Map<string, string>();
	for (const line of output.toString().split(/\r?\n/)) {
		if (!line.startsWith(marker)) continue;
		const separator = line.indexOf("=", marker.length);
		if (separator > 0) values.set(line.slice(marker.length, separator), line.slice(separator + 1));
	}

	const home = values.get("HOME");
	const username = values.get("USER");
	const remoteCwd = values.get("PWD");
	if (!home || !username || !remoteCwd) throw new Error("Could not determine the remote home directory, user, and working directory");
	return { host, home, username, remoteCwd };
}

async function resolveRemoteDirectory(state: RemoteState, requestedPath: string): Promise<string> {
	const expanded = expandKnownRemotePath(stripOuterQuotes(requestedPath), state);
	assertRemotePathAllowed(expanded);
	const output = await sshExec(state.host, `cd -- ${shellQuote(expanded)} && pwd -P`, {
		timeoutSeconds: SSH_TIMEOUT_SECONDS,
	});
	const resolved = output.toString().trim();
	if (!resolved) throw new Error(`Could not resolve remote directory: ${requestedPath}`);
	assertRemotePathAllowed(resolved);
	return resolved;
}

function createRemoteReadOps(state: RemoteState, localCwd: string): ReadOperations {
	const toRemote = (path: string) => mapLocalPathToRemote(path, localCwd, state.remoteCwd);
	return {
		readFile: async (path) => {
			const remotePath = toRemote(path);
			assertRemotePathAllowed(remotePath);
			return sshExec(state.host, `cat -- ${shellQuote(remotePath)}`);
		},
		access: async (path) => {
			const remotePath = toRemote(path);
			assertRemotePathAllowed(remotePath);
			await sshExec(state.host, `test -r ${shellQuote(remotePath)}`);
		},
		detectImageMimeType: async (path) => {
			const remotePath = toRemote(path);
			assertRemotePathAllowed(remotePath);
			try {
				const output = await sshExec(state.host, `file --mime-type -b -- ${shellQuote(remotePath)}`);
				const mime = output.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(state: RemoteState, localCwd: string): WriteOperations {
	const toRemote = (path: string) => mapLocalPathToRemote(path, localCwd, state.remoteCwd);
	return {
		writeFile: async (path, content) => {
			const remotePath = toRemote(path);
			assertRemotePathAllowed(remotePath);
			const encoded = Buffer.from(content).toString("base64");
			await sshExec(state.host, `base64 -d > ${shellQuote(remotePath)}`, { input: encoded });
		},
		mkdir: async (path) => {
			const remotePath = toRemote(path);
			assertRemotePathAllowed(remotePath);
			await sshExec(state.host, `mkdir -p -- ${shellQuote(remotePath)}`);
		},
	};
}

function createRemoteEditOps(state: RemoteState, localCwd: string): EditOperations {
	const read = createRemoteReadOps(state, localCwd);
	const write = createRemoteWriteOps(state, localCwd);
	const toRemote = (path: string) => mapLocalPathToRemote(path, localCwd, state.remoteCwd);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: async (path) => {
			const remotePath = toRemote(path);
			assertRemotePathAllowed(remotePath);
			await sshExec(state.host, `test -r ${shellQuote(remotePath)} -a -w ${shellQuote(remotePath)}`);
		},
	};
}

function createRemoteBashOps(state: RemoteState, localCwd: string, checkCommand = shellSafetyReason): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const remoteCwd = mapLocalPathToRemote(cwd, localCwd, state.remoteCwd);
			assertRemotePathAllowed(remoteCwd);
			const reason = checkCommand(command);
			if (reason) throw new Error(reason);
			const result = await runSsh(state.host, `cd -- ${shellQuote(remoteCwd)} && {\n${command}\n}`, {
				onData,
				signal,
				timeoutSeconds: timeout,
			});
			return { exitCode: result.exitCode };
		},
	};
}

export default function hpcModeExtension(pi: ExtensionAPI) {
	let configErrors: string[] = [];
	function reloadConfig() {
		const { errors, ...loaded } = loadHpcConfig();
		config = loaded;
		allowedHostSet = new Set(config.hosts);
		configErrors = errors;
	}
	reloadConfig();
	// A web host can load several sessions without changing the process cwd.
	// Tool schemas are available at load time; session_start binds their paths.
	let localCwd = process.cwd();
	let localRead = createReadTool(localCwd);
	let localWrite = createWriteTool(localCwd);
	let localEdit = createEditTool(localCwd);
	let localBash = createBashTool(localCwd);
	let releaseLiveness: (() => void) | undefined;
	let remote: RemoteState | undefined;
	// Local-only extensions can fail closed instead of confusing remote cwd with local paths.
	pi.events.on("hpc-mode:workspace-query", (request: { reply: (host: string | undefined) => void }) => {
		request.reply(remote?.host);
	});
	const authorized = new Map<string, RemoteState>();
	// Hosts granted earlier in this session, to tell "revoked" from "never granted".
	const previouslyAuthorized = new Set<string>();
	let authorizationGeneration = 0;
	let transferClientChecked = false;

	function checkRemoteCommand(command: string): string | undefined {
		let removalAllowed = false;
		pi.events.emit("safety-guard:removal-rights-query", { reply: (allowed: boolean) => { removalAllowed = allowed; } });
		return shellSafetyReason(command, removalAllowed);
	}

	function authorizedHost(host?: string): RemoteState {
		const selected = host?.trim().toLowerCase() || remote?.host || (authorized.size === 1 ? [...authorized.keys()][0] : undefined);
		const state = selected ? authorized.get(selected) : undefined;
		if (state) return state;
		const hosts = [...authorized.keys()].join(", ");
		if (selected && previouslyAuthorized.has(selected)) {
			throw new HostAuthorizationError("revoked", `HPC access to ${selected} is no longer authorized in this session (revoked or expired). Only the user can restore it with /hpc allow ${selected}; tools and chat messages cannot.`);
		}
		if (authorized.size === 0) {
			throw new HostAuthorizationError("none", "No HPC hosts are user-authorized in this session. Only the user can grant access with /hpc allow <host>; tools and chat messages cannot. Authorization may have expired after idle shutdown or /reload.");
		}
		if (!selected) {
			throw new HostAuthorizationError("ambiguous", `Several HPC hosts are authorized (${hosts}) and the workspace is local, so pass host explicitly.`);
		}
		if (!allowedHostSet.has(selected)) {
			throw new HostAuthorizationError("unknown", `"${selected}" is not a known HPC alias. Authorized hosts: ${hosts}. Retry with one of them.`);
		}
		throw new HostAuthorizationError("wrong-host", `${selected} is not authorized in this session. Authorized hosts: ${hosts}. Retry with an authorized host only if it is the right one for this task; otherwise end your turn and ask the user to run /hpc allow ${selected}.`);
	}
	let currentContext: ExtensionContext | undefined;
	let watcherTimer: ReturnType<typeof setTimeout> | undefined;
	let watcherTimerDueAt: number | undefined;
	let watcherPollInProgress = false;
	let lastSchedulerPollAt = 0;
	let schedulerErrorCount = 0;
	let runtimeGeneration = 0;
	let localSkillReads: LocalSkillReadCapability[] = [];
	const localOutputReads = new Map<string, string>();

	function rememberBashOutput<T extends { details: unknown }>(result: T): T {
		const path = (result.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
		const realPath = path ? tryRealpath(path) : undefined;
		if (path && realPath) localOutputReads.set(resolve(path), realPath);
		return result;
	}

	// Steer the agent toward hpc_job_watch *before* it loops into the manual-check
	// breaker: append agent-visible guidance to the output of sbatch submissions
	// and early scheduler polls. This reaches the model directly (unlike notify,
	// which only surfaces in the UI) and prevents token-burning poll loops.
	function annotateSchedulerGuidance<T extends { content?: Array<{ type: string; text?: string }> }>(
		host: string,
		command: string,
		result: T,
	): T {
		const combined = (result.content ?? [])
			.map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
			.join("\n");
		const submitted = /\bsbatch\b/.test(command) ? combined.match(/Submitted batch job (\d+)/) : null;
		let note: string | undefined;
		if (submitted) {
			note = `Reminder: Slurm job ${submitted[1]} was submitted on ${host}. To wait for it, register hpc_job_watch (action "watch", job_id "${submitted[1]}", until "running" or "finished") instead of polling squeue/sacct. Several jobs can share one watch call (job_ids). After registering, end your turn with a summary; the watcher resumes the conversation on the transition or expiry.`;
		} else if (SCHEDULER_CHECK_PATTERN.test(command)) {
			const used = manualChecks.get(host) ?? 0;
			const remaining = Math.max(0, MAX_MANUAL_SCHEDULER_CHECKS - used);
			if (used <= 1) {
				note = `Reminder: prefer hpc_job_watch over manual scheduler polling. Manual squeue/sacct/scontrol checks on ${host} are capped at ${MAX_MANUAL_SCHEDULER_CHECKS} between user/watcher updates (${remaining} left); a watch waits efficiently without spending that budget or your tokens.`;
			} else if (remaining <= 1) {
				note = `Warning: only ${remaining} manual scheduler check${remaining === 1 ? "" : "s"} left on ${host} before the guard stops the run. Register hpc_job_watch now instead of polling again.`;
			}
		}
		if (!note) return result;
		return { ...result, content: [...(result.content ?? []), { type: "text" as const, text: note }] } as T;
	}

	function isLocalOutputRead(path: string): boolean {
		const absolutePath = resolve(localCwd, path.startsWith("@") ? path.slice(1) : path);
		const expected = localOutputReads.get(absolutePath);
		return expected !== undefined && tryRealpath(absolutePath) === expected;
	}

	const jobWatches = new Map<string, JobWatch>();
	const manualChecks = new Map<string, number>();
	let monitoringStop: string | undefined;
	let stopAnnounced = false;
	let recoverableHostDenials = 0;
	// Watch-wait mode: hosts with a watch registered since the last user/watcher
	// update, and HPC-touching turns spent since the first such registration.
	const waitingHosts = new Set<string>();
	let waitingStartedThisTurn = false;
	let hpcToolThisTurn = false;
	let postWatchHpcTurns = 0;

	function requireAuthorizedOperation(host?: string): RemoteState {
		try {
			return authorizedHost(host);
		} catch (error) {
			if (!(error instanceof HostAuthorizationError)) throw error;
			const notExecuted = "No remote command was executed by this denied call.";
			if (!error.requiresUser && recoverableHostDenials < MAX_RECOVERABLE_HOST_DENIALS) {
				// Fixable by changing arguments: report it as an ordinary tool error.
				recoverableHostDenials += 1;
				throw new Error(`${error.message} ${notExecuted}`);
			}
			// A model retry cannot grant permission, and repeated host guessing is a
			// loop. Stop at the batch boundary without interrupting sibling results
			// or cancelling submitted jobs.
			const why = error.requiresUser ? "" : " after repeated host errors; tell the user which host the task needs";
			monitoringStop = `${error.message} Stopped autonomous HPC work${why}. ${notExecuted}`;
			throw new Error(monitoringStop);
		}
	}

	function resetMonitoringGuard() {
		recoverableHostDenials = 0;
		waitingHosts.clear();
		waitingStartedThisTurn = false;
		hpcToolThisTurn = false;
		postWatchHpcTurns = 0;
		manualChecks.clear();
		monitoringStop = undefined;
		stopAnnounced = false;
	}

	// Goals must not restart a stopped run or one waiting on pending watches;
	// the watcher resumes the conversation itself.
	pi.events.on("hpc-mode:waiting-query", (request: { reply: (waiting: boolean) => void }) => {
		request.reply(monitoringStop !== undefined || jobWatches.size > 0);
	});

	pi.on("input", (event) => {
		if (event.source !== "extension") resetMonitoringGuard();
	});

	pi.on("turn_end", (event: { entries?: unknown[] }, ctx) => {
		const countTurn = waitingHosts.size > 0 && hpcToolThisTurn && !waitingStartedThisTurn;
		waitingStartedThisTurn = false;
		hpcToolThisTurn = false;
		if (countTurn && !monitoringStop) {
			postWatchHpcTurns += 1;
			// The turn at MAX + 1 had its HPC calls refused with a wrap-up request.
			if (postWatchHpcTurns > MAX_POST_WATCH_HPC_TURNS + 1) {
				monitoringStop = `Stopped autonomous HPC work: HPC tools were still being called after a Slurm watch was registered and the wrap-up request was refused. Background watches remain active and will resume this conversation on a matching transition or expiry. Existing Slurm jobs are unchanged.`;
			}
		}
		if (!monitoringStop) return;
		const announce = !stopAnnounced;
		stopAnnounced = true;
		// terminate on a tool only stops unanimous batches; abort handles mixed
		// batches at the boundary without interrupting those tool results.
		ctx.abort();
		return {
			continue: false,
			// Commit at the boundary, not as a queued message that could wake the agent.
			entries: [
				...(event?.entries ?? []),
				...(announce ? [{ type: "custom_message", customType: "hpc-monitoring-guard", content: monitoringStop, display: true }] : []),
			],
		};
	});

	pi.on("agent_before_settle", () => monitoringStop || waitingHosts.size > 0 ? { continue: false } : undefined);

	function refreshLocalSkillReads(skills: readonly Skill[] | undefined, prompt: string) {
		const invokedSkillLocation = parseSkillBlock(prompt)?.location;
		localSkillReads = (skills ?? []).flatMap((skill) => {
			const filePath = resolve(skill.filePath);
			if (skill.disableModelInvocation && (!invokedSkillLocation || resolve(invokedSkillLocation) !== filePath)) return [];
			const realFilePath = tryRealpath(filePath);
			if (!realFilePath) return [];
			if (basename(filePath) !== "SKILL.md") return [{ filePath, realFilePath }];

			const directory = resolve(skill.baseDir);
			const realDirectory = tryRealpath(directory);
			return [{ filePath, realFilePath, directory, realDirectory }];
		});
	}

	function isLocalSkillRead(path: string): boolean {
		const normalized = path.startsWith("@") ? path.slice(1) : path;
		const absolutePath = resolve(localCwd, normalized);
		const candidates = localSkillReads.filter((capability) =>
			absolutePath === capability.filePath
			|| (capability.directory !== undefined && isPathWithin(absolutePath, capability.directory))
		);
		if (candidates.length === 0) return false;

		const realPath = tryRealpath(absolutePath);
		if (!realPath) return false;
		return candidates.some((capability) =>
			(absolutePath === capability.filePath && realPath === capability.realFilePath)
			|| (capability.realDirectory !== undefined && isPathWithin(realPath, capability.realDirectory))
		);
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	function updateStatus(ctx: ExtensionContext) {
		pi.events.emit("hpc-mode:workspace-changed", { host: remote?.host });
		if (!ctx.hasUI) return;
		const watchSuffix = jobWatches.size > 0 ? ` • ${jobWatches.size} job watch${jobWatches.size === 1 ? "" : "es"}` : "";
		const text = remote ? `HPC ${remote.host}:${remote.remoteCwd}${watchSuffix}`
			: authorized.size ? `Local • HPC allowed: ${[...authorized.keys()].join(", ")}${watchSuffix}` : undefined;
		ctx.ui.setStatus(STATUS_KEY, text ? ctx.ui.theme.fg("accent", text) : undefined);
	}

	function stopWatcherTimer() {
		if (watcherTimer) clearTimeout(watcherTimer);
		watcherTimer = undefined;
		watcherTimerDueAt = undefined;
	}

	function clearJobWatches(ctx: ExtensionContext | undefined, reason?: string) {
		const count = jobWatches.size;
		jobWatches.clear();
		stopWatcherTimer();
		schedulerErrorCount = 0;
		if (ctx) {
			updateStatus(ctx);
			if (count > 0 && reason) notify(ctx, `${reason} Stopped ${count} HPC job watch${count === 1 ? "" : "es"}.`);
		}
	}

	function sendWatchEvents(ctx: ExtensionContext, events: string[]) {
		if (events.length === 0) return;
		const content = `HPC Slurm watcher update:\n\n${events.map((event) => `- ${event}`).join("\n")}`;
		notify(ctx, content);
		try {
			const message = {
				customType: "hpc-job-watch",
				content,
				display: true,
				details: { events },
			};
			if (ctx.isIdle()) pi.sendMessage(message, { triggerTurn: true });
			else pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
		} catch (error) {
			notify(ctx, `Could not deliver HPC watcher update to the agent: ${formatError(error)}`, "error");
		}
	}

	function scheduleWatcherPoll(delayMs: number) {
		if (authorized.size === 0 || jobWatches.size === 0 || !currentContext) return;
		const dueAt = Date.now() + Math.max(0, delayMs);
		if (watcherTimer && watcherTimerDueAt !== undefined && watcherTimerDueAt <= dueAt) return;
		stopWatcherTimer();
		watcherTimerDueAt = dueAt;
		watcherTimer = setTimeout(() => {
			watcherTimer = undefined;
			watcherTimerDueAt = undefined;
			void pollJobWatches();
		}, Math.max(0, dueAt - Date.now()));
	}

	async function pollJobWatches() {
		if (watcherPollInProgress || authorized.size === 0 || jobWatches.size === 0 || !currentContext) return;
		const ctx = currentContext;
		const generation = runtimeGeneration;
		watcherPollInProgress = true;
		const now = Date.now();
		const events: string[] = [];

		for (const watch of [...jobWatches.values()]) {
			if (watch.expiresAt > now) continue;
			jobWatches.delete(`${watch.host}:${watch.jobId}`);
			events.push(`${watch.host}: job ${watch.jobId} watch expired before the requested ${watch.until} state was observed`);
		}

		try {
			if (jobWatches.size > 0) {
				lastSchedulerPollAt = Date.now();
				const states = new Map<string, string>();
				const snapshot = new Map(jobWatches);
				let pollError: unknown;
				for (const host of new Set([...snapshot.values()].map((watch) => watch.host))) {
					const state = authorized.get(host);
					if (!state) continue;
					const ids = [...snapshot.values()].filter((watch) => watch.host === host).map((watch) => watch.jobId);
					try {
						const hostStates = await querySlurmStates(state, ids);
						if (runtimeGeneration !== generation) return;
						if (authorized.get(host) !== state) continue;
						for (const [id, value] of hostStates) states.set(`${host}:${id}`, value);
					} catch (error) {
						if (runtimeGeneration !== generation) return;
						if (authorized.get(host) === state) pollError = error;
					}
				}
				if (pollError !== undefined) {
					schedulerErrorCount += 1;
					if (schedulerErrorCount === 1) notify(ctx, `HPC scheduler poll failed; backing off automatically: ${formatError(pollError)}`, "warning");
				} else {
					if (schedulerErrorCount > 0) notify(ctx, "HPC scheduler polling recovered.");
					schedulerErrorCount = 0;
				}

				for (const [key, watch] of snapshot) {
					if (jobWatches.get(key) !== watch) continue;
					const jobState = states.get(key) ?? "UNKNOWN";
					if (watch.lastState !== jobState) {
						notify(ctx, `${watch.host}: Slurm job ${watch.jobId}: ${jobState}`);
						watch.lastState = jobState;
					}
					const reachedRunning = watch.until === "running" && jobState === "RUNNING";
					const reachedTerminal = isTerminalJobState(jobState);
					if (!reachedRunning && !reachedTerminal) continue;

					jobWatches.delete(`${watch.host}:${watch.jobId}`);
					if (reachedRunning) events.push(`${watch.host}: job ${watch.jobId} reached RUNNING`);
					else if (watch.until === "running") {
						events.push(`${watch.host}: job ${watch.jobId} reached terminal state ${jobState} before RUNNING was observed`);
					} else {
						events.push(`${watch.host}: job ${watch.jobId} finished with state ${jobState}`);
					}
				}
			}
		} catch (error) {
			if (runtimeGeneration !== generation) return;
			schedulerErrorCount += 1;
			if (schedulerErrorCount === 1) {
				notify(ctx, `HPC scheduler poll failed; backing off automatically: ${formatError(error)}`, "warning");
			}
		} finally {
			watcherPollInProgress = false;
			if (runtimeGeneration === generation) {
				updateStatus(ctx);
				sendWatchEvents(ctx, events);
				if (jobWatches.size > 0) {
					const delay = schedulerErrorCount > 0
						? Math.min(PENDING_POLL_MS * 2 ** schedulerErrorCount, MAX_ERROR_BACKOFF_MS)
						: Math.min(...[...jobWatches.values()].map((watch) => pollIntervalFor(watch.lastState, watch.until)));
					scheduleWatcherPoll(delay);
				}
			} else if (jobWatches.size > 0 && currentContext) {
				// A new session may have added watches while the old generation was awaiting SSH.
				scheduleWatcherPoll(Math.max(0, lastSchedulerPollAt + MIN_SCHEDULER_POLL_MS - Date.now()));
			}
		}
	}

	function showHelp(ctx: ExtensionContext) {
		notify(
			ctx,
			[
				"HPC mode commands:",
				"/hpc <host> [task]",
				"/hpc connect <host> [directory]",
				"/hpc allow <host>",
				"/hpc local (keep authorization and job watches)",
				"/hpc revoke <host|all>",
				"/hpc cd <directory>",
				"/hpc status",
				"/hpc off",
				`Available aliases: ${config.hosts.join(", ") || `none (configure ${config.source || hpcConfigPath()} or PI_HPC_HOSTS)`}`,
			].join("\n"),
		);
	}

	async function authorize(host: string, ctx: ExtensionCommandContext): Promise<RemoteState | undefined> {
		if (!allowedHostSet.has(host)) {
			const allowed = config.hosts.length ? `Allowed hosts: ${config.hosts.join(", ")}.` : `No hosts are configured; add aliases to ${config.source || hpcConfigPath()} or PI_HPC_HOSTS, then /reload.`;
			notify(ctx, `HPC host is not allowlisted: ${host}. ${allowed}`, "error");
			return undefined;
		}
		if (authorized.has(host)) return authorized.get(host);
		if (!ctx.hasUI) {
			notify(ctx, "HPC access requires a user command with confirmation UI.", "error");
			return undefined;
		}
		// Confirm before even the metadata connection, not after it.
		const generation = authorizationGeneration;
		if (!await ctx.ui.confirm("Authorize HPC access for this session?",
			`Host: ${host}\n\nThe agent may execute commands, submit Slurm jobs, and upload/download files without per-operation confirmation. Credential inspection remains blocked; file removal requires the separate /rm-rights permission. Ordinary tools stay on the current workspace until /hpc <host>. Access resets on reload or session replacement.`)) return undefined;
		if (generation !== authorizationGeneration) return undefined;
		try {
			const candidate = await inspectRemote(host);
			if (generation !== authorizationGeneration) return undefined;
			authorized.set(host, candidate);
			previouslyAuthorized.add(host);
			currentContext = ctx;
			updateStatus(ctx);
			notify(ctx, `HPC access authorized: ${host}`);
			return candidate;
		} catch (error) {
			notify(ctx, `Could not authorize HPC access: ${formatError(error)}. For MFA, establish a reusable connection outside Pi first.`, "error");
			return undefined;
		}
	}

	async function connect(host: string, requestedPath: string | undefined, ctx: ExtensionCommandContext): Promise<boolean> {
		const candidate = await authorize(host, ctx);
		if (!candidate) return false;
		try {
			if (requestedPath?.trim()) candidate.remoteCwd = await resolveRemoteDirectory(candidate, requestedPath);
			remote = candidate;
			updateStatus(ctx);
			notify(ctx, `HPC workspace selected: ${remote.host}:${remote.remoteCwd}`);
			return true;
		} catch (error) {
			notify(ctx, `Could not select HPC workspace: ${formatError(error)}`, "error");
			return false;
		}
	}

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const state = remote;
			if (!state || isLocalSkillRead(params.path) || isLocalOutputRead(params.path)) return localRead.execute(id, params, signal, onUpdate);
			const tool = createReadTool(localCwd, { operations: createRemoteReadOps(state, localCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const state = remote;
			if (!state) return localWrite.execute(id, params, signal, onUpdate);
			const tool = createWriteTool(localCwd, { operations: createRemoteWriteOps(state, localCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const state = remote;
			if (!state) return localEdit.execute(id, params, signal, onUpdate);
			const tool = createEditTool(localCwd, { operations: createRemoteEditOps(state, localCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const state = remote;
			if (!state) return localBash.execute(id, params, signal, onUpdate);
			const tool = createBashTool(localCwd, { operations: createRemoteBashOps(state, localCwd, checkRemoteCommand) });
			return rememberBashOutput(annotateSchedulerGuidance(state.host, params.command, await tool.execute(id, params, signal, onUpdate)));
		},
	});

	pi.registerTool({
		name: "hpc_exec",
		label: "HPC Execute",
		description: "Execute a command on a user-authorized HPC without changing workspace routing. Uses bash-style truncation and timeouts. Commands start in that host's saved working directory; shell state does not persist. Heavy work must use Slurm.",
		parameters: Type.Object({
			host: Type.String({ description: "User-authorized SSH alias" }),
			command: Type.String(),
			cwd: Type.Optional(Type.String({ description: "Remote working directory; defaults to host's saved directory" })),
			timeout: Type.Optional(Type.Number({ minimum: 1, description: "Timeout in seconds" })),
		}),
		async execute(id, params, signal, onUpdate) {
			const state = requireAuthorizedOperation(params.host);
			const reason = checkRemoteCommand(params.command);
			if (reason) throw new Error(reason);
			const cwd = params.cwd ? posix.resolve(state.remoteCwd, expandKnownRemotePath(params.cwd, state)) : state.remoteCwd;
			assertRemotePathAllowed(cwd);
			const tool = createBashTool(localCwd, { operations: createRemoteBashOps({ ...state, remoteCwd: cwd }, localCwd, checkRemoteCommand) });
			return rememberBashOutput(annotateSchedulerGuidance(state.host, params.command, await tool.execute(id, { command: params.command, timeout: params.timeout }, signal, onUpdate)));
		},
	});

	pi.registerTool({
		name: "hpc_transfer",
		label: "HPC Transfer",
		description: "Upload or download one regular file between the local machine and an authorized HPC, independent of workspace routing. Explicit local_path and remote_path are file names (not directories or globs). Existing destination files may be overwritten. No recursive directory transfers, deletion, or SSH credential access. Uses modern OpenSSH scp/SFTP and reusable connections.",
		parameters: Type.Object({
			host: Type.String({ description: "User-authorized SSH alias" }),
			direction: StringEnum(["upload", "download"] as const),
			local_path: Type.String({ description: "Local file; relative to the original local workspace even in remote mode" }),
			remote_path: Type.String({ description: "Remote file; relative to host's saved directory; ~, $HOME and $USER supported" }),
			timeout: Type.Optional(Type.Number({ minimum: 1, description: "Timeout in seconds; defaults to 600" })),
		}),
		async execute(_id, params, signal) {
			const state = requireAuthorizedOperation(params.host);
			assertLocalPathAllowed(params.local_path);
			assertRemotePathAllowed(params.remote_path);
			const localPath = resolve(localCwd, expandLocalHome(params.local_path));
			const remotePath = posix.resolve(state.remoteCwd, expandKnownRemotePath(params.remote_path, state));
			assertLocalPathAllowed(localPath);
			assertRemotePathAllowed(remotePath);
			if (/[\x00\r\n*?\[\]{}]/.test(remotePath)) throw new Error("Remote transfer paths must be literal file names, not globs or control characters.");
			// Resolve existing ancestors, including for a destination that does not exist yet.
			let ancestor = localPath;
			while (!tryRealpath(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
			assertLocalPathAllowed(realpathSync(ancestor));
			try {
				const stat = lstatSync(localPath);
				if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Local transfer endpoint must be a regular file, not a directory or symlink.");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || params.direction === "upload") throw error;
			}
			if (!transferClientChecked) {
				const version = await runClient("ssh", ["-V"], { signal, timeoutSeconds: SSH_TIMEOUT_SECONDS });
				const match = Buffer.concat([version.stderr, version.stdout]).toString().match(/OpenSSH_(\d+)\./);
				if (version.exitCode !== 0 || !match || Number(match[1]) < 9) throw new Error(`File transfers require OpenSSH 9.0+ (SFTP-default scp); legacy shell-based scp is not supported.${IS_WINDOWS ? " On Windows, update the OpenSSH client or set \"ssh\"/\"scp\" in the HPC config to a newer build." : ""}`);
				transferClientChecked = true;
			}
			const canonical = (await sshExec(state.host, `realpath -m -- ${shellQuote(remotePath)}`, { signal, timeoutSeconds: SSH_TIMEOUT_SECONDS })).toString().trim();
			if (!canonical.startsWith("/") || /[\r\n]/.test(canonical)) throw new Error("Could not resolve a canonical remote transfer path.");
			assertRemotePathAllowed(canonical);
			const check = params.direction === "download"
				? `test -f ${shellQuote(remotePath)}`
				: `(test ! -e ${shellQuote(remotePath)} && test ! -L ${shellQuote(remotePath)}) || test -f ${shellQuote(remotePath)}`;
			await sshExec(state.host, check, { signal, timeoutSeconds: SSH_TIMEOUT_SECONDS });
			// An absolute POSIX path cannot be interpreted as another host or an option.
			// A Windows path such as C:\x looks like host "C", so run scp from the
			// file's directory and pass a ./-relative name instead.
			const endpoint = `${state.host}:${remotePath}`;
			const localArg = IS_WINDOWS ? `./${basename(localPath)}` : localPath;
			const paths = params.direction === "upload" ? [localArg, endpoint] : [endpoint, localArg];
			if (authorized.get(state.host) !== state) throw new Error("HPC authorization was revoked before transfer.");
			const result = await runClient("scp", [...sshOptions(), "--", ...paths], {
				signal, timeoutSeconds: params.timeout ?? 600, ...(IS_WINDOWS ? { cwd: dirname(localPath) } : {}),
			});
			if (result.exitCode !== 0) throw new Error(`HPC transfer failed (${result.exitCode}): ${result.stderr.toString().slice(-4000)}`);
			return { content: [{ type: "text", text: `${params.direction}: ${localPath} ↔ ${endpoint}` }], details: { host: state.host, direction: params.direction, localPath, remotePath } };
		},
	});

	pi.registerTool({
		name: "hpc_job_watch",
		label: "HPC Job Watch",
		description:
			"Manage conservative background Slurm job watches on user-authorized HPC hosts, including while the workspace is local. Actions: watch (job_id or job_ids; until defaults to running), list, and stop (job_id optional; omitted stops all). After a successful watch, finish remaining submissions and end your turn with a summary; manual scheduler checks and sleep on that host are refused, and only a few further HPC-touching turns are allowed. The harness polls Slurm without model requests (about every minute while pending/unknown, every 3 minutes while running toward finished, with jitter, rate limiting, and backoff) and resumes the conversation only when a job reaches the requested state, ends, or the watch expires. Watches stop on those events, host revocation, reload, or session shutdown; switching workspaces does not stop them.",
		promptSnippet: "Watch Slurm jobs without remote sleep processes or aggressive scheduler polling",
		promptGuidelines: [
			"Use hpc_job_watch instead of sleep or watch commands when waiting for a Slurm job to start or finish on an authorized HPC host.",
			"After registering a watch, do not wait or poll: finish remaining submissions, then end your turn with a summary. The watcher resumes the conversation on a transition or expiry.",
		],
		parameters: HpcJobWatchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentContext = ctx;
			if (params.action === "watch") {
				const state = requireAuthorizedOperation(params.host);
				const jobIds = [...new Set([params.job_id, ...(params.job_ids ?? [])]
					.map((id) => id?.trim())
					.filter((id): id is string => Boolean(id)))];
				// Validate everything first so a bad ID registers nothing.
				if (jobIds.length === 0 || jobIds.some((id) => !JOB_ID_PATTERN.test(id))) {
					throw new Error("watch requires numeric Slurm job IDs (job_id or job_ids), each optionally with one _array or +heterogeneous suffix");
				}
				const added = jobIds.filter((id) => !jobWatches.has(`${state.host}:${id}`)).length;
				if (jobWatches.size + added > MAX_JOB_WATCHES) {
					throw new Error(`at most ${MAX_JOB_WATCHES} Slurm jobs can be watched in one session (${jobWatches.size} already watched)`);
				}
				const now = Date.now();
				const until = params.until ?? "running";
				const maxWaitMinutes = params.max_wait_minutes ?? DEFAULT_WATCH_MAX_MINUTES;
				for (const jobId of jobIds) {
					jobWatches.set(`${state.host}:${jobId}`, {
						host: state.host,
						jobId,
						until,
						createdAt: now,
						expiresAt: now + maxWaitMinutes * 60_000,
					});
				}
				updateStatus(ctx);
				const rateLimitedDelay = Math.max(0, lastSchedulerPollAt + MIN_SCHEDULER_POLL_MS - Date.now());
				scheduleWatcherPoll(rateLimitedDelay);
				const jobs = `job${jobIds.length === 1 ? "" : "s"} ${jobIds.join(", ")}`;
				const response = {
					action: "watch",
					host: state.host,
					job_ids: jobIds,
					until,
					max_wait_minutes: maxWaitMinutes,
					polling: "aggregated; approximately 60s while any job is pending/unknown, otherwise 3m, with jitter, rate limiting, and backoff",
				};
				if (waitingHosts.size === 0) waitingStartedThisTurn = true;
				waitingHosts.add(state.host);
				const guidance = `Watching ${state.host} ${jobs} until ${until}. The harness polls Slurm in the background and resumes this conversation with an hpc-job-watch message when a job reaches ${until}, ends, or the watch expires after ${maxWaitMinutes} minutes. A job still in the queue does not wake you. Manual scheduler checks and sleep on ${state.host} are now refused. Finish any remaining submissions, then end your turn with a short summary for the user.`;
				return { content: [{ type: "text", text: `${guidance}\n\n${JSON.stringify(response, null, 2)}` }], details: response };
			}

			if (params.action === "stop") {
				const jobId = params.job_id?.trim();
				if (jobId) {
					if (!JOB_ID_PATTERN.test(jobId)) throw new Error("invalid Slurm job_id");
					const state = authorizedHost(params.host);
					const stopped = jobWatches.delete(`${state.host}:${jobId}`);
					if (jobWatches.size === 0) stopWatcherTimer();
					updateStatus(ctx);
					const response = { action: "stop", job_id: jobId, stopped, remaining: jobWatches.size };
					return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
				}
				let stopped = 0;
				for (const [key, watch] of jobWatches) {
					if (params.host && watch.host !== params.host.trim().toLowerCase()) continue;
					jobWatches.delete(key);
					stopped += 1;
				}
				if (jobWatches.size === 0) stopWatcherTimer();
				updateStatus(ctx);
				const response = { action: "stop", stopped, remaining: jobWatches.size };
				return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
			}

			const watches = [...jobWatches.values()].map((watch) => ({
				host: watch.host,
				job_id: watch.jobId,
				until: watch.until,
				last_state: watch.lastState ?? "not checked yet",
				created_at: new Date(watch.createdAt).toISOString(),
				expires_at: new Date(watch.expiresAt).toISOString(),
			}));
			const response = { action: "list", watches: params.host ? watches.filter((watch) => watch.host === params.host!.trim().toLowerCase()) : watches };
			return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
		},
	});

	pi.registerCommand("hpc", {
		description: "Authorize HPC hosts or select a local/remote workspace",
		getArgumentCompletions: (prefix) => {
			const hostAction = prefix.trimStart().match(/^(allow|revoke|connect)\s+(.*)$/);
			if (hostAction) {
				const aliases = [...config.hosts, ...(hostAction[1] === "revoke" ? ["all"] : [])];
				const items = aliases.filter((host) => host.startsWith(hostAction[2])).map((host) => ({ value: `${hostAction[1]} ${host}`, label: host }));
				return items.length ? items : null;
			}
			const options = ["allow", "revoke", "connect", ...config.hosts, "cd", "status", "local", "off", "help"];
			const normalized = prefix.trim();
			const items = options
				.filter((value) => value.startsWith(normalized))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status") {
				if (remote) notify(ctx, `HPC mode is active: ${remote.username}@${remote.host}:${remote.remoteCwd}`);
				else notify(ctx, "Workspace: local.");
				notify(ctx, `Authorized hosts: ${[...authorized.keys()].join(", ") || "none"}. Available aliases: ${config.hosts.join(", ") || "none configured"}.`);
				return;
			}

			const [action = "", ...rest] = trimmed.split(/\s+/);
			const lowerAction = action.toLowerCase();
			if (lowerAction === "status") {
				if (remote) notify(ctx, `HPC mode is active: ${remote.username}@${remote.host}:${remote.remoteCwd}`);
				else notify(ctx, "Workspace: local.");
				notify(ctx, `Authorized hosts: ${[...authorized.keys()].join(", ") || "none"}. Available aliases: ${config.hosts.join(", ") || "none configured"}.`);
				return;
			}
			if (lowerAction === "help") {
				showHelp(ctx);
				return;
			}
			if (lowerAction === "allow") {
				if (rest.length !== 1) { showHelp(ctx); return; }
				await authorize(rest[0].toLowerCase(), ctx);
				return;
			}
			if (lowerAction === "revoke") {
				if (rest.length !== 1) { showHelp(ctx); return; }
				const host = rest[0].toLowerCase();
				authorizationGeneration += 1;
				if (host === "all") authorized.clear();
				else authorized.delete(host);
				if (remote && !authorized.has(remote.host)) remote = undefined;
				for (const [key, watch] of jobWatches) if (!authorized.has(watch.host)) jobWatches.delete(key);
				if (jobWatches.size === 0) stopWatcherTimer();
				updateStatus(ctx);
				notify(ctx, `Revoked HPC access: ${host}. Existing submitted jobs are not cancelled.`);
				return;
			}
			if (["off", "disconnect", "local"].includes(lowerAction)) {
				remote = undefined;
				updateStatus(ctx);
				notify(ctx, "Tools are local. HPC authorization and job watches are retained; use /hpc revoke <host|all> to revoke access.");
				return;
			}
			if (lowerAction === "cd") {
				if (!remote) {
					notify(ctx, "HPC mode is off. Connect first with /hpc connect <host>.", "warning");
					return;
				}
				const requestedPath = trimmed.slice(action.length).trim();
				if (!requestedPath) {
					notify(ctx, "Usage: /hpc cd <remote-directory>", "warning");
					return;
				}
				try {
					remote.remoteCwd = await resolveRemoteDirectory(remote, requestedPath);
					updateStatus(ctx);
					notify(ctx, `Remote directory: ${remote.host}:${remote.remoteCwd}`);
				} catch (error) {
					notify(ctx, `Could not change remote directory: ${formatError(error)}`, "error");
				}
				return;
			}

			if (lowerAction === "connect") {
				const host = rest[0]?.toLowerCase();
				if (!host) {
					showHelp(ctx);
					return;
				}
				const path = rest.length > 1 ? trimmed.replace(/^connect\s+\S+\s*/i, "").trim() : undefined;
				await connect(host, path, ctx);
				return;
			}

			if (allowedHostSet.has(lowerAction)) {
				const task = trimmed.slice(action.length).trim();
				const activated = await connect(lowerAction, undefined, ctx);
				if (activated && task) pi.sendUserMessage(task, { expandPromptTemplates: true });
				return;
			}

			showHelp(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		reloadConfig();
		for (const error of configErrors) notify(ctx, `HPC mode: ${error}`, "warning");
		releaseLiveness?.();
		releaseLiveness = undefined;
		localCwd = ctx.cwd;
		localRead = createReadTool(localCwd);
		localWrite = createWriteTool(localCwd);
		localEdit = createEditTool(localCwd);
		localBash = createBashTool(localCwd);
		authorizationGeneration += 1;
		runtimeGeneration += 1;
		clearJobWatches(undefined);
		resetMonitoringGuard();
		authorized.clear();
		previouslyAuthorized.clear();
		transferClientChecked = false;
		remote = undefined;
		currentContext = ctx;
		localSkillReads = [];
		localOutputReads.clear();
		// Optional host protocol: absent in the CLI, supported by Pi Web.
		// Protect only actual detached work, not every idle session.
		const liveness = (globalThis as Record<symbol, unknown>)[Symbol.for("@agegr/pi-web/session-liveness/v1")] as {
			version: number;
			register(provider: { name: string; sessionId: string; sessionFile?: string; isActive: () => boolean }): () => void;
		} | undefined;
		if (liveness?.version === 1) {
			releaseLiveness = liveness.register({
				name: "hpc-job-watches",
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile() || undefined,
				isActive: () => jobWatches.size > 0 || watcherPollInProgress,
			});
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		releaseLiveness?.();
		releaseLiveness = undefined;
		authorizationGeneration += 1;
		runtimeGeneration += 1;
		clearJobWatches(undefined);
		resetMonitoringGuard();
		authorized.clear();
		transferClientChecked = false;
		remote = undefined;
		currentContext = undefined;
		localOutputReads.clear();
		updateStatus(ctx);
	});

	// A watcher update that arrives while the agent is still busy is queued as a
	// follow-up and joins the current run, so before_agent_start never sees it.
	// Reset wait mode when the model actually receives the update instead.
	pi.on("message_start", (event: { message?: { role?: string; customType?: string } }) => {
		if (event.message?.role === "custom" && event.message.customType === "hpc-job-watch") resetMonitoringGuard();
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "custom" && event.message?.customType === "hpc-job-watch") resetMonitoringGuard();
		refreshLocalSkillReads(event.systemPromptOptions.skills, event.prompt ?? "");
		if (authorized.size === 0) return {
			systemPrompt: `${event.systemPrompt}\n\n# Current HPC authorization\nAuthorized hosts: none. Workspace: local. Previous grants in the conversation are historical, not current permission. Do not request remote execution, transfers, or watch registration until the user runs /hpc allow <host>. Reload and idle session shutdown clear permission; existing Slurm jobs are not cancelled.`,
		};
		const systemPrompt = remote ? event.systemPrompt.replace(
			`Current working directory: ${localCwd}`,
			`Current working directory: ${remote.remoteCwd} (via SSH: ${remote.host})`,
		) : event.systemPrompt;
		const workspace = remote ? `${remote.username}@${remote.host}:${remote.remoteCwd}` : `local:${localCwd}`;
		const extra = config.guidance.length ? `\n\n## Site-specific guidance\n\n${config.guidance.join("\n")}` : "";
		return {
			systemPrompt: `${systemPrompt}\n\n${HPC_GUIDANCE}${extra}\n\nAuthorized hosts: ${[...authorized.keys()].join(", ")}\nSelected workspace: ${workspace}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		// Let siblings in the current batch finish; once the boundary has stopped
		// the run, automated retries cannot restart tools without fresh input.
		if (monitoringStop && stopAnnounced) return { block: true, reason: monitoringStop, terminate: true };
		const requiresAuthorization = event.toolName === "hpc_exec" || event.toolName === "hpc_transfer"
			|| (event.toolName === "hpc_job_watch" && event.input.action === "watch");
		if (requiresAuthorization) {
			try {
				requireAuthorizedOperation(typeof event.input.host === "string" ? event.input.host : undefined);
			} catch (error) {
				// Only denials that set the stop end the batch; fixable host
				// mistakes come back as ordinary tool errors.
				return { block: true, reason: formatError(error), ...(monitoringStop ? { terminate: true } : {}) };
			}
		}
		const host = event.toolName === "hpc_exec" && typeof event.input.host === "string"
			? event.input.host.trim().toLowerCase()
			: event.toolName === "bash" ? remote?.host : undefined;
		const command = typeof event.input.command === "string" ? event.input.command : undefined;
		if (waitingHosts.size > 0) {
			// Registering a watch is the wrap-up the guard asks for, so it is never
			// counted or refused as follow-up HPC work.
			const touchesHpc = (requiresAuthorization && event.toolName !== "hpc_job_watch") || (remote !== undefined && ["bash", "read", "write", "edit"].includes(event.toolName));
			if (touchesHpc) {
				hpcToolThisTurn = true;
				if (postWatchHpcTurns >= MAX_POST_WATCH_HPC_TURNS) {
					return { block: true, reason: `A Slurm watch is registered and the ${MAX_POST_WATCH_HPC_TURNS} follow-up HPC turns are used. Do not call more HPC tools now: reply to the user with what you did and end your turn. The watcher will resume this conversation on a transition or expiry; further HPC calls stop the run.` };
				}
			}
			if (command && (event.toolName === "bash" || event.toolName === "hpc_exec") && SLEEP_PATTERN.test(command)) {
				return { block: true, reason: "A Slurm watch is registered, so sleep-based waiting is refused. End your turn with a summary; the watcher resumes this conversation on a transition or expiry." };
			}
			if (host && waitingHosts.has(host) && command && SCHEDULER_CHECK_PATTERN.test(command)) {
				return { block: true, reason: `A Slurm watch is registered on ${host}, so manual scheduler checks there are refused until the next user message or watcher update. Continue other work or end your turn with a summary.` };
			}
		}
		if (host && authorized.has(host) && command && SCHEDULER_CHECK_PATTERN.test(command)) {
			const count = manualChecks.get(host) ?? 0;
			if (count >= MAX_MANUAL_SCHEDULER_CHECKS) {
				monitoringStop = `Stopped repeated manual scheduler checks on ${host} after ${MAX_MANUAL_SCHEDULER_CHECKS} commands. Use hpc_job_watch for waiting. Existing watches and Slurm jobs are unchanged; a new user request or watcher update allows fresh checks.`;
				return { block: true, reason: monitoringStop, terminate: true };
			}
			manualChecks.set(host, count + 1);
		}
		if (!remote || (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = event.input.path;
		if (typeof path === "string" && remotePathTouchesSsh(path)) {
			notify(ctx, "Blocked access to a remote .ssh directory.", "warning");
			return { block: true, reason: "Remote .ssh access is blocked; ask the user directly for SSH-related information." };
		}
	});

	pi.on("user_bash", () => {
		const state = remote;
		if (!state) return;
		return { operations: createRemoteBashOps(state, localCwd, (command) => shellSafetyReason(command, true)) };
	});
}
