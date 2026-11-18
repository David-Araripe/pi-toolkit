import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Provide the convenient /commit spelling for the imported commit skill. */
export default function commitCommandExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Create a focused Conventional Commits-style git commit",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const guidance = args.trim();
			const skillCommand = guidance ? `/skill:commit ${guidance}` : "/skill:commit";
			pi.sendUserMessage(skillCommand, { expandPromptTemplates: true });
		},
	});
}
