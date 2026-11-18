import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { piDependency } from "./pi-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = process.env.PI_TEST_AGENT_ROOT || resolve(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const fromPi = (path) => import(pathToFileURL(resolve(agentRoot, "dist", path)));
const { loadExtensions } = await fromPi("core/extensions/loader.js");
const { createEventBus } = await fromPi("core/event-bus.js");
// Pi 1.5.1+ stores `{ transformer, messageTypes }`; earlier versions stored the function.
const transformerOf = (ext) => typeof ext.markdownTransformer === "function"
  ? ext.markdownTransformer
  : ext.markdownTransformer?.transformer;

// No network, model calls, credentials, or file removal. Retain tiny test fixtures
// in the OS temporary directory, as required by the repository's safety policy.
const workspace = mkdtempSync(resolve(tmpdir(), "pi-file-links-"));
const names = [
  "instructions-vps.md", "a(b).md", "a b.md", "café.md", "hash#?.md", "a%20.md",
  "a*b_[x].md", "tick`name.md", "ending``", "a&b.md", "a<hi>.md",
];
for (const name of names) writeFileSync(resolve(workspace, name), "test fixture\n");
mkdirSync(resolve(workspace, "docs"));
writeFileSync(resolve(workspace, "docs", "guide.md"), "test fixture\n");
const url = (name) => pathToFileURL(resolve(workspace, name)).href;
const pathSpan = (name, suffix = "") => "`" + resolve(workspace, name) + suffix + "`";
// Descriptive labels are kept, followed by the full path.
const labeled = (label, name, suffix = "") => `${label} (${pathSpan(name, suffix)})`;

async function harness(cwd = workspace) {
  const bus = createEventBus();
  let remote;
  bus.on("hpc-mode:workspace-query", ({ reply }) => reply(remote));
  const loaded = await loadExtensions([resolve(root, "extensions/file-links.ts")], root, bus);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const markdownTransformer = transformerOf(ext);
  assert.equal(typeof markdownTransformer, "function");
  const transform = (text, messageType = "assistant", isStreaming = false) => markdownTransformer(
    text, { messageType, isStreaming, availableWidth: 100 },
  );
  const event = async (name, directory = cwd) => {
    for (const handler of ext.handlers.get(name) || []) await handler({}, { cwd: directory });
  };
  await event("session_start");
  return { transform, event, setRemote: (value) => { remote = value; } };
}

test("real Pi loader registers a render-only transformer, not tools or message hooks", async () => {
  const bus = createEventBus();
  const loaded = await loadExtensions([resolve(root, "extensions/file-links.ts")], root, bus);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  assert.equal(ext.tools.size, 0);
  assert.equal(ext.commands.size, 0);
  assert.deepEqual([...ext.handlers.keys()], ["session_start", "session_shutdown"]);
  if (ext.markdownTransformer?.messageTypes) {
    assert.deepEqual([...ext.markdownTransformer.messageTypes].sort(), ["assistant", "assistant-thinking", "user"]);
  }
  assert.equal(transformerOf(ext)("[file](instructions-vps.md)", { messageType: "assistant" }), "[file](instructions-vps.md)");
});

test("the reported short, code-styled filename resolves against session cwd", async () => {
  const { transform } = await harness();
  const input = "Created [`instructions-vps.md`](instructions-vps.md) covering deployment.";
  const expected = `Created ${pathSpan("instructions-vps.md")} covering deployment.`;
  assert.equal(transform(input), expected);
  assert.equal(transform(input, "assistant", true), expected);
  assert.equal(transform(expected), expected); // repeated rendering is idempotent
});

test("relative, absolute, nested, encoded, Unicode paths and URL suffixes", async () => {
  const { transform } = await harness();
  for (const [href, name, suffix = ""] of [
    ["./instructions-vps.md", "instructions-vps.md"],
    ["docs/../instructions-vps.md", "instructions-vps.md"],
    [resolve(workspace, "instructions-vps.md"), "instructions-vps.md"],
    ["docs/guide.md", "docs/guide.md"],
    ["a(b).md", "a(b).md"],
    ["a\\(b\\).md", "a(b).md"],
    ["a%20b.md", "a b.md"],
    ["café.md", "café.md"],
    ["hash%23%3F.md", "hash#?.md"],
    ["a%2520.md", "a%20.md"],
  ]) assert.equal(transform(`[file](${href})`), labeled("file", name), href);
  assert.equal(transform("[with spaces](<a b.md>)"), labeled("with spaces", "a b.md"));
});

