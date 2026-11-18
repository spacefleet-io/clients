import { describe, expect, it } from "vitest";

import { buildScriptMessageCommand } from "../src/commands";
import {
  audioPayloadSchema,
  audioStallPayloadSchema,
  chaptersPayloadSchema,
  ENVELOPE_SCHEMAS,
  playbackPayloadSchema,
  subtitleEntrySchema,
  subtitlesPayloadSchema,
  type SubtitlesPayload,
  labelsPayloadSchema,
  oscActionFileSchema,
} from "../src/envelopes";

// Per-suite dump helper: runs safeParse so the FULL Zod issue list is visible
// on failure (a bare `.parse(...).toBeTruthy()` throws an opaque ZodError).
// Body wrapped in try/catch so a dump failure can't mask the real assertion.
const dumpParse = (label: string, schema: { safeParse: (v: unknown) => unknown }, input: unknown): void => {
  try {
    const result = schema.safeParse(input) as {
      success: boolean;
      error?: { issues?: unknown };
      data?: unknown;
    };
    console.error(`=== [envelopes:${label}] parse snapshot ===`);
    console.error(`input:   ${JSON.stringify(input)}`);
    console.error(`success: ${result.success}`);
    if (result.success) {
      console.error(`data:    ${JSON.stringify(result.data)}`);
    } else {
      console.error(`issues:  ${JSON.stringify(result.error?.issues ?? result.error)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("oscActionFileSchema", () => {
  // #2473 #2487 #2488: the place in the episode left rides the action, so the
  // renderer saves it before the switch (PLAY-RESUME-02). Zod strips unknown
  // keys: without the field the renderer never sees it.
  it("@bugfix @regression-proof keeps timePos, the place in the episode left", () => {
    const input = { type: "next_episode", requestedAt: 1234, timePos: 630.04 };
    const result = oscActionFileSchema.safeParse(input);
    if (!result.success) dumpParse("osc-action-time-pos", oscActionFileSchema, input);
    expect(result.success && result.data).toEqual(input);
  });

  it("accepts an action without timePos (mpv had no time-pos)", () => {
    const result = oscActionFileSchema.safeParse({ type: "previous_episode", requestedAt: 1 });
    expect(result.success && result.data).toEqual({ type: "previous_episode", requestedAt: 1 });
  });
});

describe("subtitlesPayloadSchema", () => {
  it("accepts the minimal entry shape (url only)", () => {
    const parsed = subtitlesPayloadSchema.parse([{ url: "/a.srt" }]);
    expect(parsed).toEqual([{ url: "/a.srt" }]);
  });

  it("accepts entries with optional title/lang/format/selected", () => {
    const payload: SubtitlesPayload = [
      { url: "/a.srt", title: "English", lang: "en", format: "srt" },
      { url: "/b.srt", title: "Français", lang: "fr", format: "srt", selected: true },
    ];
    expect(subtitlesPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("accepts null title/lang/format (the renderer often uses null)", () => {
    expect(
      subtitlesPayloadSchema.parse([
        { url: "/a.srt", title: null, lang: null, format: null },
      ]),
    ).toBeTruthy();
  });

  it("rejects entries that are missing url", () => {
    expect(() =>
      subtitleEntrySchema.parse({ title: "English", lang: "en" }),
    ).toThrow();
  });

  it("@bugfix @regression-proof keeps the selected:boolean field on the wire", () => {
    // 7d42d8ff fix: dropping or weakening `selected` resurrects the
    // refresh-seek loop. The schema must accept selected: true|false|absent
    // (one entry may carry true; absence is treated as false by sf.lua).
    console.info(`[envelopes:selected-field] parsing subtitles payload with mixed selected flags`);
    const input = [
      { url: "/a.srt", selected: false },
      { url: "/b.srt", selected: true },
      { url: "/c.srt" },
    ];
    try {
      expect(subtitlesPayloadSchema.parse(input)).toHaveLength(3);
    } catch (err) {
      dumpParse("selected-field", subtitlesPayloadSchema, input);
      throw err;
    }
  });
});

describe("chaptersPayloadSchema", () => {
  it("accepts minimal chapter entries", () => {
    const parsed = chaptersPayloadSchema.parse([
      { title: "Cold Open", startSeconds: 0 },
      { title: "Act 1", startSeconds: 60, endSeconds: 600, orderIndex: 1 },
      { title: "Act 2", startSeconds: 600, endSeconds: null, orderIndex: 2 },
    ]);
    expect(parsed).toHaveLength(3);
  });

  it("rejects entries missing title or startSeconds", () => {
    expect(() =>
      chaptersPayloadSchema.parse([{ title: "OK" } as unknown as object]),
    ).toThrow();
    expect(() =>
      chaptersPayloadSchema.parse([{ startSeconds: 1 } as unknown as object]),
    ).toThrow();
  });
});

describe("audioPayloadSchema", () => {
  it("accepts the renderer's title/label/lang shape", () => {
    expect(
      audioPayloadSchema.parse([
        { title: "Japanese", label: "Japanese", lang: "ja" },
        { title: "English - Dub", label: "English - Dub", lang: "en" },
      ]),
    ).toHaveLength(2);
  });

  it("accepts entries with null fields", () => {
    expect(
      audioPayloadSchema.parse([{ title: null, label: null, lang: null }]),
    ).toBeTruthy();
  });
});

describe("playbackPayloadSchema", () => {
  it("accepts the full playback bundle shape", () => {
    console.info(`[envelopes:playback-bundle] parsing full playback bundle (markers + title + previous/next episode)`);
    const input = {
      markers: [
        { type: "intro", startSeconds: 10, endSeconds: 45 },
        { type: "credits", startSeconds: 1800, endSeconds: 1920 },
      ],
      title: "Lodgers · S1 E2 · The Lodger with the Spare Key",
      previousEpisode: { id: "ep-1", label: "S01E01" },
      nextEpisode: { id: "ep-2", label: "S01E02" },
      autoplayNextEpisode: true,
      fallbackCountdownSeconds: 15,
    };
    try {
      expect(playbackPayloadSchema.parse(input)).toBeTruthy();
    } catch (err) {
      dumpParse("playback-bundle", playbackPayloadSchema, input);
      throw err;
    }
  });

  it("accepts previousEpisode: null and nextEpisode: null", () => {
    expect(
      playbackPayloadSchema.parse({
        markers: [],
        title: "Slow Burn (1995)",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        fallbackCountdownSeconds: 15,
      }),
    ).toBeTruthy();
  });

  it("rejects unknown marker.type", () => {
    expect(() =>
      playbackPayloadSchema.parse({
        markers: [{ type: "bogus", startSeconds: 0, endSeconds: 1 }],
        title: "",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        fallbackCountdownSeconds: 15,
      }),
    ).toThrow();
  });

  it("rejects a bundle without the what's-playing title", () => {
    expect(() =>
      playbackPayloadSchema.parse({
        markers: [],
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        fallbackCountdownSeconds: 15,
      }),
    ).toThrow();
  });
});

describe("labelsPayloadSchema", () => {
  it("accepts the subtitle Off label the OSC menu shows", () => {
    expect(labelsPayloadSchema.parse({ subtitlesOff: "Aucun" })).toEqual({ subtitlesOff: "Aucun" });
  });

  it("rejects a payload without the label", () => {
    expect(() => labelsPayloadSchema.parse({})).toThrow();
  });
});

describe("audioStallPayloadSchema (MPV-AUDIO-01)", () => {
  it("accepts stalled with output and device, and cleared; rejects the rest", () => {
    const stalled = { state: "stalled", output: "pipewire", device: "WH-1000XM4 (pipewire/bluez_output.AC_80_0A)" };
    console.info(`[envelopes:audio-stall] stalled=${JSON.stringify(stalled)}`);
    expect(audioStallPayloadSchema.safeParse(stalled).success).toBe(true);
    expect(audioStallPayloadSchema.safeParse({ state: "cleared" }).success).toBe(true);
    expect(audioStallPayloadSchema.safeParse({ state: "stalled" }).success).toBe(false);
    expect(audioStallPayloadSchema.safeParse({ state: "other" }).success).toBe(false);
    expect(JSON.parse(buildScriptMessageCommand("sf-audio-stall", { state: "cleared" }).command[2])).toEqual({ state: "cleared" });
  });
});

describe("ENVELOPE_SCHEMAS map", () => {
  it("exposes all nine channel schemas", () => {
    const actual = Object.keys(ENVELOPE_SCHEMAS).sort();
    const expected = [
      "sf-audio-json",
      "sf-audio-stall",
      "sf-chapters-json",
      "sf-labels-json",
      "sf-playback-json",
      "sf-preview-picture",
      "sf-preview-sheets",
      "sf-subtitle-fetch-json",
      "sf-subtitles-json",
    ].sort();
    console.info(`[envelopes:schema-map] channels=${JSON.stringify(actual)}`);
    try {
      expect(actual).toEqual(expected);
    } catch (err) {
      try {
        console.error(`=== [envelopes:schema-map] snapshot ===`);
        console.error(`actual:   ${JSON.stringify(actual)}`);
        console.error(`expected: ${JSON.stringify(expected)}`);
      } catch (dumpErr) {
        console.error(`(snapshot failed: ${dumpErr instanceof Error ? dumpErr.message : String(dumpErr)})`);
      }
      throw err;
    }
  });
});
