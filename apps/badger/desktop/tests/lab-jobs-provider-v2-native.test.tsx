// @vitest-environment jsdom
//
// @bugfix @regression-proof
//
// Round 3 V2-native migration. Pre-fix: LabJobsProvider housed BOTH the
// V1 lab-queue IPC subscription and a V2-stream-to-LabJob bridge under one
// roof, with a feature-flag gate. Every UI bug that shipped lived in the
// conversion seam. Post-fix: LabJobsProvider drives `jobs/activeJobs/
// completedJobs/pendingFileIds` from `useRuntimeIngestJobs()` exclusively.
//
// This regression assertion guarantees the migration cannot silently
// regress to the dual-engine setup:
//   - The V1 lab-queue references (`window.sf.labQueue`,
//     `openAuthoritativeLabQueue`, `applyLabQueueActionsWithReconnect`,
//     `mergeLabJobs`, `localJobIdsRef`, `runtimeEngineV2Enabled` flag
//     branching) must NOT exist in `lib/labJobs.tsx`.
//   - The provider must wire `useRuntimeIngestJobs()` and route LabJob
//     conversion through `ingestJobsToLabJobs`.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

// Dump-on-failure: this suite scans labJobs.tsx source text for the presence /
// absence of legacy-vs-V2 symbols. On failure, report which forbidden symbols
// were still found (and what line they're on) so a regression is diagnosable
// offline without re-grepping by hand.
const dumpLabJobsSourceSnapshot = (
  label: string,
  source: string,
  symbols: { forbidden?: (string | RegExp)[]; required?: (string | RegExp)[] },
) => {
  try {
    console.error(`=== [lab-jobs-provider-v2-native:${label}] snapshot ===`);
    console.error(`source length=${source.length} chars`);
    const findLines = (needle: string | RegExp) => {
      const lines = source.split("\n");
      const hits: string[] = [];
      lines.forEach((line, i) => {
        const match =
          typeof needle === "string" ? line.includes(needle) : needle.test(line);
        if (match) hits.push(`L${i + 1}: ${line.trim()}`);
      });
      return hits;
    };
    for (const f of symbols.forbidden ?? []) {
      const hits = findLines(f);
      console.error(
        `forbidden ${String(f)} present=${hits.length > 0}${hits.length ? `\n  ${hits.join("\n  ")}` : ""}`,
      );
    }
    for (const r of symbols.required ?? []) {
      const hits = findLines(r);
      console.error(
        `required ${String(r)} present=${hits.length > 0}${hits.length ? `\n  ${hits.join("\n  ")}` : ""}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("LabJobsProvider V2-native (effervescent-teapot Round 3)", () => {
  const source = readSource("src/renderer/src/lib/labJobs.tsx");
  console.info(
    `[lab-jobs-provider-v2-native:setup] loaded labJobs.tsx source (${source.length} chars)`,
  );

  it("[@bugfix][@regression-proof] no longer references the legacy window.sf.labQueue IPC", () => {
    console.info(`[lab-jobs-provider-v2-native:no-labqueue] scanning for legacy labQueue IPC refs`);
    // Strip the doc comment header before scanning for code-level usages.
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "");
    try {
      expect(code).not.toMatch(/window\.sf\??\.labQueue/);
      expect(code).not.toContain("openAuthoritativeLabQueue");
      expect(code).not.toContain("applyLabQueueActionsWithReconnect");
    } catch (err) {
      dumpLabJobsSourceSnapshot("no-labqueue", code, {
        forbidden: [/window\.sf\??\.labQueue/, "openAuthoritativeLabQueue", "applyLabQueueActionsWithReconnect"],
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] no longer maintains parallel V1/V2 conversion paths", () => {
    console.info(`[lab-jobs-provider-v2-native:no-dual-paths] scanning for dual-engine conversion symbols`);
    try {
      expect(source).not.toContain("mergeLabJobs");
      expect(source).not.toContain("buildRemoteCommittedLabJobs");
      expect(source).not.toContain("localJobIdsRef");
    } catch (err) {
      dumpLabJobsSourceSnapshot("no-dual-paths", source, {
        forbidden: ["mergeLabJobs", "buildRemoteCommittedLabJobs", "localJobIdsRef"],
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] does not branch on the runtimeEngineV2Enabled flag", () => {
    console.info(`[lab-jobs-provider-v2-native:no-flag-branch] scanning for V2 feature-flag branching`);
    // The V2 default flip already happened; the provider treats V2 as
    // the only path.
    try {
      expect(source).not.toMatch(/runtimeEngineV2Enabled/);
      expect(source).not.toMatch(/v2Enabled/);
    } catch (err) {
      dumpLabJobsSourceSnapshot("no-flag-branch", source, {
        forbidden: [/runtimeEngineV2Enabled/, /v2Enabled/],
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] routes V2 ingest jobs through useRuntimeIngestJobs and ingestJobsToLabJobs", () => {
    console.info(`[lab-jobs-provider-v2-native:v2-routing] scanning for required V2 wiring symbols`);
    try {
      expect(source).toContain("useRuntimeIngestJobs");
      expect(source).toContain("ingestJobsToLabJobs");
      expect(source).toMatch(/useMemo\(\(\)\s*=>\s*ingestJobsToLabJobs\(/);
    } catch (err) {
      dumpLabJobsSourceSnapshot("v2-routing", source, {
        required: ["useRuntimeIngestJobs", "ingestJobsToLabJobs", /useMemo\(\(\)\s*=>\s*ingestJobsToLabJobs\(/],
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] cancel/dismiss/retry actions delegate to runtime ingest actions (no V1 lab-queue actions)", () => {
    console.info(`[lab-jobs-provider-v2-native:action-delegation] scanning for runtime action wiring + absence of V1 actions`);
    try {
      expect(source).toContain("useRuntimeIngestActions");
      expect(source).not.toContain("queueFiles");
      expect(source).not.toContain("queueFormatJobs");
      expect(source).not.toContain("setManualQuery");
      expect(source).not.toContain("toggleJobFormat");
    } catch (err) {
      dumpLabJobsSourceSnapshot("action-delegation", source, {
        required: ["useRuntimeIngestActions"],
        forbidden: ["queueFiles", "queueFormatJobs", "setManualQuery", "toggleJobFormat"],
      });
      throw err;
    }
  });
});
