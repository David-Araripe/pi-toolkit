import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { piDependency } from "./pi-runtime.mjs";

// Pi's real extension loader; the TUI is replaced by a scripted ui.custom().
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = process.env.PI_TEST_AGENT_ROOT || resolve(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const fromPi = (path) => import(pathToFileURL(resolve(agentRoot, "dist", path)));
const { loadExtensions } = await fromPi("core/extensions/loader.js");
const { createEventBus } = await fromPi("core/event-bus.js");
const tui = await import(pathToFileURL(piDependency("@earendil-works/pi-tui", "dist/index.js", agentRoot)));
const keybindings = tui.getKeybindings();
const DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";

const model = (provider, id) => ({ provider, id, name: id });
const available = [
  model("openrouter", "openai/gpt-6-sol:batch"),
  model("claude-code", "claude-opus-5-5"),
  model("openrouter", "google/gemini-3.8-flash"),
  model("openai", "gpt-6-sol"),
];

async function run(args, answers, setModelResult = true) {
  const loaded = await loadExtensions([resolve(root, "extensions/provider-picker.ts")], root, createEventBus());
  assert.deepEqual(loaded.errors, []);
  const set = [];
  loaded.runtime.setModel = async (m) => { set.push(m); return setModelResult; };
  const titles = [], shown = [], notes = [];
  const ctx = {
    mode: "tui",
    model: available[1],
    modelRegistry: { getAvailable: () => available, getProviderDisplayName: (id) => id.toUpperCase() },
    ui: {
      notify: (text, level) => notes.push([text, level]),
      custom: async (factory) => {
        let result;
        const component = factory({ requestRender() {} }, { fg: (_c, t) => t, bold: (t) => t }, keybindings, (v) => { result = v; });
        const lines = component.render(120).join("\n");
        titles.push(lines.split("\n")[1].trim());
        shown.push(lines);
        for (const key of answers.shift()) component.handleInput(key);
        return result;
      },
    },
  };
  await loaded.extensions[0].commands.get("provider").handler(args, ctx);
  return { set, titles, shown, notes };
}

test("lists providers, then that provider's models, and sets the chosen one", async () => {
  // Providers sorted: claude-code, openai, openrouter -> go down twice to openrouter.
  const r = await run("", [[DOWN, DOWN, ENTER], [DOWN, ENTER]]);
  assert.deepEqual(r.titles, ["Select provider", "OPENROUTER models"]);
  assert.match(r.shown[0], /CLAUDE-CODE.*1 model · current/);
  assert.match(r.shown[0], /OPENROUTER.*2 models/);
  assert.ok(!r.shown[1].includes("claude-opus"));
  assert.deepEqual(r.set.map((m) => `${m.provider}/${m.id}`), ["openrouter/openai/gpt-6-sol:batch"]);
  assert.deepEqual(r.notes, [["Model: openrouter/openai/gpt-6-sol:batch", "info"]]);
});

test("argument jumps straight to a provider; typing filters its models", async () => {
  const r = await run("openrouter", [["g", "e", "m", ENTER]]);
  assert.deepEqual(r.titles, ["OPENROUTER models"]);
  assert.deepEqual(r.set.map((m) => m.id), ["google/gemini-3.8-flash"]);
});

test("Esc in the model list returns to providers; Esc there cancels", async () => {
  const r = await run("openai", [[ESC], [ESC]]);
  assert.deepEqual(r.titles, ["OPENAI models", "Select provider"]);
  assert.deepEqual(r.set, []);
});

test("reports missing credentials instead of claiming success", async () => {
  const r = await run("openai", [[ENTER]], false);
  assert.deepEqual(r.notes, [["No credentials for openai", "error"]]);
});
