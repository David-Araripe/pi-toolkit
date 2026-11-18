import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Use Pi's real extension loader, skill discovery, and native command expansion.
// No model calls, credentials, network access, or generated learning artifacts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = process.env.PI_TEST_AGENT_ROOT || resolve(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const fromPi = (path) => import(pathToFileURL(resolve(agentRoot, "dist", path)));
const { loadExtensions } = await fromPi("core/extensions/loader.js");
const { createEventBus } = await fromPi("core/event-bus.js");
const { loadSkillsFromDir, formatSkillsForPrompt } = await fromPi("core/skills.js");
const { AgentSession } = await fromPi("core/agent-session.js");
const names = ["grill-me", "teach", "handoff"];

function discover() {
  const skills = [];
  for (const name of [...names, "grilling"]) {
    const loaded = loadSkillsFromDir({ dir: resolve(root, "skills", name), source: "test" });
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(loaded.skills.length, 1);
    skills.push(...loaded.skills);
  }
  return skills;
}

async function harness() {
  const loaded = await loadExtensions(
    [resolve(root, "extensions/productivity-commands.ts")], root, createEventBus(),
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const messages = [];
  loaded.runtime.sendUserMessage = (...args) => messages.push(args);
  return { commands: loaded.extensions[0].commands, messages };
}

test("skills load without warnings; entry points stay explicit-only", () => {
  const skills = discover();
  for (const name of names) {
    assert.equal(skills.find((skill) => skill.name === name).disableModelInvocation, true);
  }
  assert.equal(skills.find((skill) => skill.name === "grilling").disableModelInvocation, false);
  const advertised = formatSkillsForPrompt(skills);
  assert.match(advertised, /<name>grilling<\/name>/);
  for (const name of names) assert.ok(!advertised.includes(`<name>${name}</name>`));
});

test("short aliases preserve requests and expand the actual hidden skill", async () => {
  const { commands, messages } = await harness();
  assert.deepEqual([...commands.keys()], names);
  const skills = discover();
  for (const name of names) {
    assert.ok(commands.get(name).description);
    for (const request of ["", "   ", 'Explain "cache misses" and $HOME\nThen discuss $1 and /commands']) {
      let waited = false;
      await commands.get(name).handler(request, {
        waitForIdle: async () => { waited = true; },
      });
      assert.equal(waited, true);
      const [text, options] = messages.shift();
      assert.equal(text, `/skill:${name}${request.trim() ? ` ${request.trim()}` : ""}`);
      assert.deepEqual(options, { expandPromptTemplates: true });
      const expanded = AgentSession.prototype._expandSkillCommand.call({
        resourceLoader: { getSkills: () => ({ skills }) },
      }, text);
      assert.ok(expanded.startsWith(`<skill name="${name}" location="`));
      assert.ok(expanded.includes(`References are relative to ${resolve(root, "skills", name)}.`));
      assert.ok(expanded.endsWith(request.trim() ? `</skill>\n\n${request.trim()}` : "</skill>"));
    }
  }
});

test("aliases wait for idle before sending a user request", async () => {
  const { commands, messages } = await harness();
  let release;
  const idle = new Promise((resolveIdle) => { release = resolveIdle; });
  const running = commands.get("teach").handler("Learn Rust", { waitForIdle: () => idle });
  assert.deepEqual(messages, []);
  release();
  await running;
  assert.equal(messages.length, 1);
});

test("package manifest ships aliases and all required skill resources", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions"));
  assert.ok(manifest.pi.skills.includes("./skills"));
  const grill = readFileSync(resolve(root, "skills/grill-me/SKILL.md"), "utf8");
  assert.ok(grill.includes("../grilling/SKILL.md"));
  assert.ok(existsSync(resolve(root, "skills/grill-me/../grilling/SKILL.md")));
  const teach = readFileSync(resolve(root, "skills/teach/SKILL.md"), "utf8");
  for (const name of ["MISSION", "RESOURCES", "LEARNING-RECORD", "GLOSSARY"]) {
    assert.ok(teach.includes(`./${name}-FORMAT.md`));
    assert.ok(existsSync(resolve(root, "skills/teach", `${name}-FORMAT.md`)));
  }
  const license = readFileSync(resolve(root, "licenses/mattpocock-skills-MIT.txt"), "utf8");
  assert.match(license, /Copyright \(c\) 2026 Matt Pocock/);
  for (const skill of discover()) {
    const body = readFileSync(skill.filePath, "utf8");
    assert.match(body, /license: "MIT;/);
    assert.ok(existsSync(resolve(skill.baseDir, "../../licenses/mattpocock-skills-MIT.txt")));
    assert.doesNotMatch(body, /call the Skill tool|dispatch a sub-agent to find it/i);
  }
});
