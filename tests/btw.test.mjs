import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentRoot, loadTypeScript, piDependency } from "./pi-runtime.mjs";

const sdk = await import(join(agentRoot, "dist/index.js"));
const { createAssistantMessageEventStream } = await import(piDependency("@earendil-works/pi-ai"));
const { default: btw } = await loadTypeScript(fileURLToPath(new URL("../extensions/btw.ts", import.meta.url)));

// A provider that exists only because an extension registered it, like claude-code.
function registerFakeProvider(registry, seen) {
  registry.registerProvider("btw-fake", {
    baseUrl: "http://localhost:0", apiKey: "unused", api: "btw-fake-api",
    models: [{ id: "fake-1", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 }],
    streamSimple: (model, context) => {
      seen.push(context.messages.filter((m) => m.role !== "system").map((m) => m.content?.[0]?.text));
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant", content: [{ type: "text", text: "side answer" }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    },
  });
}

test("/btw reaches extension providers (e.g. claude-code) and sees the main conversation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "btw-test-"));
  const { session: main } = await sdk.createAgentSession({ sessionManager: sdk.SessionManager.inMemory(), cwd });
  try {
    main.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "main question" }], timestamp: Date.now() });
    const registry = new sdk.ModelRegistry(main.modelRuntime), seen = [];
    registerFakeProvider(registry, seen);
    const model = registry.find("btw-fake", "fake-1");
    assert.ok(model);
    const commands = new Map(), entries = [], notices = [];
    btw({ registerCommand: (n, c) => commands.set(n, c), on() {}, getThinkingLevel: () => "off",
      appendEntry: (type, data) => entries.push({ type, data }), sendUserMessage() {} });
    const ctx = { hasUI: true, mode: "rpc", model, modelRegistry: registry, cwd, sessionManager: main.sessionManager,
      getSystemPrompt: () => "base", isIdle: () => true, waitForIdle: async () => {},
      ui: { notify: (...a) => notices.push(a), custom: () => new Promise(() => {}) } };
    await commands.get("btw").handler("quick question", ctx);
    assert.deepEqual(notices, []);
    assert.deepEqual(entries.map((e) => [e.data.answer, e.data.provider]), [["side answer", "btw-fake"]]);
    assert.deepEqual(seen, [["main question", "quick question"]]);
    // A follow-up in the same thread sees the main conversation and the earlier side exchange.
    await commands.get("btw").handler("follow-up", ctx);
    assert.deepEqual(seen[1], ["main question", "quick question", "side answer", "follow-up"]);
  } finally {
    main.dispose();
  }
});
