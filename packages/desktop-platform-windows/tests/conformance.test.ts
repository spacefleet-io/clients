import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { conformanceChecks, type ConformanceResult } from "@space/desktop-platform-contract/conformance";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The conformance suite on a real Windows host. The suite needs `bun:ffi` (the
 * process-control checks), which vitest's Node workers lack, so the test runs
 * the standalone CLI under bun and reports each check. Skipped off Windows.
 */
const cli = fileURLToPath(new URL("../../desktop-platform/src/conformance-cli.ts", import.meta.url));

describe.skipIf(process.platform !== "win32")("windows desktop platform conformance", () => {
  let results: ConformanceResult[] = [];
  beforeAll(() => {
    console.info("[conformance:windows] running the conformance CLI under bun");
    const run = spawnSync("bun", [cli, "--json"], { encoding: "utf8", maxBuffer: 32 << 20, timeout: 280_000 });
    console.info(`[conformance:windows] cli exit ${run.status}\n${run.stderr}`);
    try {
      // Helper processes may log JSON lines on the shared stdout before the report.
      const start = run.stdout.indexOf('{\n  "platform"');
      results = (JSON.parse(run.stdout.slice(start)) as { results: ConformanceResult[] }).results;
    } catch (error) {
      throw new Error(`conformance CLI printed no JSON (exit ${run.status}): ${run.stdout.slice(-500)}\n${run.stderr.slice(-1500)}`, { cause: error });
    }
  }, 300_000);

  for (const item of conformanceChecks) {
    it(`${item.id}: ${item.title}`, (ctx) => {
      const result = results.find((candidate) => candidate.id === item.id);
      expect(result, `no result for ${item.id}`).toBeDefined();
      console.info(`[conformance:windows] ${item.id} -> ${result!.status} ${result!.detail ?? ""}`);
      if (result!.status === "skipped") ctx.skip(result!.detail ?? "skipped by the check");
      expect(result!.status, result!.detail).toBe("ok");
    });
  }
});
