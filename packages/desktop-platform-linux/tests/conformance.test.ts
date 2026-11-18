import { fileURLToPath } from "node:url";
import { conformanceChecks, createConformanceContext, disposeConformanceContext, type ConformanceContext } from "@space/desktop-platform-contract/conformance";
import { afterAll, beforeAll, describe, it } from "vitest";
import { platform } from "../src";

const platformModule = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe.skipIf(process.platform !== "linux")("linux desktop platform conformance", () => {
  let ctx: ConformanceContext;
  beforeAll(() => {
    ctx = createConformanceContext(platform, platformModule, (line) => console.info(`[conformance:linux] ${line}`));
  });
  afterAll(() => disposeConformanceContext(ctx));

  for (const item of conformanceChecks) {
    it(`${item.id}: ${item.title}`, async (testContext) => {
      console.info(`[conformance:linux] >>> ${item.id}`);
      let skipped: string | void;
      try {
        skipped = await item.run(ctx);
        console.info(`[conformance:linux] <<< ${item.id} ${skipped ? `SKIP (${skipped})` : "ok"}`);
      } catch (error) {
        console.error(`[conformance:linux] !!! ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      if (skipped) testContext.skip(skipped);
    }, 60_000);
  }
});
