// @bugfix @regression-proof issue #25 P19 — a quality picked in the mpv OSC
// video menu lost to an ABR downshift that was already reloading.
//
// Evidence (P14/P15 smoke, seed 1791529129542, case c004,
// /tmp/sf-p14p15-smoke2/timeline.jsonl + logs/mpv.log):
//   371073 driver DOWN, 371075 renderer `abr downshift {from:1080p,to:480p}`
//   371167 driver ENTER → mpv `Set property: vid="2"` (480p, the user's pick)
//   mpv.log:1098 loadfile … replace options="start=3.938,demuxer-cache-wait=yes,cache-secs=8"
//          ← the ABR reload: no vid, no hls-bitrate
//   mpv.log:1342 ● Video --vid=1 (h264 1920x1080 3830 kbps)  ← launch-time --hls-bitrate=3830000
//   372080 mpv prop:vid=1, then `quality-switch-no-effect` (1080p still selected)
//
// Root cause, two halves:
//   1. The reload loadfile never named the variant. The HLS master lists every
//      rung; mpv picks by the GLOBAL --hls-bitrate set at launch, so every
//      reload (ABR or manual) came back on the launch rung — here 1080p over
//      the user's 480p.
//   2. sf-select.lua reported only aid/sid picks: the renderer never learnt a
//      video (quality) pick, so ABR stayed in charge and kept switching.
// Fix: the reload carries a per-load `hls-bitrate=<rung bandwidth>` (and
// re-sets `vid` if mpv ignored it); sf-select.lua reports `vid` picks; the
// engine maps the picked vid to its format and switches to it as a manual
// ("user") pick, which pins the rung — ABR holds until the user picks
// Auto again or the file changes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLoadfileCommand, LUA_OUTBOUND_CHANNELS, type MpvTrack } from "@space/mpv-protocol";
import {
  findHlsVariantVid,
  hlsVariantBandwidthBps,
  resolvePickedVideoFormatId,
} from "../src/renderer/src/lib/hlsVariantPick";
import { parseTrackPickedMessage } from "../src/renderer/src/lib/oscTrackPicks";
import { createAbrController, noteSessionStarted, stepNetworkAbr } from "@space/playback-abr";

const LOG = "[osc-video-pick-wins-over-abr]";
const MASTER = "http://127.0.0.1:41227/playback/hls/dc24e7cc-c519-4873-a662-e9a65ebc21fa/master.m3u8";
// c004's formats, in `formats` order (the master's variant order).
const FORMATS = [
  { id: "fmt-1080", quality: "1080p", bitrateKbps: 3830 },
  { id: "fmt-480", quality: "480p", bitrateKbps: 269 },
  { id: "fmt-360", quality: "360p", bitrateKbps: 183 },
] as const;
// mpv's track-list after the ABR reload (timeline 376184, quality-switch-no-effect).
const TRACK_LIST: MpvTrack[] = [
  { id: 1, type: "video", selected: true, "hls-bitrate": 3830000 },
  { id: 2, type: "video", selected: false, "hls-bitrate": 269000 },
  { id: 3, type: "video", selected: false, "hls-bitrate": 183000 },
  { id: 1, type: "audio", selected: true },
];
const pickMessage = (property: string, value: string) => ({
  type: "script_message",
  name: LUA_OUTBOUND_CHANNELS.TRACK_PICKED,
  args: [property, value],
});
const read = (path: string) => readFileSync(resolve(__dirname, path), "utf8");

