/**
 * @test-id MPV-TV-AUDIO-001
 * @level unit
 * @why MPV-TV-03: surround reaches the receiver. The box's audio sink facts (Android `AudioManager` / `AudioTrack`,
 *   tvOS `AVAudioSession`) are planned into mpv `audio-spdif` / `audio-channels` in pure TS (`tvAudioOutput.ts`); the
 *   native side only reports and applies. These tests pin the mapping: on Android TV DD / DD+ / DTS pass through when the
 *   sink takes them, TrueHD / DTS-HD never do (mpv's audiotrack carries IEC 61937 on a stereo track only) and are
 *   decoded to the sink's channel count; on Apple TV nothing passes through and decoded sound asks for up to 7.1.
 *   The rule stays pending until a real receiver run; this is the logic half only.
 * @req MPV-TV-03[badger-tv]
 */
import { describe, expect, it, vi } from "vitest";
import {
  ANDROID_PASSTHROUGH_FORMATS,
  configureTvAudioOutput,
  planTvAudioOutput,
  type AndroidAudioDevice,
  type TvAudioReport,
} from "../src/tvAudioOutput";

const ID = "MPV-TV-AUDIO-001";
const log = (phase: string, data: unknown) => console.info(`[${ID}] ${phase}`, JSON.stringify(data));

const hdmi = (encodings: string[], channelCounts: number[] = [], type = "hdmi"): AndroidAudioDevice => ({ type, encodings, channelCounts });
const android = (over: Partial<Extract<TvAudioReport, { platform: "android" }>> = {}): TvAudioReport => ({
  platform: "android",
  sdk: 30,
  devices: [],
  hdmiPlug: null,
  direct: null,
  ...over,
});

const plan = (name: string, report: TvAudioReport) => {
  log(`${name}: report`, report);
  const result = planTvAudioOutput(report);
  log(`${name}: plan`, result);
  return result;
};

describe("planTvAudioOutput, Android TV", () => {
  it("API 29+: what AudioTrack will open directly wins over what the sink declares", () => {
    const p = plan("direct", android({
      sdk: 30,
      devices: [hdmi(["pcm", "ac3", "eac3", "dts", "truehd"], [2, 6, 8])],
      direct: ["ac3", "eac3"],
    }));
    expect(p.spdif).toBe("ac3,eac3");
    expect(p.channels).toBe("7.1,5.1,stereo");
    expect(p.preferredOutputChannels).toBeNull();
    expect(p.reason).toContain("source=direct-playback");
  });

  it("before API 29: the HDMI sink's declared encodings, never TrueHD / DTS-HD", () => {
    const p = plan("declared", android({
      sdk: 28,
      devices: [hdmi(["pcm", "ac3", "eac3", "eac3_joc", "dts", "dts_hd", "truehd"], [2, 6]), { type: "speaker", encodings: [], channelCounts: [2] }],
    }));
    expect(p.spdif).toBe("ac3,eac3,dts");
    expect(p.spdif).not.toMatch(/truehd|dts_hd/);
    expect(p.channels).toBe("5.1,stereo");
    expect(p.reason).toContain("source=hdmi-declared");
    expect(p.reason).toContain("sinks=hdmi");
  });

  it("HDMI plug broadcast only (Fire TV): its encodings and max channel count", () => {
    const p = plan("plug", android({ sdk: 25, hdmiPlug: { plugged: true, encodings: ["ac3", "dts"], maxChannels: 8 } }));
    expect(p.spdif).toBe("ac3,dts");
    expect(p.channels).toBe("7.1,5.1,stereo");
  });

  it("an unplugged HDMI broadcast counts for nothing", () => {
    const p = plan("unplugged", android({ sdk: 25, hdmiPlug: { plugged: false, encodings: ["ac3"], maxChannels: 8 } }));
    expect(p.spdif).toBe("");
    expect(p.channels).toBe("auto-safe");
    expect(p.reason).toContain("source=no-hdmi-sink");
  });

  it("no HDMI sink (stereo-only TV speakers): decode everything, mpv's default layout", () => {
    const p = plan("no-sink", android({ sdk: 28, devices: [{ type: "speaker", encodings: [], channelCounts: [2] }] }));
    expect(p.spdif).toBe("");
    expect(p.channels).toBe("auto-safe");
  });

  it("an ARC sink declaring stereo only gets DD passthrough and stereo PCM", () => {
    const p = plan("arc", android({ sdk: 28, devices: [hdmi(["pcm", "ac3"], [2], "hdmi_arc")] }));
    expect(p.spdif).toBe("ac3");
    expect(p.channels).toBe("stereo");
  });

  it("passthrough is ever only the formats mpv's audiotrack output can carry", () => {
    const p = plan("all-direct", android({ sdk: 34, direct: ["ac3", "eac3", "dts", "dts_hd", "truehd"] }));
    log("allowed", ANDROID_PASSTHROUGH_FORMATS);
    expect(p.spdif.split(",")).toEqual([...ANDROID_PASSTHROUGH_FORMATS]);
  });
});

