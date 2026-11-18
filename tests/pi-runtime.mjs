// Resolve dependencies from the selected SDK, not an assumed npm directory layout.
// Pi loads TypeScript with Jiti; tests should not require native Node TS support.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export const agentRoot = process.env.PI_TEST_AGENT_ROOT || resolve(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);

export function piDependency(name, file = "dist/index.js", root = agentRoot) {
  const require = createRequire(join(root, "package.json"));
  // pi-ai has import-only exports, so require.resolve(name) cannot resolve it.
  // Use Node's package search order for both nested and hoisted installations.
  for (const modules of require.resolve.paths(name) ?? []) {
    const path = join(modules, name, file);
    if (existsSync(path)) return path;
  }
  throw new Error(`Cannot find ${name}/${file} from Pi SDK ${root}`);
}

let loader;
export function loadTypeScript(path) {
  if (!loader) {
    const require = createRequire(join(agentRoot, "package.json"));
    const { createJiti } = require("jiti");
    loader = createJiti(import.meta.url, { alias: {
      "@earendil-works/pi-coding-agent": join(agentRoot, "dist/index.js"),
      "@earendil-works/pi-ai/compat": piDependency("@earendil-works/pi-ai", "dist/compat.js"),
      "@earendil-works/pi-ai": piDependency("@earendil-works/pi-ai"),
      "typebox": require.resolve("typebox"),
    } });
  }
  return loader.import(path);
}
