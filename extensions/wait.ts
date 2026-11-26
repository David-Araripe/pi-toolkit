import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const usage = "Usage: /wait <duration> <prompt> (e.g. /wait 1h30m continue), or /wait cancel";

function durationMs(text: string): number | undefined {
	const parts = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
	if (!parts) return;
	const [, h = 0, m = 0, s = 0] = parts;
	const ms = Math.ceil(Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000);
	// Larger delays overflow a Node timer and would send the prompt almost immediately.
	return ms > 0 && ms <= 2_147_483_647 ? ms : undefined;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	function cancel(ctx: ExtensionContext) {
		if (timer === undefined) return false;
		clearTimeout(timer);
		timer = undefined;
		ctx.ui.setStatus("wait", undefined);
		return true;
	}

	pi.on("session_shutdown", (_event, ctx) => { cancel(ctx); });
	pi.on("session_tree", (_event, ctx) => {
		if (cancel(ctx)) ctx.ui.notify("Branch changed; delayed prompt cancelled.", "info");
	});

	pi.registerCommand("wait", {
		description: "Send a prompt later, e.g. /wait 1h30m continue. Cancel with /wait cancel.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") throw new Error("/wait needs an open Pi TUI session.");
			const input = args.trim();
			if (input === "cancel") {
				ctx.ui.notify(cancel(ctx) ? "Delayed prompt cancelled." : "No delayed prompt is pending.", "info");
				return;
			}
			const match = /^(\S+)\s+([\s\S]+)$/.exec(input);
			const ms = match && durationMs(match[1]);
			if (!match || !ms) {
				ctx.ui.notify(usage, "warning");
				return;
			}
			if (timer !== undefined) {
				ctx.ui.notify("A prompt is already scheduled. Use /wait cancel before replacing it.", "warning");
				return;
			}
			const [, , prompt] = match;
			const due = new Date(Date.now() + ms).toLocaleString();
			timer = setTimeout(() => {
				timer = undefined;
				ctx.ui.setStatus("wait", undefined);
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}, ms);
			ctx.ui.setStatus("wait", `Prompt due: ${due}`);
			ctx.ui.notify(`Prompt scheduled for ${due}. Keep this session open; /wait cancel to cancel.`, "info");
		},
	});
}
