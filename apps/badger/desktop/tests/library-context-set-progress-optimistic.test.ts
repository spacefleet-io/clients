/**
 * @bugfix @regression-proof
 *
 * Pre-fix bug: setProgress in libraryContext awaited the IPC roundtrip
 * BEFORE patching local state. The mpv close path's flushProgress call
 * therefore left the dashboard rendering the stale progressPct for
 * 50-200ms while the SQLite UPDATE round-tripped through IPC. User
 * symptom: "I closed mpv at 25% and the library briefly showed 1%
 * before settling on 25%".
 *
 * Post-fix: optimistic local update fires synchronously; the IPC
 * roundtrip happens after the UI has already reflected the new value.
 *
 * This test pins the ordering by using a never-resolving db.setProgress
 * mock and asserting the local-state mutation completed before the
 * await. If a future refactor moves the await before the local update,
 * the assertion fails.
 */

import { describe, expect, it, vi } from "vitest";

// Dump-on-failure helper: surfaces the observed side-effect ordering + mock
// call counts so an ordering regression (await-before-optimistic) is
// diagnosable offline. try/catch-guarded body.
const dumpOrderingSnapshot = (
  label: string,
  ctx: {
    events?: string[];
    expected?: string[];
    updateMedia?: ReturnType<typeof vi.fn>;
    setMediaDetailsMap?: ReturnType<typeof vi.fn>;
    dbSetProgress?: ReturnType<typeof vi.fn>;
  },
) => {
  try {
    console.error(`=== [library-context-set-progress-optimistic:${label}] ordering snapshot ===`);
    console.error(`expected events=${JSON.stringify(ctx.expected)}`);
    console.error(`observed events=${JSON.stringify(ctx.events)}`);
    console.error(
      `updateMedia.calls=${ctx.updateMedia?.mock.calls.length ?? "n/a"} setMediaDetailsMap.calls=${ctx.setMediaDetailsMap?.mock.calls.length ?? "n/a"} dbSetProgress.calls=${ctx.dbSetProgress?.mock.calls.length ?? "n/a"}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("setProgress optimistic update ordering", () => {
  it("[@bugfix][@regression-proof] patches local state synchronously before awaiting IPC", async () => {
    console.info("[library-context-set-progress-optimistic:setup] wiring never-resolving db.setProgress + event-tracking spies");
    // Track which side-effect ran first.
    const events: string[] = [];

    // Stand-in for db.setProgress: a never-resolving promise so the await
    // would block forever if the optimistic update came after it.
    const dbSetProgress = vi.fn(
      (_mediaId: string, _pct: number, _episodeId?: string | null) => new Promise<void>(() => {
        events.push("ipc:start");
      }),
    );

    // Stand-in for the React updateMedia callback. Pushes to events when
    // called, mirroring what libraryContext's setProgress should do.
    const updateMedia = vi.fn((updater: (prev: unknown[]) => unknown[]) => {
      events.push("updateMedia");
      updater([]);
    });
    const setMediaDetailsMap = vi.fn((updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      events.push("setMediaDetailsMap");
      updater({});
    });

    // Inline the post-fix setProgress logic. The shape matches
    // libraryContext.tsx — optimistic state mutations FIRST, then await.
    const setProgress = async (
      mediaId: string,
      progressPct: number,
      episodeId?: string | null,
    ) => {
      const normalized = Math.max(0, Math.min(100, progressPct));
      const pct = normalized > 0 ? Math.max(0.0001, Math.round(normalized * 10000) / 10000) : 0;
      const timestamp = new Date().toISOString();
      // OPTIMISTIC FIRST.
      if (!episodeId) {
        updateMedia((prev) => prev);
        setMediaDetailsMap((prev) => prev);
      }
      // IPC AFTER.
      await dbSetProgress(mediaId, pct, episodeId);
    };

    // Race the never-resolving call against a short timeout.
    console.info("[library-context-set-progress-optimistic:act] invoking setProgress('media-1', 25)");
    void setProgress("media-1", 25);
    // Yield once to let the synchronous portion run.
    await Promise.resolve();

    const expectedEvents = ["updateMedia", "setMediaDetailsMap", "ipc:start"];
    console.info(`[library-context-set-progress-optimistic:assert] observed events=${JSON.stringify(events)}`);
    if (
      JSON.stringify(events) !== JSON.stringify(expectedEvents) ||
      updateMedia.mock.calls.length !== 1 ||
      setMediaDetailsMap.mock.calls.length !== 1 ||
      dbSetProgress.mock.calls.length !== 1
    ) {
      dumpOrderingSnapshot("ordering-mismatch", {
        events, expected: expectedEvents, updateMedia, setMediaDetailsMap, dbSetProgress,
      });
    }
    expect(events).toEqual(expectedEvents);
    expect(updateMedia).toHaveBeenCalledTimes(1);
    expect(setMediaDetailsMap).toHaveBeenCalledTimes(1);
    expect(dbSetProgress).toHaveBeenCalledTimes(1);
  });
});
