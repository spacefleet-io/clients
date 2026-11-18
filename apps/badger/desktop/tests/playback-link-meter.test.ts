/**
 * @bugfix @regression-proof
 *
 * Issue #25: the renderer measured "bandwidth" from mpv's `fw-bytes`, which is
 * the bytes cached AHEAD of the play position (flat once the cache is full),
 * so the estimate sat at 1-2.4 Mbps on a 30+ Mbps link and Auto quality could
 * never climb back after a network drop. The real link is upstream: Electron
 * main fetching HLS segments through the tunnel. This suite pins the main-side
 * busy-time meter over those fetches (pure core, injected clock).
 */

import { describe, expect, it } from "vitest";

import {
  PLAYBACK_LINK_EWMA_ALPHA,
  createPlaybackLinkMeter,
  effectiveLinkEstimate,
  isMeteredHlsObject,
  type PlaybackLinkMeter,
} from "../src/main/playbackLinkMeter";

const SUITE = "playback-link-meter";
const MB = 1_000_000;

const createClock = (startMs = 0) => {
  let now = startMs;
  return {
    nowMs: () => now,
    set: (ms: number) => {
      now = ms;
    },
  };
};

const dumpMeterSnapshot = (label: string, meter: PlaybackLinkMeter, extra: Record<string, unknown> = {}) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(`snapshot: ${JSON.stringify(meter.snapshot())}`);
    console.error(`extra: ${JSON.stringify(extra, null, 2)}`);
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const withDump = (label: string, meter: PlaybackLinkMeter, extra: Record<string, unknown>, assert: () => void) => {
  console.info(`[${SUITE}:${label}] asserting snapshot=${JSON.stringify(meter.snapshot())}`);
  try {
    assert();
  } catch (err) {
    dumpMeterSnapshot(label, meter, extra);
    throw err;
  }
};

