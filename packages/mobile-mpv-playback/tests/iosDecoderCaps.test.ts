/**
 * @test-id MPV-IOS-CAPS-001
 * @level unit
 * @why PLAY-QUAL-06: an iPhone reports no decoder limits, so the start quality uses Apple's published limits for its
 *   model, keyed by the `utsname` machine id. The limits table is a pure TS layer (`iosDecoderCaps.ts`); the Swift side
 *   only reports raw facts. These tests pin the table per generation (old iPhones 4K30, A11+ HEVC 4K60 with H.264 at 4K30,
 *   AV1 from the iPhone 15 Pro, HEVC 4K120 on Pro models), the rules for unknown / newer / simulator devices, the probe
 *   verdicts, and the `DecoderCaps` shape shared with Android.
 */
import { describe, expect, it, vi } from "vitest";
import { withIosDecoderCaps } from "../src/MpvControl";
import type { DecoderProbe } from "../src/types";
import {
  CONSERVATIVE_PROFILE,
  IOS_MIME_AV1,
  IOS_MIME_AVC,
  IOS_MIME_HEVC,
  IOS_MIME_VP9,
  composeIosDecoderCaps,
  describeIosProfile,
  iosDecoderProfile,
  type IosDecoderReport,
} from "../src/iosDecoderCaps";

// `MpvControl.ts` reads `NativeModules` at load; the wrapper under test is given its native object explicitly.
vi.mock("react-native", () => ({ NativeModules: {} }));

const allVt = { [IOS_MIME_AVC]: true, [IOS_MIME_HEVC]: true, [IOS_MIME_VP9]: true, [IOS_MIME_AV1]: true };
const report = (machine: string, over: Partial<IosDecoderReport> = {}): IosDecoderReport => ({
  sdk: 18,
  machine,
  simulator: false,
  videoToolbox: allVt,
  ...over,
});
const probe = (id: string, mime: string, height: number, fps = 30, tenBit = false): DecoderProbe => ({
  id,
  mime,
  width: Math.round((height * 16) / 9 / 2) * 2,
  height,
  fps,
  tenBit,
});
const verdicts = (machine: string, probes: DecoderProbe[], over: Partial<IosDecoderReport> = {}) => {
  const caps = composeIosDecoderCaps(report(machine, over), probes);
  const out = Object.fromEntries(caps.probes.map((p) => [p.id, p]));
  console.info(`[ios-decoder-caps] ${machine} ${JSON.stringify(over)} -> ${describeIosProfile(iosDecoderProfile(machine, over.simulator ?? false))} probes=${JSON.stringify(caps.probes)}`);
  return out;
};

const hevc4k10 = probe("hevc4k10", IOS_MIME_HEVC, 2160, 30, true);
const hevc4k60 = probe("hevc4k60", IOS_MIME_HEVC, 2160, 60, true);
const hevc4k120 = probe("hevc4k120", IOS_MIME_HEVC, 2160, 120, true);
const avc1080 = probe("avc1080", IOS_MIME_AVC, 1080);
const avc4k30 = probe("avc4k30", IOS_MIME_AVC, 2160, 30);
const avc4k60 = probe("avc4k60", IOS_MIME_AVC, 2160, 60);
const avc10bit = probe("avc10bit", IOS_MIME_AVC, 1080, 30, true);
const av14k = probe("av14k", IOS_MIME_AV1, 2160, 30, true);
const vp9 = probe("vp9", IOS_MIME_VP9, 1080);
const ALL = [hevc4k10, hevc4k60, hevc4k120, avc1080, avc4k30, avc4k60, avc10bit, av14k, vp9];

