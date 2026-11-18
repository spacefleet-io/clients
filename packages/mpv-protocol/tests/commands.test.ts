import { describe, expect, it } from "vitest";

import {
  buildLaunchTrackArgs,
  buildLoadfileCommand,
  buildScriptMessageCommand,
  buildSeekCommand,
  buildSubAddCommand,
  MPV_TRACK_SWITCH_SAFE_SECONDS,
  trackSwitchSeeksBeforeStart,
} from "../src/commands";
import type { ChaptersPayload, SubtitlesPayload } from "../src/envelopes";

// Per-suite dump helper: console.error's the built command (actual) against
// the expected wire shape so a builder failure is diagnosable from CI logs.
// Body wrapped in try/catch so a dump failure can't mask the real assertion.
const dumpCommand = (label: string, actual: unknown, expected?: unknown): void => {
  try {
    console.error(`=== [commands:${label}] command snapshot ===`);
    console.error(`actual:   ${JSON.stringify(actual)}`);
    if (expected !== undefined) {
      console.error(`expected: ${JSON.stringify(expected)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("buildScriptMessageCommand", () => {
  it("emits the canonical script-message wire shape", () => {
    const cmd = buildScriptMessageCommand("sf-subtitles-json", [
      { url: "/a.srt", title: "English", lang: "en" },
    ]);
    expect(cmd.command[0]).toBe("script-message");
    expect(cmd.command[1]).toBe("sf-subtitles-json");
    const parsed = JSON.parse(cmd.command[2]);
    expect(parsed).toEqual([{ url: "/a.srt", title: "English", lang: "en" }]);
  });

  it("preserves the `selected: true` flag in the serialized payload", () => {
    // Locked at apps/badger/desktop/tests/mpv-external-metadata.test.ts:121+
    console.info(`[commands:selected-flag] building sf-subtitles-json with 3 entries (1 selected)`);
    const payload: SubtitlesPayload = [
      { url: "/a.srt", selected: false },
      { url: "/b.srt", selected: true },
      { url: "/c.srt" },
    ];
    const cmd = buildScriptMessageCommand("sf-subtitles-json", payload);
    const parsed = JSON.parse(cmd.command[2]) as Array<{ url: string; selected?: boolean }>;
    const selected = parsed.find((entry) => entry.selected === true);
    try {
      expect(selected?.url).toBe("/b.srt");
      expect(parsed.filter((entry) => entry.selected === true)).toHaveLength(1);
    } catch (err) {
      dumpCommand("selected-flag", { cmd, parsed, selectedUrl: selected?.url });
      throw err;
    }
  });

  it("throws when the payload fails envelope validation (validate=true)", () => {
    expect(() =>
      buildScriptMessageCommand(
        "sf-subtitles-json",
        [{ title: "no url here" } as unknown as { url: string }],
        { validate: true },
      ),
    ).toThrow(/sf-subtitles-json/);
  });

  it("does not throw when validate=false even with bad payload", () => {
    const cmd = buildScriptMessageCommand(
      "sf-subtitles-json",
      [{ title: "no url here" } as unknown as { url: string }],
      { validate: false },
    );
    expect(cmd.command[1]).toBe("sf-subtitles-json");
  });

  it("validates chapter payloads", () => {
    const ok: ChaptersPayload = [
      { title: "Chapter 1", startSeconds: 0, endSeconds: null, orderIndex: 0 },
    ];
    expect(() => buildScriptMessageCommand("sf-chapters-json", ok)).not.toThrow();

    expect(() =>
      buildScriptMessageCommand(
        "sf-chapters-json",
        [{ title: "Missing time" } as unknown as ChaptersPayload[number]],
        { validate: true },
      ),
    ).toThrow();
  });

  it("validates audio payloads (label/title/lang)", () => {
    expect(() =>
      buildScriptMessageCommand("sf-audio-json", [
        { title: "Japanese", label: "Japanese", lang: "ja" },
      ]),
    ).not.toThrow();
  });

  it("validates playback payloads", () => {
    expect(() =>
      buildScriptMessageCommand("sf-playback-json", {
        markers: [],
        title: "Slow Burn (1995)",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        fallbackCountdownSeconds: 15,
      }),
    ).not.toThrow();
  });

  it("@bugfix @regression-proof matches the hand-rolled wire shape used by apps/badger/desktop/.../mpv-external-metadata.test.ts:121+", () => {
    // The existing contract test in apps/badger/desktop builds the same
    // payload via mpvExternalMetadata.ts's hand-rolled JSON.stringify. The
    // new builder must produce a byte-identical wire string for the same
    // input so the migrator can swap to it without changing what mpv sees.
    const payload: SubtitlesPayload = [
      { url: "/cache/a.sup", title: "Chinese - chi", lang: "zh", format: "sup", selected: false },
      { url: "/cache/b.sup", title: "French - fre", lang: "fr", format: "sup", selected: true },
      { url: "/cache/c.sup", title: "English", lang: "en", format: "sup" },
    ];
    console.info(`[commands:wire-parity] building byte-identical sf-subtitles-json wire shape`);
    const cmd = buildScriptMessageCommand("sf-subtitles-json", payload);
    const handRolledShape = {
      command: ["script-message", "sf-subtitles-json", JSON.stringify(payload)],
    };
    try {
      expect(cmd).toEqual(handRolledShape);
    } catch (err) {
      dumpCommand("wire-parity", cmd, handRolledShape);
      throw err;
    }
  });
});

describe("buildSeekCommand", () => {
  it("emits a target-only seek", () => {
    expect(buildSeekCommand(42.5)).toEqual({ command: ["seek", 42.5] });
  });

  it("appends mode and precision flags in positional order", () => {
    expect(buildSeekCommand(120, "absolute", "exact")).toEqual({
      command: ["seek", 120, "absolute", "exact"],
    });
  });

  it("matches the wire shape the engine has historically used", () => {
    // Locks parity with the pre-Phase-1b inline form at
    // useMpvPlaybackEngine.ts:244 — `{ command: ["seek", playerTarget,
    // "absolute", "exact"] }`. mpv tolerates relative/absolute either as
    // a single comma-joined string or as separate positional args.
    const playerTarget = 573.9;
    const cmd = buildSeekCommand(playerTarget, "absolute", "exact");
    const expected = { command: ["seek", 573.9, "absolute", "exact"] };
    try {
      expect(cmd).toEqual(expected);
    } catch (err) {
      dumpCommand("seek-wire-parity", cmd, expected);
      throw err;
    }
  });
});

describe("buildLoadfileCommand", () => {
  it("emits the canonical loadfile wire shape", () => {
    expect(buildLoadfileCommand("https://example.com/stream.m3u8", "replace")).toEqual({
      command: ["loadfile", "https://example.com/stream.m3u8", "replace"],
    });
  });

  it("supports append-play for playlist mutation paths", () => {
    expect(buildLoadfileCommand("https://example.com/next.m3u8", "append-play")).toEqual({
      command: ["loadfile", "https://example.com/next.m3u8", "append-play"],
    });
  });

  it("@bugfix @regression-proof issue #25 P18 carries aid/sid per load, and only valid selections", () => {
    const cmd = buildLoadfileCommand("http://x/master.m3u8", "replace", {
      startSeconds: 18.313,
      audioTrack: 2,
      subtitleTrack: "no",
    });
    console.info(`[commands:loadfile-tracks] ${JSON.stringify(cmd)}`);
    expect(cmd).toEqual({
      command: [
        "loadfile",
        "http://x/master.m3u8",
        "replace",
        -1,
        "start=18.313,demuxer-cache-wait=no,aid=2,sid=no",
      ],
    });
    // A track pick alone (start over at 0) still makes a per-load option,
    // with the cache policy pinned (#25 playable-start).
    expect(buildLoadfileCommand("u", "replace", { startSeconds: null, audioTrack: 3 })).toEqual({
      command: ["loadfile", "u", "replace", -1, "demuxer-cache-wait=no,aid=3"],
    });
    // null / non-positive / fractional ids are never sent.
    for (const bad of [null, 0, -1, 1.5, Number.NaN]) {
      expect(buildLoadfileCommand("u", "replace", { audioTrack: bad, subtitleTrack: bad })).toEqual({
        command: ["loadfile", "u", "replace", -1, "demuxer-cache-wait=no"],
      });
    }
  });
});

describe("buildSubAddCommand", () => {
  it("emits a minimal sub-add with just url + flag", () => {
    expect(buildSubAddCommand("/cache/a.srt", "select")).toEqual({
      command: ["sub-add", "/cache/a.srt", "select"],
    });
  });

  it("appends optional title and lang in positional order", () => {
    expect(buildSubAddCommand("/cache/a.srt", "auto", "English", "en")).toEqual({
      command: ["sub-add", "/cache/a.srt", "auto", "English", "en"],
    });
  });

  it("@bugfix @regression-proof preserves the 'select' flag for the default-subtitle path", () => {
    // Commit 7d42d8ff plumbed `selected: boolean` so sf.lua's
    // `maybe_add_subtitle` could use mpv's "select" flag at sub-add
    // time — fixing the post-launch refresh-seek loop. The JS engine
    // at useMpvPlaybackEngine.ts:1549 also sub-adds with "select" for
    // genuinely-new entries the user picks after launch. Either way,
    // the flag MUST round-trip verbatim through this builder.
    console.info(`[commands:sub-add-select] building sub-add with the 'select' flag`);
    const cmd = buildSubAddCommand("/cache/french.sup", "select");
    try {
      expect(cmd.command[2]).toBe("select");
    } catch (err) {
      dumpCommand("sub-add-select", cmd);
      throw err;
    }
  });
});

// @bugfix @regression-proof #2762: a replay's remembered audio was set as a runtime `aid` switch ~0.2 s in; mpv's
// refresh seek (time-pos - 1 s) failed in FFmpeg 8.1's HLS demuxer and the replay stalled or jumped ahead.
describe("buildLaunchTrackArgs (#2762)", () => {
  it("@bugfix @regression-proof #2762 a direct stream launch opens on the per-load tracks", () => {
    const args = buildLaunchTrackArgs({ audioTrack: 3, subtitleTrack: 2 });
    dumpCommand("launch-tracks", args, ["--aid=3", "--sid=2"]);
    expect(args).toEqual(["--aid=3", "--sid=2"]);
    expect(buildLaunchTrackArgs({ audioTrack: "no", subtitleTrack: "no" })).toEqual(["--aid=no", "--sid=no"]);
  });

  it("no option for no choice or an invalid track id", () => {
    expect(buildLaunchTrackArgs({})).toEqual([]);
    expect(buildLaunchTrackArgs({ audioTrack: null, subtitleTrack: undefined })).toEqual([]);
    expect(buildLaunchTrackArgs({ audioTrack: 0, subtitleTrack: 1.5 })).toEqual([]);
  });
});

describe("trackSwitchSeeksBeforeStart (#2762)", () => {
  it("@bugfix @regression-proof #2762 a switch in the first second would seek before the stream start", () => {
    console.info(`[commands:track-switch] safe from ${MPV_TRACK_SWITCH_SAFE_SECONDS}s`);
    // 0.065 s: the time-pos of the failed e2e replay's switch (refresh seek to -0.88 s).
    expect(trackSwitchSeeksBeforeStart(0.065)).toBe(true);
    expect(trackSwitchSeeksBeforeStart(1.0)).toBe(true);
    expect(trackSwitchSeeksBeforeStart(null)).toBe(true);
    expect(trackSwitchSeeksBeforeStart(Number.NaN)).toBe(true);
    expect(trackSwitchSeeksBeforeStart(MPV_TRACK_SWITCH_SAFE_SECONDS)).toBe(false);
    expect(trackSwitchSeeksBeforeStart(1.5)).toBe(false);
  });
});
