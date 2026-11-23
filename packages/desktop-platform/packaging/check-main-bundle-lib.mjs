// Workspace `@space/*` packages export raw TypeScript (`"exports": "./src/index.ts"`).
// The main and preload bundles must inline them: a bare `@space/*` import left in
// out/main or out/preload resolves to app.asar/node_modules at runtime, where Node
// refuses to strip types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) and the
// packaged app dies at startup (issue #25, PR #116).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BUNDLE_FILE = /\.(?:c|m)?js$/;
const WORKSPACE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])(@space\/[^"']+)\1/g;

/**
 * Lists every bare `@space/*` import, dynamic import or require left in the
 * bundle files under `dirs` (recursively). Missing directories are skipped.
 * @param {string[]} dirs
 * @returns {{ file: string, specifier: string }[]}
 */
export function findUnbundledWorkspaceImports(dirs) {
  const hits = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !BUNDLE_FILE.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      for (const match of readFileSync(file, "utf8").matchAll(WORKSPACE_IMPORT)) {
        hits.push({ file, specifier: match[2] });
      }
    }
  }
  return hits;
}
