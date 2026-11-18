// @bugfix @regression-proof issue #25 P18 — an ABR reload silently reverted the
// audio track picked in the OSC (confirm run seed 1791373829836: every
// osc-audio-signal failure, S1 c066/x018 and S3 c010/c042, 1–8 s after an
// `abr downshift`).
//
// Evidence (shard-1/logs/mpv-17-1791385742395.log):
//   :89158  Set property: aid="2"            ← the OSC pick (sf-select.lua)
//   :91698  loadfile … replace options="start=18.313,…"  ← abr 1080p→360p, no aid
//   :94479  ● Audio --aid=1                  ← mpv's default again (440 Hz EN, not 660 Hz FR)
//
// Root cause: sf-select.lua set `aid` straight in mpv; the renderer never saw
// it, so the ABR reload's loadfile carried no aid/sid and mpv re-picked its
// default. Fix: sf-select.lua emits `script-message sf-track-picked <prop>
// <value>`, the engine records it per file (OscTrackPicks) and every reload /
// handoff loadfile spreads it into the per-load options; a subtitle pick that
// maps to an app subtitle option flows back into selectedSubtitleId.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLoadfileCommand, LUA_OUTBOUND_CHANNELS, type MpvTrack } from "@space/mpv-protocol";
import { formatTrackDisplayLabel } from "@space/shared/mediaLanguageDisplay";
import {
  OscTrackPicks,
  parseTrackPickedMessage,
  resolvePickedSubtitleOptionId,
  type OscTrackPick,
} from "../src/renderer/src/lib/oscTrackPicks";
import type { SubtitleOption } from "../src/renderer/src/lib/playbackTypes";

const LOG = "[osc-track-pick-survives-abr-reload]";
const FILE = "80056f09-fd61-492e-bb9a-6b32b51d3870";
const MASTER = "http://127.0.0.1:35853/playback/hls/b9b0f1fd-395c-4edd-b70e-71f2345017a6/master.m3u8";
const pickMessage = (property: string, value: string) => ({
  type: "script_message",
  name: LUA_OUTBOUND_CHANNELS.TRACK_PICKED,
  args: [property, value],
});

/** Parses a forwarded message that must be an audio/subtitle pick (not a video pick, not invalid). */
const parseAudioOrSubtitlePick = (msg: ReturnType<typeof pickMessage>): OscTrackPick => {
  const pick = parseTrackPickedMessage(msg);
  if (pick === null || pick.property === "vid") throw new Error(`expected an aid/sid pick, got ${JSON.stringify(pick)}`);
  return pick;
};

const SUBTITLES: SubtitleOption[] = [
  { id: "off", label: "Off", language: "off", isDefault: false, objectKey: null },
  { id: "sub-en", label: "English - PGS", language: "en", objectKey: "k-en" },
  { id: "sub-fr", label: "French - SRT", language: "fr", objectKey: "k-fr" },
];
// The track-list mpv reported in the evidence log: two external subs whose
// titles come from the same formatter the metadata payload uses.
const TRACK_LIST: MpvTrack[] = [
  { id: 1, type: "video", selected: true } as MpvTrack,
  { id: 1, type: "audio", selected: false } as MpvTrack,
  { id: 2, type: "audio", selected: true } as MpvTrack,
  {
    id: 1,
    type: "sub",
    lang: "en",
    title: formatTrackDisplayLabel("en", "English - PGS", "en", "Subtitle"),
    "external-filename": "/cache/en.sup",
  } as MpvTrack,
  {
    id: 2,
    type: "sub",
    lang: "fr",
    title: formatTrackDisplayLabel("fr", "French - SRT", "en", "Subtitle"),
    "external-filename": "/cache/fr.srt",
  } as MpvTrack,
];

