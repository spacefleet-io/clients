/**
 * @test-id MOBILE-PLAYBACK-QUALITY-SWITCH-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * A quality switch (Auto or manual) always completes and resumes at the spot the viewer was at (PLAY-ABR-04). Mirrors the
 * desktop proofs `abr-reload-pos-zero`, `abr-switch-keeps-pending-start` and `abr-switch-always-completes`: before the
 * first frame, or while a seek is in flight, mpv still reports position 0 (or the old position), so the switch must keep
 * the pending start target instead of reloading from there. A switch that never settles is retried; picks made during a
 * switch are queued; the machine always ends idle.
 *
 * Every scenario runs the production state machine against a fake player and a fake clock, and logs each load it sends.
 */
import { describe, expect, it } from "vitest";
import type { MpvTrack, PlaybackSnapshot, SubtitleTrack } from "@space/mobile-mpv-playback";
import {
  PENDING_START_ABANDON_AFTER_MS,
  PendingStart,
  QualitySwitchMachine,
  SWITCH_MAX_ATTEMPTS,
  SWITCH_SETTLE_TIMEOUT_MS,
  type SwitchRequestOutcome,
  type SwitchResult,
} from "../src/lib/playback/qualitySwitch";

const LOG = "[quality-switch]";
const C002_START = 39.54234508;
const PLAY_URL = "http://127.0.0.1:40547/playback/hls/4bb5b7c2/master.m3u8";

const snap = (over: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
  sampledAtMs: 0, position: 0, duration: 100, paused: false, cacheEnd: 0, cacheDuration: 0, cacheSpeed: 0, eof: false,
  pausedForCache: false, seeking: false, idle: false, coreIdle: false, voConfigured: true, hwdec: "mediacodec",
  currentVo: "gpu", videoCodec: "h264", frameDrops: 0, decoderFrameDrops: 0, avsync: 0, netBps: 0, cacheSecs: 30, demuxerMaxBytes: 33554432, vid: 1, aid: 1, sid: 0, videoWidth: 1920, videoHeight: 804,
  ...over,
});

type Load = { url: string; startSeconds: number; options: string };

/** Fake mpv: `onLoad` decides what the player reports after each `loadfile` (the clock only moves through `sleep`). */
class Harness {
  nowMs = 1_000_000;
  playing: PlaybackSnapshot = snap({ voConfigured: false, idle: false, position: 0 });
  tracks: MpvTrack[] = [];
  loads: Load[] = [];
  seeks: number[] = [];
  results: SwitchResult[] = [];
  queuedApplied: string[] = [];
  /** The switches the queued picks started, so a test can wait for them to end. */
  queuedRuns: Promise<SwitchRequestOutcome>[] = [];
  loadRejects = 0;
  /** What the player reports after load number `n` (1-based); default = a healthy file at the requested start. */
  afterLoad: (n: number, load: Load) => PlaybackSnapshot = (_n, load) => snap({ position: load.startSeconds, paused: load.options.includes("pause=yes") });
  alive = true;
  /** Runs while a `loadfile` is in flight (the viewer acts during the reload). */
  duringLoad: (() => void) | null = null;
  /** Awaited inside the next `loadfile` (then cleared): holds that reload in flight until the test resolves it. */
  holdLoad: Promise<void> | null = null;
  /** Runs on settle poll number `n` (1-based), before the player's state is read (the viewer acts while the switch waits). */
  onPoll: ((n: number) => void) | null = null;
  polls = 0;
  /** The library's subtitle list the switch matches the active sidecar against. */
  subtitleTracks: SubtitleTrack[] = [];
  /** Every sidecar the switch re-added after a reload. */
  restored: Array<{ url: string; id: string }> = [];

