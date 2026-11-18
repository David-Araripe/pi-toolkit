import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHECKPOINT_TURNS = 12;
const MAX_FAILURES = 128;
const GUIDELINES = [
	"Keep progress updates concise: report new evidence and the next action, not the same completed-work recap each turn. After several inspection rounds, act on the evidence or name the specific missing fact.",
	"Do not repeat failed tool calls without a changed premise or a bounded retry rationale; record negative results and try a different diagnostic.",
	"Parallelize only independent calls. Wait for writes and destination-directory creation before uploads, and for uploads before execution or submission.",
	"Report completion only from returned evidence. A submission, one completed job, or an intermediate check does not establish that the whole task is complete.",
];

// Hash arguments instead of retaining or displaying potentially sensitive commands.
function fingerprint(tool: string, input: unknown): string {
	const stable = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(stable);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
		}
		return value;
	};
	return createHash("sha256").update(JSON.stringify([tool, stable(input)])).digest("hex");
}

/** Advisory checkpoints only: never block tools, stop a watch, or request a turn. */
export default function progressCheck(pi: ExtensionAPI) {
	let turns = 0;
	const repeatedFailures = new Set<string>();
	const failures = new Map<string, number>();
	const reset = () => { turns = 0; repeatedFailures.clear(); failures.clear(); };

	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("session_tree", reset);
	pi.on("model_select", reset);
	pi.on("input", (event) => {
		if (event.source === "interactive" || event.source === "rpc") reset();
	});
	pi.on("before_agent_start", (event) => {
		const guidelines = event.systemPromptOptions.promptGuidelines ??= [];
		for (const guideline of GUIDELINES) {
			if (!guidelines.includes(guideline)) {
				guidelines.push(guideline);
			}
		}
	});
	pi.on("tool_result", (event) => {
		const key = fingerprint(event.toolName, event.input);
		if (!event.isError) { failures.delete(key); repeatedFailures.delete(key); return; }
		const count = (failures.get(key) ?? 0) + 1;
		failures.set(key, count);
		if (failures.size > MAX_FAILURES) {
			const oldest = failures.keys().next().value!;
			failures.delete(oldest);
			repeatedFailures.delete(oldest);
		}
		if (count === 3) repeatedFailures.add(key);
	});
	pi.on("turn_end", (event) => {
		if (event.outcome !== "completed" || event.toolResults.length === 0) return;
		turns++;
		if (repeatedFailures.size === 0 && turns < CHECKPOINT_TURNS) return;
		const reason = repeatedFailures.size > 0
			? "The same tool and arguments have failed three times without a successful result for that call. Change the diagnostic or explain what changed before retrying."
			: `${CHECKPOINT_TURNS} tool-using turns since the last checkpoint; this is a progress reminder, not a determination that work has stalled.`;
		turns = 0;
		repeatedFailures.clear();
		return { entries: [...event.entries, {
			type: "custom_message" as const,
			customType: "progress-check",
			content: `${reason} Briefly identify new evidence, the remaining blocker (if any), and the next concrete action. Do not re-derive settled findings or claim completion without evidence.`,
			display: true,
		}] };
	});
}