test("line anchors become clickable :line suffixes; other fragments stay visible but separate", async () => {
  const { transform } = await harness();
  for (const [href, suffix] of [
    ["instructions-vps.md#L42", ":42"], ["instructions-vps.md#L42-L50", ":42"],
    ["instructions-vps.md#L42C7", ":42:7"], ["instructions-vps.md:42", ":42"],
    ["instructions-vps.md:42:7", ":42:7"], ["instructions-vps.md?raw=1#L3", ":3"],
  ]) assert.equal(transform(`[instructions-vps.md](${href})`), pathSpan("instructions-vps.md", suffix), href);
  assert.equal(transform("[instructions-vps.md](instructions-vps.md#setup)"), `${pathSpan("instructions-vps.md")} \`#setup\``);
  assert.equal(transform("[instructions-vps.md](instructions-vps.md?raw=1)"), pathSpan("instructions-vps.md"));
  assert.equal(transform("[missing](missing.md:42)"), "[missing](missing.md:42)");
});

test("redundant labels collapse to the path; descriptive labels are kept", async () => {
  const { transform } = await harness();
  const abs = resolve(workspace, "docs/guide.md");
  for (const label of [
    "guide.md", "`guide.md`", "**guide.md**", "docs/guide.md", "./docs/guide.md", abs,
    "`docs/guide.md:12`", "guide.md#L12", "guide.md (line 12)", "guide.md lines 3-9",
  ]) assert.equal(transform(`[${label}](docs/guide.md)`), pathSpan("docs/guide.md"), label);
  assert.equal(transform("[docs](docs/)"), "`" + resolve(workspace, "docs") + "`");
  assert.equal(transform("[`docs/`](docs)"), "`" + resolve(workspace, "docs") + "`");
  for (const label of ["the guide", "guide", "**setup guide**", "see `guide.md` for details"]) {
    assert.equal(transform(`[${label}](docs/guide.md)`), labeled(label, "docs/guide.md"), label);
  }
});

test("home paths, formatted labels, titles and reference links", async () => {
  const { transform } = await harness();
  // Probe the already-known home directory only, not any credentials.
  assert.equal(transform("[home](~/)"), "home (`" + homedir() + "`)");
  assert.equal(transform("[~](~)"), "`" + homedir() + "`");
  assert.equal(transform('[**guide**](instructions-vps.md "My guide")'), labeled("**guide**", "instructions-vps.md"));
  assert.equal(transform('[a][guide]\n\n[guide]: instructions-vps.md "A guide"'), `${labeled("a", "instructions-vps.md")}\n\n[guide]: instructions-vps.md "A guide"`);
  assert.equal(transform('[instructions-vps.md][]\n\n[instructions-vps.md]: instructions-vps.md'), `${pathSpan("instructions-vps.md")}\n\n[instructions-vps.md]: instructions-vps.md`);
});

test("existing local file URLs also become visible absolute paths", async () => {
  const { transform } = await harness();
  for (const name of ["instructions-vps.md", "a b.md", "café.md", "hash#?.md", "a%20.md"]) {
    assert.equal(transform(`[short](<${url(name)}>)`), labeled("short", name));
    assert.equal(transform(`[${name.replace(/[[\]`*_<&]/g, "\\$&")}](<${url(name)}>)`), pathSpan(name), name);
  }
  const localhost = url("instructions-vps.md").replace("file:///", "file://localhost/");
  assert.equal(transform(`[short](${localhost}#setup)`), `short (${pathSpan("instructions-vps.md")} \`#setup\`)`);
  assert.equal(transform(`[instructions-vps.md](${localhost}#L9)`), pathSpan("instructions-vps.md", ":9"));
});

