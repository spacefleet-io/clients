/**
 * @test-id MOBILE-CAST-001
 * @level unit
 * @why The phone must never hand a cast device a video it cannot decode (black screen) nor refuse one it can play. The
 *   decision rests on the vendors' PUBLISHED format lists (Google Cast, Apple HLS), encoded in castProfiles.ts; this
 *   pins that table (UX-TV-03: not measured on a real device, so the table is the contract).
 */
import { describe, expect, it } from "vitest";
import {
  airPlayProfile,
  audioFamilyOf,
  audioVerdict,
  avcLevelOf,
  castProfileForModel,
  hevcInfoOf,
  videoVerdict,
} from "../src/lib/cast/castProfiles";

describe("cast profiles by model name", () => {
  // @req UX-TV-03[badger-mobile]
  it.each([
    ["Chromecast", "cast-chromecast"],
    ["Chromecast Ultra", "cast-ultra"],
    ["Chromecast with Google TV", "cast-google-tv"],
    ["Google TV Streamer", "cast-google-tv-streamer"],
    ["Google Nest Hub", "cast-nest-hub"],
    ["Some Soundbar 3000", "cast-chromecast"],
    [null, "cast-chromecast"],
    [undefined, "cast-chromecast"],
  ])("%s -> %s", (model, id) => {
    const profile = castProfileForModel(model as string | null | undefined);
    expect(profile.id).toBe(id);
  });
});

describe("codec string readers", () => {
  // @req UX-TV-03[badger-mobile]
  it("reads H.264 levels", () => {
    expect(avcLevelOf("avc1.640029")).toBe(0x29);
    expect(avcLevelOf("avc1.64002A")).toBe(0x2a);
    expect(avcLevelOf("avc1.640033")).toBe(0x33);
    expect(avcLevelOf("hvc1.1.6.L153.B0")).toBeNull();
    expect(avcLevelOf(null)).toBeNull();
  });

  // @req UX-TV-03[badger-mobile]
  it("reads HEVC tag and level", () => {
    expect(hevcInfoOf("hvc1.1.6.L153.B0")).toEqual({ tag: "hvc1", level: 153 });
    expect(hevcInfoOf("hev1.2.4.L120.90")).toEqual({ tag: "hev1", level: 120 });
    expect(hevcInfoOf("avc1.640029")).toEqual({ tag: null, level: null });
  });

  // @req UX-TV-03[badger-mobile]
  it("names audio families from label or codec string", () => {
    expect(audioFamilyOf("aac", "mp4a.40.2")).toBe("aac");
    expect(audioFamilyOf("AAC-LC", null)).toBe("aac");
    expect(audioFamilyOf("ac3", null)).toBe("ac3");
    expect(audioFamilyOf("eac3", "ec-3")).toBe("eac3");
    expect(audioFamilyOf("dts", null)).toBe("dts");
    expect(audioFamilyOf("truehd", null)).toBe("truehd");
    expect(audioFamilyOf("", "")).toBeNull();
  });
});

