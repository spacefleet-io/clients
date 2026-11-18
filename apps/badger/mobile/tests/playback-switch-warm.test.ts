/**
 * @test-id MOBILE-PLAYBACK-SWITCH-WARM-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Make-before-break quality switch (PLAY-ABR-04). OnePlus 6 test phone `abr-recovery` at 1000 kbit/s: Auto decided 1080p -> 420p at
 * 65.1 s with 23.3 s buffered, the reload dropped the 1080p picture at once and waited on the 2.3 MB 420p segment at
 * 62.6 s, which shared the link with the 1080p read-ahead still downloading (a 9.3 MB segment and the next); three
 * 15 s reload timeouts later the switch ended unsettled after 46.4 s and the first 420p frame came only once the throttle
 * lifted. Now the proxy fetches the new rung's segment while the old one plays on (the proxy drops the old rung's
 * downloads), and the switch reloads only once it is here: at the segment the fetch can reach before the playhead leaves it.
 *
 * Segment starts and sizes below are the 420p rung of that run (logcat `object.tunnel_and_decrypt`, `prefetch.batch`).
 */
import { describe, expect, it } from "vitest";
import type { MpvTrack, PlaybackSnapshot } from "@space/mobile-mpv-playback";
import type { VariantSegment } from "@space/playback-abr";
import { QualitySwitchMachine, SWITCH_SETTLE_TIMEOUT_MS, type SwitchResult } from "../src/lib/playback/qualitySwitch";
import { planSwitchWarm } from "../src/lib/playback/switchWarm";

const LOG = "[switch-warm]";
const PLAY_URL = "http://127.0.0.1:40547/playback/hls/3d9ef54e/master.m3u8";
const TARGET = "e7c67aa2-0536-4c71-bb48-ee3be3f6dac9";

/** 420p of the OnePlus 6 test phone run: 20.9 s segments of about 2.1-2.3 MB (a little under 1 Mbit/s of video). */
const RUNG_420P: VariantSegment[] = [
  { startSeconds: 0, sizeBytes: 1_436_020 },
  { startSeconds: 20.9, sizeBytes: 277_260 },
  { startSeconds: 41.7, sizeBytes: 666_222 },
  { startSeconds: 62.6, sizeBytes: 2_331_296 },
  { startSeconds: 83.4, sizeBytes: 2_021_841 },
  { startSeconds: 104.3, sizeBytes: 2_105_530 },
  { startSeconds: 125.1, sizeBytes: 2_278_716 },
];
/** The decision of that run: position 65.065, 23.3 s buffered, 0.99 Mbit/s measured. */
const DECISION = { positionSeconds: 65.065, bufferSeconds: 23.3, ewmaBps: 990_000 };

/** @req PLAY-ABR-04[badger-mobile] */
describe("which segment of the new rung to fetch first", () => {
  it("at 1 Mbit/s the segment at the position cannot arrive before the playhead leaves it: the next one, inside the buffer", () => {
    const plan = planSwitchWarm({ segments: RUNG_420P, ...DECISION, advancing: true });
    console.info(`${LOG} 1 Mbit/s plan ${JSON.stringify(plan)}`);
    // #3 (62.6-83.4, 2.3 MB) needs ~18.8 s: the playhead is at 83.9 by then. #4 (83.4, 2.0 MB, ~16.3 s) is here at ~81.4
    // and the 1080p buffer plays up to 88.4.
    expect(plan?.index).toBe(4);
    expect(plan?.startSeconds).toBe(83.4);
    expect(plan?.fetchSeconds).toBeCloseTo(16.34, 1);
  });

  it("on a fast link the segment at the position", () => {
    const plan = planSwitchWarm({ segments: RUNG_420P, ...DECISION, ewmaBps: 50_000_000, advancing: true });
    expect(plan?.index).toBe(3);
  });

  it("throughput unknown or paused: the segment at the position", () => {
    expect(planSwitchWarm({ segments: RUNG_420P, ...DECISION, ewmaBps: null, advancing: true })?.index).toBe(3);
    expect(planSwitchWarm({ segments: RUNG_420P, ...DECISION, advancing: false })?.index).toBe(3);
  });

  it("no later segment starts inside the buffer: the segment at the position (nothing better exists)", () => {
    const plan = planSwitchWarm({ segments: RUNG_420P, ...DECISION, bufferSeconds: 4, advancing: true });
    expect(plan?.index).toBe(3);
  });

  it("no segments known: no plan (the switch reloads straight away)", () => {
    expect(planSwitchWarm({ segments: [], ...DECISION, advancing: true })).toBeNull();
  });
});

const snap = (over: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
  sampledAtMs: 0, position: 0, duration: 13698, paused: false, cacheEnd: 0, cacheDuration: 0, cacheSpeed: 0, eof: false,
  pausedForCache: false, seeking: false, idle: false, coreIdle: false, voConfigured: true, hwdec: "mediacodec",
  currentVo: "gpu", videoCodec: "h264", frameDrops: 0, decoderFrameDrops: 0, avsync: 0, netBps: 0, cacheSecs: 30, demuxerMaxBytes: 33554432, vid: 1, aid: 1, sid: 0, videoWidth: 1920, videoHeight: 804,
  ...over,
});