  readonly machine = new QualitySwitchMachine(
    {
      readPlayback: async () => ({ snapshot: this.playing, tracks: this.tracks }),
      readSnapshot: async () => {
        this.polls += 1;
        this.onPoll?.(this.polls);
        return this.playing;
      },
      load: async (url, startSeconds, options) => {
        const load = { url, startSeconds, options };
        this.loads.push(load);
        console.info(`${LOG} load #${this.loads.length} start=${startSeconds} options="${options}" url=${url}`);
        if (this.loadRejects > 0) {
          this.loadRejects -= 1;
          throw new Error("loadfile rejected");
        }
        this.duringLoad?.();
        this.duringLoad = null;
        const hold = this.holdLoad;
        this.holdLoad = null;
        if (hold) await hold;
        this.playing = this.afterLoad(this.loads.length, load);
      },
      seek: async (seconds) => {
        this.seeks.push(seconds);
      },
      restoreSidecar: async (url, sidecar) => {
        this.restored.push({ url, id: sidecar.id });
      },
      sleep: async (ms) => {
        this.nowMs += ms;
        // A healthy player's position advances while we wait.
        if (this.playing.voConfigured && !this.playing.paused && !this.playing.seeking) this.playing = { ...this.playing, position: this.playing.position + ms / 1000 };
      },
      now: () => this.nowMs,
      alive: () => this.alive,
      log: (event, data) => console.info(`${LOG} ${event} ${JSON.stringify(data)}`),
    },
    () => ({ playUrl: PLAY_URL, subtitleTracks: this.subtitleTracks }),
    {
      onSettled: (result) => {
        this.results.push(result);
        console.info(`${LOG} settled ${JSON.stringify(result)}`);
      },
      onQueuedPick: (targetId) => {
        this.queuedApplied.push(targetId);
        this.queuedRuns.push(this.machine.request(targetId, "manual"));
      },
    },
  );
}

describe("pending start target", () => {
  it("holds the requested start until a sample reaches it", () => {
    const pending = new PendingStart();
    expect(pending.arm(C002_START)).toBe(C002_START);
    const verdicts = [0, 0, 0].map((position, i) => pending.observe(position, i * 250));
    console.info(`${LOG} pre-seek verdicts=${verdicts.join(",")} pending=${pending.get()}`);
    expect(verdicts).toEqual(["pending", "pending", "pending"]);
    expect(pending.get()).toBe(C002_START);
    expect(pending.observe(39.6, 1000)).toBe("reached");
    expect(pending.get()).toBeNull();
    expect(pending.observe(40, 1250)).toBe("none");
  });

  it("a start at zero carries nothing to protect", () => {
    const pending = new PendingStart();
    expect(pending.arm(0)).toBeNull();
    expect(pending.arm(0.2)).toBeNull();
    expect(pending.observe(5, 0)).toBe("none");
  });

  it("the old file's position cannot reach a target whose load is still in flight (desktop c061)", () => {
    const pending = new PendingStart();
    pending.armForLoad(8.979313);
    expect(pending.observe(8.979313, 0)).toBe("pending");
    pending.loadLanded();
    expect(pending.observe(0, 2000)).toBe("pending");
    expect(pending.observe(9, 4000)).toBe("reached");
  });

  it("abandons the target when mpv keeps advancing elsewhere, but never while it just stalls", () => {
    const advancing = new PendingStart();
    advancing.arm(600);
    let verdict = advancing.observe(0, 0);
    let now = 0;
    let t = 0;
    while (verdict === "pending" && now < PENDING_START_ABANDON_AFTER_MS * 2) {
      now += 250;
      t += 0.25;
      verdict = advancing.observe(t, now);
    }
    console.info(`${LOG} abandon verdict=${verdict} afterMs=${now}`);
    expect(verdict).toBe("abandoned");
    expect(advancing.get()).toBeNull();

    const stalled = new PendingStart();
    stalled.arm(600);
    for (let at = 0; at <= 120_000; at += 250) expect(stalled.observe(0, at)).toBe("pending");
    expect(stalled.get()).toBe(600);
  });
});

