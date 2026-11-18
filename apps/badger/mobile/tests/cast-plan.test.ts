/**
 * @test-id MOBILE-CAST-002
 * @level unit
 * @why A title is cast only when the device can play its video and the chosen subtitle is text. Otherwise the phone refuses
 *   with a reason the UI turns into "plays on the SpaceBadger TV app" (UX-TV-03). Also pins what the cast server is given.
 */
import { describe, expect, it } from "vitest";
import { type AudioTrack, type IngestMetadata, type SubtitleTrack, type VideoFormat } from "@space/mobile-mpv-playback";
import { airPlayProfile, castProfileForModel } from "../src/lib/cast/castProfiles";
import { planCast } from "../src/lib/cast/castPlan";

const video = (id: string, quality: string, codec: string, codecString: string, height: number, bitrateKbps = 4000): VideoFormat => ({
  id,
  quality,
  codec,
  codecString,
  initKey: `v/${id}/init.mp4`,
  initSize: 800,
  durationSeconds: 100,
  totalSize: 1000,
  bitrateKbps,
  height,
  width: Math.round((height * 16) / 9),
  chunks: [{ key: `v/${id}/0.m4s`, sizeBytes: 1000, startSeconds: 0, durationSeconds: 100 }],
});

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

const sub = (id: string, language: string, format: SubtitleTrack["format"], isDefault = false): SubtitleTrack => ({
  id,
  language,
  label: language,
  isDefault,
  format,
  encrypted: true,
  url: `subs/${id}.${format === "vtt" ? "vtt" : "sup"}`,
});

const metadata = (over: Partial<IngestMetadata> = {}): IngestMetadata => ({
  encryptionKeyBase64: "AAAA",
  videos: [video("v1080", "1080p", "h264", "avc1.640028", 1080)],
  audioTracks: [audio("en", "en", "aac", true), audio("fr", "fr", "aac")],
  subtitleTracks: [sub("s-en", "en", "vtt"), sub("s-fr-pgs", "fr", "pgs")],
  chapters: [{ title: "Intro", startSeconds: 0, endSeconds: 10 }],
  ...over,
});

const OFF = { audioIdx: 0, subtitle: { mode: "off" } } as const;

