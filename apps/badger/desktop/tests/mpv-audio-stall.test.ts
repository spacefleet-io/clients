/**
 * @req MPV-AUDIO-01[badger-desktop]
 *
 * Frozen audio clock (`src/main/mpvAudioStall.ts`). On 2026-10-31 a pair of Bluetooth headphones refused audio
 * (`org.bluez.Error.NotAuthorized`): mpv keeps time from the audio, so `audio-pts` stopped and the picture froze while
 * the player was unpaused, not buffering and not seeking. The watcher sees that state, drops to no sound so the video
 * keeps playing, tells the OSC (`sf-audio-stall`) and logs the audio output and device mpv reports; the notice's
 * "Retry with sound" (or a change in the audio outputs) brings the audio track back.
 *
 * The property stream below mirrors what a real stalled sink pushes (measured 2026-11-02 with the bundled mpv 0.41
 * and `--ao=null --ao-null-speed=0`: pause=false, paused-for-cache=false, seeking=false, core-idle=false, time-pos and
 * audio-pts frozen; `aid=no` restarts the picture, `aid=1` re-opens the output).
 */
import { describe, expect, it } from "vitest";
import { buildExternalMpvArgs } from "@space/mpv";
import type { AudioStallPayload } from "@space/mpv-protocol";
import {
  AUDIO_STALL_MS,
  AUDIO_STALL_PROPERTIES,
  createMpvAudioStallWatch,
  type MpvAudioStallWatch,
  requestsNullAo,
} from "../src/main/mpvAudioStall";

const TAG = "[mpv-audio-stall]";

type LogLine = { level: "info" | "warn"; obj: Record<string, unknown>; msg: string };

const harness = (options: { intentionalNullAo?: boolean } = {}) => {
  let clock = 1_000;
  const aidSets: unknown[] = [];
  let aoReloads = 0;
  const notices: AudioStallPayload[] = [];
  const logs: LogLine[] = [];
  const watch: MpvAudioStallWatch = createMpvAudioStallWatch({
    intentionalNullAo: options.intentionalNullAo ?? false,
    reloadAo: async () => {
      aoReloads += 1;
      console.info(`${TAG} t=${clock} ao-reload`);
    },
    now: () => clock,
    setAid: async (value) => {
      aidSets.push(value);
      console.info(`${TAG} t=${clock} set aid=${String(value)}`);
    },
    notify: (payload) => {
      notices.push(payload);
      console.info(`${TAG} t=${clock} notify ${JSON.stringify(payload)}`);
    },
    log: {
      info: (obj, msg) => {
        logs.push({ level: "info", obj, msg });
        console.info(`${TAG} t=${clock} log.info ${msg} ${JSON.stringify(obj)}`);
      },
      warn: (obj, msg) => {
        logs.push({ level: "warn", obj, msg });
        console.info(`${TAG} t=${clock} log.warn ${msg} ${JSON.stringify(obj)}`);
      },
    },
  });
  const set = (name: (typeof AUDIO_STALL_PROPERTIES)[number], value: unknown) => {
    console.info(`${TAG} t=${clock} prop ${name}=${JSON.stringify(value)}`);
    watch.onProperty(name, value);
  };
  /** Advance wall time in 500 ms ticks (the production tick), moving audio-pts with it while `playing()` says so. */
  const advance = (ms: number, playing: () => boolean = () => false) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      clock += 500;
      if (playing()) {
        const pts = (watch.snapshot().props["audio-pts"] as number) + 0.5;
        set("audio-pts", pts);
        set("time-pos", pts);
      }
      watch.tick();
    }
  };
  /** A loaded, playing file with audio on the device "bluez_output.AC_80_0A" through PipeWire. */
  const playing = () => {
    set("current-ao", "pipewire");
    set("audio-device", "pipewire/bluez_output.AC_80_0A");
    set("audio-device-list", [
      { name: "auto", description: "Autoselect device" },
      { name: "pipewire/bluez_output.AC_80_0A", description: "WH-1000XM4" },
    ]);
    set("aid", 1);
    set("pause", false);
    set("paused-for-cache", false);
    set("seeking", false);
    set("audio-pts", 10);
    set("time-pos", 10);
  };
  /** {@link playing}, with the sound fallen on mpv's null output: the clock moves, nothing is heard. */
  const noOutput = () => {
    playing();
    set("current-ao", "null");
  };
  const dump = (label: string) =>
    console.info(`${TAG} ${label} snapshot=${JSON.stringify(watch.snapshot())} aidSets=${JSON.stringify(aidSets)} notices=${JSON.stringify(notices)}`);
  return { watch, set, advance, playing, noOutput, aidSets, aoReloads: () => aoReloads, notices, logs, dump, now: () => clock };
};