/** @req PLAY-ABR-04[badger-mobile] */
describe("quality switch machine: resumes at the same spot", () => {
  it("a pick before the first frame reloads at the pending start, not 0:00 (desktop c002)", async () => {
    const h = new Harness();
    h.machine.armStart(C002_START);
    // Until mpv's start seek lands it reports time-pos 0 and voConfigured false.
    h.playing = snap({ voConfigured: false, position: 0 });
    h.machine.observe(h.playing, h.nowMs);
    await h.machine.request("720p", "manual");
    console.info(`${LOG} loads=${JSON.stringify(h.loads)}`);
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0]!.startSeconds).toBe(C002_START);
    expect(h.loads[0]!.url).toBe("http://127.0.0.1:40547/playback/hls/4bb5b7c2/master-720p.m3u8");
    expect(h.results[0]).toMatchObject({ targetId: "720p", settled: true, startSeconds: C002_START });
    expect(h.machine.switching).toBe(false);
  });

  it("a pick while a seek is in flight reloads at the seek target, not the stale polled position", async () => {
    const h = new Harness();
    h.playing = snap({ position: 12.3 });
    h.machine.noteSeek(600);
    // The seek has not landed: mpv still reports the old position.
    await h.machine.request("480p", "manual");
    expect(h.loads[0]!.startSeconds).toBe(600);
  });

  it("a seek that already landed no longer pins the position", async () => {
    const h = new Harness();
    h.machine.noteSeek(600);
    h.machine.observe(snap({ position: 600.4 }), h.nowMs);
    h.playing = snap({ position: 640 });
    await h.machine.request("480p", "manual");
    expect(h.loads[0]!.startSeconds).toBe(640);
  });

  it("with no pending start the switch resumes at mpv's fresh position and keeps the pause state", async () => {
    const h = new Harness();
    h.playing = snap({ position: 123.4, paused: true });
    await h.machine.request("480p", "abr-downshift");
    expect(h.loads[0]).toMatchObject({ startSeconds: 123.4 });
    expect(h.loads[0]!.options).toContain("pause=yes");
  });

  it("a switch that never settles is retried at the same start (stalled file reports 0, desktop c061)", async () => {
    const h = new Harness();
    h.machine.armStart(C002_START);
    h.playing = snap({ voConfigured: false });
    // First load: the new file sits at 0, seeking, no frame. Second load: healthy.
    h.afterLoad = (n, load) => (n === 1 ? snap({ voConfigured: false, seeking: true, position: 0 }) : snap({ position: load.startSeconds }));
    await h.machine.request("360p", "abr-downshift");
    console.info(`${LOG} retry loads=${JSON.stringify(h.loads.map((l) => l.startSeconds))} results=${JSON.stringify(h.results)}`);
    expect(h.loads.map((l) => l.startSeconds)).toEqual([C002_START, C002_START]);
    expect(h.results[0]).toMatchObject({ settled: true, attempts: 2 });
    expect(h.machine.switching).toBe(false);
  });

  it("a rejected loadfile is retried too", async () => {
    const h = new Harness();
    h.playing = snap({ position: 50 });
    h.loadRejects = 1;
    await h.machine.request("360p", "manual");
    expect(h.loads.map((l) => l.startSeconds)).toEqual([50, 50]);
    expect(h.results[0]).toMatchObject({ settled: true, attempts: 2 });
  });

  it("gives up after the attempt budget but still completes: idle, result reported, no unbounded loop", async () => {
    const h = new Harness();
    h.playing = snap({ position: 50 });
    h.afterLoad = () => snap({ idle: true, voConfigured: false });
    const before = h.nowMs;
    await h.machine.request("360p", "manual");
    console.info(`${LOG} exhausted loads=${h.loads.length} elapsedMs=${h.nowMs - before}`);
    expect(h.loads).toHaveLength(SWITCH_MAX_ATTEMPTS);
    expect(h.results[0]).toMatchObject({ settled: false, attempts: SWITCH_MAX_ATTEMPTS });
    expect(h.nowMs - before).toBeLessThanOrEqual(SWITCH_MAX_ATTEMPTS * (SWITCH_SETTLE_TIMEOUT_MS + 2_000));
    expect(h.machine.switching).toBe(false);
  });

  it("a seek made while the reload is in flight is re-applied once it landed, never lost", async () => {
    const h = new Harness();
    h.playing = snap({ position: 20 });
    h.duringLoad = () => h.machine.noteSeek(900);
    await h.machine.request("480p", "manual");
    console.info(`${LOG} seek during switch: loads=${JSON.stringify(h.loads.map((l) => l.startSeconds))} seeks=${JSON.stringify(h.seeks)}`);
    expect(h.loads[0]!.startSeconds).toBe(20);
    expect(h.seeks).toEqual([900]);
    expect(h.machine.pendingStart.get()).toBe(900);
  });

  /** @req PLAY-TRACK-03[badger-mobile,badger-tv] */
  it("reads the tracks fresh at switch time: a track pick made since the last poll is what the reload keeps", async () => {
    const h = new Harness();
    // The last 0.5-1 Hz poll the machine observed still says audio 1 + subtitle 3; mpv itself (the fresh read the
    // machine makes at switch time) says audio 2 + subtitles Off: the viewer picked them after that poll.
    h.machine.observe(snap({ position: 69, aid: 1, sid: 3 }), h.nowMs);
    h.playing = snap({ position: 70, aid: 2, sid: 0 });
    await h.machine.request("480p", "manual");
    console.info(`${LOG} fresh tracks: options="${h.loads[0]!.options}"`);
    expect(h.loads[0]!.options).toBe("aid=2,sid=no");
  });

  it("the machine never touches the player after the screen unmounted", async () => {
    const h = new Harness();
    h.alive = false;
    await h.machine.request("360p", "manual");
    expect(h.loads).toHaveLength(0);
    expect(h.machine.switching).toBe(false);
  });

  it("cancel (Retry, or a playback failure) ends the running switch at once: no more loads, no settle report, no queued pick", async () => {
    const h = new Harness();
    h.playing = snap({ position: 50 });
    h.afterLoad = () => snap({ idle: true, voConfigured: false });
    let switchingAfterCancel: boolean | null = null;
    h.onPoll = (n) => {
      if (n !== 3) return;
      h.machine.cancel();
      switchingAfterCancel = h.machine.switching;
    };
    const first = h.machine.request("360p", "manual");
    expect(await h.machine.request("480p", "manual")).toBe("queued");
    await first;
    console.info(`${LOG} cancelled: loads=${h.loads.length} polls=${h.polls} switchingAfterCancel=${switchingAfterCancel} results=${JSON.stringify(h.results)} queued=${JSON.stringify(h.queuedApplied)}`);
    expect(switchingAfterCancel).toBe(false);
    expect(h.loads).toHaveLength(1);
    expect(h.polls).toBe(3);
    expect(h.results).toEqual([]);
    expect(h.queuedApplied).toEqual([]);
    expect(h.machine.switching).toBe(false);
  });

  it("a switch started after a cancel is not ended by the cancelled one finishing", async () => {
    const h = new Harness();
    h.playing = snap({ position: 50 });
    h.afterLoad = (n, load) => (n === 1 ? snap({ idle: true, voConfigured: false }) : snap({ position: load.startSeconds }));
    let release = (): void => undefined;
    let second: Promise<SwitchRequestOutcome> | null = null;
    h.onPoll = (n) => {
      if (n !== 2) return;
      h.machine.cancel();
      h.holdLoad = new Promise<void>((done) => {
        release = done;
      });
      second = h.machine.request("720p", "manual");
    };
    const first = h.machine.request("360p", "manual");
    await first;
    const switchingWhileSecondLoads = h.machine.switching;
    release();
    await second;
    console.info(`${LOG} cancel then new switch: switchingWhileSecondLoads=${switchingWhileSecondLoads} loads=${JSON.stringify(h.loads.map((l) => l.url.split("/").pop()))} results=${JSON.stringify(h.results)}`);
    expect(switchingWhileSecondLoads).toBe(true);
    expect(h.loads.map((l) => l.url.split("/").pop())).toEqual(["master-360p.m3u8", "master-720p.m3u8"]);
    expect(h.results.map((r) => [r.targetId, r.settled])).toEqual([["720p", true]]);
    expect(h.machine.switching).toBe(false);
  });
});