describe("OSC track pick survives reloads (@bugfix @regression-proof issue #25 P18)", () => {
  it("replays S1 c066: OSC picks aid=2, then the ABR reload's loadfile carries aid=2", () => {
    const picks = new OscTrackPicks();
    // Before any pick the reload is exactly what it was (no aid/sid option).
    const before = buildLoadfileCommand(MASTER, "replace", { startSeconds: 18.313, ...picks.reloadOptions(FILE) });
    console.info(`${LOG} phase=no-pick loadfile=${JSON.stringify(before.command)}`);
    // #25 playable-start: the reload starts as soon as it is playable (no prefill).
    expect(before.command[4]).toBe("start=18.313,demuxer-cache-wait=no");

    const pick = parseAudioOrSubtitlePick(pickMessage("aid", "2"));
    console.info(`${LOG} phase=osc-pick parsed=${JSON.stringify(pick)}`);
    expect(pick).toEqual({ property: "aid", value: 2 });
    picks.record(FILE, pick);

    // abr downshift 1080p→360p → selectFixedFormat(id, "abr") → reload loadfile.
    const reload = buildLoadfileCommand(MASTER, "replace", { startSeconds: 18.313, ...picks.reloadOptions(FILE) });
    console.info(`${LOG} phase=abr-reload loadfile=${JSON.stringify(reload.command)}`);
    expect(reload.command).toEqual([
      "loadfile",
      MASTER,
      "replace",
      -1,
      "start=18.313,demuxer-cache-wait=no,aid=2",
    ]);

    // A second ABR reload (360p → 720p upshift) still carries it.
    const again = buildLoadfileCommand(MASTER, "replace", { startSeconds: 40, ...picks.reloadOptions(FILE) });
    console.info(`${LOG} phase=second-reload loadfile=${JSON.stringify(again.command)}`);
    expect(again.command[4]).toContain("aid=2");
  });

  it("a subtitle pick maps back to the app's subtitle option (reload re-selects it via the payload), not a raw sid", () => {
    const picks = new OscTrackPicks();
    const pick = parseAudioOrSubtitlePick(pickMessage("sid", "2"));
    picks.record(FILE, pick);
    const optionId = resolvePickedSubtitleOptionId({ sid: pick.value, trackList: TRACK_LIST, subtitleOptions: SUBTITLES });
    console.info(`${LOG} phase=sid-map sid=${pick.value} optionId=${optionId}`);
    expect(optionId).toBe("sub-fr");
    picks.subtitleMappedToOption(FILE);
    expect(picks.reloadOptions(FILE)).toEqual({ audioTrack: null, subtitleTrack: null });

    // "no" → the app's "off" option.
    expect(resolvePickedSubtitleOptionId({ sid: "no", trackList: TRACK_LIST, subtitleOptions: SUBTITLES })).toBe("off");
  });

  it("an unmappable subtitle pick (embedded offline track) is carried as a raw sid", () => {
    const picks = new OscTrackPicks();
    const embedded: MpvTrack[] = [{ id: 3, type: "sub", lang: "de", title: "Deutsch (embedded)" } as MpvTrack];
    const pick = parseAudioOrSubtitlePick(pickMessage("sid", "3"));
    picks.record(FILE, pick);
    const optionId = resolvePickedSubtitleOptionId({ sid: pick.value, trackList: embedded, subtitleOptions: SUBTITLES });
    console.info(`${LOG} phase=sid-unmapped optionId=${optionId} reload=${JSON.stringify(picks.reloadOptions(FILE))}`);
    expect(optionId).toBeNull();
    // Every per-load options object also pins the cache policy (#25 playable-start).
    expect(buildLoadfileCommand("file:///x.mkv", "replace", picks.reloadOptions(FILE)).command[4]).toBe("demuxer-cache-wait=no,sid=3");
  });

  it("picks never leak into another file, and the app's own choice wins", () => {
    const picks = new OscTrackPicks();
    picks.record(FILE, { property: "aid", value: 2 });
    picks.record(FILE, { property: "sid", value: "no" });
    const other = picks.reloadOptions("another-file");
    console.info(`${LOG} phase=isolation other=${JSON.stringify(other)} same=${JSON.stringify(picks.reloadOptions(FILE))}`);
    expect(other).toEqual({ audioTrack: null, subtitleTrack: null });
    expect(picks.reloadOptions(FILE)).toEqual({ audioTrack: 2, subtitleTrack: "no" });

    picks.clearAudio();
    picks.clearSubtitle();
    expect(picks.reloadOptions(FILE)).toEqual({ audioTrack: null, subtitleTrack: null });

    // A pick for a new file drops the previous file's picks.
    picks.record(FILE, { property: "aid", value: 2 });
    picks.record("next-episode", { property: "sid", value: 1 });
    expect(picks.reloadOptions("next-episode")).toEqual({ audioTrack: null, subtitleTrack: 1 });
    expect(picks.reloadOptions(FILE)).toEqual({ audioTrack: null, subtitleTrack: null });

    picks.reset();
    expect(picks.reloadOptions("next-episode")).toEqual({ audioTrack: null, subtitleTrack: null });
  });

  it("parses only well-formed sf-track-picked messages", () => {
    const rejected = [
      { type: "script_message", name: "sf-pill-state", args: ["aid", "2"] },
      { type: "osc_action", name: LUA_OUTBOUND_CHANNELS.TRACK_PICKED, args: ["aid", "2"] },
      pickMessage("secondary-sid", "1"),
      pickMessage("aid", "0"),
      pickMessage("aid", "1.5"),
      pickMessage("aid", "auto"),
      { type: "script_message", name: LUA_OUTBOUND_CHANNELS.TRACK_PICKED },
    ].map((msg) => parseTrackPickedMessage(msg));
    console.info(`${LOG} phase=parse rejected=${JSON.stringify(rejected)}`);
    expect(rejected.every((value) => value === null)).toBe(true);
    expect(parseTrackPickedMessage(pickMessage("sid", "no"))).toEqual({ property: "sid", value: "no" });
    // A vid pick is a quality pick (issue #25 P19, osc-video-pick-wins-over-abr.test.ts).
    expect(parseTrackPickedMessage(pickMessage("vid", "1"))).toEqual({ property: "vid", value: 1 });
  });

  it("sf-select.lua reports every track pick on the channel the renderer listens to", () => {
    const lua = readFileSync(resolve(__dirname, "../../../../packages/mpv/resources/osc/sf-select.lua"), "utf8");
    const emits = lua.match(/mp\.commandv\("script-message", "([^"]+)", property, encoded\)/);
    const submitCalls = (lua.match(/emit_track_picked\(/g) ?? []).length;
    console.info(`${LOG} phase=lua-wiring channel=${emits?.[1]} emitCalls=${submitCalls}`);
    expect(emits?.[1]).toBe(LUA_OUTBOUND_CHANNELS.TRACK_PICKED);
    // definition + select-track submit + select_track submit (aid/sid menus)
    expect(submitCalls).toBe(3);
  });

  it("the engine records picks and spreads them into the reload and handoff loadfiles", () => {
    const src = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const uses = {
      parse: /parseTrackPickedMessage\(msg\)/.test(src),
      record: /oscTrackPicksRef\.current\.record\(/.test(src),
      subtitleBack: /resolvePickedSubtitleOptionId\(/.test(src) && /setSelectedSubtitleId\(optionId\)/.test(src),
      // PLAY-TRACK-04: loadStream's loadTrackOptions() reads the picks, then falls back to the app's audio aid.
      helperReadsPicks: /const loadTrackOptions = \(\) => \{\s*const picks = oscTrackPicksRef\.current\.reloadOptions\(fileIdRef\.current\);/.test(src),
      loadfileSpreads: (src.match(/\.\.\.loadTrackOptions\(\)/g) ?? []).length,
      reloadUsesHelper: /const reloadTrackOptions = loadTrackOptions\(\);/.test(src),
      reloadSpread: /\.\.\.reloadTrackOptions/.test(src),
    };
    console.info(`${LOG} phase=engine-wiring ${JSON.stringify(uses)}`);
    expect(uses.parse).toBe(true);
    expect(uses.record).toBe(true);
    expect(uses.subtitleBack).toBe(true);
    expect(uses.helperReadsPicks).toBe(true);
    expect(uses.reloadUsesHelper).toBe(true);
    // The launch on the stream (#2762) and the backdrop→stream handoff loadfile; the alive-mpv reload spreads
    // reloadTrackOptions.
    expect(uses.loadfileSpreads).toBe(2);
    expect(uses.reloadSpread).toBe(true);
  });

  it("@bugfix @regression-proof #25 Orchard: only a user pick marks Off as picked; the controller's per-request reset does not", () => {
    const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const controller = readFileSync(resolve(__dirname, "../src/renderer/src/components/MediaPlaybackController.tsx"), "utf8");
    const uses = {
      oscPick: /setSubtitlesOffPicked\(optionId === "off"\);\s*setSelectedSubtitleId\(optionId\)/.test(engine),
      appPick: /setSubtitlesOffPicked\(trackId === "off"\);\s*setSelectedSubtitleId\(trackId\)/.test(engine),
      resetClears: /resetSelectedSubtitle = useCallback\(\(trackId: string\) => \{[^}]*setSubtitlesOffPicked\(false\);/.test(engine),
      resetExported: /resetSelectedSubtitleId: resetSelectedSubtitle,/.test(engine),
      controllerUsesReset: /const resetSub = playback\.resetSelectedSubtitleId;/.test(controller),
    };
    console.info(`${LOG} phase=off-picked-wiring ${JSON.stringify(uses)}`);
    expect(uses).toEqual({ oscPick: true, appPick: true, resetClears: true, resetExported: true, controllerUsesReset: true });
  });
});
