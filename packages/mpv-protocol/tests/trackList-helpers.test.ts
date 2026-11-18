import { describe, expect, it } from "vitest";

import {
  buildTrackSignature,
  hasUsableExternalTrackState,
  type MpvTrack,
} from "../src/trackList";

// Per-suite dump helper. Body wrapped in try/catch so a dump failure can never
// mask the real assertion. Surfaces the input tracks/args and actual vs
// expected for the failing helper case.
const dumpTrackHelperSnapshot = (
  label: string,
  ctx: { input?: unknown; actual?: unknown; expected?: unknown },
) => {
  try {
    console.error(`=== [mpv-protocol-trackList-helpers:${label}] snapshot ===`);
    console.error(`input=${JSON.stringify(ctx.input, null, 2)}`);
    console.error(`actual=${JSON.stringify(ctx.actual)} expected=${JSON.stringify(ctx.expected)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("buildTrackSignature", () => {
  it("emits a deterministic colon/pipe-joined signature per track", () => {
    console.info(`[mpv-protocol-trackList-helpers:signature-full] 3-track list (video/audio/sub)`);
    const tracks: MpvTrack[] = [
      { id: 1, type: "video", lang: "und", external: false, selected: true },
      { id: 2, type: "audio", lang: "fr", external: false, selected: false },
      { id: 3, type: "sub", lang: "en", external: true, selected: false },
    ];
    const sig = buildTrackSignature(tracks);
    const expected = "1:video:und:int:sel|2:audio:fr:int|3:sub:en:ext";
    console.info(`[mpv-protocol-trackList-helpers:signature-full] sig=${JSON.stringify(sig)}`);
    if (sig !== expected) {
      dumpTrackHelperSnapshot("signature-full", { input: tracks, actual: sig, expected });
    }
    expect(sig).toBe(expected);
  });

  it("omits empty fields cleanly", () => {
    console.info(`[mpv-protocol-trackList-helpers:signature-empty-fields] empty + id-only tracks`);
    const a = buildTrackSignature([{}]);
    const b = buildTrackSignature([{ id: 7 }]);
    console.info(`[mpv-protocol-trackList-helpers:signature-empty-fields] empty=${JSON.stringify(a)} idOnly=${JSON.stringify(b)}`);
    if (a !== "int" || b !== "7:int") {
      dumpTrackHelperSnapshot("signature-empty-fields", {
        input: [{}, { id: 7 }],
        actual: { empty: a, idOnly: b },
        expected: { empty: "int", idOnly: "7:int" },
      });
    }
    expect(a).toBe("int");
    expect(b).toBe("7:int");
  });

  it("returns empty string for empty list", () => {
    const sig = buildTrackSignature([]);
    if (sig !== "") {
      dumpTrackHelperSnapshot("signature-empty-list", { input: [], actual: sig, expected: "" });
    }
    expect(sig).toBe("");
  });
});

describe("hasUsableExternalTrackState", () => {
  it("returns false when list is empty or nullish", () => {
    console.info(`[mpv-protocol-trackList-helpers:usable-empty] empty/null/undefined lists → false`);
    const cases: Array<{ args: [unknown, unknown, unknown]; actual: boolean }> = [
      { args: [[], 0, 0], actual: hasUsableExternalTrackState([], 0, 0) },
      { args: [null, 0, 0], actual: hasUsableExternalTrackState(null, 0, 0) },
      { args: [undefined, 0, 0], actual: hasUsableExternalTrackState(undefined, 0, 0) },
    ];
    if (cases.some((c) => c.actual !== false)) {
      dumpTrackHelperSnapshot("usable-empty", { input: cases.map((c) => c.args), actual: cases.map((c) => c.actual), expected: false });
    }
    expect(hasUsableExternalTrackState([], 0, 0)).toBe(false);
    expect(hasUsableExternalTrackState(null, 0, 0)).toBe(false);
    expect(hasUsableExternalTrackState(undefined, 0, 0)).toBe(false);
  });

  it("returns true when signature has been stable for >=450 ms", () => {
    console.info(`[mpv-protocol-trackList-helpers:usable-stable] timePos=null, stableMs=450/600 → true`);
    const a = hasUsableExternalTrackState([{ id: 1, type: "video" }], null, 450);
    const b = hasUsableExternalTrackState([{ id: 1, type: "video" }], null, 600);
    if (a !== true || b !== true) {
      dumpTrackHelperSnapshot("usable-stable", {
        input: { stable450: a, stable600: b },
        actual: { stable450: a, stable600: b },
        expected: true,
      });
    }
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it("returns true when not yet stable but timePos is a finite non-negative number", () => {
    console.info(`[mpv-protocol-trackList-helpers:usable-timepos] timePos=0/1.5 with non-stable signature → true`);
    const a = hasUsableExternalTrackState([{ id: 1, type: "video" }], 0, 0);
    const b = hasUsableExternalTrackState([{ id: 1, type: "video" }], 1.5, 100);
    if (a !== true || b !== true) {
      dumpTrackHelperSnapshot("usable-timepos", {
        input: { timePos0: a, timePos1_5: b },
        actual: { timePos0: a, timePos1_5: b },
        expected: true,
      });
    }
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it("returns false when not stable AND timePos is missing or invalid", () => {
    console.info(`[mpv-protocol-trackList-helpers:usable-invalid] timePos=null/NaN/-1 with non-stable signature → false`);
    const a = hasUsableExternalTrackState([{ id: 1, type: "video" }], null, 100);
    const b = hasUsableExternalTrackState([{ id: 1, type: "video" }], Number.NaN, 100);
    const c = hasUsableExternalTrackState([{ id: 1, type: "video" }], -1, 100);
    if (a !== false || b !== false || c !== false) {
      dumpTrackHelperSnapshot("usable-invalid", {
        input: { timePosNull: a, timePosNaN: b, timePosNeg: c },
        actual: { timePosNull: a, timePosNaN: b, timePosNeg: c },
        expected: false,
      });
    }
    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(c).toBe(false);
  });
});