describe("createPlaybackLinkMeter", () => {
  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-001
   * @level unit
   */
  it("reports bps 0, no samples and a null timestamp before any completion", () => {
    const meter = createPlaybackLinkMeter({ nowMs: createClock(5_000).nowMs });
    expect(meter.snapshot()).toEqual({ bps: 0, sampleCount: 0, updatedAtMs: null });
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-002
   * @level unit
   */
  it("samples bytes over busy time for a single fetch", () => {
    const label = "single-fetch";
    const clock = createClock(1_000);
    const meter = createPlaybackLinkMeter({ nowMs: clock.nowMs });
    const fetch = meter.begin();
    clock.set(1_500);
    fetch.addBytes(MB / 2);
    clock.set(2_000);
    fetch.addBytes(MB / 2);
    const sampleBps = fetch.end("complete");
    console.info(`[${SUITE}:${label}] sampleBps=${sampleBps}`);
    withDump(label, meter, { sampleBps }, () => {
      expect(sampleBps).toBe(8 * MB);
      expect(meter.snapshot()).toEqual({ bps: 8 * MB, sampleCount: 1, updatedAtMs: 2_000 });
    });
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-003
   * @level unit
   * @why A full mpv cache idles the upstream link: idle wall time must not dilute the estimate.
   */
  it("excludes idle time between fetches from the busy window", () => {
    const label = "idle-gap-excluded";
    const clock = createClock(0);
    const meter = createPlaybackLinkMeter({ nowMs: clock.nowMs });
    const first = meter.begin();
    clock.set(1_000);
    first.addBytes(MB);
    first.end("complete");
    console.info(`[${SUITE}:${label}] after first fetch snapshot=${JSON.stringify(meter.snapshot())}`);
    clock.set(11_000); // 10 s idle: cache full, no fetch in flight
    const second = meter.begin();
    clock.set(12_000);
    second.addBytes(MB);
    const sampleBps = second.end("complete");
    withDump(label, meter, { sampleBps }, () => {
      expect(sampleBps).toBe(8 * MB);
      expect(meter.snapshot()).toEqual({ bps: 8 * MB, sampleCount: 2, updatedAtMs: 12_000 });
    });
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-004
   * @level unit
   * @why Prefetch runs 2 fetches at once; per-fetch throughput would halve the link estimate.
   */
  it("aggregates concurrent fetches: Δbytes of every fetch over the union busy time", () => {
    const label = "concurrent-aggregate";
    const clock = createClock(0);
    const meter = createPlaybackLinkMeter({ nowMs: clock.nowMs });
    // 16 Mbps link (2 MB/s) shared by A (1 MB) and B (2 MB), both starting at t=0.
    const a = meter.begin();
    const b = meter.begin();
    clock.set(1_000);
    a.addBytes(MB);
    b.addBytes(MB);
    const sampleA = a.end("complete");
    console.info(`[${SUITE}:${label}] A complete t=1000 sampleA=${sampleA} snapshot=${JSON.stringify(meter.snapshot())}`);
    clock.set(1_500);
    b.addBytes(MB);
    const sampleB = b.end("complete");
    console.info(`[${SUITE}:${label}] B complete t=1500 sampleB=${sampleB} snapshot=${JSON.stringify(meter.snapshot())}`);
    withDump(label, meter, { sampleA, sampleB }, () => {
      expect(sampleA).toBe(16 * MB);
      expect(sampleB).toBe(16 * MB);
      expect(meter.snapshot()).toEqual({ bps: 16 * MB, sampleCount: 2, updatedAtMs: 1_500 });
    });
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-005
   * @level unit
   */
  it("counts partially overlapping fetches once and skips the idle hole between bursts", () => {
    const label = "partial-overlap";
    const clock = createClock(0);
    const meter = createPlaybackLinkMeter({ nowMs: clock.nowMs });
    const a = meter.begin(); // busy 0..2000 (A 0..1000, B 500..2000)
    clock.set(500);
    const b = meter.begin();
    clock.set(1_000);
    a.addBytes(MB);
    const sampleA = a.end("complete"); // 1 MB over 1000 busy ms
    clock.set(2_000);
    b.addBytes(2 * MB);
    const sampleB = b.end("complete"); // 2 MB over 1000 busy ms
    clock.set(5_000); // idle 2000..5000
    const c = meter.begin();
    clock.set(5_500);
    c.addBytes(MB);
    const sampleC = c.end("complete"); // 1 MB over 500 busy ms
    console.info(`[${SUITE}:${label}] samples A=${sampleA} B=${sampleB} C=${sampleC}`);
    const ewma = [8 * MB, 16 * MB, 16 * MB].reduce<number | null>(
      (acc, sample) => (acc === null ? sample : PLAYBACK_LINK_EWMA_ALPHA * sample + (1 - PLAYBACK_LINK_EWMA_ALPHA) * acc),
      null,
    );
    withDump(label, meter, { sampleA, sampleB, sampleC, ewma }, () => {
      expect([sampleA, sampleB, sampleC]).toEqual([8 * MB, 16 * MB, 16 * MB]);
      expect(meter.snapshot().bps).toBeCloseTo(ewma as number, 6);
      expect(meter.snapshot().sampleCount).toBe(3);
    });
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-006
   * @level unit
   */
  it("smooths samples with EWMA alpha 0.3 seeded by the first sample", () => {
    const label = "ewma";
    const clock = createClock(0);
    const meter = createPlaybackLinkMeter({ nowMs: clock.nowMs });
    expect(PLAYBACK_LINK_EWMA_ALPHA).toBe(0.3);
    const first = meter.begin();
    clock.set(1_000);
    first.addBytes(MB);
    first.end("complete"); // 8 Mbps
    const second = meter.begin();
    clock.set(2_000);
    second.addBytes(MB / 2);
    second.end("complete"); // 4 Mbps
    withDump(label, meter, {}, () => {
      expect(meter.snapshot().bps).toBeCloseTo(0.3 * 4 * MB + 0.7 * 8 * MB, 6);
      expect(meter.snapshot().sampleCount).toBe(2);
    });
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-007
   * @level unit
   */
  it("takes no sample when two fetches complete at the same instant (zero busy delta)", () => {
    const label = "zero-busy-delta";
    const clock = createClock(0);
    const meter = createPlaybackLinkMeter({ nowMs: clock.nowMs });
    const a = meter.begin();
    const b = meter.begin();
    clock.set(2_000);
    a.addBytes(MB);
    b.addBytes(MB);
    const sampleA = a.end("complete");
    const sampleB = b.end("complete");
    console.info(`[${SUITE}:${label}] sampleA=${sampleA} sampleB=${sampleB}`);
    withDump(label, meter, { sampleA, sampleB }, () => {
      expect(sampleA).toBe(8 * MB);
      expect(sampleB).toBeNull();
      expect(meter.snapshot()).toEqual({ bps: 8 * MB, sampleCount: 1, updatedAtMs: 2_000 });
    });
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-008
   * @level unit
   */
  it("takes no sample on a failed fetch and carries its bytes and busy time into the next completion", () => {
    const label = "failed-carry";
    const clock = createClock(0);
    const meter = createPlaybackLinkMeter({ nowMs: clock.nowMs });
    const failed = meter.begin();
    clock.set(1_000);
    failed.addBytes(MB / 2);
    const failedSample = failed.end("failed");
    console.info(`[${SUITE}:${label}] failed end sample=${failedSample} snapshot=${JSON.stringify(meter.snapshot())}`);
    expect(failedSample).toBeNull();
    expect(meter.snapshot()).toEqual({ bps: 0, sampleCount: 0, updatedAtMs: null });
    const retry = meter.begin();
    clock.set(2_000);
    retry.addBytes(MB);
    const sample = retry.end("complete");
    withDump(label, meter, { failedSample, sample }, () => {
      // 1.5 MB over 2 s of busy time.
      expect(sample).toBe(6 * MB);
      expect(meter.snapshot()).toEqual({ bps: 6 * MB, sampleCount: 1, updatedAtMs: 2_000 });
    });
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-009
   * @level unit
   */
  it("ends a fetch handle once: a second end is ignored", () => {
    const clock = createClock(0);
    const meter = createPlaybackLinkMeter({ nowMs: clock.nowMs });
    const fetch = meter.begin();
    clock.set(1_000);
    fetch.addBytes(MB);
    expect(fetch.end("complete")).toBe(8 * MB);
    expect(fetch.end("complete")).toBeNull();
    expect(meter.snapshot().sampleCount).toBe(1);
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-010
   * @level unit
   * @why A new HLS session (new file / reload) must not inherit the previous link estimate.
   */
  it("reset clears the estimate and ignores fetches begun before it", () => {
    const label = "reset";
    const clock = createClock(0);
    const meter = createPlaybackLinkMeter({ nowMs: clock.nowMs });
    const old = meter.begin();
    clock.set(1_000);
    old.addBytes(MB);
    old.end("complete");
    const straggler = meter.begin(); // still in flight across the reset
    clock.set(1_500);
    meter.reset();
    console.info(`[${SUITE}:${label}] after reset snapshot=${JSON.stringify(meter.snapshot())}`);
    expect(meter.snapshot()).toEqual({ bps: 0, sampleCount: 0, updatedAtMs: null });

    const fresh = meter.begin();
    clock.set(2_000);
    straggler.addBytes(10 * MB);
    const stragglerSample = straggler.end("complete");
    clock.set(2_500);
    fresh.addBytes(MB / 2);
    const freshSample = fresh.end("complete");
    console.info(`[${SUITE}:${label}] stragglerSample=${stragglerSample} freshSample=${freshSample}`);
    withDump(label, meter, { stragglerSample, freshSample }, () => {
      expect(stragglerSample).toBeNull();
      // Only the fresh fetch: 0.5 MB over its own 1000 busy ms.
      expect(freshSample).toBe(4 * MB);
      expect(meter.snapshot()).toEqual({ bps: 4 * MB, sampleCount: 1, updatedAtMs: 2_500 });
    });
  });
});

describe("isMeteredHlsObject", () => {
  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-011
   * @level unit
   * @why Init segments are tiny (latency-bound) and audio is a fixed side stream: only video media segments measure the link the rungs compete for.
   */
  it("meters HLS video media segments only", () => {
    const cases = [
      { meta: { kind: "video" as const, isInit: false }, expected: true },
      { meta: { kind: "video" as const, isInit: true }, expected: false },
      { meta: { kind: "audio" as const, isInit: false }, expected: false },
      { meta: { kind: "audio" as const, isInit: true }, expected: false },
      { meta: undefined, expected: false },
    ];
    const actual = cases.map((entry) => ({ ...entry, actual: isMeteredHlsObject(entry.meta) }));
    console.info(`[${SUITE}:classification] ${JSON.stringify(actual)}`);
    expect(actual.map((entry) => entry.actual)).toEqual(cases.map((entry) => entry.expected));
  });
});

describe("effectiveLinkEstimate", () => {
  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-012
   * @level unit
   * @why The test throttle paces the mpv-facing response, so upstream fetches cannot see it: the effective link is the slower of the two.
   */
  it("caps the upstream estimate at the active throttle rate", () => {
    const upstream = { bps: 8 * MB, sampleCount: 3, updatedAtMs: 42 };
    const cases = [
      { throttleKbps: 0, expected: { bps: 8 * MB, sampleCount: 3, updatedAtMs: 42, throttleKbps: 0 } },
      { throttleKbps: 1_000, expected: { bps: MB, sampleCount: 3, updatedAtMs: 42, throttleKbps: 1_000 } },
      { throttleKbps: 20_000, expected: { bps: 8 * MB, sampleCount: 3, updatedAtMs: 42, throttleKbps: 20_000 } },
    ];
    for (const entry of cases) {
      const actual = effectiveLinkEstimate(upstream, entry.throttleKbps);
      console.info(`[${SUITE}:effective] throttleKbps=${entry.throttleKbps} actual=${JSON.stringify(actual)}`);
      expect(actual).toEqual(entry.expected);
    }
  });

  /**
   * @test-id DESKTOP-PLAYBACK-LINK-METER-013
   * @level unit
   */
  it("keeps bps 0 without an upstream sample even when the throttle is active", () => {
    expect(effectiveLinkEstimate({ bps: 0, sampleCount: 0, updatedAtMs: null }, 1_500)).toEqual({
      bps: 0,
      sampleCount: 0,
      updatedAtMs: null,
      throttleKbps: 1_500,
    });
  });
});