/** @req PLAY-ABR-04[badger-mobile] */
describe("quality switch machine: picks during a switch", () => {
  it("queues the picks, applies only the last one after the running switch settles, and ends idle", async () => {
    const h = new Harness();
    h.playing = snap({ position: 70 });
    const first = h.machine.request("720p", "manual");
    expect(h.machine.switching).toBe(true);
    expect(await h.machine.request("480p", "manual")).toBe("queued");
    expect(await h.machine.request("360p", "manual")).toBe("queued");
    await first;
    await Promise.all(h.queuedRuns);
    console.info(`${LOG} queued applied=${JSON.stringify(h.queuedApplied)} loads=${JSON.stringify(h.loads.map((l) => [l.url.split("/").pop(), l.startSeconds]))}`);
    expect(h.queuedApplied).toEqual(["360p"]);
    expect(h.loads.map((l) => l.url.split("/").pop())).toEqual(["master-720p.m3u8", "master-360p.m3u8"]);
    // The second reload resumes where the first one landed, never from 0.
    expect(h.loads[1]!.startSeconds).toBeGreaterThanOrEqual(70);
    expect(h.machine.switching).toBe(false);
  });

  it("a pick for the quality already being loaded is ignored; an automatic request during a switch is dropped", async () => {
    const h = new Harness();
    h.playing = snap({ position: 70 });
    const first = h.machine.request("720p", "manual");
    expect(await h.machine.request("720p", "manual")).toBe("ignored");
    expect(await h.machine.request("360p", "abr-downshift")).toBe("ignored");
    await first;
    expect(h.queuedRuns).toEqual([]);
    expect(h.loads).toHaveLength(1);
    expect(h.queuedApplied).toEqual([]);
  });

  it("re-picking the rung that is loading drops the queued pick: the last pick wins", async () => {
    const h = new Harness();
    h.playing = snap({ position: 70 });
    const first = h.machine.request("720p", "manual");
    expect(await h.machine.request("480p", "manual")).toBe("queued");
    expect(await h.machine.request("720p", "manual")).toBe("ignored");
    await first;
    expect(h.queuedRuns).toEqual([]);
    console.info(`${LOG} repick applied=${JSON.stringify(h.queuedApplied)} loads=${h.loads.length}`);
    expect(h.queuedApplied).toEqual([]);
    expect(h.loads.map((l) => l.url.split("/").pop())).toEqual(["master-720p.m3u8"]);
  });

  it("cancelQueued (Auto chosen, or the current rung re-picked, during a switch) drops the queued pick", async () => {
    const h = new Harness();
    h.playing = snap({ position: 70 });
    const first = h.machine.request("720p", "manual");
    expect(await h.machine.request("480p", "manual")).toBe("queued");
    h.machine.cancelQueued();
    await first;
    expect(h.queuedRuns).toEqual([]);
    expect(h.queuedApplied).toEqual([]);
    expect(h.loads).toHaveLength(1);
  });

  it("a seek right after the new rung landed, before its first stable sample, settles without a 15 s timeout or reload", async () => {
    const h = new Harness();
    h.playing = snap({ position: 20 });
    const before = h.nowMs;
    // The new file landed (400 ms later) but reports no stable frame yet; the viewer seeks then.
    h.afterLoad = () => snap({ voConfigured: false, position: 0 });
    h.onPoll = (n) => {
      if (n !== 2) return;
      h.machine.noteSeek(900);
      h.playing = snap({ position: 900 });
    };
    await h.machine.request("480p", "manual");
    console.info(`${LOG} seek-after-land loads=${h.loads.length} elapsedMs=${h.nowMs - before} results=${JSON.stringify(h.results)}`);
    expect(h.loads).toHaveLength(1);
    expect(h.results[0]).toMatchObject({ settled: true, attempts: 1 });
    // Not even the 10 s abandon window: the seek's target is what the attempt waits for.
    expect(h.nowMs - before).toBeLessThan(PENDING_START_ABANDON_AFTER_MS);
    expect(h.seeks).toEqual([]);
  });

  it("a queued pick still runs when the running switch exhausted its attempts", async () => {
    const h = new Harness();
    h.playing = snap({ position: 70 });
    h.afterLoad = (n, load) => (n <= SWITCH_MAX_ATTEMPTS ? snap({ idle: true, voConfigured: false }) : snap({ position: load.startSeconds }));
    const first = h.machine.request("720p", "manual");
    await h.machine.request("360p", "manual");
    await first;
    await Promise.all(h.queuedRuns);
    expect(h.results.map((r) => [r.targetId, r.settled])).toEqual([["720p", false], ["360p", true]]);
    expect(h.machine.switching).toBe(false);
  });
});

