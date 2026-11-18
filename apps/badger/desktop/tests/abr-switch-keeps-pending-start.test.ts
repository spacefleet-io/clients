// @bugfix @regression-proof issue #25 P8 — ABR downshift during start dropped
// the resume offset (ultimate run 1791294602218864000, case c002).
//
// Evidence (shard-1/logs/mpv-17-1791302525105.log + timeline.jsonl):
//   +0.089 s  loadfile ... options="start=39.54234508,pause=..."
//   renderer  time-pos sample timePos: 0  → progress poll save pct: 0 (x2)
//   +2.2 s    abr downshift 1080p → 720p → selectFixedFormat(…, "abr")
//   +2.415 s  loadfile ... options=""      (start dropped)
//   +9.739 s  playback restart complete @ 0.000000
//
// Root cause: until mpv's start seek lands it reports time-pos 0. The poll
// trusted it (lastKnownTimeRef/currentTime = 0, progress saved as 0), the ABR
// switch took currentTime (0) as its resume point, and the reload effect
// re-captured time-pos (0) — so the reload carried no start.
//
// Fix: PendingStartTarget holds the requested start until a sample reaches
// it; the poll, format switch and reload all defer to it while pending.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PENDING_START_ABANDON_AFTER_MS,
  PendingStartTarget,
  resolveFormatSwitchResumeTime,
  resolveReloadStartTime,
} from "../src/renderer/src/lib/pendingStartTarget";

const LOG = "[abr-switch-keeps-pending-start]";
const C002_START = 39.54234508;

describe("pending start target (@bugfix @regression-proof issue #25 P8)", () => {
  it("replays c002: pre-seek time-pos 0 samples, ABR switch and reload keep the 39.54 s start", () => {
    const pending = new PendingStartTarget();
    let now = 1_791_302_503_320;
    console.info(`${LOG} phase=arm target=${pending.arm(C002_START)}`);

    // Poll samples while mpv is still loading: time-pos 0, not advancing.
    const verdicts = [0, 0, 0, 0].map((sample) => {
      now += 250;
      return pending.observe(sample, now);
    });
    console.info(`${LOG} phase=pre-seek-samples verdicts=${verdicts.join(",")} pending=${pending.get()}`);
    expect(verdicts).toEqual(["pending", "pending", "pending", "pending"]);

    // ABR downshift: selectFixedFormat computes its resume point. The UI time
    // and lastKnownTime still read the pre-seek 0 (what the old code used).
    const switchResume = resolveFormatSwitchResumeTime({ pendingStart: pending.get(), lastKnownTime: 0 });
    // Reload effect: the captured time-pos was the pre-seek 0 too.
    const reloadStart = resolveReloadStartTime({
      pendingStart: pending.get(),
      capturedTime: 0,
      seekTarget: switchResume,
      lastKnownTime: 0,
    });
    console.info(`${LOG} phase=abr-switch switchResume=${switchResume} reloadStart=${reloadStart}`);
    expect(switchResume).toBe(C002_START);
    expect(reloadStart).toBe(C002_START);

    // The reloaded stream lands on the target: pending clears, sample trusted.
    now += 250;
    const landed = pending.observe(39.6, now);
    console.info(`${LOG} phase=landed verdict=${landed} pending=${pending.get()}`);
    expect(landed).toBe("reached");
    expect(pending.get()).toBeNull();
    expect(pending.observe(40.1, now + 250)).toBe("none");
  });

  it("without a pending start, switch and reload behave exactly as before", () => {
    const pending = new PendingStartTarget();
    expect(pending.arm(0)).toBeNull();
    expect(pending.observe(123.4, 0)).toBe("none");
    // Without a pending start the switch records the polled position
    // (lastKnownTime), never a render-closure UI time (issue #25 s1:x002).
    expect(resolveFormatSwitchResumeTime({ pendingStart: null, lastKnownTime: 99 })).toBe(99);
    expect(resolveReloadStartTime({ pendingStart: null, capturedTime: 123.4, seekTarget: 50, lastKnownTime: 99 })).toBe(123.4);
    expect(resolveReloadStartTime({ pendingStart: null, capturedTime: null, seekTarget: 50, lastKnownTime: 99 })).toBe(50);
    expect(resolveReloadStartTime({ pendingStart: null, capturedTime: null, seekTarget: null, lastKnownTime: 99 })).toBe(99);
  });

  it("abandons the target when mpv keeps advancing elsewhere (start ignored), so it never pins forever", () => {
    const pending = new PendingStartTarget();
    pending.arm(600);
    let t = 0;
    let now = 0;
    let verdict = pending.observe(t, now);
    while (verdict === "pending" && now < PENDING_START_ABANDON_AFTER_MS * 2) {
      now += 250;
      t += 0.25;
      verdict = pending.observe(t, now);
    }
    console.info(`${LOG} phase=abandon verdict=${verdict} afterMs=${now} t=${t}`);
    expect(verdict).toBe("abandoned");
    expect(now).toBeGreaterThanOrEqual(PENDING_START_ABANDON_AFTER_MS);
    expect(now).toBeLessThan(PENDING_START_ABANDON_AFTER_MS + 1_000);
    expect(pending.get()).toBeNull();
  });

  it("a stalled (non-advancing) start never abandons the target, however long it buffers", () => {
    const pending = new PendingStartTarget();
    pending.arm(600);
    for (let now = 0; now <= 60_000; now += 250) {
      expect(pending.observe(0, now)).toBe("pending");
    }
    expect(pending.get()).toBe(600);
  });

  it("the engine routes the poll, ABR/quality switches, reload and seeks through the pending start", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"),
      "utf8",
    );
    const uses = {
      pollObserve: /pendingStart\.observe\(/.test(src),
      switchResume: (src.match(/resolveFormatSwitchResumeTime\(/g) ?? []).length,
      reloadStart: /resolveReloadStartTime\(/.test(src),
      armOnLoad: /pendingStart\.arm\(options\.startTime\)/.test(src),
      armOnSeek: /pendingStart\.userSeek\(clamped\)/.test(src),
    };
    console.info(`${LOG} phase=source-wiring ${JSON.stringify(uses)}`);
    expect(uses.pollObserve).toBe(true);
    // selectFixedFormat + selectAutoQuality
    expect(uses.switchResume).toBe(2);
    expect(uses.reloadStart).toBe(true);
    expect(uses.armOnLoad).toBe(true);
    expect(uses.armOnSeek).toBe(true);
  });
});
