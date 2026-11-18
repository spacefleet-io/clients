import { describe, expect, it } from "vitest";

import {
  collectRendererBudgetEntries,
  DEFAULT_RENDERER_BUDGETS,
  evaluateRendererBudgets,
  formatRendererBudgetReport,
} from "../scripts/check-renderer-budgets-lib.mjs";
import type { ManifestChunk, RendererBudgetEntry, RendererBudgetEvaluation } from "../scripts/check-renderer-budgets-lib.mjs";

// On a budget-eval mismatch, dump the collected entries, the evaluation result,
// and the rendered report so a violation/miss is diagnosable from the log alone.
type SnapshotContext = {
  manifest?: Record<string, ManifestChunk>;
  entries?: RendererBudgetEntry[];
  result?: RendererBudgetEvaluation;
  report?: string;
};

const dumpBudgetsSnapshot = (label: string, ctx: SnapshotContext) => {
  try {
    console.error(`=== [check-renderer-budgets:${label}] snapshot ===`);
    if (ctx.manifest !== undefined) {
      console.error(`manifest:\n${JSON.stringify(ctx.manifest, null, 2)}`);
    }
    if (ctx.entries !== undefined) {
      console.error(`entries:\n${JSON.stringify(ctx.entries, null, 2)}`);
    }
    if (ctx.result !== undefined) {
      console.error(`result.violations.length=${ctx.result.violations?.length}`);
      console.error(`result.missing.length=${ctx.result.missing?.length}`);
      console.error(`result:\n${JSON.stringify(ctx.result, null, 2)}`);
    }
    if (ctx.report !== undefined) {
      console.error(`report:\n${ctx.report}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Shape of a real badger renderer manifest (keys relative to src/renderer).
const manifest = {
  "_index-aaa.js": { file: "assets/index-aaa.js", name: "index" },
  "index.html": { file: "assets/index-zzz.js", name: "index", src: "index.html", isEntry: true },
  "index.html.css": { file: "assets/index-zzz.css", src: "index.html" },
  // Dynamic-import chunk with merged sibling modules: no facade, so no `src`.
  "_AuthenticatedApp-def.js": {
    file: "assets/AuthenticatedApp-def.js",
    name: "AuthenticatedApp",
    isDynamicEntry: true,
  },
  "_TopNav-ghi.js": { file: "assets/TopNav-ghi.js", name: "TopNav" },
  "src/components/TopNavJobsSidebarContent.tsx": {
    file: "assets/TopNavJobsSidebarContent-jkl.js",
    name: "TopNavJobsSidebarContent",
    src: "src/components/TopNavJobsSidebarContent.tsx",
    isDynamicEntry: true,
  },
  "src/components/FileIngestionDialog.tsx": {
    file: "assets/FileIngestionDialog-mno.js",
    name: "FileIngestionDialog",
    src: "src/components/FileIngestionDialog.tsx",
    isDynamicEntry: true,
  },
};

describe("renderer chunk budgets", () => {
  it("resolves each budget to its exact manifest chunk (entry from index.html, not an index-* helper)", () => {
    console.info(`[check-renderer-budgets:collect] collecting from ${Object.keys(manifest).length} manifest records`);
    const statted: string[] = [];
    const entries = collectRendererBudgetEntries("/tmp/renderer", manifest, DEFAULT_RENDERER_BUDGETS, (path) => {
      statted.push(path);
      return { size: 1024 };
    });

    const files = entries.map((entry) => entry.file);
    console.info(`[check-renderer-budgets:collect] resolved files=${JSON.stringify(files)} statted=${JSON.stringify(statted)}`);
    const expectedFiles = [
      "assets/index-zzz.js",
      "assets/AuthenticatedApp-def.js",
      "assets/TopNav-ghi.js",
      "assets/TopNavJobsSidebarContent-jkl.js",
      "assets/FileIngestionDialog-mno.js",
    ];
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
      dumpBudgetsSnapshot("collect", { manifest, entries });
    }
    expect(files).toEqual(expectedFiles);
    expect(statted).toContain("/tmp/renderer/assets/index-zzz.js");
  });

  it("reports a budget as missing when its selector matches zero or several chunks", () => {
    const ambiguous: Record<string, ManifestChunk> = {
      ...manifest,
      "_TopNav-xyz.js": { file: "assets/TopNav-xyz.js", name: "TopNav" },
    };
    delete ambiguous["_AuthenticatedApp-def.js"];
    const entries = collectRendererBudgetEntries("/tmp/renderer", ambiguous, DEFAULT_RENDERER_BUDGETS, () => ({
      size: 1024,
    }));
    const result = evaluateRendererBudgets(entries);
    const report = formatRendererBudgetReport({ entries, ...result });
    console.info(`[check-renderer-budgets:ambiguous] missing=${JSON.stringify(result.missing.map((e) => e.name))}`);
    console.info(`[check-renderer-budgets:ambiguous] report:\n${report}`);

    const names = result.missing.map((entry) => entry.name);
    if (JSON.stringify(names) !== JSON.stringify(["AuthenticatedApp", "TopNav"])) {
      dumpBudgetsSnapshot("ambiguous", { manifest: ambiguous, entries, result, report });
    }
    expect(names).toEqual(["AuthenticatedApp", "TopNav"]);
    expect(report).toContain('chunk name "AuthenticatedApp" matched 0 chunks');
    expect(report).toContain('chunk name "TopNav" matched 2 chunks');
  });

  it("reports missing chunks and budget violations deterministically", () => {
    const entries = [
      { ...DEFAULT_RENDERER_BUDGETS[0], file: "assets/index-abc.js", bytes: 2048 * 1024 },
      { ...DEFAULT_RENDERER_BUDGETS[1], file: null, bytes: null, reason: "not found" },
    ];
    console.info(
      `[check-renderer-budgets:evaluate] evaluating ${entries.length} entries (1 over-budget, 1 missing)`
    );
    const result = evaluateRendererBudgets(entries);
    const report = formatRendererBudgetReport({ entries, ...result });
    console.info(
      `[check-renderer-budgets:evaluate] violations=${result.violations.length} missing=${result.missing.length}`
    );

    if (
      result.violations.length !== 1 ||
      result.missing.length !== 1 ||
      !report.includes("Renderer chunk budget violations:") ||
      !report.includes("Missing expected renderer chunks:")
    ) {
      dumpBudgetsSnapshot("evaluate", { entries, result, report });
    }
    expect(result.violations).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
    expect(report).toContain("Renderer chunk budget violations:");
    expect(report).toContain("Missing expected renderer chunks:");
  });
});
