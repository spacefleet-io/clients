import { describe, expect, it } from "vitest";
import { resolveTranscodeOutputs } from "../src/labQueueShared";

const SUITE = "lab-queue-shared";

const dumpLabQueueSnapshot = (
  label: string,
  ctx: {
    selections?: unknown;
    fallbackEnabled?: boolean;
    actualOutputs?: unknown;
    expectedOutputs?: unknown;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.selections !== undefined) {
      console.error(`input selections:\n${JSON.stringify(ctx.selections, null, 2)}`);
    }
    if (ctx.fallbackEnabled !== undefined) {
      console.error(`fallbackEnabled=${ctx.fallbackEnabled}`);
    }
    if (ctx.actualOutputs !== undefined) {
      console.error(`actual outputs:\n${JSON.stringify(ctx.actualOutputs, null, 2)}`);
    }
    if (ctx.expectedOutputs !== undefined) {
      console.error(`expected outputs:\n${JSON.stringify(ctx.expectedOutputs, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("lab queue shared helpers", () => {
  it("@bugfix @regression-proof keeps empty transcode output selections empty instead of silently restoring fallback outputs", () => {
    console.info(`[${SUITE}:setup] inputs: selections=[] tested with fallback=false then fallback=true`);

    console.info(`[${SUITE}:exec] calling resolveTranscodeOutputs([], false)`);
    const withoutFallback = resolveTranscodeOutputs([], false);
    console.info(`[${SUITE}:exec] resolveTranscodeOutputs([], false) returned length=${withoutFallback.length}`);

    try {
      expect(withoutFallback).toEqual([]);
    } catch (err) {
      dumpLabQueueSnapshot("empty-selections-no-fallback", {
        selections: [],
        fallbackEnabled: false,
        actualOutputs: withoutFallback,
        expectedOutputs: [],
      });
      throw err;
    }

    console.info(`[${SUITE}:exec] calling resolveTranscodeOutputs([], true)`);
    const withFallback = resolveTranscodeOutputs([], true);
    console.info(`[${SUITE}:exec] resolveTranscodeOutputs([], true) returned length=${withFallback.length}`);

    try {
      expect(withFallback).toEqual([]);
    } catch (err) {
      dumpLabQueueSnapshot("empty-selections-with-fallback", {
        selections: [],
        fallbackEnabled: true,
        actualOutputs: withFallback,
        expectedOutputs: [],
      });
      throw err;
    }
  });
});