describe("OSC video pick wins over ABR (@bugfix @regression-proof issue #25 P19)", () => {
  it("the ABR reload names its rung: per-load hls-bitrate = the rung's master BANDWIDTH", () => {
    const bps = hlsVariantBandwidthBps(FORMATS[1].bitrateKbps);
    const reload = buildLoadfileCommand(MASTER, "replace", { startSeconds: 3.938, hlsBitrateBps: bps });
    console.info(`${LOG} phase=abr-reload bps=${bps} loadfile=${JSON.stringify(reload.command)}`);
    expect(bps).toBe(269000);
    expect(reload.command).toEqual([
      "loadfile",
      MASTER,
      "replace",
      -1,
      "start=3.938,demuxer-cache-wait=yes,cache-secs=8,hls-bitrate=269000",
    ]);
    // Same fallback as playbackServer's master (`bitrateKbps ?? 5000`).
    expect(hlsVariantBandwidthBps(null)).toBe(5_000_000);
    // playbackServer writes `kbps * 1000` unrounded and FFmpeg atoi()s it: truncate.
    expect(hlsVariantBandwidthBps(269.9999)).toBe(269_999);
    // No bitrate option → no hls-bitrate piece (offline / handoff loads).
    expect(buildLoadfileCommand(MASTER, "replace", { startSeconds: 40 }).command[4]).toBe("start=40,demuxer-cache-wait=no");
  });

  it("a reload that landed on the launch rung is detected and re-pointed at the format's vid", () => {
    const expected = findHlsVariantVid(TRACK_LIST, FORMATS, "fmt-480");
    console.info(`${LOG} phase=reload-verify liveVid=1 expectedVid=${expected}`);
    expect(expected).toBe(2);
    expect(findHlsVariantVid(TRACK_LIST, FORMATS, "fmt-1080")).toBe(1);
    expect(findHlsVariantVid(TRACK_LIST, FORMATS, "fmt-360")).toBe(3);
    // Unknown format, or a track-list without HLS bitrates (offline file): no opinion.
    expect(findHlsVariantVid(TRACK_LIST, FORMATS, "nope")).toBeNull();
    expect(findHlsVariantVid([{ id: 1, type: "video" }], FORMATS, "fmt-480")).toBeNull();
  });

  it("two rungs with the same bandwidth map by their order in the master", () => {
    const formats = [
      { id: "a", bitrateKbps: 500 },
      { id: "b", bitrateKbps: 500 },
    ];
    const tracks: MpvTrack[] = [
      { id: 1, type: "video", "hls-bitrate": 500000 },
      { id: 2, type: "video", "hls-bitrate": 500000 },
    ];
    console.info(`${LOG} phase=duplicate-bandwidth`);
    expect(findHlsVariantVid(tracks, formats, "b")).toBe(2);
    expect(resolvePickedVideoFormatId({ vid: 2, trackList: tracks, formats })).toBe("b");
  });

  it("replays c004: the OSC pick vid=2 is reported and maps to the 480p format", () => {
    const pick = parseTrackPickedMessage(pickMessage("vid", "2"));
    console.info(`${LOG} phase=osc-pick parsed=${JSON.stringify(pick)}`);
    expect(pick).toEqual({ property: "vid", value: 2 });
    const formatId = resolvePickedVideoFormatId({ vid: 2, trackList: TRACK_LIST, formats: FORMATS });
    console.info(`${LOG} phase=osc-pick-map formatId=${formatId}`);
    expect(formatId).toBe("fmt-480");
    // "no" (re-picking the playing rung turns video off) and unknown ids are not quality picks.
    expect(resolvePickedVideoFormatId({ vid: "no", trackList: TRACK_LIST, formats: FORMATS })).toBeNull();
    expect(resolvePickedVideoFormatId({ vid: 9, trackList: TRACK_LIST, formats: FORMATS })).toBeNull();
  });

  it("a pinned (manual) rung is never downshifted by ABR, even in an underrun", () => {
    const variants = FORMATS.map((f) => ({ id: f.id, quality: f.quality, codec: "h264", bitrateKbps: f.bitrateKbps }));
    const ctrl = createAbrController(variants, { quality: "480p", force: false }, 0, null, { firstFrameFrom: "event" });
    noteSessionStarted(ctrl, 0);
    // The engine's per-tick sync of a manual pick: `mode: "manual"` on the rung playing.
    ctrl.quality = { ...ctrl.quality, currentId: "fmt-480", mode: "manual" };
    ctrl.firstFrameAtMs = 0;
    const action = stepNetworkAbr(ctrl, variants, {
      nowMs: 60_000,
      voConfigured: true,
      pausedForCache: true,
      bufferSeconds: 0.5,
      cacheReachedEof: false,
      netBps: 100_000,
      cache: { cacheSecs: 16, demuxerMaxBytes: 96 * 1024 * 1024 },
    });
    console.info(`${LOG} phase=pinned-abr action=${JSON.stringify(action)}`);
    expect(action).toEqual({ kind: "hold" });
  });

  it("sf-select.lua reports video picks too", () => {
    const lua = read("../../../../packages/mpv/resources/osc/sf-select.lua");
    const guard = lua.match(/local function emit_track_picked\(property, value\)\n([\s\S]*?)\nend\n/)?.[1] ?? "";
    console.info(`${LOG} phase=lua guard=${JSON.stringify(guard)}`);
    expect(guard).toContain('property ~= "vid"');
  });

  it("the engine wires it: reload names the rung and re-checks vid; a vid pick is a manual switch that pins ABR", () => {
    const src = read("../src/renderer/src/lib/useMpvPlaybackEngine.ts");
    const reloadSend = src.match(/const sendReloadLoadfile = \(\) =>[\s\S]*?\n {10}\);\n/)?.[0] ?? "";
    const selectFixed = src.match(/const selectFixedFormat = [\s\S]*?\n {2}};\n/)?.[0] ?? "";
    const selectAuto = src.match(/const selectAutoQuality = [\s\S]*?\n {2}};\n/)?.[0] ?? "";
    const wiring = {
      reloadCarriesBitrate: /hlsBitrateBps: reloadHlsBitrateBps/.test(reloadSend),
      reloadVerifiesVid: /findHlsVariantVid\(\s*Array\.isArray\(reloadTrackList\) \? reloadTrackList : \[\],\s*hlsMasterFormats,/.test(src)
        && /buildSetPropertyCommand\("vid", expectedVid\)/.test(src),
      vidPickSwitches: /resolvePickedVideoFormatId\(\{ vid, trackList, formats: hlsMasterFormats \}\)/.test(src)
        && /selectFixedFormatRef\.current\(formatId, "user"\)/.test(src),
      // Ties rank among the rungs the master lists (createHlsSession drops formats without a chunk map).
      masterFormatsFiltered: /formats\.filter\(\(format\) => buildChunkMapFromFormat\(format\) !== null\)/.test(src),
      userPins: /abrManualPinRef\.current = true/.test(selectFixed),
      abrUnpinnedOnlyForAbr: !/abrManualPinRef\.current = false/.test(selectFixed),
      autoUnpins: /abrManualPinRef\.current = false/.test(selectAuto),
      abrHonoursPin: /const pinned = forcePlaybackQualityRef\.current \|\| abrManualPinRef\.current;[\s\S]*?mode: pinned \? "manual" : "auto"/.test(src),
    };
    console.info(`${LOG} phase=engine-wiring ${JSON.stringify(wiring)}`);
    expect(wiring).toEqual({
      reloadCarriesBitrate: true,
      reloadVerifiesVid: true,
      vidPickSwitches: true,
      masterFormatsFiltered: true,
      userPins: true,
      abrUnpinnedOnlyForAbr: true,
      autoUnpins: true,
      abrHonoursPin: true,
    });
  });
});
