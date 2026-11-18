import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * /fork-here [prompt] — split the conversation at the latest message.
 *
 * Copies the active branch through the current leaf (what the TUI shows) into
 * a new session, like the built-in /clone. An optional prompt is sent as the
 * first message of the fork.
 */
export default function forkHere(pi: ExtensionAPI) {
	pi.registerCommand("fork-here", {
		description: "Fork a new session from the latest message, optionally sending a prompt",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				ctx.ui.notify("Nothing to fork yet", "warning");
				return;
			}
			const prompt = args.trim();
			const result = await ctx.fork(leafId, {
				position: "at",
				withSession: async (forked) => {
					forked.ui.notify("Forked here into a new session", "info");
					if (prompt) await forked.sendUserMessage(prompt);
				},
			});
			if (result.cancelled) ctx.ui.notify("Fork cancelled", "info");
		},
	});
}