describe("video verdict", () => {
  // @req UX-TV-03[badger-mobile]
  it("1080p H.264 High 4.0 plays on every Google device", () => {
    for (const model of ["Chromecast", "Chromecast Ultra", "Chromecast with Google TV", "Google TV Streamer", "Google Nest Hub"]) {
      const profile = castProfileForModel(model);
      const verdict = videoVerdict(profile, { codec: "h264", codecString: "avc1.640028", height: model === "Google Nest Hub" ? 720 : 1080 });
      expect(verdict.playable).toBe(true);
    }
  });

  // @req UX-TV-03[badger-mobile]
  it("H.264 level 4.2 is refused on a first/second-gen Chromecast and plays on the Ultra", () => {
    const input = { codec: "h264", codecString: "avc1.64002A", height: 1080 };
    expect(videoVerdict(castProfileForModel("Chromecast"), input).playable).toBe(false);
    expect(videoVerdict(castProfileForModel("Chromecast Ultra"), input).playable).toBe(true);
  });

  // @req UX-TV-03[badger-mobile]
  it("HEVC is refused on old dongles and plays on Ultra / Google TV", () => {
    const input = { codec: "hevc", codecString: "hvc1.1.6.L150.B0", height: 2160 };
    const old = videoVerdict(castProfileForModel("Chromecast"), input);
    expect(old.playable).toBe(false);
    expect(videoVerdict(castProfileForModel("Chromecast Ultra"), input).playable).toBe(true);
    expect(videoVerdict(castProfileForModel("Chromecast with Google TV"), input).playable).toBe(true);
  });

  // @req UX-TV-03[badger-mobile]
  it("a height above the device's limit is refused (Nest Hub 720p)", () => {
    const verdict = videoVerdict(castProfileForModel("Google Nest Hub"), { codec: "h264", codecString: "avc1.640028", height: 1080 });
    expect(verdict.playable).toBe(false);
  });

  // @req UX-TV-03[badger-mobile]
  it("AirPlay takes HEVC only with the hvc1 tag", () => {
    const air = airPlayProfile();
    expect(videoVerdict(air, { codec: "hevc", codecString: "hvc1.2.4.L153.B0", height: 2160 }).playable).toBe(true);
    const hev1 = videoVerdict(air, { codec: "hevc", codecString: "hev1.2.4.L153.B0", height: 2160 });
    expect(hev1.playable).toBe(false);
    expect(videoVerdict(air, { codec: "h264", codecString: "avc1.640033", height: 1080 }).playable).toBe(true);
  });

  // @req UX-TV-03[badger-mobile]
  it("VP9 and AV1 follow the lists", () => {
    const vp9 = { codec: "vp9", codecString: "vp09.00.40.08", height: 2160 };
    const av1 = { codec: "av1", codecString: "av01.0.13M.08", height: 2160 };
    expect(videoVerdict(castProfileForModel("Chromecast"), vp9).playable).toBe(false);
    expect(videoVerdict(castProfileForModel("Chromecast Ultra"), vp9).playable).toBe(true);
    expect(videoVerdict(castProfileForModel("Chromecast Ultra"), av1).playable).toBe(false);
    expect(videoVerdict(castProfileForModel("Google TV Streamer"), av1).playable).toBe(true);
    expect(videoVerdict(airPlayProfile(), vp9).playable).toBe(false);
  });

  // @req UX-TV-03[badger-mobile]
  it("an H.264 version whose level cannot be read is refused rather than guessed", () => {
    expect(videoVerdict(castProfileForModel("Chromecast"), { codec: "h264", codecString: "", height: 1080 }).playable).toBe(false);
  });
});

describe("audio verdict", () => {
  // @req UX-TV-03[badger-mobile]
  it("AAC plays on every target; DTS and TrueHD are left out", () => {
    for (const profile of [castProfileForModel("Chromecast"), castProfileForModel("Google TV Streamer"), airPlayProfile()]) {
      expect(audioVerdict(profile, { codec: "aac", codecString: "mp4a.40.2" })).toBe("play");
      expect(audioVerdict(profile, { codec: "dts", codecString: "" })).toBe("omit");
      expect(audioVerdict(profile, { codec: "truehd", codecString: "" })).toBe("omit");
    }
  });

  // @req UX-TV-03[badger-mobile]
  it("AC-3 is a Cast pass-through only on the Web Receiver, so the default receiver leaves it out; AirPlay plays it", () => {
    expect(audioVerdict(castProfileForModel("Chromecast with Google TV"), { codec: "ac3", codecString: "ac-3" })).toBe("omit");
    expect(audioVerdict(airPlayProfile(), { codec: "ac3", codecString: "ac-3" })).toBe("play");
  });

  // @req UX-TV-03[badger-mobile]
  it("an audio codec nobody can name is left out, never handed over unchecked", () => {
    expect(audioVerdict(airPlayProfile(), { codec: "", codecString: "" })).toBe("omit");
  });
});
