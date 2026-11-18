import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Short aliases that explicitly load skills, including model-hidden ones. */
export default function productivityCommands(pi: ExtensionAPI) {
	const commands = [
		["grill-me", "Stress-test a plan or idea through a structured interview"],
		["teach", "Learn a topic over multiple sessions in this workspace"],
		["handoff", "Write a temporary handoff document for the next session"],
	] as const;

	for (const [name, description] of commands) {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				await ctx.waitForIdle();
				const request = args.trim();
				pi.sendUserMessage(`/skill:${name}${request ? ` ${request}` : ""}`, {
					expandPromptTemplates: true,
				});
			},
		});
	}
}
