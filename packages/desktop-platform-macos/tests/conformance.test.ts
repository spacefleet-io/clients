import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { conformanceChecks, createConformanceContext, disposeConformanceContext, type ConformanceContext } from "@space/desktop-platform-contract/conformance";
import { afterAll, beforeAll, describe, it } from "vitest";
import { platform } from "../src";
import { buildLifeline } from "./lifelineBuild";

const platformModule = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe.skipIf(process.platform !== "darwin")("macos desktop platform conformance", () => {
  let ctx: ConformanceContext;
  let lifeline: string;
  let previousLifeline: string | undefined;
  let previousBunPath: string | undefined;
  beforeAll(() => {
    // childLifetime needs bin/sf-lifeline of a deps bundle; build it from this checkout's source instead, and hand it to
    // the helper processes (they import the platform module and inherit the environment).
    lifeline = buildLifeline();
    previousLifeline = process.env.SF_LIFELINE_BIN;
    process.env.SF_LIFELINE_BIN = lifeline;
    // Under vitest (Node) the suite starts helpers with `$BUN_PATH` or `bun` from PATH. A version-manager shim there
    // (volta's `bun` is a launcher that runs the real binary as ITS child) puts a process between the suite and the
    // helper, so signals and parent-death checks would hit the shim. Point BUN_PATH at the real executable.
    previousBunPath = process.env.BUN_PATH;
    if (!previousBunPath) {
      const real = spawnSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf8" }).stdout?.trim();
      if (real) process.env.BUN_PATH = real;
    }
    ctx = createConformanceContext(platform, platformModule, (line) => console.info(`[conformance:macos] ${line}`));
  });
  afterAll(() => {
    disposeConformanceContext(ctx);
    if (previousLifeline === undefined) delete process.env.SF_LIFELINE_BIN;
    else process.env.SF_LIFELINE_BIN = previousLifeline;
    if (previousBunPath === undefined) delete process.env.BUN_PATH;
    rmSync(dirname(lifeline), { recursive: true, force: true });
  });

  for (const item of conformanceChecks) {
    it(`${item.id}: ${item.title}`, async (testContext) => {
      console.info(`[conformance:macos] >>> ${item.id}`);
      let skipped: string | void;
      try {
        skipped = await item.run(ctx);
        console.info(`[conformance:macos] <<< ${item.id} ${skipped ? `SKIP (${skipped})` : "ok"}`);
      } catch (error) {
        console.error(`[conformance:macos] !!! ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      if (skipped) testContext.skip(skipped);
    }, 60_000);
  }
});
