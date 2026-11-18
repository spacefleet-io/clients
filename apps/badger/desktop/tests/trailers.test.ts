import { describe, expect, it } from "vitest";
import { selectTrailersByLanguage } from "../src/renderer/src/lib/trailers";

// On failure, dump the input trailer set, the requested languages, and the
// resulting key order so a selection/ordering regression is diagnosable in CI.
const dumpTrailerSnapshot = (
  label: string,
  ctx: { input: unknown; langs: string[]; observedKeys: unknown; expectedKeys: unknown }
) => {
  try {
    console.error(`=== [trailers:${label}] snapshot ===`);
    console.error(`input:\n${JSON.stringify(ctx.input, null, 2)}`);
    console.error(`requested langs=${JSON.stringify(ctx.langs)}`);
    console.error(`observed keys=${JSON.stringify(ctx.observedKeys)}`);
    console.error(`expected keys=${JSON.stringify(ctx.expectedKeys)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("trailer selection", () => {
  it("prefers official trailers and language filtering", () => {
    const input = {
      originalLanguage: "en",
      trailers: [
        { key: "a", language: "en", official: true },
        { key: "b", language: "fr", official: true },
        { key: "c", language: "en", official: false },
      ] as any,
    };
    const langs = ["fr"];
    console.info(
      `[trailers:prefer-official] input ${input.trailers.length} trailers, requested langs=${JSON.stringify(langs)}`
    );
    const selected = selectTrailersByLanguage(input, langs);
    const observedKeys = selected.map((entry: any) => entry.key);
    const expectedKeys = ["a", "b"];
    console.info(`[trailers:prefer-official] selected keys=${JSON.stringify(observedKeys)} (expected ${JSON.stringify(expectedKeys)})`);
    if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys))
      dumpTrailerSnapshot("prefer-official", { input, langs, observedKeys, expectedKeys });

    expect(observedKeys).toEqual(expectedKeys);
  });

  it("falls back to candidates when no language matches", () => {
    const input = {
      originalLanguage: "es",
      trailers: [
        { key: "a", language: "en", official: true },
        { key: "b", language: "fr", official: true },
      ] as any,
    };
    const langs: string[] = [];
    console.info(
      `[trailers:fallback] input ${input.trailers.length} trailers, no requested langs (originalLanguage=${input.originalLanguage})`
    );
    const selected = selectTrailersByLanguage(input, langs);
    const observedKeys = selected.map((entry: any) => entry.key);
    const expectedKeys = ["a", "b"];
    console.info(`[trailers:fallback] selected keys=${JSON.stringify(observedKeys)} (expected ${JSON.stringify(expectedKeys)})`);
    if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys))
      dumpTrailerSnapshot("fallback", { input, langs, observedKeys, expectedKeys });

    expect(observedKeys).toEqual(expectedKeys);
  });
});