test("web schemes, anchors, remote, missing, unsafe, and malformed targets are untouched", async () => {
  const { transform } = await harness();
  for (const href of [
    "https://example.com/a.md", "http://example.com", "mailto:me@example.com",
    "file:///nonexistent-pi-file-links/already-absolute.md", "vscode://file/tmp/a.md", "ssh://host/a.md",
    "file://remote/tmp/a.md", "file:///tmp/%00.md", "file:///tmp/%GG.md", "file://[bad",
    "file:///Users/example/.ssh/config",
    "//example.com/a.md", "#setup", "cluster-a:/scratch/guide.md", "/scratch/nonexistent/guide.md",
    "missing.md", "$HOME/guide.md", "~other/guide.md", "%GG.md", "%00.md",
    "~/.ssh/config", "docs/../../.ssh/config", "",
  ]) {
    const input = `[file](${href})`;
    assert.equal(transform(input), input, href);
  }
  assert.equal(transform("[unfinished](instructions-vps.md"), "[unfinished](instructions-vps.md");
});

test("literal examples, code, images and HTML are preserved", async () => {
  const { transform } = await harness();
  const link = "[file](instructions-vps.md)";
  for (const input of [
    `\`${link}\``, `\`\`a \` ${link}\`\``, `\\${link}`,
    `\`\`\`md\n${link}\n\`\`\``, `~~~md\n${link}\n~~~`, `    ${link}\n`,
    `> \`\`\`md\n> ${link}\n> \`\`\``, `- \`\`\`md\n  ${link}\n  \`\`\``,
    `![file](instructions-vps.md)`, `<div>\n${link}\n</div>`,
    `<span title="${link}">text</span>`, `Text <code>${link}</code>`,
    `Text <a href="https://example.com">${link}</a>`,
    `https://example.com/${link}`, `<https://example.com/${link}>`,
    `www.example.com/${link}`, `ftp://example.com/${link}`,
  ]) assert.equal(transform(input), input);
  assert.equal(transform(`\`\`\`md\n${link}\n\`\`\`\n\n${link}`), `\`\`\`md\n${link}\n\`\`\`\n\n${labeled("file", "instructions-vps.md")}`);
  for (const prefix of ["- ", "> ", "1. ", "## "]) assert.equal(transform(prefix + link), `${prefix}${labeled("file", "instructions-vps.md")}`);
  assert.equal(transform(`Text <code>${link}</code> then ${link}`), `Text <code>${link}</code> then ${labeled("file", "instructions-vps.md")}`);
});

test("multiple links resolve independently without changing non-assistant messages", async () => {
  const { transform } = await harness();
  const input = "[instructions-vps.md](instructions-vps.md) and [b](docs/guide.md)";
  assert.equal(transform(input), `${pathSpan("instructions-vps.md")} and ${labeled("b", "docs/guide.md")}`);
  for (const role of ["user", "assistant-thinking"]) assert.equal(transform(input, role), input);
});

test("session replacement uses fresh cwd, shutdown disables resolution, remote mode skips it", async () => {
  const { transform, event, setRemote } = await harness();
  const input = "[file](instructions-vps.md)";
  setRemote("cluster-a");
  assert.equal(transform(input), input);
  setRemote(undefined);
  assert.notEqual(transform(input), input);
  await event("session_shutdown");
  assert.equal(transform(input), input);
  await event("session_start", resolve(workspace, "docs"));
  assert.equal(transform("[guide.md](guide.md)"), pathSpan("docs/guide.md"));
  assert.equal(transform(input), input);
});

test("the real TUI shows full paths without OSC 8 URLs, with or without hyperlink support", async () => {
  const { transform } = await harness();
  const { Markdown, setCapabilities } = await import(pathToFileURL(piDependency("@earendil-works/pi-tui", "dist/index.js", agentRoot)));
  const identity = (text) => text;
  const theme = Object.fromEntries([
    "heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder",
    "hr", "listBullet", "bold", "italic", "strikethrough", "underline",
  ].map((key) => [key, identity]));
  for (const hyperlinks of [true, false]) {
    setCapabilities({ hyperlinks, images: null, trueColor: true });
    for (const name of names) {
      const input = `Created [short](<${url(name)}>)`;
      const transformed = transform(input);
      assert.equal(transform(transformed), transformed);
      const rendered = new Markdown(input, 0, 0, theme, undefined, {
        transform: (source) => transform(source),
      }).render(200).join("\n");
      assert.ok(rendered.includes(resolve(workspace, name)), name);
      assert.ok(!rendered.includes("\x1b]8;;"), name);
      assert.ok(!rendered.includes("file://"), name);
    }
  }
});

test("extension is already covered by the package manifest", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions"));
  assert.ok(existsSync(resolve(root, "extensions/file-links.ts")));
});