describe("planCast", () => {
  // @req UX-TV-03[badger-mobile]
  it("casts a playable title and hands the server exactly one video, the playable audio and no chapters", () => {
    const plan = planCast({ metadata: metadata(), startTracks: { audioIdx: 1, subtitle: { mode: "off" } }, profile: castProfileForModel("Chromecast") });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.serverMetadata.videos.map((v) => v.id)).toEqual(["v1080"]);
    expect(plan.serverMetadata.audioTracks.map((a) => a.id)).toEqual(["fr", "en"]);
    expect(plan.serverMetadata.audioTracks.find((a) => a.isDefault)?.id).toBe("fr");
    expect(plan.serverMetadata.subtitleTracks).toEqual([]);
    expect(plan.serverMetadata.chapters).toEqual([]);
  });

  // @req UX-TV-03[badger-mobile]
  it("picks the tallest version the device plays, H.264 first at equal height", () => {
    const meta = metadata({
      videos: [
        video("hevc2160", "2160p", "hevc", "hvc1.1.6.L150.B0", 2160),
        video("avc1080", "1080p", "h264", "avc1.640028", 1080),
        video("hevc1080", "1080p", "hevc", "hvc1.1.6.L120.B0", 1080, 9000),
      ],
    });
    const chromecast = planCast({ metadata: meta, startTracks: OFF, profile: castProfileForModel("Chromecast") });
    const ultra = planCast({ metadata: meta, startTracks: OFF, profile: castProfileForModel("Chromecast Ultra") });
    expect(chromecast.ok && chromecast.video.id).toBe("avc1080");
    expect(chromecast.ok && chromecast.skippedVideos.map((s) => s.id).sort()).toEqual(["hevc1080", "hevc2160"]);
    expect(ultra.ok && ultra.video.id).toBe("hevc2160");
  });

  // @req UX-TV-03[badger-mobile]
  it("refuses a title whose only video the device cannot play", () => {
    const meta = metadata({ videos: [video("hevc2160", "2160p", "hevc", "hvc1.1.6.L150.B0", 2160)] });
    const plan = planCast({ metadata: meta, startTracks: OFF, profile: castProfileForModel("Chromecast") });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe("video-unsupported");
      expect(plan.detail).toContain("hevc2160");
    }
  });

  // @req UX-TV-03[badger-mobile]
  it.each([
    ["pgs", "s-fr-pgs"],
    ["vobsub", "s-fr-vob"],
  ] as const)("refuses when the chosen subtitle is an image (%s)", (format, id) => {
    const meta = metadata({ subtitleTracks: [sub("s-en", "en", "vtt"), sub(id, "fr", format)] });
    const plan = planCast({ metadata: meta, startTracks: { audioIdx: 0, subtitle: { mode: "track", idx: 1 } }, profile: castProfileForModel("Google TV Streamer") });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("image-subtitles");
  });

  // @req UX-TV-03[badger-mobile]
  it("casts with a chosen text subtitle and serves only that one, flagged default", () => {
    const plan = planCast({ metadata: metadata(), startTracks: { audioIdx: 0, subtitle: { mode: "track", idx: 0 } }, profile: airPlayProfile() });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.subtitle?.id).toBe("s-en");
    expect(plan.serverMetadata.subtitleTracks).toEqual([expect.objectContaining({ id: "s-en", isDefault: true })]);
  });

  // @req UX-TV-03[badger-mobile]
  it("a default image subtitle refuses like a picked one; a default text one is cast; no default means none", () => {
    const imageDefault = metadata({ subtitleTracks: [sub("s-en", "en", "vtt"), sub("s-fr-pgs", "fr", "pgs", true)] });
    const textDefault = metadata({ subtitleTracks: [sub("s-en", "en", "vtt", true), sub("s-fr-pgs", "fr", "pgs")] });
    const noDefault = metadata({ subtitleTracks: [sub("s-en", "en", "vtt"), sub("s-fr-pgs", "fr", "pgs")] });
    const start = { audioIdx: 0, subtitle: { mode: "default" } } as const;
    const a = planCast({ metadata: imageDefault, startTracks: start, profile: airPlayProfile() });
    const b = planCast({ metadata: textDefault, startTracks: start, profile: airPlayProfile() });
    const c = planCast({ metadata: noDefault, startTracks: start, profile: airPlayProfile() });
    expect(a).toMatchObject({ ok: false, reason: "image-subtitles" });
    expect(b.ok && b.subtitle?.id).toBe("s-en");
    expect(c.ok && c.subtitle).toBeNull();
  });

  // @req UX-TV-03[badger-mobile]
  it("leaves out audio the device cannot play, and refuses when none is left", () => {
    const mixed = metadata({ audioTracks: [audio("dts", "en", "dts", true), audio("fr", "fr", "aac")] });
    const plan = planCast({ metadata: mixed, startTracks: { audioIdx: 0, subtitle: { mode: "off" } }, profile: castProfileForModel("Chromecast") });
    expect(plan.ok && plan.audio.map((a) => a.id)).toEqual(["fr"]);
    expect(plan.ok && plan.omittedAudio.map((o) => o.id)).toEqual(["dts"]);

    const none = planCast({
      metadata: metadata({ audioTracks: [audio("dts", "en", "dts", true)] }),
      startTracks: OFF,
      profile: castProfileForModel("Chromecast"),
    });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("no-playable-audio");
  });

  // @req UX-TV-03[badger-mobile]
  it("refuses a file with no video", () => {
    const plan = planCast({ metadata: metadata({ videos: [] }), startTracks: OFF, profile: airPlayProfile() });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("no-video");
  });
});
