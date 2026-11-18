import { describe, expect, it } from "vitest";

import {
  chapterListEquals,
  chapterListSchema,
  parseChapterList,
} from "../src/chapterList";

// Per-suite dump helper: console.error's the input + parsed/computed result
// against the expectation so a parse/equality failure is diagnosable from CI
// logs. Body wrapped in try/catch so a dump failure can't mask the assertion.
const dumpChapterList = (label: string, input: unknown, actual: unknown, expected: unknown): void => {
  try {
    console.error(`=== [chapterList:${label}] snapshot ===`);
    console.error(`input:    ${JSON.stringify(input)}`);
    console.error(`actual:   ${JSON.stringify(actual)}`);
    console.error(`expected: ${JSON.stringify(expected)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("parseChapterList", () => {
  it("returns the parsed array for a well-formed payload", () => {
    const parsed = parseChapterList([
      { time: 0, title: "Cold open" },
      { time: 95.2, title: "Opening titles" },
      { time: 138, title: "Act one" },
    ]);
    expect(parsed).toEqual([
      { time: 0, title: "Cold open" },
      { time: 95.2, title: "Opening titles" },
      { time: 138, title: "Act one" },
    ]);
  });

  it("accepts chapters without a title (mpv's chapter-list often has untitled entries)", () => {
    const parsed = parseChapterList([{ time: 0 }, { time: 42.5 }]);
    expect(parsed).toEqual([{ time: 0 }, { time: 42.5 }]);
  });

  it("passes through extra fields mpv may include (forward-compat)", () => {
    const parsed = parseChapterList([
      { time: 0, title: "Cold open", "some-future-field": "value" },
    ]);
    expect(parsed).toEqual([
      { time: 0, title: "Cold open", "some-future-field": "value" },
    ]);
  });

  it("returns empty array on non-array input (defensive)", () => {
    expect(parseChapterList(null)).toEqual([]);
    expect(parseChapterList(undefined)).toEqual([]);
    expect(parseChapterList({})).toEqual([]);
    expect(parseChapterList("not chapters")).toEqual([]);
  });

  it("returns empty array when any entry is missing the required `time` field", () => {
    // The schema requires `time` on every entry; one missing entry tanks
    // the whole list rather than silently filtering, so the caller sees
    // a consistent "no chapters" signal instead of a partial list.
    console.info(`[chapterList:missing-time] parsing list with one entry missing time`);
    const input = [{ time: 0, title: "Cold open" }, { title: "Missing time" }];
    const parsed = parseChapterList(input);
    try {
      expect(parsed).toEqual([]);
    } catch (err) {
      dumpChapterList("missing-time", input, parsed, []);
      throw err;
    }
  });

  it("returns empty array when `time` is not a number", () => {
    console.info(`[chapterList:stringy-time] parsing list with non-numeric time`);
    const input = [{ time: "0", title: "Stringy time" }];
    const parsed = parseChapterList(input);
    try {
      expect(parsed).toEqual([]);
    } catch (err) {
      dumpChapterList("stringy-time", input, parsed, []);
      throw err;
    }
  });
});

describe("chapterListEquals", () => {
  it("returns true for two empty lists", () => {
    expect(chapterListEquals([], [])).toBe(true);
  });

  it("returns false when lengths differ", () => {
    expect(
      chapterListEquals([{ time: 0 }, { time: 30 }], [{ time: 0 }]),
    ).toBe(false);
  });

  it("returns true when first AND last times match within tolerance", () => {
    // Mirrors sf.lua:438 chapter_list_matches — checks boundaries only,
    // not interior elements (mpv may re-sort).
    console.info(`[chapterList:boundary-only] comparing lists with differing interior time`);
    const a = [{ time: 0 }, { time: 30 }, { time: 60 }];
    const b = [{ time: 0 }, { time: 31 }, { time: 60 }];
    const result = chapterListEquals(a, b);
    try {
      expect(result).toBe(true);
    } catch (err) {
      dumpChapterList("boundary-only", { a, b }, result, true);
      throw err;
    }
  });

  it("respects the toleranceSeconds parameter on first time", () => {
    expect(
      chapterListEquals([{ time: 0 }], [{ time: 0.0005 }], 0.001),
    ).toBe(true);
    expect(
      chapterListEquals([{ time: 0 }], [{ time: 0.5 }], 0.001),
    ).toBe(false);
  });

  it("respects the toleranceSeconds parameter on last time", () => {
    expect(
      chapterListEquals(
        [{ time: 0 }, { time: 60 }],
        [{ time: 0 }, { time: 60.0005 }],
        0.001,
      ),
    ).toBe(true);
    expect(
      chapterListEquals(
        [{ time: 0 }, { time: 60 }],
        [{ time: 0 }, { time: 60.5 }],
        0.001,
      ),
    ).toBe(false);
  });

  it("returns false when either side has a non-numeric time", () => {
    // Defensive against caller-side parsing slip (e.g. mpv returns
    // chapter-list with a missing `time` for an unindexed chapter).
    expect(
      chapterListEquals(
        [{ time: 0 }, { time: 60 }],
        [{ time: 0 }, {}],
      ),
    ).toBe(false);
  });
});

describe("chapterListSchema (re-exported)", () => {
  it("is the same schema parseChapterList uses internally", () => {
    // Smoke test that consumers who want the Zod schema directly (e.g.
    // for composition into a larger schema) can import it.
    const result = chapterListSchema.safeParse([{ time: 12.5 }]);
    expect(result.success).toBe(true);
  });
});
