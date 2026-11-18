import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectRendererBudgetEntries,
  evaluateRendererBudgets,
  formatRendererBudgetReport,
  readRendererManifest,
} from "./check-renderer-budgets-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, "..", "out", "renderer");

if (!existsSync(rendererDir)) {
  console.error(`Renderer build output not found: ${rendererDir}`);
  console.error("Run `bun run --cwd apps/badger/desktop build` before checking renderer budgets.");
  process.exit(1);
}

let manifest;
try {
  manifest = readRendererManifest(rendererDir);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const entries = collectRendererBudgetEntries(rendererDir, manifest);
const result = evaluateRendererBudgets(entries);
const report = formatRendererBudgetReport({ entries, ...result });

if (result.missing.length > 0 || result.violations.length > 0) {
  console.error(report);
  process.exit(1);
}

console.log(report);
