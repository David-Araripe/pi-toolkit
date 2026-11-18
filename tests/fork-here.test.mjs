import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = process.env.PI_TEST_AGENT_ROOT || resolve(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const fromPi = (path) => import(pathToFileURL(resolve(agentRoot, "dist", path)));
const { loadExtensions } = await fromPi("core/extensions/loader.js");
const { createEventBus } = await fromPi("core/event-bus.js");

async function command() {
  const loaded = await loadExtensions([resolve(root, "extensions/fork-here.ts")], root, createEventBus());
  assert.deepEqual(loaded.errors, []);
  return loaded.extensions[0].commands.get("fork-here");
}

function context(leafId, { cancelled = false } = {}) {
  const calls = { forks: [], notes: [], sent: [], waited: false };
  const forked = {
    ui: { notify: (...a) => calls.notes.push(["forked", ...a]) },
    sendUserMessage: async (text) => calls.sent.push(text),
  };
  const ctx = {
    waitForIdle: async () => { calls.waited = true; },
    sessionManager: { getLeafId: () => leafId },
    ui: { notify: (...a) => calls.notes.push(["old", ...a]) },
    fork: async (id, options) => {
      calls.forks.push([id, options.position]);
      if (!cancelled) await options.withSession(forked);
      return { cancelled };
    },
  };
  return { ctx, calls };
}

test("forks at the current leaf after waiting for idle", async () => {
  const { ctx, calls } = context("leaf-1");
  await (await command()).handler("", ctx);
  assert.equal(calls.waited, true);
  assert.deepEqual(calls.forks, [["leaf-1", "at"]]);
  assert.deepEqual(calls.sent, []);
});

test("sends an optional prompt into the fork", async () => {
  const { ctx, calls } = context("leaf-2");
  await (await command()).handler("  try another approach  ", ctx);
  assert.deepEqual(calls.sent, ["try another approach"]);
});

test("empty sessions and cancelled forks are reported", async () => {
  const empty = context(null);
  await (await command()).handler("x", empty.ctx);
  assert.deepEqual(empty.calls.forks, []);
  assert.equal(empty.calls.notes[0][2], "warning");
  const cancelled = context("leaf-3", { cancelled: true });
  await (await command()).handler("x", cancelled.ctx);
  assert.deepEqual(cancelled.calls.sent, []);
  assert.match(cancelled.calls.notes[0][1], /cancelled/);
});
