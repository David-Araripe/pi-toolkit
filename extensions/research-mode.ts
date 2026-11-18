import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
	compact,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATE_ENTRY = "research-mode-state";
const STATUS_KEY = "research-mode";
const ALLOWED_LEVELS = new Set<ThinkingLevel>(["high", "xhigh"]);

const RESEARCH_PROTOCOL = `# Research mode

Treat the task as a stateful, evidence-driven scientific investigation.

- First read project instructions and any existing research, progress, protocol, or handoff documents. Project-specific instructions take precedence.
- Define the research question, success criteria, constraints, and available evidence before making strong conclusions.
- Maintain durable task state in the project's designated progress document. If none exists and the investigation is substantial, choose an appropriate research ledger without overwriting unrelated work.
- Keep direct observations, hypotheses, assumptions, interpretations, uncertainties, and alternative explanations explicitly distinct.
- Use an iterative loop: hypothesis -> discriminating test -> observation -> updated hypothesis.
- Prefer primary sources, raw data, implementation, and reproducible outputs over summaries. Record provenance precisely.
- Preserve exact commands, versions, parameters, seeds, data paths, relevant counts, and other details needed to reproduce results.
- Record negative and null results and rejected hypotheses; do not silently repeat failed approaches.
- Before concluding, perform an independent check where practical and assess sensitivity to important assumptions.
- Re-read durable state before each major new phase instead of re-deriving settled findings.
- Do not stop at a plan when the investigation can be executed with available tools.
- Report clearly what is established, what is inferred, and what remains unresolved.`;

const SCIENTIFIC_COMPACTION_INSTRUCTIONS = `This is a scientific/research session. Preserve the investigation state with high fidelity while remaining concise.

Explicitly retain:
- the research question, success criteria, constraints, and protocol;
- direct observations and facts with provenance (source, URL, file and line, command and relevant output, date/version where applicable);
- active and rejected hypotheses, their predictions, status, and discriminating tests;
- assumptions, interpretations, uncertainties, contradictions, and alternative explanations, kept distinct from observations;
- negative, null, and failed results, including why an approach failed and why it should not be repeated;
- data lineage: datasets, identifiers, hashes when available, filters, parameters, seeds, environment, software versions, and relevant counts;
- decisions and their rationale;
- artifacts read or changed, reproducible commands, and verification already performed;
- current work state, unresolved questions, blockers, and the next discriminating action.

Never promote an uncertain claim to fact, erase contradictory evidence, invent provenance, or collapse observation and interpretation into one statement.`;

interface ResearchModeState {
	active: boolean;
	level?: ThinkingLevel;
	previousLevel?: ThinkingLevel;
	provider?: string;
	model?: string;
}