type Load = { url: string; startSeconds: number; options: string; atMs: number; positionBefore: number };

/**
 * Fake mpv and proxy on a fake clock. The old rung plays (its position advances with the clock) until a load replaces it;
 * the warm resolves or rejects when the test says (`finishWarm`, from `onPoll`).
 */
class Harness {
  nowMs = 1_000_000;
  playing: PlaybackSnapshot;
  loads: Load[] = [];
  warms: Array<{ targetId: string; atSeconds: number; atMs: number }> = [];
  results: SwitchResult[] = [];
  logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  onPoll: ((h: Harness) => void) | null = null;
  ewmaBps: number | null = DECISION.ewmaBps;
  private settleWarm: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private readonly withWarm: boolean;
  readonly machine: QualitySwitchMachine;

  constructor(start: Partial<PlaybackSnapshot>, withWarm = true) {
    this.playing = snap(start);
    this.withWarm = withWarm;
    this.machine = this.createMachine();
  }

  finishWarm(error?: Error): void {
    const settle = this.settleWarm;
    this.settleWarm = null;
    if (!settle) return;
    if (error) settle.reject(error);
    else settle.resolve();
  }

  get warmPending(): boolean {
    return this.settleWarm !== null;
  }

  private createMachine(): QualitySwitchMachine {
    return new QualitySwitchMachine(
    {
      readPlayback: async () => ({ snapshot: this.playing, tracks: [] as MpvTrack[] }),
      readSnapshot: async () => {
        this.onPoll?.(this);
        return this.playing;
      },
      load: async (url, startSeconds, options) => {
        this.loads.push({ url, startSeconds, options, atMs: this.nowMs, positionBefore: this.playing.position });
        console.info(`${LOG} load #${this.loads.length} start=${startSeconds.toFixed(2)} (old rung at ${this.playing.position.toFixed(2)})`);
        this.playing = snap({ position: startSeconds, cacheDuration: 20, videoWidth: 1002, videoHeight: 420 });
      },
      seek: async () => undefined,
      restoreSidecar: async () => undefined,
      warm: this.withWarm
        ? (targetId, atSeconds) => {
            this.warms.push({ targetId, atSeconds, atMs: this.nowMs });
            console.info(`${LOG} warm ${targetId} at=${atSeconds.toFixed(2)}`);
            const { promise, resolve, reject } = Promise.withResolvers<void>();
            this.settleWarm = { resolve, reject };
            return promise;
          }
        : undefined,
      sleep: async (ms) => {
        this.nowMs += ms;
        if (this.playing.voConfigured && !this.playing.paused && !this.playing.seeking && !this.playing.pausedForCache) {
          this.playing = { ...this.playing, position: this.playing.position + ms / 1000 };
        }
      },
      now: () => this.nowMs,
      alive: () => true,
      log: (event, data) => {
        this.logs.push({ event, data });
        console.info(`${LOG} ${event} ${JSON.stringify(data)}`);
      },
    },
    () => ({
      playUrl: PLAY_URL,
      subtitleTracks: [],
      warmInputs: (targetId) => (targetId === TARGET ? { segments: RUNG_420P, ewmaBps: this.ewmaBps } : null),
    }),
    {
      onSettled: (result) => {
        this.results.push(result);
        console.info(`${LOG} settled ${JSON.stringify(result)}`);
      },
      onQueuedPick: () => undefined,
    },
    );
  }
}

const startOfDecision = { position: DECISION.positionSeconds, cacheDuration: DECISION.bufferSeconds };

