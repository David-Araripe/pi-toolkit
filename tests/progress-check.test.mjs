import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { agentRoot, piDependency } from "./pi-runtime.mjs";

const { loadExtensions } = await import(pathToFileURL(join(agentRoot, "dist/core/extensions/loader.js")));
const { createEventBus } = await import(pathToFileURL(join(agentRoot, "dist/core/event-bus.js")));
async function harness() {
  const loaded = await loadExtensions([fileURLToPath(new URL("../extensions/progress-check.ts", import.meta.url))], process.cwd(), createEventBus());
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  // Any attempt to drive a continuation, stop a session, or send extra requests fails.
  for (const name of ["sendMessage", "sendUserMessage"]) loaded.runtime[name] = () => assert.fail(`Unexpected ${name}`);
  const ctx = { hasUI: false, abort: () => assert.fail("Unexpected abort") };
  const event = async (name, data = {}) => {
    let result;
    for (const handler of ext.handlers.get(name) ?? []) result = await handler(data, ctx);
    return result;
  };
  const turn = (extra = {}) => event("turn_end", { outcome: "completed", toolResults: [{}], entries: [], ...extra });
  const tool = (extra = {}) => event("tool_result", { toolName: "hpc_exec", input: { host: "example", command: "a private command" }, isError: true, ...extra });
  return { event, turn, tool };
}

test("stable guidance composes without replacing the system prompt or duplicating rules", async () => {
  const h = await harness();
  const input = { systemPrompt: "original", systemPromptOptions: { promptGuidelines: ["existing"] } };
  assert.equal(await h.event("before_agent_start", input), undefined);
  assert.equal(input.systemPrompt, "original");
  assert.equal(input.systemPromptOptions.promptGuidelines.length, 5);
  await h.event("before_agent_start", input);
  assert.equal(input.systemPromptOptions.promptGuidelines.length, 5);
  await h.event("before_agent_start", { systemPromptOptions: {} });
});

test("three identical failures get one advisory, preserve earlier entries, and expose no arguments", async () => {
  const h = await harness();
  for (let i = 0; i < 2; i++) { assert.equal(await h.tool(), undefined); assert.equal(await h.turn(), undefined); }
  // Object insertion order does not change call identity.
  await h.tool({ input: { command: "a private command", host: "example" } });
  const previous = { type: "custom", customType: "other", data: {} };
  const result = await h.turn({ entries: [previous], continue: true });
  assert.equal(result.entries[0], previous);
  assert.match(result.entries[1].content, /failed three times/);
  assert.doesNotMatch(JSON.stringify(result), /private command|example/);
  assert.equal(result.continue, undefined);
  for (let i = 0; i < 3; i++) { await h.tool(); assert.equal(await h.turn(), undefined); }
});

test("successful retries clear failure counts; different tools/arguments are separate", async () => {
  const h = await harness();
  await h.tool(); await h.tool(); await h.tool({ isError: false });
  await h.tool(); await h.tool();
  await h.tool({ toolName: "bash" });
  await h.tool({ input: { command: "different" } });
  assert.equal(await h.turn(), undefined);
  await h.tool(); assert.match((await h.turn()).entries[0].content, /failed three times/);
});

test("a successful sibling result cancels its pending failure warning before the boundary", async () => {
  const h = await harness();
  for (let i = 0; i < 3; i++) await h.tool();
  await h.tool({ isError: false });
  assert.equal(await h.turn(), undefined);
});

test("long tool runs get bounded checkpoints, never a forced continuation or stall verdict", async () => {
  const h = await harness();
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let i = 0; i < 11; i++) assert.equal(await h.turn(), undefined);
    const result = await h.turn();
    assert.match(result.entries[0].content, /not a determination that work has stalled/);
    assert.deepEqual(Object.keys(result), ["entries"]);
  }
});

test("final responses, errors, and aborted turns do not produce checkpoints", async () => {
  const h = await harness();
  for (let i = 0; i < 3; i++) await h.tool();
  assert.equal(await h.turn({ outcome: "aborted" }), undefined);
  assert.equal(await h.turn({ outcome: "error" }), undefined);
  assert.equal(await h.turn({ toolResults: [] }), undefined);
});

test("human input and lifecycle changes reset counters, automatic continuations do not", async () => {
  const h = await harness();
  for (const [event, data] of [["session_start", {}], ["session_shutdown", {}], ["session_tree", {}], ["model_select", {}], ["input", { source: "rpc" }], ["input", { source: "interactive" }]]) {
    await h.tool(); await h.tool(); await h.event(event, data); await h.tool();
    assert.equal(await h.turn(), undefined);
    await h.event("session_start");
  }
  await h.tool(); await h.tool();
  await h.event("input", { source: "extension" });
  await h.event("before_agent_start", { messageType: "custom", systemPromptOptions: {} });
  await h.tool(); assert.ok(await h.turn());
});

test("failure history is bounded even across many distinct failing commands", async () => {
  const h = await harness();
  await h.tool(); await h.tool();
  for (let i = 0; i < 128; i++) await h.tool({ input: { command: `unique-${i}` } });
  await h.tool(); assert.equal(await h.turn(), undefined);
});

test("real SDK persists a checkpoint without adding requests beyond the natural tool loop", async () => {
  const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(agentRoot, "dist/index.js")));
  const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } = await import(pathToFileURL(piDependency("@earendil-works/pi-ai")));
  const cwd = mkdtempSync(join(tmpdir(), "pi-progress-sdk-"));
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(cwd, "catalog.json"), refreshOnCreate: false, allowModelNetwork: false });
  const faux = fauxProvider({ provider: "progress-check-fixture", models: [{ id: "faux" }], tokensPerSecond: 100000 });
  faux.setResponses([
    ...Array.from({ length: 12 }, () => fauxAssistantMessage(fauxToolCall("fixture", {}), { stopReason: "toolUse" })),
    fauxAssistantMessage("Finished the synthetic checks."),
  ]);
  modelRuntime.registerNativeProvider(faux.provider);
  const loaded = await loadExtensions([fileURLToPath(new URL("../extensions/progress-check.ts", import.meta.url))], cwd, createEventBus());
  assert.deepEqual(loaded.errors, []);
  const resourceLoader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Synthetic progress-check test.", getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources() {}, async reload() {},
  };
  const sm = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, modelRuntime, model: faux.getModel(), resourceLoader,
    sessionManager: sm, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    tools: [], customTools: [{ name: "fixture", label: "Fixture", description: "An inert test tool", parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "New synthetic evidence" }], details: undefined }) }],
  });
  try {
    await session.bindExtensions({ mode: "json" });
    await session.prompt("Run the synthetic checks.");
    assert.equal(faux.state.callCount, 13);
    const checkpoints = sm.getEntries().filter(e => e.type === "custom_message" && e.customType === "progress-check");
    assert.equal(checkpoints.length, 1);
    assert.match(session.getLastAssistantText(), /Finished/);
  } finally { session.dispose(); }
});
