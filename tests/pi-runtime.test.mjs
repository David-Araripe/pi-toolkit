import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { piDependency } from "./pi-runtime.mjs";

function layout() {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-layout-"));
  const sdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), '{"name":"@earendil-works/pi-coding-agent"}');
  return { root, sdk };
}
function dependency(modules) {
  const file = join(modules, "@earendil-works/pi-ai/dist/index.js");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export const fixture = true;");
  writeFileSync(join(dirname(file), "../package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
  return file;
}

test("SDK dependencies resolve in hoisted layouts even with import-only exports", () => {
  const { root, sdk } = layout();
  const file = dependency(join(root, "node_modules"));
  assert.equal(piDependency("@earendil-works/pi-ai", "dist/index.js", sdk), file);
});

test("nested SDK dependencies take precedence over a different hoisted copy", () => {
  const { root, sdk } = layout();
  dependency(join(root, "node_modules"));
  const nested = dependency(join(sdk, "node_modules"));
  assert.equal(piDependency("@earendil-works/pi-ai", "dist/index.js", sdk), nested);
});

test("missing dependencies report the selected SDK rather than silently selecting another", () => {
  const { sdk } = layout();
  assert.throws(() => piDependency("@pi-test/missing-dependency", "dist/index.js", sdk), /Cannot find .* from Pi SDK/);
});
