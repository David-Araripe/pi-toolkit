// Self-contained HTML rendering of a subagent transcript, for runs whose
// native harness has no exporter we can call (Claude Code, Codex).
import type { Report, RunSpec, RunState, TranscriptEntry } from "./store.ts";

function escape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const LABELS: Record<TranscriptEntry["role"], string> = {
	user: "User",
	assistant: "Assistant",
	thinking: "Thinking",
	tool: "Tool call",
	result: "Tool result",
	system: "System",
	approval: "Permission",
	error: "Error",
};

export function renderHtml(spec: RunSpec, state: RunState, entries: TranscriptEntry[], reports: Report[], paths: { events: string; native?: string }): string {
	const rows = entries.map((entry) => {
		const label = `${LABELS[entry.role]}${entry.tool ? ` · ${escape(entry.tool)}` : ""}`;
		const time = escape(entry.at.replace("T", " ").replace(/\.\d+Z$/, "Z"));
		const body = `<pre>${escape(entry.text)}</pre>`;
		// Long or secondary content collapses so the conversation stays readable.
		const collapse = entry.role === "thinking" || entry.role === "result" || (entry.role === "tool" && entry.text.length > 300);
		const content = collapse ? `<details><summary>${label}</summary>${body}</details>` : `<div class="label">${label}</div>${body}`;
		return `<section class="entry ${entry.role}"><time>${time}</time>${content}</section>`;
	}).join("\n");
	const meta: Array<[string, string | undefined]> = [
		["Name", spec.name],
		["ID", spec.id],
		["Backend", spec.backend],
		["Model", spec.model ?? "default"],
		["Effort", spec.effort],
		["Mode", spec.mode],
		["Working directory", spec.cwd],
		["Created", spec.createdAt],
		["Status", state.status],
		["Turns", String(state.turns)],
		["Native session", state.nativeSessionId],
		["Native transcript", paths.native ?? state.nativeTranscript],
		["Raw protocol log", paths.events],
		["Parent session", spec.parentSessionFile ?? spec.parentSessionId],
		["Error", state.error],
	];
	const reportRows = reports.map((r) => `<tr><td>${r.seq}</td><td>${escape(r.at)}</td><td>${escape(r.kind)}</td><td>${escape(r.status)}</td><td>${escape(r.error ?? "")}</td></tr>`).join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Subagent ${escape(spec.name)} (${escape(spec.id)})</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafafa; --muted: #6e6e73; --card: #fff; --border: #e0e0e5; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8ed; --bg: #161618; --muted: #9a9aa0; --card: #1f1f22; --border: #333338; } }
body { font: 14px/1.5 -apple-system, system-ui, sans-serif; color: var(--fg); background: var(--bg); max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.3rem; } table { border-collapse: collapse; margin-bottom: 1.5rem; } td, th { padding: 2px 10px 2px 0; vertical-align: top; text-align: left; }
th { color: var(--muted); font-weight: 500; } .entry { background: var(--card); border: 1px solid var(--border); border-left-width: 4px; border-radius: 6px; padding: .5rem .8rem; margin: .5rem 0; }
.entry time { float: right; color: var(--muted); font-size: 12px; } .label, summary { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); cursor: default; }
summary { cursor: pointer; } pre { white-space: pre-wrap; word-break: break-word; margin: .3rem 0 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.user { border-left-color: #2f6fde; } .assistant { border-left-color: #2e9e5b; } .tool, .result { border-left-color: #8a8a90; } .thinking { border-left-color: #b38cd9; }
.approval { border-left-color: #d9a400; } .error { border-left-color: #d64545; } .system { border-left-color: #5aa9c9; }
</style></head><body>
<h1>Subagent ${escape(spec.name)}</h1>
<table>${meta.filter(([, v]) => v).map(([k, v]) => `<tr><th>${escape(k)}</th><td>${escape(v!)}</td></tr>`).join("")}</table>
${reports.length ? `<h2>Reports</h2><table><tr><th>#</th><th>At</th><th>Kind</th><th>Status</th><th>Error</th></tr>${reportRows}</table>` : ""}
<h2>Transcript</h2>
${rows || "<p>No transcript entries.</p>"}
</body></html>
`;
}
