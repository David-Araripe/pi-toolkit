import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTypeScript } from "./pi-runtime.mjs";

const { default: install } = await loadTypeScript(fileURLToPath(new URL("../extensions/wait.ts", import.meta.url)));
function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const commands = new Map(), events = new Map(), sent = [], statuses = [], notices = [];
  const ctx = { mode: "tui", ui: {
    setStatus: (...args) => statuses.push(args), notify: (...args) => notices.push(args),
  } };
  install({ registerCommand: (name, cmd) => commands.set(name, cmd), on: (name, fn) => events.set(name, fn),
    sendUserMessage: (...args) => sent.push(args) });
  return { wait: (args) => commands.get("wait").handler(args, ctx), emit: (name) => events.get(name)({}, ctx), sent, statuses, notices };
}

test("waits 90 minutes locally, then submits only the prompt once with busy-safe delivery", async (t) => {
  const { wait, sent, statuses } = setup(t);
  await wait("1h30m continue\nfrom  here");
  assert.match(statuses.at(-1)[1], /due/i);
  t.mock.timers.tick(5_399_999);
  assert.deepEqual(sent, []);
  t.mock.timers.tick(1);
  t.mock.timers.tick(5_400_000);
  assert.deepEqual(sent, [["continue\nfrom  here", { deliverAs: "followUp" }]]);
  assert.deepEqual(statuses.at(-1), ["wait", undefined]);
});

test("invalid input never schedules a prompt, including overflowing timeouts", async (t) => {
  const { wait, sent, statuses, notices } = setup(t);
  for (const args of ["", "90m", "1h  ", "90 continue", "0s continue", "1hjunk continue", "600h continue"]) {
    await wait(args);
    assert.equal(notices.at(-1)[1], "warning");
  }
  t.mock.timers.tick(5_400_000);
  assert.deepEqual(statuses, []);
  assert.deepEqual(sent, []);
});

test("a second wait cannot silently replace the first; cancel allows rescheduling", async (t) => {
  const { wait, sent, notices } = setup(t);
  await wait("2s first");
  await wait("1s second");
  assert.match(notices.at(-1)[0], /already scheduled/);
  t.mock.timers.tick(2000);
  await wait("1s discarded");
  await wait("cancel");
  await wait("1.5s third");
  t.mock.timers.tick(1500);
  assert.deepEqual(sent.map(([text]) => text), ["first", "third"]);
});

for (const event of ["session_shutdown", "session_tree"]) {
  test(`${event} clears the timer so the prompt cannot land elsewhere`, async (t) => {
    const { wait, emit, sent, statuses } = setup(t);
    await wait("2m continue");
    emit(event);
    t.mock.timers.tick(120_000);
    assert.deepEqual(sent, []);
    assert.deepEqual(statuses.at(-1), ["wait", undefined]);
  });
}