describe("quality switch machine: picture subtitles and their OCR twin (PLAY-TRACK-05)", () => {
  const pgs: SubtitleTrack = {
    id: "pgs-fr",
    language: "fr",
    label: "Français",
    isDefault: false,
    format: "pgs",
    encrypted: false,
    url: "subs-fr-pgs/fre.sup",
    ocrTwin: { id: "pgs-fr-ocr", url: "subs-fr-pgs/fre.ocr.srt" },
  };
  const activeSidecar: MpvTrack = { id: 3, type: "sub", selected: true, lang: "fr", title: "Français", external: true };

  // @req PLAY-TRACK-05
  it("re-adds the twin's SRT after the reload while direct rendering, the picture on the GPU path", async () => {
    for (const [currentVo, expectedKey] of [
      ["mediacodec_embed", "subs-fr-pgs%2Ffre.ocr.srt"],
      ["gpu", "subs-fr-pgs%2Ffre.sup"],
    ] as const) {
      const h = new Harness();
      h.subtitleTracks = [pgs];
      h.tracks = [activeSidecar];
      h.playing = snap({ position: 70, currentVo, sid: 3 });
      h.afterLoad = (_n, load) => snap({ position: load.startSeconds, currentVo });
      console.info(`${LOG} phase: switch with vo=${currentVo}`);
      await h.machine.request("480p", "manual");
      console.info(`${LOG} restored ${JSON.stringify(h.restored)}`);
      expect(h.results.at(-1)?.settled).toBe(true);
      expect(h.restored).toEqual([{ url: `http://127.0.0.1:40547/playback/object/${expectedKey}`, id: "pgs-fr" }]);
    }
  });
});
