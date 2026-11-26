#!/usr/bin/env node
// Minimal fake of pi RPC, Claude stream-json and Codex app-server for the
// subagents tests. FAKE_BACKEND selects the protocol; argv is logged to
// $PI_SUBAGENT_RUN_DIR/fake-argv.jsonl so tests can check launch flags.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const backend = process.env.FAKE_BACKEND;
const dir = process.env.PI_SUBAGENT_RUN_DIR;
appendFileSync(join(dir, "fake-argv.jsonl"), `${JSON.stringify(process.argv.slice(2))}\n`);
appendFileSync(join(dir, "fake-env.jsonl"), `${JSON.stringify({ PI_AGENT_COMM_ID: process.env.PI_AGENT_COMM_ID ?? null })}\n`);
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
let buffer = "";
const waiting = new Map();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, i);
		buffer = buffer.slice(i + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => process.exit(0));

function handle(record) {
	if (backend === "pi") return pi(record);
	if (backend === "claude") return claude(record);
	return codex(record);
}

function pi(record) {
	if (record.type === "get_state") return out({ id: record.id, type: "response", command: "get_state", success: true, data: { sessionId: "pi-session", sessionFile: join(dir, "fake-pi-session.jsonl") } });
	if (record.type === "abort") return out({ id: record.id, type: "response", command: "abort", success: true });
	if (record.type === "prompt") {
		out({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
		out({ type: "agent_start" });
		out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: record.message }] } });
		out({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] } });
		out({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "file.txt" }] } });
		const finish = () => {
			out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `pi done: ${record.message}` }] } });
			out({ type: "agent_settled", aborted: false });
		};
		// HOLD keeps the turn running until the test creates <run dir>/release.
		if (!record.message.includes("HOLD")) return finish();
		const gate = setInterval(() => {
			if (!existsSync(join(dir, "release"))) return;
			clearInterval(gate);
			finish();
		}, 25);
	}
}

function claudeFinish(text) {
	out({ type: "assistant", message: { content: [{ type: "text", text }] } });
	out({ type: "result", subtype: "success", result: text, is_error: false });
}

function claude(record) {
	if (record.type === "control_request" && record.request.subtype === "initialize") return out({ type: "control_response", response: { subtype: "success", request_id: record.request_id, response: { commands: [] } } });
	if (record.type === "control_request" && record.request.subtype === "interrupt") {
		out({ type: "control_response", response: { subtype: "success", request_id: record.request_id, response: {} } });
		return out({ type: "result", subtype: "error_during_execution", is_error: true });
	}
	if (record.type === "control_response") {
		const pending = waiting.get(record.response.request_id);
		waiting.delete(record.response.request_id);
		return claudeFinish(`claude permission ${record.response.response.behavior}`);
	}
	if (record.type === "user") {
		const text = record.message.content;
		if (text.includes("PERMISSION")) {
			out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "make" } }] } });
			waiting.set("perm-1", true);
			return out({ type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "make" }, description: "Run make" } });
		}
		return claudeFinish(`claude done: ${text}`);
	}
}

let turn = 0;
function codex(record) {
	if (record.method === "initialize") return out({ id: record.id, result: { userAgent: "fake" } });
	if (record.method === "initialized") return;
	if (record.method === "thread/start" || record.method === "thread/resume") {
		appendFileSync(join(dir, "fake-codex-calls.jsonl"), `${JSON.stringify(record)}\n`);
		return out({ id: record.id, result: { thread: { id: record.params.threadId ?? "codex-thread", path: join(dir, "rollout.jsonl") } } });
	}
	if (record.method === "thread/goal/set") {
		appendFileSync(join(dir, "fake-codex-calls.jsonl"), `${JSON.stringify(record)}\n`);
		return out({ id: record.id, result: {} });
	}
	if (record.method === "turn/start") {
		turn += 1;
		const id = `turn-${turn}`;
		const text = record.params.input[0].text;
		out({ id: record.id, result: { turn: { id, status: "inProgress" } } });
		out({ method: "turn/started", params: { turn: { id } } });
		if (text.includes("APPROVAL")) {
			waiting.set(900, id);
			return out({ id: 900, method: "item/commandExecution/requestApproval", params: { command: "git push", cwd: "/tmp", reason: "network" } });
		}
		out({ method: "item/completed", params: { item: { type: "commandExecution", command: "ls", exitCode: 0, aggregatedOutput: "a\n" } } });
		out({ method: "item/completed", params: { item: { type: "agentMessage", phase: "final_answer", text: `codex done: ${text}` } } });
		return out({ method: "turn/completed", params: { turn: { id, status: "completed" } } });
	}
	if (record.id === 900 && record.result) {
		const id = waiting.get(900);
		out({ method: "item/completed", params: { item: { type: "agentMessage", phase: "final_answer", text: `codex approval ${record.result.decision}` } } });
		return out({ method: "turn/completed", params: { turn: { id, status: "completed" } } });
	}
}
