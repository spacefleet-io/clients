import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findUnbundledWorkspaceImports } from "./check-main-bundle-lib.mjs";

// Optional argument: the desktop app directory to check. Defaults to the app
// this script lives in.
const appDir = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(appDir, "out");
const bundleDirs = [join(outDir, "main"), join(outDir, "preload")];

const missing = bundleDirs.filter((dir) => !existsSync(dir));
if (missing.length > 0) {
  console.error(`Main/preload build output not found: ${missing.join(", ")}`);
  console.error(`Run \`bun run build\` in ${appDir} before checking the main bundle.`);
  process.exit(1);
}

const hits = findUnbundledWorkspaceImports(bundleDirs);
if (hits.length > 0) {
  console.error("Workspace packages must be bundled into out/main and out/preload, not imported at runtime:");
  for (const { file, specifier } of hits) console.error(`  ${file}: ${specifier}`);
  console.error("Keep @space/* out of package.json `dependencies` (electron-vite externalizes every runtime dependency).");
  process.exit(1);
}

console.log("check:main-bundle: no unbundled @space/* imports in out/main or out/preload");