describe("planTvAudioOutput, Apple TV", () => {
  it("an 8-channel route asks the session for 8 and lets mpv pick up to 7.1, no passthrough", () => {
    const p = plan("tvos-8", { platform: "tvos", maxOutputChannels: 8, outputPorts: ["HDMIOutput"] });
    expect(p).toMatchObject({ spdif: "", channels: "7.1,5.1,stereo", preferredOutputChannels: 8 });
    expect(p.reason).toContain("passthrough=unavailable");
  });

  it("a 6-channel route: 5.1", () => {
    const p = plan("tvos-6", { platform: "tvos", maxOutputChannels: 6, outputPorts: ["HDMIOutput"] });
    expect(p).toMatchObject({ channels: "5.1,stereo", preferredOutputChannels: 6 });
  });

  it("a stereo route stays stereo", () => {
    const p = plan("tvos-2", { platform: "tvos", maxOutputChannels: 2, outputPorts: ["HDMIOutput"] });
    expect(p).toMatchObject({ spdif: "", channels: "stereo", preferredOutputChannels: 2 });
  });

  it("more than 8 reported channels are capped at 8", () => {
    const p = plan("tvos-16", { platform: "tvos", maxOutputChannels: 16, outputPorts: ["HDMIOutput"] });
    expect(p.preferredOutputChannels).toBe(8);
  });
});

describe("configureTvAudioOutput", () => {
  it("reads, plans and applies once", async () => {
    log("configure: phase", "start");
    const report: TvAudioReport = android({ sdk: 30, direct: ["ac3", "eac3", "dts"], devices: [hdmi(["ac3"], [8])] });
    const native = {
      getAudioOutputReport: vi.fn(async () => report),
      setAudioOutput: vi.fn(async () => true),
    };
    const result = await configureTvAudioOutput(native);
    log("configure: calls", native.setAudioOutput.mock.calls);
    expect(native.setAudioOutput).toHaveBeenCalledTimes(1);
    expect(native.setAudioOutput.mock.calls[0]?.slice(0, 3)).toEqual(["ac3,eac3,dts", "7.1,5.1,stereo", 0]);
    expect(result?.spdif).toBe("ac3,eac3,dts");
  });

  it("passes the tvOS preferred channel count", async () => {
    const native = {
      getAudioOutputReport: vi.fn(async (): Promise<TvAudioReport> => ({ platform: "tvos", maxOutputChannels: 8, outputPorts: ["HDMIOutput"] })),
      setAudioOutput: vi.fn<Parameters<typeof configureTvAudioOutput>[0]["setAudioOutput"]>(async () => true),
    };
    await configureTvAudioOutput(native);
    log("configure-tvos: calls", native.setAudioOutput.mock.calls);
    expect(native.setAudioOutput.mock.calls[0]?.[2]).toBe(8);
  });

  it("a failed native read keeps mpv's defaults and never throws", async () => {
    const native = {
      getAudioOutputReport: vi.fn(async (): Promise<TvAudioReport> => {
        throw new Error("no module");
      }),
      setAudioOutput: vi.fn(async () => true),
    };
    const result = await configureTvAudioOutput(native);
    log("configure-fail: result", result);
    expect(result).toBeNull();
    expect(native.setAudioOutput).not.toHaveBeenCalled();
  });
});
