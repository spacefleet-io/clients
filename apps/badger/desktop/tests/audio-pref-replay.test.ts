/**
 * @req PLAY-TRACK-04
 * @bugfix @regression-proof audio-choice-not-restored-on-replay
 *
 * Walk finding (Badger desktop, 2026-11-12): pick French audio + French subtitles in mpv, close, replay → French
 * subtitles but English audio. Two causes:
 *  1. the desktop HLS master carried no `LANGUAGE` on its audio renditions, so mpv only saw the fragment's own tag
 *     (`und` for a file whose audio language was set in the app) and the OSC audio pick had no language to save;
 *  2. the app's audio choice (the remembered one at play start) never reached mpv: the master's DEFAULT flag does
 *     not choose for mpv, which takes rendition 1, and nothing set `aid`.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: vi.fn(),
}));

import { buildMasterPlaylist, type HlsSession } from "../src/main/playbackServer";
import { hlsAudioTrackFor, waitForSafeTrackSwitch } from "../src/renderer/src/lib/mpvPlaybackSelection";
import { trackPrefsPatchForPick } from "../src/renderer/src/lib/oscTrackPicks";

const TAG = "[audio-pref-replay]";

const hlsTrack = (id: string) => ({ initKey: `init-${id}`, codecString: "mp4a.40.2", segments: [{ key: `${id}-1`, durationSeconds: 12 }] });

describe("the desktop HLS master names each audio rendition's language (PLAY-TRACK-04)", () => {
  it("@req PLAY-TRACK-04[badger-desktop] LANGUAGE carries the library language as ISO 639-1, none for und", () => {
    const audio = [
      { id: "a-en", language: "eng", label: "English", isDefault: true },
      { id: "a-fr", language: "fre", label: "French", isDefault: false },
      { id: "a-de", language: "de", label: "German", isDefault: false },
      { id: "a-x", language: "und", label: "Commentary", isDefault: false },
    ];
    const session: HlsSession = {
      id: "s1",
      mode: "vod",
      videos: [{ id: "v1", quality: "1080p", bitrateKbps: 5000, width: 1920, height: 1080, track: { ...hlsTrack("v1"), codecString: "avc1.640028" } }],
      audio: audio.map((entry) => ({ ...entry, track: hlsTrack(entry.id) })),
      createdAt: 0,
    };
    const master = buildMasterPlaylist(session, "http://127.0.0.1:1");
    const lines = master.split("\n").filter((line) => line.startsWith("#EXT-X-MEDIA:"));
    console.info(`${TAG} master audio lines:\n${lines.join("\n")}`);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('LANGUAGE="en"');
    expect(lines[1]).toContain('LANGUAGE="fr"');
    expect(lines[2]).toContain('LANGUAGE="de"');
    expect(lines[3]).not.toContain("LANGUAGE=");
    // RFC 8216 attribute order is free, but keep the rest of each line intact.
    expect(lines[1]).toBe(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="fr",NAME="French",DEFAULT=NO,AUTOSELECT=YES,URI="http://127.0.0.1:1/playback/hls/s1/audio-a-fr.m3u8"',
    );
  });
});

describe("the app's audio choice has an mpv aid (PLAY-TRACK-04)", () => {
  const options = [
    { id: "a-en", initKey: "i-en", chunks: [{ key: "en-1" }] },
    { id: "a-broken", initKey: null, chunks: [] },
    { id: "a-fr", initKey: "i-fr", chunks: [{ key: "fr-1" }] },
  ] as const;

  it("@req PLAY-TRACK-04[badger-desktop] the remembered French option is rendition 2 (unplayable options are not in the master)", () => {
    const aid = hlsAudioTrackFor(options as never, "a-fr");
    console.info(`${TAG} a-fr → aid ${aid}`);
    expect(aid).toBe(2);
    expect(hlsAudioTrackFor(options as never, "a-en")).toBe(1);
  });

  it("@req PLAY-TRACK-04[badger-desktop] no aid for no choice, an unknown id, or an option the master leaves out", () => {
    expect(hlsAudioTrackFor(options as never, null)).toBeNull();
    expect(hlsAudioTrackFor(options as never, "a-gone")).toBeNull();
    expect(hlsAudioTrackFor(options as never, "a-broken")).toBeNull();
  });
});

describe("an OSC audio pick of an untagged file is remembered (PLAY-TRACK-04)", () => {
  it("@req PLAY-TRACK-04[badger-desktop] mpv's lang from the master LANGUAGE becomes the audio pref", () => {
    // What mpv 0.41 reports for und-tagged fragments once the master says LANGUAGE="en"/"fr".
    const trackList = [
      { id: 1, type: "audio", lang: "en" },
      { id: 2, type: "audio", lang: "fr" },
    ];
    const patch = trackPrefsPatchForPick({ pick: { property: "aid", value: 2 }, trackList, subtitleOptions: [], subtitleOptionId: null });
    console.info(`${TAG} pick aid 2 → ${JSON.stringify(patch)}`);
    expect(patch).toEqual({ audioLanguage: "fr" });
    // Before the fix mpv had no lang for such a file and the pick was dropped.
    expect(trackPrefsPatchForPick({ pick: { property: "aid", value: 2 }, trackList: [{ id: 2, type: "audio" }], subtitleOptions: [], subtitleOptionId: null })).toBeNull();
  });
});

describe("the engine hands the app's audio choice to mpv (source guards, PLAY-TRACK-04)", () => {
  const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");

  it("@req PLAY-TRACK-04[badger-desktop] every streamed (re)load carries the app's aid when no OSC pick holds", () => {
    expect(engine).toMatch(/audioTrack: picks\.audioTrack \?\? \(isOfflineSource \? null : appAudioTrackRef\.current\)/);
    expect(engine).toContain("...loadTrackOptions(),");
    expect(engine).toContain("const reloadTrackOptions = loadTrackOptions();");
    expect(engine).not.toContain("...oscTrackPicksRef.current.reloadOptions(fileIdRef.current),");
  });

  it("@req PLAY-TRACK-04[badger-desktop] after the file shows, aid is set when mpv plays another rendition", () => {
    const start = engine.indexOf("// PLAY-TRACK-04: mpv plays the app's audio choice");
    expect(start).toBeGreaterThan(0);
    const effect = engine.slice(start, engine.indexOf("}, [open, lifecycle, isReadyToReveal, audioOptions, selectedAudioId", start));
    expect(effect).toContain('getProperty(sendExternalRequest, "aid")');
    expect(effect).toContain('buildSetPropertyCommand("aid", aid)');
    expect(effect).toContain("offlineSessionRef.current !== null");
    expect(effect).toContain("reloadOptions(fileIdRef.current).audioTrack !== null");
  });

  it("@req PLAY-TRACK-04[badger-desktop] @bugfix @regression-proof #2762 a launch on the stream carries the tracks; the aid set waits for a safe time-pos", () => {
    const launch = engine.match(/window\.sf\?\.launchExternalMpv\?\.\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(launch).toContain("...loadTrackOptions(),");
    const main = readFileSync(resolve(__dirname, "../src/main/externalMpv.ts"), "utf8");
    expect(main).toContain("if (!backdropUsed) extraArgs.push(...buildLaunchTrackArgs(payload));");
    const start = engine.indexOf("// PLAY-TRACK-04: mpv plays the app's audio choice");
    const effect = engine.slice(start, engine.indexOf("}, [open, lifecycle, isReadyToReveal, audioOptions, selectedAudioId", start));
    const wait = effect.indexOf("waitForSafeTrackSwitch(");
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(effect.indexOf('buildSetPropertyCommand("aid", aid)'));
    expect(effect).toContain('getProperty(sendExternalRequest, "time-pos")');
    expect(effect).toContain("cancelled = true;");
  });
});

/**
 * @bugfix @regression-proof #2762: on replay the app set the remembered `aid` at time-pos ≈ 0.07 s; mpv's refresh
 * seek to -0.88 s failed ("Seek failed (Operation not permitted)") and the replay stayed buffering.
 */
describe("the aid set waits until mpv's refresh seek lands in the stream (#2762)", () => {
  it("@req PLAY-TRACK-04[badger-desktop] @bugfix @regression-proof #2762 resolves once time-pos reaches 1.25 s", async () => {
    const positions = [0.07, null, 0.6, 1.3, 2];
    let reads = 0;
    const ok = await waitForSafeTrackSwitch(async () => positions[reads++], () => false, 0);
    console.info(`[audio-pref-replay:#2762] safe after ${reads} time-pos reads`);
    expect(ok).toBe(true);
    expect(reads).toBe(4);
  });

  it("@req PLAY-TRACK-04[badger-desktop] @bugfix @regression-proof #2762 gives up without a switch once cancelled", async () => {
    let reads = 0;
    const ok = await waitForSafeTrackSwitch(async () => { reads += 1; return 0.07; }, () => reads >= 3, 0);
    expect(ok).toBe(false);
    expect(reads).toBe(3);
    expect(await waitForSafeTrackSwitch(async () => 5, () => true, 0)).toBe(false);
  });
});