export default function researchModeExtension(pi: ExtensionAPI) {
	let mode: ResearchModeState | undefined;

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (mode?.active && mode.level) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `research:${mode.level}`));
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	function persistState(state: ResearchModeState) {
		pi.appendEntry(STATE_ENTRY, state);
	}

	function restoreState(ctx: ExtensionContext) {
		const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
		let latest: ResearchModeState | undefined;

		for (const entry of ctx.sessionManager.getEntries()) {
			if (!branchIds.has(entry.id) || entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			latest = entry.data as ResearchModeState;
		}

		mode = latest?.active ? { ...latest } : undefined;
		if (mode?.level && ALLOWED_LEVELS.has(mode.level)) {
			pi.setThinkingLevel(mode.level);
			const effective = pi.getThinkingLevel();
			if (effective !== mode.level) mode.level = effective;
		}
		updateStatus(ctx);
	}

	function enforceThinking(ctx: ExtensionContext, warn = false) {
		if (!mode?.active || !mode.level || pi.getThinkingLevel() === mode.level) return;

		pi.setThinkingLevel(mode.level);
		const effective = pi.getThinkingLevel();

		if (effective === mode.level) {
			if (warn) notify(ctx, `Research mode restored ${mode.level} reasoning.`, "warning");
			return;
		}

		if (warn) {
			notify(ctx, `Research mode requested ${mode.level} reasoning, but this model provides ${effective}.`, "warning");
		}
		mode.level = effective;
		persistState(mode);
		updateStatus(ctx);
	}

	pi.registerCommand("research-mode", {
		description: "Enable scientific research mode: [high|xhigh] [task], or off/status",
		getArgumentCompletions: (prefix) => {
			const options = ["high", "xhigh", "off", "status"];
			const items = options
				.filter((value) => value.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				notify(ctx, "Wait for the current agent run or compaction to finish, then invoke /research-mode again.", "warning");
				return;
			}

			const trimmed = args.trim();
			const [first = "", ...rest] = trimmed.split(/\s+/);
			const keyword = first.toLowerCase();

			if (keyword === "status") {
				if (!mode?.active) {
					notify(ctx, "Research mode is off.");
					return;
				}
				notify(
					ctx,
					`Research mode is on (${mode.level}); anchored to ${mode.provider ?? "unknown"}/${mode.model ?? "unknown"}.`,
				);
				return;
			}

			if (keyword === "off") {
				const previousLevel = mode?.previousLevel;
				mode = undefined;
				persistState({ active: false });
				if (previousLevel) pi.setThinkingLevel(previousLevel);
				updateStatus(ctx);
				notify(ctx, "Research mode disabled.");
				return;
			}

			const requestedLevel: ThinkingLevel = keyword === "xhigh" ? "xhigh" : "high";
			const task = keyword === "high" || keyword === "xhigh" ? rest.join(" ") : trimmed;
			const previousLevel = mode?.previousLevel ?? pi.getThinkingLevel();

			pi.setThinkingLevel(requestedLevel);
			const effectiveLevel = pi.getThinkingLevel();
			mode = {
				active: true,
				level: effectiveLevel,
				previousLevel,
				provider: ctx.model?.provider,
				model: ctx.model?.id,
			};
			persistState(mode);
			updateStatus(ctx);

			if (effectiveLevel !== requestedLevel) {
				notify(ctx, `Research mode enabled, but ${requestedLevel} was clamped to ${effectiveLevel} for this model.`, "warning");
			} else {
				notify(ctx, `Research mode enabled with ${effectiveLevel} reasoning and scientific compaction.`);
			}

			if (task) pi.sendUserMessage(task);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!mode?.active) return;
		enforceThinking(ctx, true);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${RESEARCH_PROTOCOL}`,
		};
	});

	pi.on("model_select", async (event, ctx) => {
		if (!mode?.active) return;
		enforceThinking(ctx, true);
		if (event.model.provider !== mode.provider || event.model.id !== mode.model) {
			notify(
				ctx,
				`Model changed during research mode (${mode.provider}/${mode.model} -> ${event.model.provider}/${event.model.id}). Private reasoning continuity may be reduced; durable research state and compaction remain active.`,
				"warning",
			);
		}
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		if (!mode?.active || !ctx.hasUI) return;
		const proceed = await ctx.ui.confirm(
			"Research mode is active",
			"Switching sessions interrupts the current reasoning trajectory. Continue?",
		);
		if (!proceed) return { cancel: true };
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		if (!mode?.active || !ctx.hasUI) return;
		const proceed = await ctx.ui.confirm(
			"Research mode is active",
			"Forking or cloning may branch away from part of the accumulated research state. Continue?",
		);
		if (!proceed) return { cancel: true };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!mode?.active || !ctx.model) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) {
			notify(ctx, `Scientific compaction could not resolve model authentication; using Pi's default compaction: ${auth.error}`, "warning");
			return;
		}

		const customInstructions = event.customInstructions?.trim()
			? `${SCIENTIFIC_COMPACTION_INSTRUCTIONS}\n\nUser-supplied compaction focus:\n${event.customInstructions.trim()}`
			: SCIENTIFIC_COMPACTION_INSTRUCTIONS;

		try {
			notify(ctx, "Applying scientific research compaction...", "info");
			const result = await compact(
				event.preparation,
				ctx.model,
				auth.apiKey,
				auth.headers,
				customInstructions,
				event.signal,
				pi.getThinkingLevel(),
				undefined,
				auth.env,
			);
			return { compaction: result };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!event.signal.aborted) {
				notify(ctx, `Scientific compaction failed; falling back to Pi's default compaction: ${message}`, "warning");
			}
			return;
		}
	});
}
