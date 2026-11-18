import { describe, expect, it } from "vitest";

import { formatMemoryReport, summarizeAppMetrics } from "../scripts/report-memory-baseline-lib.mjs";

// On assertion failure, dump the computed summary/report text so a
// byte-accounting or formatting regression is diagnosable from CI logs.
const dumpMemoryBaselineSnapshot = (label: string, computed: unknown) => {
  try {
    console.error(`=== [report-memory-baseline:${label}] snapshot ===`);
    console.error(`computed: ${JSON.stringify(computed, null, 2)}`);
    console.error(`=== [report-memory-baseline:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("report memory baseline helpers", () => {
  it("summarizes Electron process metrics by type", () => {
    console.info("[report-memory-baseline:summarize] summarizing 3 metric rows (1 Browser, 2 Tab)");
    const summary = summarizeAppMetrics([
      {
        pid: 101,
        type: "Browser",
        memory: {
          workingSetSize: 20000,
          privateBytes: 15000,
          peakWorkingSetSize: 22000,
        },
      },
      {
        pid: 202,
        type: "Tab",
        memory: {
          workingSetSize: 10000,
          privateBytes: 8000,
          peakWorkingSetSize: 12000,
        },
      },
      {
        pid: 203,
        type: "Tab",
        memory: {
          workingSetSize: 6000,
          privateBytes: 4000,
          peakWorkingSetSize: 9000,
        },
      },
    ]);

    console.info(`[report-memory-baseline:summarize] totalWorkingSetBytes=${summary.totalWorkingSetBytes} byType.length=${summary.byType.length}`);
    try {
      expect(summary.totalWorkingSetBytes).toBe((20000 + 10000 + 6000) * 1024);
      expect(summary.byType).toEqual([
        {
          type: "Browser",
          count: 1,
          workingSetBytes: 20000 * 1024,
          privateBytes: 15000 * 1024,
          peakWorkingSetBytes: 22000 * 1024,
        },
        {
          type: "Tab",
          count: 2,
          workingSetBytes: 16000 * 1024,
          privateBytes: 12000 * 1024,
          peakWorkingSetBytes: 12000 * 1024,
        },
      ]);
    } catch (err) {
      dumpMemoryBaselineSnapshot("summarize", summary);
      throw err;
    }
  });

  it("formats a readable memory report", () => {
    console.info("[report-memory-baseline:format] formatting memory report for 'login idle' state");
    const text = formatMemoryReport({
      buildLabel: "test build",
      states: [
        {
          label: "login idle",
          route: "/login",
          domNodeCount: 123,
          jsHeapUsedBytes: 8 * 1024 * 1024,
          processes: {
            totalWorkingSetBytes: 48 * 1024 * 1024,
            totalPrivateBytes: 32 * 1024 * 1024,
            byType: [
              {
                type: "Browser",
                count: 1,
                workingSetBytes: 20 * 1024 * 1024,
                privateBytes: 10 * 1024 * 1024,
                peakWorkingSetBytes: 24 * 1024 * 1024,
              },
            ],
          },
        },
      ],
    });

    console.info(`[report-memory-baseline:format] formatted report length=${text.length} chars`);
    try {
      expect(text).toContain("Build: test build");
      expect(text).toContain("login idle:");
      expect(text).toContain("- route: /login");
      expect(text).toContain("- DOM nodes: 123");
      expect(text).toContain("- JS heap used: 8.0 MiB");
      expect(text).toContain("- Electron working set: 48.0 MiB");
      expect(text).toContain("Browser: 1 process(es), working set 20.0 MiB");
    } catch (err) {
      dumpMemoryBaselineSnapshot("format", text);
      throw err;
    }
  });
});