describe("mpv audio stall watch (MPV-AUDIO-01)", () => {
  it("watches the properties it needs", () => {
    expect([...AUDIO_STALL_PROPERTIES].sort()).toEqual(
      ["aid", "audio-device", "audio-device-list", "audio-pts", "current-ao", "pause", "paused-for-cache", "seeking", "time-pos"].sort(),
    );
    expect(AUDIO_STALL_MS).toBe(3_000);
  });

  it("a frozen audio clock while playing drops to no sound, shows the notice and logs the output and device", () => {
    const h = harness();
    h.playing();
    h.advance(2_500);
    h.dump("after 2.5 s frozen");
    expect(h.aidSets, "not before the threshold").toEqual([]);
    expect(h.notices).toEqual([]);
    h.advance(500);
    h.dump("after 3 s frozen");
    expect(h.aidSets).toEqual(["no"]);
    expect(h.notices).toEqual([{ state: "stalled", output: "pipewire", device: "WH-1000XM4 (pipewire/bluez_output.AC_80_0A)" }]);
    const warn = h.logs.find((line) => line.level === "warn");
    expect(warn?.msg).toContain("audio clock frozen");
    expect(warn?.obj).toMatchObject({
      output: "pipewire",
      device: "WH-1000XM4 (pipewire/bluez_output.AC_80_0A)",
      audioPts: 10,
      timePos: 10,
      stalledMs: 3_000,
      aid: 1,
    });
    expect(h.watch.snapshot().mode).toBe("fallback");
    // Playing on without sound: mpv drops the audio output, the picture moves again; no second fallback.
    h.set("aid", false);
    h.set("current-ao", null);
    h.set("audio-pts", null);
    h.advance(10_000);
    expect(h.aidSets).toEqual(["no"]);
    expect(h.notices).toHaveLength(1);
  });

  it("a healthy audio clock never triggers", () => {
    const h = harness();
    h.playing();
    h.advance(30_000, () => true);
    h.dump("30 s healthy");
    expect(h.aidSets).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("a plain pause does not trigger, and resuming starts a fresh window", () => {
    const h = harness();
    h.playing();
    h.advance(1_000, () => true);
    h.set("pause", true);
    h.advance(20_000);
    h.dump("20 s paused");
    expect(h.aidSets).toEqual([]);
    h.set("pause", false);
    h.advance(2_500);
    expect(h.aidSets, "resume is a fresh window, not 22 s frozen").toEqual([]);
    h.advance(10_000, () => true);
    expect(h.aidSets).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("buffering (paused-for-cache) does not trigger", () => {
    const h = harness();
    h.playing();
    h.advance(1_000, () => true);
    h.set("paused-for-cache", true);
    h.advance(20_000);
    h.dump("20 s buffering");
    h.set("paused-for-cache", false);
    h.advance(10_000, () => true);
    expect(h.aidSets).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("a seek (and the initial load, which mpv reports as seeking) does not trigger", () => {
    const h = harness();
    h.playing();
    h.set("seeking", true);
    h.advance(20_000);
    h.dump("20 s seeking");
    h.set("seeking", false);
    h.advance(2_500);
    expect(h.aidSets).toEqual([]);
    h.advance(10_000, () => true);
    expect(h.aidSets).toEqual([]);
    // Before the file loaded: seeking is unavailable (null), audio-pts unavailable.
    const fresh = harness();
    fresh.set("pause", false);
    fresh.set("current-ao", "pipewire");
    fresh.advance(20_000);
    expect(fresh.aidSets).toEqual([]);
    expect(fresh.notices).toEqual([]);
  });

  it("a file without audio (no audio output) does not trigger", () => {
    const h = harness();
    h.playing();
    h.set("aid", false);
    h.set("current-ao", null);
    h.set("audio-pts", null);
    h.advance(20_000);
    expect(h.aidSets).toEqual([]);
  });

  it("Retry with sound restores the audio track; a moving clock afterwards logs that the sound is back", () => {
    const h = harness();
    h.playing();
    h.advance(3_000);
    expect(h.aidSets).toEqual(["no"]);
    h.set("aid", false);
    h.set("current-ao", null);
    h.set("audio-pts", null);
    h.advance(5_000);
    h.watch.retry("user");
    h.dump("after retry");
    expect(h.aidSets).toEqual(["no", 1]);
    expect(h.notices.at(-1)).toEqual({ state: "cleared" });
    expect(h.watch.snapshot().mode).toBe("watching");
    h.set("aid", 1);
    h.set("current-ao", "pipewire");
    h.set("audio-pts", 18);
    h.advance(5_000, () => true);
    expect(h.aidSets, "healthy after retry: no new fallback").toEqual(["no", 1]);
    expect(h.logs.some((line) => line.level === "info" && line.msg.includes("sound back"))).toBe(true);
  });

  it("Retry while the device is still dead falls back again after the threshold", () => {
    const h = harness();
    h.playing();
    h.advance(3_000);
    h.set("aid", false);
    h.set("current-ao", null);
    h.set("audio-pts", null);
    h.watch.retry("user");
    h.set("aid", 1);
    h.set("current-ao", "pipewire");
    h.set("audio-pts", 13);
    h.advance(3_000);
    h.dump("retry on a dead device");
    expect(h.aidSets).toEqual(["no", 1, "no"]);
    expect(h.notices.map((notice) => notice.state)).toEqual(["stalled", "cleared", "stalled"]);
  });

  it("a change in the audio outputs while falling back retries with sound by itself", () => {
    const h = harness();
    h.playing();
    h.advance(3_000);
    h.set("aid", false);
    h.set("current-ao", null);
    h.set("audio-pts", null);
    h.set("audio-device-list", [{ name: "auto", description: "Autoselect device" }, { name: "pipewire/alsa_output.pci", description: "Speakers" }]);
    h.dump("after output change");
    expect(h.aidSets).toEqual(["no", 1]);
    expect(h.notices.at(-1)).toEqual({ state: "cleared" });
  });

  it("the user picking an audio track while falling back ends the fallback without a retry command", () => {
    const h = harness();
    h.playing();
    h.advance(3_000);
    h.set("aid", false);
    h.set("current-ao", null);
    h.set("audio-pts", null);
    h.set("aid", 2);
    expect(h.aidSets).toEqual(["no"]);
    expect(h.notices.at(-1)).toEqual({ state: "cleared" });
    expect(h.watch.snapshot().mode).toBe("watching");
  });

  it("retry outside a fallback does nothing", () => {
    const h = harness();
    h.playing();
    h.watch.retry("user");
    expect(h.aidSets).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("an unknown audio track id is restored as auto", () => {
    const h = harness();
    h.playing();
    h.set("aid", "auto");
    h.advance(3_000);
    h.watch.retry("user");
    expect(h.aidSets).toEqual(["no", "auto"]);
  });
});

/**
 * @req MPV-AUDIO-02[badger-desktop]
 * @bugfix pc-no-sound-output-silently-dropped
 *
 * 2026-11-16, a user: a movie played without sound on their Windows PC (fine on their phone). When mpv cannot open
 * the sound output at load (Windows default device gone, held exclusively, audio service hiccup), it drops the audio
 * track: `current-ao` unavailable, `aid=false`, no `audio-pts`, the video plays silently and nothing says so (reproduced
 * with mpv 0.41 and a sound server that does not answer: "Could not open/initialize audio device -> no sound.").
 * With `--audio-fallback-to-null=yes` mpv keeps the track on its `null` output instead (`current-ao="null"`, `aid=1`,
 * `audio-pts` moving) and `ao-reload` reopens the real output once it answers (measured the same day).
 */
describe("mpv sound output that cannot be opened (MPV-AUDIO-02)", () => {
  it("@bugfix playing on the null output (no sound output could be opened) shows the notice and logs it, at once", () => {
    const h = harness();
    h.noOutput();
    h.advance(500, () => true);
    h.dump("null output");
    expect(h.notices).toEqual([{ state: "stalled", reason: "no-output", output: "null", device: "WH-1000XM4 (pipewire/bluez_output.AC_80_0A)" }]);
    const warn = h.logs.filter((line) => line.level === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0]!.msg).toContain("[sf-audio-stall] no sound output could be opened");
    expect(h.aidSets, "the track stays on: mpv keeps the clock on the null output").toEqual([]);
    h.advance(5_000, () => true);
    expect(h.notices, "one notice, not one per tick").toHaveLength(1);
  });

  it("@bugfix a change in the outputs or Retry with sound reopens the output (ao-reload); a still-dead output shows the notice again", () => {
    const h = harness();
    h.noOutput();
    h.advance(500, () => true);
    h.set("audio-device-list", [{ name: "auto", description: "Autoselect device" }]);
    h.dump("after device change");
    expect(h.aoReloads()).toBe(1);
    expect(h.notices.at(-1)).toEqual({ state: "cleared" });
    // ao-reload on a still-dead output: current-ao goes away, then back to "null".
    h.set("current-ao", undefined);
    h.set("current-ao", "null");
    h.advance(AUDIO_STALL_MS, () => true);
    expect(h.notices.filter((n) => n.state === "stalled")).toHaveLength(2);
    h.watch.retry("user");
    expect(h.aoReloads()).toBe(2);
    // The output answers this time.
    h.set("current-ao", "wasapi");
    h.advance(AUDIO_STALL_MS + 500, () => true);
    h.dump("after sound back");
    expect(h.notices.filter((n) => n.state === "stalled")).toHaveLength(2);
    expect(h.logs.some((line) => line.msg.includes("sound back"))).toBe(true);
    expect(h.aidSets).toEqual([]);
  });

  it("an output the user's sound comes back on by itself clears the notice", () => {
    const h = harness();
    h.noOutput();
    h.advance(500, () => true);
    h.set("current-ao", "wasapi");
    expect(h.notices.at(-1)).toEqual({ state: "cleared" });
  });

  it("a null output asked for on purpose (SF_SILENT, --ao=null) is not a missing output", () => {
    const h = harness({ intentionalNullAo: true });
    h.noOutput();
    h.advance(5_000, () => true);
    expect(h.notices).toEqual([]);
    expect(h.logs.filter((line) => line.level === "warn")).toEqual([]);
  });

  it("requestsNullAo reads the last --ao the launch passes", () => {
    expect(requestsNullAo(["--ao=pulse", "--mute=yes", "--ao=null"])).toBe(true);
    expect(requestsNullAo(["--ao=null", "--ao=wasapi"])).toBe(false);
    expect(requestsNullAo(["--vo=gpu"])).toBe(false);
  });

  it("@bugfix the launch args keep the audio track on a null output when the real one cannot open", () => {
    const args: string[] = buildExternalMpvArgs({ url: "http://127.0.0.1:3000/playback/hls/test/master.m3u8" });
    console.info(`${TAG} audio args ${JSON.stringify(args.filter((arg) => arg.startsWith("--audio")))}`);
    expect(args).toContain("--audio-fallback-to-null=yes");
  });
});
