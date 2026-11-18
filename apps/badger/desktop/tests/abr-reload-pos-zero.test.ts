// @bugfix @regression-proof issue #25 NEW-abr-reload-pos-zero (ultimate run
// 1791422679313, S1 c061, video_backwards 215→0).
//
// Evidence (shard-1/timeline.jsonl + logs/mpv-16-1791428477094.log):
//   444.440  loadStream: enter (reload #1, ABR 1080p→480p) — arms 8.979313
//   444.441  poll: start target reached {displayTime: 8.979313}  ← OLD file
//   444.505  mpv loadfile … start=8.979313,demuxer-cache-wait=yes,aid=2
//   445.278  file-loaded, time-pos 0, seeking — stuck ~11 s (throttled)
//   451.351  progress poll save pct 0 (target gone, 0 trusted)
//   456.142  reload #2 (480p→360p) loadfile options="aid=3"   ← no start=
//   466.543  playback-restart at 0.06 s
//
// Root cause: the poll fed the previous file's time-pos into the new reload's
// pending start target; it "reached" before the loadfile was even sent, so
// the stalled new file's 0 was trusted and reload #2 restarted at 0:00.
//
// Fix: a reload on a live mpv arms the target with the load in flight. Until
// the new file loads, samples cannot reach the target, and the reload start
// ignores the captured time-pos in favour of the reload's seek target.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PendingStartTarget, resolveReloadStartTime } from "../src/renderer/src/lib/pendingStartTarget";

const LOG = "[abr-reload-pos-zero]";
const C061_START = 8.979313;

describe("ABR reload keeps its start across a stalled reload (@bugfix @regression-proof issue #25 c061)", () => {
  it("resolveReloadStartTime ignores the captured time-pos while a reload's file is still loading", () => {
    const start = resolveReloadStartTime({
      pendingStart: null,
      capturedTime: 0,
      seekTarget: C061_START,
      lastKnownTime: 0,
      loadInFlight: true,
    });
    console.info(`${LOG} phase=resolve-in-flight start=${start}`);
    expect(start).toBe(C061_START);
    // Not reloading: the live time-pos is the playhead, exactly as before.
    expect(resolveReloadStartTime({ pendingStart: null, capturedTime: 42, seekTarget: C061_START, lastKnownTime: 0 })).toBe(42);
  });

  it("replays c061: the old file's sample cannot reach the reload target before the new file loads", () => {
    const pending = new PendingStartTarget();
    let now = 1_791_428_444_440;
    // Reload #1 on a live mpv.
    expect(pending.armForReload(C061_START)).toBe(C061_START);
    // 444.441: the poll still reads the OLD file at exactly the target.
    const stale = pending.observe(C061_START, now);
    console.info(`${LOG} phase=stale-old-file-sample verdict=${stale} pending=${pending.get()}`);
    expect(stale).toBe("pending");
    expect(pending.get()).toBe(C061_START);

    // 445.278: file-loaded; the new file sits at 0 (seeking) for ~11 s.
    pending.loadLanded();
    const stalled = [0, 0, 0, 0, 0].map(() => {
      now += 2_000;
      return pending.observe(0, now);
    });
    console.info(`${LOG} phase=stalled-new-file verdicts=${stalled.join(",")} pending=${pending.get()}`);
    expect(stalled.every((verdict) => verdict === "pending")).toBe(true);

    // Reload #2: still pending, so it reloads at 8.979, not 0.
    const reload2 = resolveReloadStartTime({
      pendingStart: pending.get(),
      capturedTime: 0,
      seekTarget: C061_START,
      lastKnownTime: 0,
      loadInFlight: pending.isLoadInFlight(),
    });
    console.info(`${LOG} phase=reload-2 start=${reload2}`);
    expect(reload2).toBe(C061_START);

    // The new stream lands on the target: cleared and trusted again.
    expect(pending.observe(9.0, now + 250)).toBe("reached");
    expect(pending.get()).toBeNull();
  });

  it("a plain arm (seek / fresh launch) is not gated on a load", () => {
    const pending = new PendingStartTarget();
    pending.armForReload(30);
    expect(pending.isLoadInFlight()).toBe(true);
    pending.arm(30);
    expect(pending.isLoadInFlight()).toBe(false);
    expect(pending.observe(30.5, 1)).toBe("reached");
  });

  it("the engine arms reloads for the load, releases on file-loaded, and passes loadInFlight to both reload sites", () => {
    const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const needles = [
      "pendingStart.armForReload(options.startTime)",
      'if (msg.type !== "file_loaded") return;',
      "pendingStart.loadLanded();",
      "loadInFlight: pendingStart.isLoadInFlight(),",
    ];
    for (const needle of needles) {
      console.info(`${LOG} phase=source needle=${JSON.stringify(needle)} present=${engine.includes(needle)}`);
      expect(engine.includes(needle)).toBe(true);
    }
    expect(engine.match(/resolveReloadStartTime\(\{[^}]*loadInFlight/g)?.length).toBe(2);
  });
});
