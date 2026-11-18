/**
 * @test-id LIBRARY-SNAPSHOT-PERSISTER-001
 * @bugfix
 * @regression-proof
 * @level unit
 * @why Issue #25: the cold-start library snapshot cache (~1 MB JSON.stringify
 *      + synchronous localStorage.setItem on the renderer main thread) was
 *      scheduled by a trailing 10 s debounce re-armed on EVERY library state
 *      change. Playback changes state every 500 ms (progress writes), so the
 *      write never fired during playback — the cache stayed as stale as the
 *      whole session — and then landed as one long task on a raw timer. The
 *      only final flush was `pagehide`, which close-to-tray's `win.destroy()`
 *      never fires. Pre-fix `createLibrarySnapshotPersister` does not exist;
 *      the old policy is modelled below as `oldTrailingDebounce` to pin the
 *      starvation it had.
 * @covers apps/badger/desktop/src/renderer/src/lib/librarySnapshotPersister.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySnapshot } from "../src/renderer/src/lib/libraryDb";
import {
  createLibrarySnapshotPersister,
  type LibrarySnapshotPersister,
  type SnapshotPersistEvent,
} from "../src/renderer/src/lib/librarySnapshotPersister";

const TAG = "library-snapshot-persister";

type Harness = {
  saves: Array<{ atMs: number; tick: number }>;
  events: SnapshotPersistEvent[];
  counters: { getterCalls: number; idleRequests: number };
  persister: LibrarySnapshotPersister;
  change: (tick: number) => void;
  dump: (label: string) => void;
};

// Fake requestIdleCallback: runs the callback on a 0 ms timer (an idle slot
// right after the due timer) and counts the requests so tests can see the
// write went through the idle path.
const createHarness = (options: { quietMs?: number; maxStaleMs?: number } = {}): Harness => {
  const saves: Harness["saves"] = [];
  const events: SnapshotPersistEvent[] = [];
  const counters = { getterCalls: 0, idleRequests: 0 };
  const persister = createLibrarySnapshotPersister({
    save: (snapshot) => {
      const tick = Number((snapshot.settings?.tick?.value ?? "-1"));
      saves.push({ atMs: Date.now(), tick });
    },
    quietMs: options.quietMs,
    maxStaleMs: options.maxStaleMs,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle),
    requestIdle: (fn) => {
      counters.idleRequests += 1;
      return setTimeout(fn, 0) as unknown as number;
    },
    cancelIdle: (handle) => clearTimeout(handle),
    log: (entry) => {
      events.push(entry);
      console.info(`[${TAG}:persister] ${JSON.stringify(entry)}`);
    },
  });
  const change = (tick: number) =>
    persister.markDirty(() => {
      counters.getterCalls += 1;
      return {
        media: [],
        playlists: [],
        settings: { tick: { value: String(tick), updatedAt: "t" } },
      } satisfies LibrarySnapshot;
    });
  return {
    saves,
    events,
    counters,
    persister,
    change,
    dump: (label) => {
      console.error(`=== [${TAG}:${label}] dump ===`);
      console.error(JSON.stringify({ saves, events: events.slice(-20), counters, pending: persister.hasPending() }, null, 2));
    },
  };
};

// The pre-fix libraryContext effect: clearTimeout + setTimeout(save, 10 s) on every change.
const oldTrailingDebounce = (save: (tick: number) => void) => {
  let timer: NodeJS.Timeout | undefined;
  return (tick: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => save(tick), 10_000);
  };
};

// Playback: one progress write every 500 ms for `seconds`.
const playFor = (seconds: number, onTick: (tick: number) => void, startTick = 1) => {
  const ticks = seconds * 2;
  for (let i = 0; i < ticks; i += 1) {
    onTick(startTick + i);
    vi.advanceTimersByTime(500);
  }
  return startTick + ticks - 1;
};

describe("[@bugfix][@regression-proof] library snapshot cache persister", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("baseline: the old trailing debounce never writes during continuous playback", () => {
    const saves: number[] = [];
    const change = oldTrailingDebounce((tick) => saves.push(tick));
    const lastTick = playFor(120, change);
    console.info(`[${TAG}:baseline] lastTick=${lastTick} savesDuringPlayback=${saves.length}`);
    expect(saves).toEqual([]);
  });

  it("coalesces a burst into ONE write of the latest state after the quiet window, serialized lazily", () => {
    const h = createHarness();
    for (let tick = 1; tick <= 5; tick += 1) {
      h.change(tick);
      vi.advanceTimersByTime(1_000);
    }
    console.info(`[${TAG}:burst] after burst saves=${h.saves.length} getterCalls=${h.counters.getterCalls}`);
    try {
      expect(h.saves).toEqual([]);
      expect(h.counters.getterCalls).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(h.saves.map((s) => s.tick)).toEqual([5]);
      expect(h.counters.getterCalls).toBe(1);
      expect(h.counters.idleRequests).toBe(1);
      expect(h.persister.hasPending()).toBe(false);
    } catch (err) {
      h.dump("burst");
      throw err;
    }
  });

  it("bounds staleness under continuous playback: a write at least every maxStaleMs (no starvation)", () => {
    const h = createHarness({ quietMs: 10_000, maxStaleMs: 60_000 });
    const startedAt = Date.now();
    const lastTick = playFor(150, (tick) => h.change(tick));
    const savesAt = h.saves.map((s) => ({ ms: s.atMs - startedAt, tick: s.tick }));
    console.info(`[${TAG}:playback] lastTick=${lastTick} saves=${JSON.stringify(savesAt)}`);
    try {
      // 150 s of churn: due at 60 s and 120 s (+ the idle slot), not 300 times.
      expect(h.saves.length).toBe(2);
      expect(savesAt[0].ms).toBeGreaterThanOrEqual(59_500);
      expect(savesAt[0].ms).toBeLessThanOrEqual(60_500);
      expect(savesAt[1].ms - savesAt[0].ms).toBeLessThanOrEqual(60_500);
      // Each write carries the newest state at the moment it ran.
      expect(savesAt[0].tick).toBeGreaterThanOrEqual(119);
      expect(h.counters.getterCalls).toBe(2);
      // After playback stops, the tail is written once the quiet window passes.
      vi.advanceTimersByTime(10_500);
      expect(h.saves.at(-1)?.tick).toBe(lastTick);
      expect(h.saves.length).toBe(3);
    } catch (err) {
      h.dump("playback");
      throw err;
    }
  });

  it("a change while waiting for the idle slot is included in that write, not dropped or doubled", () => {
    let runIdle: (() => void) | null = null;
    const saved: string[] = [];
    const persister = createLibrarySnapshotPersister({
      save: (snapshot) => saved.push(String(snapshot.settings?.tick?.value)),
      quietMs: 1_000,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimer: (handle) => clearTimeout(handle),
      requestIdle: (fn) => {
        runIdle = fn;
        return 1;
      },
      cancelIdle: () => {
        runIdle = null;
      },
      log: (entry) => console.info(`[${TAG}:idle-race] ${JSON.stringify(entry)}`),
    });
    const snap = (tick: number) => (): LibrarySnapshot => ({ media: [], playlists: [], settings: { tick: { value: String(tick), updatedAt: "t" } } });
    persister.markDirty(snap(1));
    vi.advanceTimersByTime(1_000);
    expect(runIdle).not.toBeNull();
    persister.markDirty(snap(2));
    (runIdle as unknown as () => void)();
    vi.advanceTimersByTime(5_000);
    console.info(`[${TAG}:idle-race] saved=${JSON.stringify(saved)}`);
    expect(saved).toEqual(["2"]);
    expect(persister.hasPending()).toBe(false);
  });

  it("flush-on-quit: flush() writes the pending state synchronously and disarms the scheduled write", () => {
    const h = createHarness();
    playFor(3, (tick) => h.change(tick));
    try {
      expect(h.saves).toEqual([]);
      expect(h.persister.flush("window-destroy")).toBe(true);
      expect(h.saves.map((s) => s.tick)).toEqual([6]);
      expect(h.events.at(-1)).toMatchObject({ event: "persisted", reason: "window-destroy", changes: 6 });
      // Nothing left to write: the armed timer must not fire a second write.
      vi.advanceTimersByTime(120_000);
      expect(h.saves.length).toBe(1);
      // A second flush (pagehide after the destroy handshake) is a no-op.
      expect(h.persister.flush("pagehide")).toBe(false);
      expect(h.saves.length).toBe(1);
    } catch (err) {
      h.dump("flush");
      throw err;
    }
  });

  it("flush-on-quit right after an idle write writes nothing stale or duplicate", () => {
    const h = createHarness();
    h.change(1);
    vi.advanceTimersByTime(10_001);
    expect(h.saves.map((s) => s.tick)).toEqual([1]);
    expect(h.persister.flush("pagehide")).toBe(false);
    h.change(2);
    expect(h.persister.flush("pagehide")).toBe(true);
    expect(h.saves.map((s) => s.tick)).toEqual([1, 2]);
  });

  it("cancel() (logout / cache reset) drops the pending write so a cleared cache is not resurrected", () => {
    const h = createHarness();
    playFor(5, (tick) => h.change(tick));
    h.persister.cancel();
    vi.advanceTimersByTime(120_000);
    expect(h.persister.flush("pagehide")).toBe(false);
    console.info(`[${TAG}:cancel] saves=${JSON.stringify(h.saves)}`);
    expect(h.saves).toEqual([]);
    expect(h.events.some((e) => e.event === "cancelled")).toBe(true);
  });

  it("a failing save is logged and does not wedge later writes", () => {
    let fail = true;
    const saved: string[] = [];
    const events: SnapshotPersistEvent[] = [];
    const persister = createLibrarySnapshotPersister({
      save: (snapshot) => {
        if (fail) throw new Error("QuotaExceededError");
        saved.push(String(snapshot.settings?.tick?.value));
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimer: (handle) => clearTimeout(handle),
      requestIdle: (fn) => setTimeout(fn, 0) as unknown as number,
      cancelIdle: (handle) => clearTimeout(handle),
      log: (entry) => events.push(entry),
    });
    const snap = (tick: number) => (): LibrarySnapshot => ({ media: [], playlists: [], settings: { tick: { value: String(tick), updatedAt: "t" } } });
    persister.markDirty(snap(1));
    expect(persister.flush("quit")).toBe(false);
    console.info(`[${TAG}:save-error] events=${JSON.stringify(events)}`);
    expect(events.at(-1)).toMatchObject({ event: "error", reason: "quit", error: "QuotaExceededError" });
    fail = false;
    persister.markDirty(snap(2));
    vi.advanceTimersByTime(10_001);
    expect(saved).toEqual(["2"]);
  });

  it("LibraryProvider wires the persister: pagehide + close-to-tray flush, cancel on logout, DB-backed state only", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/renderer/src/lib/libraryContext.tsx", import.meta.url)), "utf8");
    const checks = {
      noRawTimer: !src.includes("snapshotTimerRef"),
      createsPersister: src.includes("createLibrarySnapshotPersister({"),
      flushesOnPageHide: src.includes('persister.flush("pagehide")') && src.includes('addEventListener("pagehide", flushOnPageHide)'),
      flushesBeforeDestroy: src.includes('onBeforeWindowDestroy?.(() => persister.flush("window-destroy"))'),
      cancelsOnUnmount: src.includes("persister.cancel();"),
      cancelsBeforeClear: (src.match(/snapshotPersisterRef\.current\?\.cancel\(\);\s*\n\s*if \(user\?\.id\) \{\s*\n\s*clearLibrarySnapshotCache/g) ?? []).length === 2,
      dbGated: /if \(!db\) return;\s*\n\s*snapshotPersisterRef\.current\?\.markDirty/.test(src),
    };
    console.info(`[${TAG}:wiring] checks=${JSON.stringify(checks)}`);
    expect(checks).toEqual({
      noRawTimer: true,
      createsPersister: true,
      flushesOnPageHide: true,
      flushesBeforeDestroy: true,
      cancelsOnUnmount: true,
      cancelsBeforeClear: true,
      dbGated: true,
    });
  });
});
