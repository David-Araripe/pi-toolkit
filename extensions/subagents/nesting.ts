// No recursive spawning: a pi session started from inside a delegated agent
// refuses to run. The check happens in the new process, at session start, so
// it does not depend on how that process was launched (script, python,
// symlink, another shell) or on what the command text looked like.
import { execFileSync } from "node:child_process";
import { readState, type RunState } from "./store.ts";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	command: string;
}

export const NESTED_SESSION_REFUSED = "Refused: this pi session was started from inside a delegated agent. Subagents cannot start pi sessions; do the work yourself, or end your turn and ask your coordinator.";

// index.ts starts workers as `node … <extension>/subagents/worker.ts <runDir>`.
const WORKER_COMMAND = /[\\/]subagents[\\/]worker\.ts (.+)$/;
const MAX_ANCESTORS = 64;

// One `ps` for the whole table: about as cheap as asking for a single process.
export function processTable(): ProcessInfo[] {
	const output = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], {
		encoding: "utf8", timeout: 2000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
	});
	return output.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
	});
}

export function nestedSessionReason(
	env: NodeJS.ProcessEnv = process.env,
	ppid: number = process.ppid,
	table: () => ProcessInfo[] = processTable,
	state: (dir: string) => RunState | undefined = readState,
): string | undefined {
	// A delegated session is legitimate only as the direct child of its run's
	// worker. Anything else carrying the marker was started by a subagent (or by
	// one of its tools). Fails closed, and needs no process listing.
	if (env.PI_SUBAGENT || env.PI_SUBAGENT_RUN_DIR) {
		const worker = env.PI_SUBAGENT_RUN_DIR ? state(env.PI_SUBAGENT_RUN_DIR)?.workerPid : undefined;
		return worker !== undefined && worker === ppid ? undefined : NESTED_SESSION_REFUSED;
	}
	// Without the marker this looks like a root session. If the environment was
	// wiped, the process tree still tells: a live worker among the ancestors.
	// Fails open: a root session must start even where `ps` is missing or odd.
	let processes: ProcessInfo[];
	try {
		processes = table();
	} catch {
		return undefined;
	}
	const byPid = new Map(processes.map((p) => [p.pid, p]));
	for (let pid = ppid, depth = 0; pid > 1 && depth < MAX_ANCESTORS; depth += 1) {
		const ancestor = byPid.get(pid);
		if (!ancestor) break;
		const dir = WORKER_COMMAND.exec(ancestor.command)?.[1];
		// The run's own state confirms the worker, so a look-alike command line is not enough.
		if (dir && state(dir)?.workerPid === pid) return NESTED_SESSION_REFUSED;
		pid = ancestor.ppid;
	}
	return undefined;
}