describe("iosDecoderProfile: one row per SoC generation, keyed by the machine id", () => {
  /** @req PLAY-QUAL-06[badger-mobile] */
  it.each([
    ["iPhone8,1", "A9"], // 6s
    ["iPhone8,4", "A9"], // SE 1st
    ["iPhone9,1", "A10"], // 7
    ["iPhone10,6", "A11"], // X
    ["iPhone11,8", "A12"], // XR
    ["iPhone12,1", "A13"], // 11
    ["iPhone12,8", "A13"], // SE 2nd
    ["iPhone13,2", "A14"], // 12
    ["iPhone14,5", "A15"], // 13
    ["iPhone14,7", "A15"], // 14
    ["iPhone15,2", "A16"], // 14 Pro
    ["iPhone15,4", "A16"], // 15
    ["iPhone16,1", "A17 Pro"], // 15 Pro
    ["iPhone17,3", "A18"], // 16
    ["iPhone17,5", "A18"], // 16e
    ["iPhone18,3", "A19"], // 17
    ["iPhone18,4", "A19"], // Air
    ["iPhone18,5", "A19"], // 17e
  ])("%s is a %s row, found by its machine id", (machine, chip) => {
    const match = iosDecoderProfile(machine, false);
    console.info(`[ios-decoder-caps] ${machine} -> ${describeIosProfile(match)}`);
    expect(match.source).toBe("model");
    expect(match.profile.chip).toBe(chip);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("iPhone 6s / 7 decode 4K at 30 fps, iPhone 8 and later HEVC at 60 fps and H.264 at 30 fps (Apple Tech Specs)", () => {
    expect(iosDecoderProfile("iPhone8,1", false).profile.hevc.maxFps).toBe(30);
    expect(iosDecoderProfile("iPhone8,1", false).profile.h264.maxFps).toBe(30);
    expect(iosDecoderProfile("iPhone9,3", false).profile.hevc.maxFps).toBe(30);
    for (const machine of ["iPhone10,1", "iPhone11,2", "iPhone12,1", "iPhone13,1", "iPhone14,2", "iPhone15,3"]) {
      const { profile } = iosDecoderProfile(machine, false);
      expect(profile.hevc.maxFps).toBe(60);
      // Apple publishes H.264 4K only at 30 fps (iPhone 6s, SP726), no H.264 4K60: H.264 stays at 30 (lower figure).
      expect(profile.h264.maxFps).toBe(30);
    }
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("hardware AV1 only from the iPhone 15 Pro (A17 Pro): the iPhone 15 and everything older have none", () => {
    for (const machine of ["iPhone8,1", "iPhone12,1", "iPhone14,5", "iPhone15,2", "iPhone15,4", "iPhone15,5"]) {
      expect(iosDecoderProfile(machine, false).profile.av1, machine).toBeNull();
    }
    for (const machine of ["iPhone16,1", "iPhone16,2", "iPhone17,3", "iPhone17,1", "iPhone18,3", "iPhone18,4"]) {
      expect(iosDecoderProfile(machine, false).profile.av1, machine).not.toBeNull();
    }
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("only the Pro models Apple publishes at 4K 120 fps get it (HEVC only); the others stay at 60", () => {
    for (const machine of ["iPhone17,1", "iPhone17,2", "iPhone18,1", "iPhone18,2", "iPhone19,2", "iPhone19,3"]) {
      expect(iosDecoderProfile(machine, false).profile.hevc.maxFps, machine).toBe(120);
      expect(iosDecoderProfile(machine, false).profile.h264.maxFps, machine).toBe(30);
    }
    for (const machine of ["iPhone17,3", "iPhone17,4", "iPhone17,5", "iPhone18,3", "iPhone18,4", "iPhone16,1"]) {
      expect(iosDecoderProfile(machine, false).profile.hevc.maxFps, machine).toBe(60);
    }
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("the shared rows are not mutated by the 4K120 override", () => {
    const pro = iosDecoderProfile("iPhone17,1", false).profile;
    const base = iosDecoderProfile("iPhone17,3", false).profile;
    expect(pro.hevc.maxFps).toBe(120);
    expect(base.hevc.maxFps).toBe(60);
    expect(iosDecoderProfile("iPhone17,4", false).profile.hevc.maxFps).toBe(60);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("an iPhone newer than the table gets the newest known generation, not the conservative row", () => {
    const match = iosDecoderProfile("iPhone25,3", false);
    console.info(`[ios-decoder-caps] iPhone25,3 -> ${describeIosProfile(match)}`);
    expect(match.source).toBe("newest-known");
    expect(match.profile.chip).toBe("A20");
    expect(match.profile.av1).not.toBeNull();
    expect(match.profile.hevc.maxFps).toBe(60);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("the simulator, an iPad / Apple TV / Mac / empty id, and an iPhone older than iOS 15.1 get the conservative row", () => {
    expect(iosDecoderProfile("iPhone17,1", true)).toMatchObject({ source: "simulator", profile: CONSERVATIVE_PROFILE });
    expect(iosDecoderProfile("arm64", true).profile).toBe(CONSERVATIVE_PROFILE);
    for (const machine of ["iPad14,3", "AppleTV14,1", "Mac14,2", "arm64", "", "iPhone7,2", "garbage"]) {
      const match = iosDecoderProfile(machine, false);
      expect(match.source, machine).toBe("unlisted-device");
      expect(match.profile, machine).toBe(CONSERVATIVE_PROFILE);
    }
    expect(CONSERVATIVE_PROFILE.av1).toBeNull();
    expect(CONSERVATIVE_PROFILE.hevc.maxFps).toBe(30);
  });
});

describe("composeIosDecoderCaps: the same DecoderCaps shape Android returns", () => {
  /** @req PLAY-QUAL-06[badger-mobile] */
  it("lists avc, hevc, vp9 and av01 with a hardware limit per model and an FFmpeg software decoder for each", () => {
    const caps = composeIosDecoderCaps(report("iPhone16,1", { sdk: 26 }), []);
    console.info(`[ios-decoder-caps] iPhone16,1 codecs=${JSON.stringify(caps.codecs)}`);
    expect(caps.sdk).toBe(26);
    expect(caps.probes).toEqual([]);
    expect(caps.codecs.map((c) => c.mime)).toEqual([IOS_MIME_AVC, IOS_MIME_HEVC, IOS_MIME_VP9, IOS_MIME_AV1]);
    const [avc, hevc, vp9Codec, av1] = caps.codecs;
    expect(avc!.hardware).toEqual({ name: "videotoolbox-avc", maxWidth: 4096, maxHeight: 2304, maxFps: 30, tenBit: false });
    expect(hevc!.hardware).toEqual({ name: "videotoolbox-hevc", maxWidth: 4096, maxHeight: 2304, maxFps: 60, tenBit: true });
    expect(vp9Codec!.hardware).toBeNull();
    // Apple publishes no AV1 frame rate: the lower figure, 4K at 30 fps.
    expect(av1!.hardware).toEqual({ name: "videotoolbox-av1", maxWidth: 4096, maxHeight: 2304, maxFps: 30, tenBit: true });
    for (const codec of caps.codecs) {
      expect(codec.software).toMatchObject({ maxWidth: 8192, maxHeight: 4320, maxFps: null, tenBit: true });
    }
    expect(avc!.software!.name).toBe("ffmpeg-h264");
    expect(av1!.software!.name).toBe("ffmpeg-libdav1d");
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("a model's probes are answered from its own limits: iPhone 11 (4K60 HEVC 10-bit, no AV1, no 4K120)", () => {
    const v = verdicts("iPhone12,1", ALL);
    expect(v.hevc4k10!.hardware).toBe(true);
    expect(v.hevc4k60!.hardware).toBe(true);
    expect(v.hevc4k120!.hardware).toBe(false);
    expect(v.avc1080!.hardware).toBe(true);
    expect(v.avc4k60!.hardware).toBe(false); // Apple publishes no H.264 4K60 decode: capped at 4K30
    expect(v.avc4k30!.hardware).toBe(true);
    expect(v.avc10bit!.hardware).toBe(false); // no hardware High10 H.264
    expect(v.av14k!.hardware).toBe(false);
    expect(v.vp9!.hardware).toBe(false);
    // Software (FFmpeg) can decode anything of a known codec up to 8K, so a probe is never "unanswerable" here.
    for (const p of ["hevc4k10", "avc10bit", "av14k", "vp9"]) expect(v[p]!.software, p).toBe(true);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("an iPhone 7 (A10) cannot decode 4K at 60 fps in hardware, an iPhone 8 can: the start quality differs per model", () => {
    expect(verdicts("iPhone9,1", [hevc4k10, hevc4k60]).hevc4k60!.hardware).toBe(false);
    expect(verdicts("iPhone9,1", [hevc4k10, hevc4k60]).hevc4k10!.hardware).toBe(true);
    expect(verdicts("iPhone10,1", [hevc4k10, hevc4k60]).hevc4k60!.hardware).toBe(true);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("AV1 is hardware-decodable on an iPhone 16 and an unknown newer iPhone, not on an iPhone 15; 4K60 AV1 is not (no published rate)", () => {
    expect(verdicts("iPhone15,4", [av14k]).av14k!.hardware).toBe(false);
    expect(verdicts("iPhone17,3", [av14k]).av14k!.hardware).toBe(true);
    expect(verdicts("iPhone30,1", [av14k]).av14k!.hardware).toBe(true);
    const av14k60 = probe("av14k60", IOS_MIME_AV1, 2160, 60, true);
    expect(verdicts("iPhone17,1", [av14k60]).av14k60!.hardware).toBe(false);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("a 4K 120 fps HEVC version is hardware-decodable on an iPhone 17 Pro and an iPhone 18 Pro Max, not on an iPhone 17", () => {
    expect(verdicts("iPhone18,1", [hevc4k120]).hevc4k120!.hardware).toBe(true);
    expect(verdicts("iPhone19,3", [hevc4k120]).hevc4k120!.hardware).toBe(true);
    expect(verdicts("iPhone18,3", [hevc4k120]).hevc4k120!.hardware).toBe(false);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("VideoToolbox can take a codec away from the table, never add one", () => {
    const noHevc = verdicts("iPhone16,1", [hevc4k10, avc1080], { videoToolbox: { ...allVt, [IOS_MIME_HEVC]: false } });
    expect(noHevc.hevc4k10!.hardware).toBe(false);
    expect(noHevc.avc1080!.hardware).toBe(true);
    const capsNoHevc = composeIosDecoderCaps(report("iPhone16,1", { videoToolbox: { ...allVt, [IOS_MIME_HEVC]: false } }), []);
    expect(capsNoHevc.codecs.find((c) => c.mime === IOS_MIME_HEVC)!.hardware).toBeNull();
    // The OS saying yes for AV1 on an iPhone 15 does not add it: the published table has none.
    expect(verdicts("iPhone15,4", [av14k], { videoToolbox: allVt }).av14k!.hardware).toBe(false);
    // A codec VideoToolbox did not answer for is left to the table.
    expect(verdicts("iPhone16,1", [hevc4k10], { videoToolbox: {} }).hevc4k10!.hardware).toBe(true);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("the simulator is conservative: 4K30, no AV1, whatever model it pretends to be", () => {
    const v = verdicts("arm64", [hevc4k10, hevc4k60, av14k, avc1080], { simulator: true });
    expect(v.hevc4k10!.hardware).toBe(true);
    expect(v.hevc4k60!.hardware).toBe(false);
    expect(v.av14k!.hardware).toBe(false);
    expect(v.avc1080!.hardware).toBe(true);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("a mime the table does not know gets no hardware and no software answer (unknown, not decodable)", () => {
    const v = verdicts("iPhone16,1", [{ id: "mp2", mime: "video/mpeg2", width: 1920, height: 1080, fps: 30, tenBit: false }]);
    expect(v.mp2).toEqual({ id: "mp2", hardware: false, software: false });
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("a picture beyond the software ceiling (8K UHD) is not decodable at all", () => {
    const v = verdicts("iPhone16,1", [{ id: "huge", mime: IOS_MIME_HEVC, width: 16384, height: 8640, fps: 30, tenBit: false }]);
    expect(v.huge).toEqual({ id: "huge", hardware: false, software: false });
  });
});

describe("withIosDecoderCaps: getDecoderCaps on iPhone answers from the model's table", () => {
  /** @req PLAY-QUAL-06[badger-mobile] */
  it("composes the native report in JS: the same probes get each model's own verdicts", async () => {
    const probes = [hevc4k10, hevc4k60, av14k];
    const iPhone11 = withIosDecoderCaps({}, async () => report("iPhone12,1", { sdk: 18 }));
    const iPhone7 = withIosDecoderCaps({}, async () => report("iPhone9,1", { sdk: 15 }));
    const caps11 = await iPhone11.getDecoderCaps(probes);
    const caps7 = await iPhone7.getDecoderCaps(probes);
    console.info(`[ios-decoder-caps] withIosDecoderCaps iPhone12,1 -> ${JSON.stringify(caps11.probes)}; iPhone9,1 -> ${JSON.stringify(caps7.probes)}`);
    expect(caps11.sdk).toBe(18);
    expect(caps11.probes).toEqual([
      { id: "hevc4k10", hardware: true, software: true },
      { id: "hevc4k60", hardware: true, software: true },
      { id: "av14k", hardware: false, software: true },
    ]);
    expect(caps7.sdk).toBe(15);
    expect(caps7.probes).toEqual([
      { id: "hevc4k10", hardware: true, software: true },
      { id: "hevc4k60", hardware: false, software: true },
      { id: "av14k", hardware: false, software: true },
    ]);
  });
});