/** @req PLAY-ABR-04[badger-mobile] */
describe("the switch keeps the old rung playing until the new one can show a frame", () => {
  it("1 Mbit/s: no reload while the 420p segment is on its way; one reload at its start, settled at the first attempt", async () => {
    const h = new Harness(startOfDecision);
    let warmedAtPosition: number | null = null;
    h.onPoll = (x) => {
      // The proxy has the segment ~16.3 s after the warm started (the fetch alone on the link).
      if (x.warmPending && x.nowMs - x.warms[0]!.atMs >= 16_300) {
        warmedAtPosition = x.playing.position;
        x.finishWarm();
      }
    };
    await h.machine.request(TARGET, "abr-downshift");

    expect(h.warms).toHaveLength(1);
    expect(h.warms[0]!.targetId).toBe(TARGET);
    // The segment at 83.4 (a hair inside it: the proxy's EXTINF sums and the metadata may differ by a rounding).
    expect(h.warms[0]!.atSeconds).toBeGreaterThan(83.4);
    expect(h.warms[0]!.atSeconds).toBeLessThan(83.6);
    expect(warmedAtPosition).not.toBeNull();
    expect(warmedAtPosition!).toBeLessThan(83.4);
    // One reload, only once the playhead got to the warmed segment: the 1080p picture played all the way there.
    expect(h.loads).toHaveLength(1);
    const load = h.loads[0]!;
    expect(load.url).toContain(`master-${TARGET}.m3u8`);
    expect(load.positionBefore).toBeGreaterThanOrEqual(83.4 - 0.6);
    expect(load.startSeconds).toBeGreaterThanOrEqual(83.4);
    expect(load.startSeconds - load.positionBefore).toBeLessThan(0.7);
    expect(h.results).toEqual([expect.objectContaining({ targetId: TARGET, settled: true, attempts: 1 })]);
    // The reload has lavf open one segment at a time: with its default (`http_multiple`) it opens the next segment
    // (104.3 s, not fetched) before reading the warmed one, and that open waits until the proxy has all of it.
    expect(load.options).toContain("demuxer-lavf-o-append=http_multiple=0");
    // Decision to reload: the playhead's own way to 83.4 (~18.4 s), far inside the harness' 95 s.
    expect(h.results[0]!.ms).toBeLessThan(20_000);
    expect(h.machine.switching).toBe(false);
  });

  it("a fast link warms the segment at the position and reloads there as soon as it is here", async () => {
    const h = new Harness(startOfDecision);
    h.ewmaBps = 50_000_000;
    h.onPoll = (x) => x.finishWarm();
    await h.machine.request(TARGET, "manual");
    expect(h.warms[0]!.atSeconds).toBeCloseTo(DECISION.positionSeconds, 5);
    expect(h.loads).toHaveLength(1);
    // Reloaded where the old rung was when the segment landed (one poll later), not at a segment start.
    expect(h.loads[0]!.startSeconds).toBeCloseTo(h.loads[0]!.positionBefore, 5);
    expect(h.loads[0]!.startSeconds - DECISION.positionSeconds).toBeLessThan(1);
    expect(h.results[0]).toEqual(expect.objectContaining({ settled: true, attempts: 1 }));
  });

  it("a failed warm reloads right away at the playing position", async () => {
    const h = new Harness(startOfDecision);
    h.onPoll = (x) => x.finishWarm(new Error("warm_failed"));
    await h.machine.request(TARGET, "abr-downshift");
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0]!.startSeconds).toBeCloseTo(h.loads[0]!.positionBefore, 5);
    expect(h.loads[0]!.startSeconds).toBeLessThan(DECISION.positionSeconds + 1);
    expect(h.logs.map((l) => l.event)).toContain("warm_failed");
    expect(h.loads[0]!.options).toContain("demuxer-lavf-o-append=http_multiple=0");
  });

  it("a warm that never lands: the switch reloads anyway once the playhead's way plus the settle timeout is spent", async () => {
    const h = new Harness(startOfDecision);
    await h.machine.request(TARGET, "abr-downshift");
    expect(h.loads).toHaveLength(1);
    const waited = h.loads[0]!.atMs - h.warms[0]!.atMs;
    expect(waited).toBeGreaterThanOrEqual((83.5 - DECISION.positionSeconds) * 1000 + SWITCH_SETTLE_TIMEOUT_MS - 400);
    expect(waited).toBeLessThanOrEqual((83.5 - DECISION.positionSeconds) * 1000 + SWITCH_SETTLE_TIMEOUT_MS + 400);
    expect(h.logs.map((l) => l.event)).toContain("warm_timeout");
    expect(h.results[0]).toEqual(expect.objectContaining({ settled: true }));
  });

  it("a seek during the warm: the switch reloads at the seek target, not at the warmed segment", async () => {
    const h = new Harness(startOfDecision);
    h.onPoll = (x) => {
      if (x.nowMs - x.warms[0]!.atMs === 2_000) {
        x.machine.noteSeek(300);
        x.playing = { ...x.playing, position: 300, seeking: true };
      }
    };
    await h.machine.request(TARGET, "abr-downshift");
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0]!.startSeconds).toBe(300);
    expect(h.logs.map((l) => l.event)).toContain("warm_abandoned");
  });

  it("paused once the segment is here: reloads where the viewer paused, still paused", async () => {
    const h = new Harness(startOfDecision);
    h.onPoll = (x) => {
      if (x.nowMs - x.warms[0]!.atMs === 3_000) x.playing = { ...x.playing, paused: true };
      if (x.nowMs - x.warms[0]!.atMs >= 16_300) x.finishWarm();
    };
    await h.machine.request(TARGET, "abr-downshift");
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0]!.startSeconds).toBeCloseTo(h.loads[0]!.positionBefore, 5);
    expect(h.loads[0]!.options).toContain("pause=yes");
  });

  it("without a native warm (iOS) the switch reloads straight away, as before", async () => {
    const h = new Harness(startOfDecision, false);
    await h.machine.request(TARGET, "abr-downshift");
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0]!.atMs).toBe(1_000_000);
    expect(h.loads[0]!.startSeconds).toBe(DECISION.positionSeconds);
    expect(h.loads[0]!.options).not.toContain("http_multiple");
  });
});
