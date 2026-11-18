import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";

/** Group available models by provider, providers sorted by name, models by id. */
export function groupByProvider<M extends { provider: string; id: string }>(models: readonly M[]): Map<string, M[]> {
	const groups = new Map<string, M[]>();
	for (const model of models) {
		const list = groups.get(model.provider) ?? [];
		list.push(model);
		groups.set(model.provider, list);
	}
	for (const list of groups.values()) list.sort((a, b) => a.id.localeCompare(b.id));
	return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Two-step model picker: choose a provider, then search its models.
 * Reaches every signed-in provider (e.g. OpenRouter) without putting
 * them in the `enabledModels` shortlist that `/model` and Ctrl+P use.
 */
export default function providerPicker(pi: ExtensionAPI) {
	pi.registerCommand("provider", {
		description: "Pick a model by provider (provider list, then its models)",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/provider requires interactive mode", "error");
				return;
			}
			const groups = groupByProvider(ctx.modelRegistry.getAvailable());
			if (!groups.size) {
				ctx.ui.notify("No signed-in providers. Use /login.", "warning");
				return;
			}
			let provider = groups.has(args.trim()) ? args.trim() : undefined;
			while (true) {
				if (!provider) {
					provider = await pick(ctx, "Select provider", [...groups].map(([id, models]) => ({
						value: id,
						label: ctx.modelRegistry.getProviderDisplayName(id) || id,
						description: `${models.length} model${models.length === 1 ? "" : "s"}${ctx.model?.provider === id ? " · current" : ""}`,
					})), false);
					if (!provider) return;
				}
				const models = groups.get(provider)!;
				const id = await pick(ctx, `${ctx.modelRegistry.getProviderDisplayName(provider) || provider} models`, models.map((m) => ({
					value: m.id,
					label: m.id,
					description: m.name && m.name !== m.id ? m.name : undefined,
				})), true, ctx.model?.provider === provider ? ctx.model.id : undefined);
				if (id === undefined) { provider = undefined; continue; } // Esc goes back to providers
				const model = models.find((m) => m.id === id)!;
				if (await pi.setModel(model)) ctx.ui.notify(`Model: ${model.provider}/${model.id}`, "info");
				else ctx.ui.notify(`No credentials for ${model.provider}`, "error");
				return;
			}
		},
	});
}

const LIST_KEYS = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"] as const;

/** Searchable list. Resolves the chosen value, or undefined on Esc. */
function pick(ctx: ExtensionCommandContext, title: string, items: SelectItem[], searchable: boolean, current?: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
		const listTheme = {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: () => theme.fg("warning", "  No matching models"),
		};
		const input = new Input({ prompt: "Search: " });
		const holder = new Container();
		let list: SelectList;
		const rebuild = (query: string) => {
			const shown = query ? fuzzyFilter(items, query, (i) => `${i.value} ${i.description ?? ""}`) : items;
			list = new SelectList(shown, Math.min(Math.max(shown.length, 1), 15), listTheme);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			const index = query ? 0 : shown.findIndex((i) => i.value === current);
			if (index > 0) list.setSelectedIndex(index);
			holder.clear();
			holder.addChild(list);
		};
		rebuild("");
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		if (searchable) container.addChild(input);
		container.addChild(new Spacer(1));
		container.addChild(holder);
		container.addChild(new Text(theme.fg("dim", `↑↓ navigate · enter select · esc ${searchable ? "back" : "cancel"}${searchable ? " · type to search" : ""}`), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		const component = {
			focused: false,
			get capturesViewportInput() { return true; },
			render: (width: number) => { input.focused = component.focused; return container.render(width); },
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (!searchable || LIST_KEYS.some((key) => kb.matches(data, key))) {
					list.handleInput(data);
				} else {
					const before = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== before) rebuild(input.getValue());
				}
				tui.requestRender();
			},
		};
		return component;
	}, { blocked: { kind: "question", message: title } });
}
