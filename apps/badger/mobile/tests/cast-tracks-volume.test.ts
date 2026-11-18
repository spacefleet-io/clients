/**
 * @test-id MOBILE-CAST-007
 * @level unit
 * @why While a title plays on a Cast or AirPlay device, the phone lets the user pick the audio track and the subtitles and
 *   sets the device's volume (UX-TV-03, Chris 2026-11-09). Pins which tracks are offered, what a pick re-plans, and when
 *   a reading of the device may overwrite the volume the user just set.
 */
import { describe, expect, it } from "vitest";
import type { AudioTrack, IngestMetadata, SubtitleTrack, VideoFormat } from "@space/mobile-mpv-playback";
import { castProfileForModel } from "../src/lib/cast/castProfiles";
import { planCast } from "../src/lib/cast/castPlan";
import { activeCastTracks, castTrackChoices, pickCastTrack } from "../src/lib/cast/castTracks";
import { AIRPLAY_UNMUTE_FALLBACK, VOLUME_SETTLE_MS, airPlayMuteLevel, followsDeviceVolume } from "../src/lib/cast/castVolume";

const video: VideoFormat = {
  id: "v1080",
  quality: "1080p",
  codec: "h264",
  codecString: "avc1.640028",
  initKey: "v/init.mp4",
  initSize: 800,
  durationSeconds: 100,
  totalSize: 1000,
  bitrateKbps: 4000,
  height: 1080,
  width: 1920,
  chunks: [{ key: "v/0.m4s", sizeBytes: 1000, startSeconds: 0, durationSeconds: 100 }],
};

const audio = (id: string, language: string, codec: string, isDefault = false): AudioTrack => ({
  id,
  language,
  label: language,
  isDefault,
  codec,
  codecString: codec === "aac" ? "mp4a.40.2" : codec,
  initKey: `a/${id}/init.mp4`,
  initSize: 700,
  durationSeconds: 100,
  totalSize: 500,
  chunks: [{ key: `a/${id}/0.m4s`, sizeBytes: 500, startSeconds: 0, durationSeconds: 100 }],
});

const subtitle = (id: string, language: string, format: SubtitleTrack["format"], isDefault = false): SubtitleTrack => ({
  id,
  language,
  label: language,
  isDefault,
  format,
  encrypted: false,
  url: `subs/${id}`,
});

const metadata: IngestMetadata = {
  encryptionKeyBase64: "",
  videos: [video],
  audioTracks: [audio("en", "en", "aac", true), audio("fr-dts", "fr", "dts"), audio("fr", "fr", "aac")],
  subtitleTracks: [subtitle("en-srt", "en", "vtt"), subtitle("fr-pgs", "fr", "pgs"), subtitle("de", "de", "vtt")],
  chapters: [],
};

const profile = castProfileForModel("Google TV Streamer");

describe("cast track pickers", () => {
  it("offers only the audio the device plays, and every subtitle with picture ones not castable", () => {
    const choices = castTrackChoices(metadata, profile);
    console.info("choices", JSON.stringify({ audio: choices.audio.map((c) => c.idx), subs: choices.subtitles.map((c) => [c.idx, c.castable]) }));
    expect(choices.audio.map((c) => c.track.id)).toEqual(["en", "fr"]);
    expect(choices.audio.map((c) => c.idx)).toEqual([0, 2]);
    expect(choices.subtitles.map((c) => [c.track.id, c.castable])).toEqual([
      ["en-srt", true],
      ["fr-pgs", false],
      ["de", true],
    ]);
  });

  it("reads what is on the device from the plan, as indexes into the file", () => {
    const plan = planCast({ metadata, profile, startTracks: { audioIdx: 2, subtitle: { mode: "track", idx: 2 } } });
    if (!plan.ok) throw new Error(plan.detail);
    expect(activeCastTracks(metadata, plan)).toEqual({ audioIdx: 2, subtitleIdx: 2 });
    const noSubs = planCast({ metadata, profile, startTracks: { audioIdx: null, subtitle: { mode: "off" } } });
    if (!noSubs.ok) throw new Error(noSubs.detail);
    expect(activeCastTracks(metadata, noSubs)).toEqual({ audioIdx: 0, subtitleIdx: -1 });
  });

  it("an audio pick keeps the subtitle on the device and re-plans with the picked track", () => {
    const choices = castTrackChoices(metadata, profile);
    const next = pickCastTrack(choices, { audioIdx: 0, subtitleIdx: 2 }, { kind: "audio", idx: 2 });
    expect(next).toEqual({ audioIdx: 2, subtitle: { mode: "track", idx: 2 } });
    const plan = planCast({ metadata, profile, startTracks: next! });
    if (!plan.ok) throw new Error(plan.detail);
    expect(plan.audio[0]?.id).toBe("fr");
    expect(plan.subtitle?.id).toBe("de");
  });

  it("a subtitle pick keeps the audio; -1 turns subtitles off", () => {
    const choices = castTrackChoices(metadata, profile);
    expect(pickCastTrack(choices, { audioIdx: 2, subtitleIdx: -1 }, { kind: "subtitle", idx: 0 })).toEqual({ audioIdx: 2, subtitle: { mode: "track", idx: 0 } });
    expect(pickCastTrack(choices, { audioIdx: 2, subtitleIdx: 0 }, { kind: "subtitle", idx: -1 })).toEqual({ audioIdx: 2, subtitle: { mode: "off" } });
  });

  it("a pick that changes nothing, a track the device cannot play or a picture subtitle reloads nothing", () => {
    const choices = castTrackChoices(metadata, profile);
    const active = { audioIdx: 0, subtitleIdx: -1 };
    expect(pickCastTrack(choices, active, { kind: "audio", idx: 0 })).toBeNull();
    expect(pickCastTrack(choices, active, { kind: "audio", idx: 1 })).toBeNull();
    expect(pickCastTrack(choices, active, { kind: "audio", idx: 9 })).toBeNull();
    expect(pickCastTrack(choices, active, { kind: "subtitle", idx: -1 })).toBeNull();
    expect(pickCastTrack(choices, active, { kind: "subtitle", idx: 1 })).toBeNull();
  });
});

describe("cast volume", () => {
  it("ignores device readings for a moment after the user changed the volume", () => {
    expect(followsDeviceVolume(1000, 1000 + VOLUME_SETTLE_MS - 1)).toBe(false);
    expect(followsDeviceVolume(1000, 1000 + VOLUME_SETTLE_MS)).toBe(true);
    expect(followsDeviceVolume(0, Date.now())).toBe(true);
  });

  it("AirPlay mute goes to 0 and unmute restores the level before it", () => {
    const muted = airPlayMuteLevel(true, 0.6, null);
    expect(muted).toEqual({ level: 0, remembered: 0.6 });
    expect(airPlayMuteLevel(false, 0, muted.remembered)).toEqual({ level: 0.6, remembered: null });
  });

  it("unmuting a route that was silent before gives an audible level", () => {
    const muted = airPlayMuteLevel(true, 0, null);
    expect(muted).toEqual({ level: 0, remembered: null });
    expect(airPlayMuteLevel(false, 0, muted.remembered).level).toBe(AIRPLAY_UNMUTE_FALLBACK);
  });
});
