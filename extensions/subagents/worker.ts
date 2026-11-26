// Detached worker: owns one child CLI (pi RPC, Claude stream-json or Codex
// app-server), applies inbox commands, and records state, transcript, raw
// protocol events and reports under the run directory.
//
// Usage: node worker.ts <runDir>
//
// Protocol knowledge for Claude and Codex was informed by pi-cli-subagents
// (MIT, joshua-zyy); the inbox/bridge idea follows Mario Zechner's
// pi-subagent. No code is copied from either project.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	appendEvent, appendTranscript, readSpec, readState, takeInbox, updateState, validateMode, writeReport,
	type InboxCommand, type RunSpec, type TranscriptEntry,
} from "./store.ts";

type Json = Record<string, any>;
type Delivery = "auto" | "steer" | "followUp";

const POLL_MS = Number(process.env.PI_SUBAGENTS_POLL_MS || 400);
const MAX_RECORD = 16 * 1024 * 1024;
const TOOL_TEXT_LIMIT = 4000;

function clip(text: string, limit = TOOL_TEXT_LIMIT): string {
	return text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} more characters]` : text;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

interface Hooks {
	transcript(entry: Omit<TranscriptEntry, "at">): void;
	turnEnd(status: "completed" | "failed" | "interrupted", text: string, error?: string): void;
	approval(requestId: string, tool: string, summary: string): void;
	session(id: string, transcript?: string): void;
	busy(busy: boolean): void;
}

abstract class Adapter {
	protected child!: ChildProcessWithoutNullStreams;
	protected buffer = "";
	busy = false;
	exited = false;
	onExit?: (code: number | null, signal: string | null) => void;
	protected spec: RunSpec;
	protected dir: string;
	protected hooks: Hooks;
	constructor(spec: RunSpec, dir: string, hooks: Hooks) {
		this.spec = spec;
		this.dir = dir;
		this.hooks = hooks;
	}

	abstract start(resumeId: string | undefined): Promise<void>;
	abstract send(message: string, delivery: Delivery): Promise<void>;
	abstract interrupt(): Promise<void>;
	abstract reply(requestId: string, allow: boolean, reason?: string): Promise<void>;
	protected abstract record(record: Json): void;

	protected launch(command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
		appendEvent(this.dir, "worker", { launch: command, args });
		this.child = spawn(command, args, {
			cwd: this.spec.cwd,
			// PI_AGENT_COMM_ID names the child's agent-comm identity; without a member record it does nothing.
			env: { ...process.env, ...env, PI_SUBAGENT: "1", PI_SUBAGENT_RUN_DIR: this.dir, PI_AGENT_COMM_ID: this.spec.id },
			stdio: ["pipe", "pipe", "pipe"],
		});
		updateState(this.dir, { childPid: this.child.pid });
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => {
			this.buffer += chunk;
			// Split on LF only: JSON strings may contain U+2028/U+2029.
			let newline: number;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline).replace(/\r$/, "");
				this.buffer = this.buffer.slice(newline + 1);
				if (!line.trim()) continue;
				let record: Json;
				try {
					record = JSON.parse(line);
				} catch {
					appendEvent(this.dir, "in", { unparsed: clip(line, 2000) });
					continue;
				}
				appendEvent(this.dir, "in", record);
				try {
					this.record(record);
				} catch (error) {
					appendEvent(this.dir, "worker", { handlerError: String(error) });
				}
			}
			if (this.buffer.length > MAX_RECORD) this.buffer = "";
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => appendEvent(this.dir, "err", chunk));
		this.child.on("error", (error) => appendEvent(this.dir, "worker", { childError: String(error) }));
		this.child.on("close", (code, signal) => {
			this.exited = true;
			this.onExit?.(code, signal);
		});
	}

	protected write(record: Json): void {
		if (this.exited) throw new Error("Child process has exited");
		appendEvent(this.dir, "out", record);
		this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	async close(): Promise<void> {
		if (this.exited) return;
		this.child.stdin.end();
		const done = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
		const timer = setTimeout(() => this.child.kill("SIGTERM"), 5000);
		const hard = setTimeout(() => this.child.kill("SIGKILL"), 15000);
		await done;
		clearTimeout(timer);
		clearTimeout(hard);
	}

	protected setBusy(busy: boolean): void {
		this.busy = busy;
		this.hooks.busy(busy);
	}
}

// ---------------------------------------------------------------- pi (RPC)

class PiAdapter extends Adapter {
	private pending = new Map<string, (response: Json) => void>();
	private lastAssistant = "";
	private queued: string[] = [];

	private request(command: Json): Promise<Json> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`pi ${command.type} timed out`));
			}, 60_000);
			this.pending.set(id, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
			this.write({ ...command, id });
		});
	}

	async start(resumeId: string | undefined): Promise<void> {
		const args = ["--mode", "rpc", "--name", `subagent ${this.spec.name}`];
		if (resumeId) args.push("--session", resumeId);
		if (this.spec.model) args.push("--model", this.spec.model);
		if (this.spec.effort) args.push("--thinking", this.spec.effort);
		this.launch(this.spec.bin || "pi", args);
		const state = await this.request({ type: "get_state" });
		if (!state.success) throw new Error(`pi get_state failed: ${state.error ?? "unknown"}`);
		this.hooks.session(state.data.sessionFile || state.data.sessionId, state.data.sessionFile);
	}

	async send(message: string, delivery: Delivery): Promise<void> {
		if (!this.busy) this.setBusy(true);
		const streamingBehavior = delivery === "followUp" ? "followUp" : "steer";
		const response = await this.request({ type: "prompt", message, streamingBehavior });
		if (!response.success) throw new Error(`pi rejected the prompt: ${response.error ?? "unknown"}`);
	}

	async interrupt(): Promise<void> {
		await this.request({ type: "abort" });
	}

	async reply(): Promise<void> {
		throw new Error("pi children do not raise permission requests");
	}

	protected record(record: Json): void {
		if (record.type === "response" && typeof record.id === "string") {
			this.pending.get(record.id)?.(record);
			this.pending.delete(record.id);
			return;
		}
		if (record.type === "extension_ui_request") {
			// No human is attached to a child; dialogs are declined, not guessed.
			if (["select", "confirm", "input", "editor"].includes(record.method)) {
				this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
				this.hooks.transcript({ role: "system", text: `Declined extension dialog: ${record.title ?? record.method}` });
			}
			return;
		}
		if (record.type === "agent_start") {
			if (!this.busy) this.setBusy(true);
			return;
		}
		if (record.type === "message_end") {
			const message = record.message ?? {};
			if (message.role === "user") this.hooks.transcript({ role: "user", text: textOf(message.content) });
			if (message.role === "assistant") {
				for (const part of message.content ?? []) {
					if (part.type === "text" && part.text) {
						this.lastAssistant = part.text;
						this.hooks.transcript({ role: "assistant", text: part.text });
					}
					if (part.type === "thinking" && part.thinking) this.hooks.transcript({ role: "thinking", text: part.thinking });
					if (part.type === "toolCall") this.hooks.transcript({ role: "tool", tool: part.name, text: clip(JSON.stringify(part.arguments ?? {})) });
				}
				if (message.stopReason === "error" && message.errorMessage) this.hooks.transcript({ role: "error", text: message.errorMessage });
			}
			if (message.role === "toolResult") this.hooks.transcript({ role: "result", tool: message.toolName, text: clip(textOf(message.content)) });
			return;
		}
		if (record.type === "agent_settled") {
			this.setBusy(false);
			this.hooks.turnEnd(record.aborted ? "interrupted" : "completed", this.lastAssistant);
			this.lastAssistant = "";
		}
	}
}

// ---------------------------------------------------- Claude Code (stream-json)

function claudeSettings(dir: string, root: string): string {
	const shell = ["rm", "rmdir", "unlink", "shred", "trash", "git clean", "git reset --hard", "ssh", "scp", "sftp", "mosh", "claude", "codex"];
	const home = homedir();
	const settings = {
		permissions: {
			deny: [
				...shell.map((command) => `Bash(${command}:*)`),
				`Read(${home}/.ssh/**)`,
				`Edit(${home}/.ssh/**)`,
				`Edit(${root}/**)`,
			],
		},
	};
	const path = join(dir, "claude-settings.json");
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	return path;
}

class ClaudeAdapter extends Adapter {
	private sessionId?: string;
	private transcriptPath?: string;
	// Claude reports an interrupted turn as error_during_execution.
	private interrupting = false;
	private controls = new Map<string, (response: Json) => void>();
	private permissions = new Map<string, Json>();
	private lastAssistant = "";

	private control(request: Json): Promise<Json> {
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.controls.delete(requestId);
				reject(new Error(`Claude ${request.subtype} timed out`));
			}, 60_000);
			this.controls.set(requestId, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
			this.write({ type: "control_request", request_id: requestId, request });
		});
	}

	async start(resumeId: string | undefined): Promise<void> {
		const mode = validateMode("claude", this.spec.mode)!;
		const sessionId = resumeId ?? randomUUID();
		const root = join(this.dir, "..", "..");
		const args = [
			"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
			"--permission-prompt-tool", "stdio", "--permission-mode", mode,
			"--settings", claudeSettings(this.dir, root),
			resumeId ? "--resume" : "--session-id", sessionId,
		];
		if (this.spec.model) args.push("--model", this.spec.model);
		if (this.spec.effort) args.push("--effort", this.spec.effort);
		// Never resume an interrupted turn on its own; this worker decides what runs.
		this.launch(this.spec.bin || "claude", args, { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "" });
		const response = await this.control({ subtype: "initialize" });
		if (response.subtype !== "success") throw new Error(`Claude initialize failed: ${response.error ?? "unknown"}`);
		this.sessionId = sessionId;
		this.transcriptPath = findClaudeTranscript(sessionId);
		this.hooks.session(sessionId, this.transcriptPath);
	}

	async send(message: string): Promise<void> {
		// Claude queues a user message that arrives during a turn and reads it next.
		if (!this.busy) this.setBusy(true);
		this.write({ type: "user", message: { role: "user", content: message } });
		this.hooks.transcript({ role: "user", text: message });
	}

	async interrupt(): Promise<void> {
		this.interrupting = true;
		await this.control({ subtype: "interrupt" });
	}

	async reply(requestId: string, allow: boolean, reason?: string): Promise<void> {
		const request = this.permissions.get(requestId);
		if (!request) throw new Error(`No pending Claude permission request ${requestId}`);
		this.permissions.delete(requestId);
		const response = allow
			? { behavior: "allow", updatedInput: request.input ?? {} }
			: { behavior: "deny", message: reason || "Denied by the coordinating agent." };
		this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
		this.hooks.transcript({ role: "approval", tool: request.tool_name, text: `${allow ? "Allowed once" : "Denied"}${reason ? `: ${reason}` : ""}` });
	}

	protected record(record: Json): void {
		if (record.type === "control_response") {
			const response = record.response ?? {};
			this.controls.get(response.request_id)?.(response);
			this.controls.delete(response.request_id);
			return;
		}
		if (record.type === "control_request" && record.request?.subtype === "can_use_tool") {
			const request = record.request;
			this.permissions.set(record.request_id, request);
			const summary = clip(`${request.tool_name}: ${request.description ?? ""}\n${JSON.stringify(request.input ?? {})}`, 2000);
			this.hooks.transcript({ role: "approval", tool: request.tool_name, text: `Permission requested\n${summary}` });
			this.hooks.approval(record.request_id, request.tool_name, summary);
			return;
		}
		if (record.type === "control_request") {
			// Unknown control requests (hooks, MCP) are refused rather than guessed.
			this.write({ type: "control_response", response: { subtype: "error", request_id: record.request_id, error: "Not supported by pi subagent worker" } });
			return;
		}
		if (record.type === "control_cancel_request") {
			this.permissions.delete(record.request_id);
			return;
		}
		if (record.type === "assistant") {
			for (const part of record.message?.content ?? []) {
				if (part.type === "text" && part.text) {
					this.lastAssistant = part.text;
					this.hooks.transcript({ role: "assistant", text: part.text });
				}
				if (part.type === "thinking" && part.thinking) this.hooks.transcript({ role: "thinking", text: part.thinking });
				if (part.type === "tool_use") this.hooks.transcript({ role: "tool", tool: part.name, text: clip(JSON.stringify(part.input ?? {})) });
			}
			return;
		}
		if (record.type === "user" && Array.isArray(record.message?.content)) {
			for (const part of record.message.content) {
				if (part.type === "tool_result") this.hooks.transcript({ role: "result", text: clip(typeof part.content === "string" ? part.content : textOf(part.content)) });
			}
			return;
		}
		if (record.type === "result") {
			// Claude writes its transcript file only after the first turn.
			if (!this.transcriptPath && this.sessionId) {
				this.transcriptPath = findClaudeTranscript(this.sessionId);
				if (this.transcriptPath) this.hooks.session(this.sessionId, this.transcriptPath);
			}
			this.setBusy(false);
			const failed = record.is_error || (record.subtype && record.subtype !== "success");
			const text = typeof record.result === "string" && record.result ? record.result : this.lastAssistant;
			const interrupted = failed && this.interrupting;
			this.interrupting = false;
			if (interrupted) this.hooks.turnEnd("interrupted", text);
			else this.hooks.turnEnd(failed ? "failed" : "completed", text, failed ? String(record.subtype ?? "error") : undefined);
			this.lastAssistant = "";
		}
	}
}

function findClaudeTranscript(sessionId: string): string | undefined {
	const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
	if (!existsSync(projects)) return undefined;
	for (const project of readdirSync(projects)) {
		const candidate = join(projects, project, `${sessionId}.jsonl`);
		if (existsSync(candidate)) return candidate;
	}
	// The file appears after the first turn; report the expected directory meanwhile.
	return undefined;
}

// --------------------------------------------------------- Codex (app-server)

class CodexAdapter extends Adapter {
	private nextId = 1;
	private calls = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
	private approvals = new Map<string, { id: number | string; method: string }>();
	private threadId?: string;
	private turnId?: string;
	private lastAssistant = "";
	private followUps: string[] = [];

	private call(method: string, params: Json): Promise<Json> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.calls.delete(id);
				reject(new Error(`Codex ${method} timed out`));
			}, 120_000);
			this.calls.set(id, {
				resolve: (value) => { clearTimeout(timer); resolve(value); },
				reject: (error) => { clearTimeout(timer); reject(error); },
			});
			this.write({ id, method, params });
		});
	}

	async start(resumeId: string | undefined): Promise<void> {
		const sandbox = validateMode("codex", this.spec.mode)!;
		this.launch(this.spec.bin || "codex", ["app-server", "--listen", "stdio://"]);
		await this.call("initialize", { clientInfo: { name: "pi-subagents", title: "pi subagents", version: "1.0.0" }, capabilities: null });
		this.write({ method: "initialized" });
		const config: Json = {};
		if (this.spec.effort) config.model_reasoning_effort = this.spec.effort;
		// on-request routes escalations to the auto reviewer, then to this worker.
		const common = { cwd: this.spec.cwd, sandbox, approvalPolicy: "on-request", approvalsReviewer: "auto_review", config, ...(this.spec.model ? { model: this.spec.model } : {}) };
		const result = resumeId
			? await this.call("thread/resume", { threadId: resumeId, ...common })
			: await this.call("thread/start", common);
		this.threadId = result.thread?.id;
		if (!this.threadId) throw new Error("Codex did not return a thread id");
		this.hooks.session(this.threadId, result.thread?.path ?? undefined);
		if (this.spec.goal && !resumeId) {
			await this.call("thread/goal/set", { threadId: this.threadId, objective: this.spec.goal, status: "active", origin: "user" }).catch((error) => {
				this.hooks.transcript({ role: "error", text: `Could not set Codex goal: ${error.message}` });
			});
		}
	}

	private async startTurn(message: string): Promise<void> {
		this.setBusy(true);
		this.hooks.transcript({ role: "user", text: message });
		const result = await this.call("turn/start", { threadId: this.threadId, input: [{ type: "text", text: message, text_elements: [] }] });
		this.turnId = result.turn?.id;
	}

	async send(message: string, delivery: Delivery): Promise<void> {
		if (!this.busy) return this.startTurn(message);
		if (delivery === "followUp" || !this.turnId) {
			this.followUps.push(message);
			this.hooks.transcript({ role: "system", text: `Queued follow-up: ${clip(message, 500)}` });
			return;
		}
		this.hooks.transcript({ role: "user", text: message });
		await this.call("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: "text", text: message, text_elements: [] }] });
	}

	async interrupt(): Promise<void> {
		if (this.turnId) await this.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
	}

	async reply(requestId: string, allow: boolean, reason?: string): Promise<void> {
		const approval = this.approvals.get(requestId);
		if (!approval) throw new Error(`No pending Codex approval ${requestId}`);
		this.approvals.delete(requestId);
		this.write({ id: approval.id, result: { decision: allow ? "accept" : "decline" } });
		this.hooks.transcript({ role: "approval", text: `${allow ? "Accepted once" : "Declined"}${reason ? `: ${reason}` : ""}` });
	}

	protected record(record: Json): void {
		if (record.id !== undefined && record.method) return this.serverRequest(record);
		if (record.id !== undefined) {
			const call = this.calls.get(record.id);
			this.calls.delete(record.id);
			if (record.error) call?.reject(new Error(record.error.message ?? JSON.stringify(record.error)));
			else call?.resolve(record.result ?? {});
			return;
		}
		const params = record.params ?? {};
		switch (record.method) {
			case "turn/started":
				this.turnId = params.turn?.id ?? this.turnId;
				if (!this.busy) this.setBusy(true);
				return;
			case "item/completed":
				return this.item(params.item ?? {});
			case "error":
				this.hooks.transcript({ role: "error", text: clip(JSON.stringify(params.error ?? params)) });
				return;
			case "turn/completed": {
				const turn = params.turn ?? {};
				const status = turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "interrupted" : "completed";
				this.turnId = undefined;
				const text = this.lastAssistant;
				this.lastAssistant = "";
				const next = this.followUps.shift();
				if (next !== undefined) {
					this.hooks.turnEnd(status, text, turn.error?.message);
					void this.startTurn(next).catch((error) => this.hooks.transcript({ role: "error", text: String(error) }));
					return;
				}
				this.setBusy(false);
				this.hooks.turnEnd(status, text, turn.error?.message);
				return;
			}
		}
	}

	private item(item: Json): void {
		switch (item.type) {
			case "agentMessage":
				if (item.text) {
					if (item.phase !== "commentary") this.lastAssistant = item.text;
					else if (!this.lastAssistant) this.lastAssistant = item.text;
					this.hooks.transcript({ role: "assistant", text: item.text });
				}
				return;
			case "reasoning": {
				const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
				if (text) this.hooks.transcript({ role: "thinking", text });
				return;
			}
			case "commandExecution":
				this.hooks.transcript({ role: "tool", tool: "shell", text: String(item.command ?? "") });
				this.hooks.transcript({ role: "result", tool: "shell", text: clip(`exit ${item.exitCode ?? "?"}\n${item.aggregatedOutput ?? ""}`) });
				return;
			case "fileChange":
				this.hooks.transcript({ role: "tool", tool: "apply_patch", text: clip((item.changes ?? []).map((c: Json) => `${c.kind?.type ?? c.kind ?? "change"} ${c.path}`).join("\n")) });
				return;
			case "mcpToolCall":
			case "dynamicToolCall":
				this.hooks.transcript({ role: "tool", tool: `${item.server ?? ""}${item.tool ?? item.type}`, text: clip(JSON.stringify(item.arguments ?? {})) });
				return;
		}
	}

	private serverRequest(record: Json): void {
		const method: string = record.method;
		if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
			const requestId = `codex-${record.id}`;
			this.approvals.set(requestId, { id: record.id, method });
			const params = record.params ?? {};
			const summary = clip([params.command && `command: ${Array.isArray(params.command) ? params.command.join(" ") : params.command}`, params.cwd && `cwd: ${params.cwd}`, params.reason && `reason: ${params.reason}`, params.grantRoot && `grant root: ${params.grantRoot}`].filter(Boolean).join("\n") || JSON.stringify(params), 2000);
			const tool = method.includes("command") ? "shell" : "apply_patch";
			this.hooks.transcript({ role: "approval", tool, text: `Approval requested\n${summary}` });
			this.hooks.approval(requestId, tool, summary);
			return;
		}
		// Permission-profile grants, user-input forms and MCP elicitations are not
		// forwarded in this version; refusing is the safe default.
		this.hooks.transcript({ role: "system", text: `Refused unsupported Codex request: ${method}` });
		this.write({ id: record.id, error: { code: -32601, message: "Not supported by pi subagent worker" } });
	}
}

// ------------------------------------------------------------------ main loop

async function main(): Promise<void> {
	const dir = process.argv[2];
	if (!dir) throw new Error("usage: node worker.ts <runDir>");
	const spec = readSpec(dir);
	if (!spec) throw new Error(`No spec in ${dir}`);
	const previous = readState(dir);
	const resumeId = previous?.nativeSessionId;
	updateState(dir, { status: "starting", workerPid: process.pid, error: undefined, approval: undefined });
	appendEvent(dir, "worker", { start: true, pid: process.pid, resume: resumeId ?? null });

	let turns = previous?.turns ?? 0;
	let stopping = false;
	const hooks: Hooks = {
		transcript: (entry) => appendTranscript(dir, entry),
		turnEnd: (status, text, error) => {
			turns += 1;
			const report = writeReport(dir, { kind: "turn", status, text, error });
			appendEvent(dir, "worker", { report: report.seq, status });
			updateState(dir, { status: adapter.busy ? "running" : "idle", turns, lastText: text.slice(0, 2000), approval: undefined, error });
		},
		approval: (requestId, tool, summary) => {
			const approval = { requestId, tool, summary, at: new Date().toISOString() };
			updateState(dir, { status: "waiting", approval });
			writeReport(dir, { kind: "approval", status: "waiting", text: `Permission requested (${requestId}) for ${tool}:\n${summary}` });
		},
		session: (id, transcript) => updateState(dir, { nativeSessionId: id, nativeTranscript: transcript }),
		busy: (busy) => {
			const state = readState(dir);
			if (state?.status !== "waiting") updateState(dir, { status: busy ? "running" : "idle" });
		},
	};

	const AdapterClass = spec.backend === "pi" ? PiAdapter : spec.backend === "claude" ? ClaudeAdapter : CodexAdapter;
	const adapter: Adapter = new AdapterClass(spec, dir, hooks);
	let exitResolve!: () => void;
	const exited = new Promise<void>((resolve) => { exitResolve = resolve; });
	adapter.onExit = (code, signal) => {
		appendEvent(dir, "worker", { childExit: code, signal });
		if (!stopping) {
			const error = `Child ${spec.backend} exited unexpectedly (${code ?? signal})`;
			updateState(dir, { status: "failed", error, childPid: undefined, workerPid: undefined });
			writeReport(dir, { kind: "exit", status: "failed", text: "", error });
		}
		exitResolve();
	};

	try {
		await adapter.start(resumeId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		updateState(dir, { status: "failed", error: message, workerPid: undefined });
		writeReport(dir, { kind: "exit", status: "failed", text: "", error: message });
		stopping = true;
		await adapter.close();
		return;
	}
	if (readState(dir)?.status === "starting") updateState(dir, { status: "idle" });

	const handle = async (command: InboxCommand): Promise<boolean> => {
		switch (command.type) {
			case "send":
				await adapter.send(command.message, command.delivery);
				return false;
			case "interrupt":
				await adapter.interrupt();
				return false;
			case "reply":
				await adapter.reply(command.requestId, command.allow, command.reason);
				updateState(dir, { status: adapter.busy ? "running" : "idle", approval: undefined });
				return false;
			case "hpc-grants":
				return false; // pi children re-read hpc-grants.json themselves.
			case "stop":
				return true;
		}
	};

	while (!adapter.exited) {
		let stop = false;
		for (const command of takeInbox(dir)) {
			appendEvent(dir, "worker", { inbox: command.type });
			try {
				if (await handle(command)) stop = true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				appendTranscript(dir, { role: "error", text: `${command.type} failed: ${message}` });
				updateState(dir, { error: message });
			}
		}
		if (stop) {
			stopping = true;
			await adapter.close();
			updateState(dir, { status: "stopped", workerPid: undefined, childPid: undefined, approval: undefined });
			appendEvent(dir, "worker", { stopped: true });
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	await exited;
}

main().catch((error) => {
	const dir = process.argv[2];
	if (dir) {
		try {
			appendEvent(dir, "worker", { fatal: String(error?.stack ?? error) });
			updateState(dir, { status: "failed", error: String(error?.message ?? error), workerPid: undefined });
		} catch {}
	}
	process.exitCode = 1;
});
