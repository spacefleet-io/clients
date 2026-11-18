import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) => {
  const abs = resolve(process.cwd(), relativePath);
  console.info(`[playback-progress-exit-source:read] reading source ${abs}`);
  const src = readFileSync(abs, "utf8");
  console.info(`[playback-progress-exit-source:read] loaded ${relativePath}, length=${src.length} chars`);
  return src;
};

// Dump the matched source slice + computed indices so a source-contract
// failure (a regex no longer matches, or ordering invariant broke) is
// diagnosable offline. Wrapped in try/catch so the dump can't mask the real
// assertion failure.
const dumpProgressExitSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [playback-progress-exit-source:${label}] snapshot ===`);
    for (const [key, value] of Object.entries(ctx)) {
      if (typeof value === "string" && value.length > 200) {
        console.error(`${key} (len=${value.length}):\n${value}`);
      } else {
        console.error(`${key}=${JSON.stringify(value)}`);
      }
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

/**
 * @test-id DESKTOP-PLAYBACK-PROGRESS-001
 * @level source-contract
 * @bugfix
 * @regression-proof Fails if ensureExternalSeek stops updating lastKnownTimeRef
 *   immediately on seek, which would cause flushProgress (on mpv exit) to save a
 *   stale position instead of the actual seek target.
 */
describe("playback progress persistence source contracts", () => {
  it("@bugfix @regression-proof ensureExternalSeek updates lastKnownTimeRef before the async seek", () => {
    // PR 4.1c: `ensureExternalSeek` moved from useMpvPlaybackEngine.ts
    // to useExternalMpvCommands.ts. The lastKnownTimeRef-write-before-seek
    // invariant is still load-bearing for flushProgress on mpv exit:
    // if the seek-target write happens AFTER the retry loop, an mpv exit
    // mid-seek would persist the stale position instead of the user's
    // intended target.
    const source = readSource("src/renderer/src/lib/useExternalMpvCommands.ts");

    const seekFn = source.match(/const ensureExternalSeek = useCallback[\s\S]*?(?=\n {2}const )/)?.[0] ?? "";
    if (!seekFn) dumpProgressExitSnapshot("ensure-seek-not-found", { matchedFn: seekFn });
    expect(seekFn).toBeTruthy();

    // The ref must be updated BEFORE the seek loop.
    const refUpdateIndex = seekFn.indexOf("lastKnownTimeRef.current = target");
    const seekLoopIndex = seekFn.indexOf("for (let attempt");
    console.info(
      `[playback-progress-exit-source:ensure-seek] refUpdateIndex=${refUpdateIndex} seekLoopIndex=${seekLoopIndex}`,
    );
    if (refUpdateIndex < 0 || seekLoopIndex < 0 || refUpdateIndex >= seekLoopIndex) {
      dumpProgressExitSnapshot("ensure-seek-ordering", { refUpdateIndex, seekLoopIndex, seekFn });
    }
    expect(refUpdateIndex).toBeGreaterThan(-1);
    expect(seekLoopIndex).toBeGreaterThan(-1);
    expect(refUpdateIndex).toBeLessThan(seekLoopIndex);
  });

  it("@bugfix @regression-proof mpv exit handler resets reveal state immediately and awaits flushProgress", () => {
    const source = readSource("src/renderer/src/lib/useMpvPlaybackEngine.ts");

    // Tier-4 multiplexed the per-event onExternalMpvExit channel into
    // onMpvExternalMessage; the exit branch lives inside an async listener
    // that filters by `msg.type === "exit"`.
    console.info("[playback-progress-exit-source:exit-reveal] checking onMpvExternalMessage exit branch shape");
    if (!source.includes("onMpvExternalMessage")) {
      dumpProgressExitSnapshot("exit-reveal-no-listener", { hasListener: false });
    }
    expect(source).toContain("onMpvExternalMessage");
    // Tier-5 — the renderer's active/ready refs were collapsed into the
    // useMpvLifecycleStore snapshot. The main-process reducer dispatches
    // process_exited BEFORE this renderer-side IPC notification fires, so
    // the lifecycle is already "idle" by the time the listener runs (the
    // next loadStream therefore observes idle and takes the launch
    // branch). PR 3.2e — `setIsReadyToReveal(false)` is gone from the
    // listener; the renderer-side reveal flip is now owned by the phase
    // reducer's `process_gone` (dispatched by the lifecycle subscription
    // when state.kind === "idle", see useMpvPlaybackEngine.ts:266).
    // `deriveIsReadyToReveal(idle) === false`, so the loading UI flips
    // synchronously when the lifecycle subscriber observes the transition.
    // The exit-message handler only awaits flushProgress() now.
    const exitBlock =
      source.match(/onMpvExternalMessage\?\.\(async \(msg\)[\s\S]*?\n {4}\}\)/)?.[0] ?? "";
    const flushIndex = exitBlock.indexOf("flushProgress()");
    console.info(
      `[playback-progress-exit-source:exit-reveal] exitBlock len=${exitBlock.length} flushIndex=${flushIndex} hasReveal=${exitBlock.includes("setIsReadyToReveal")}`,
    );
    if (
      !exitBlock ||
      !exitBlock.includes('msg.type !== "exit"') ||
      flushIndex < 0 ||
      exitBlock.includes("setIsReadyToReveal")
    ) {
      dumpProgressExitSnapshot("exit-reveal-block", { flushIndex, exitBlock });
    }
    expect(exitBlock).toBeTruthy();
    expect(exitBlock).toContain('msg.type !== "exit"');
    expect(flushIndex).toBeGreaterThan(-1);
    // Reveal flip is owned by the phase machine (process_gone in the
    // lifecycle subscription) — this listener does NOT call
    // setIsReadyToReveal directly.
    expect(exitBlock).not.toContain("setIsReadyToReveal");
  });

  /**
   * @test-id DESKTOP-PLAYBACK-PROGRESS-002
   * @level source-contract
   * @bugfix
   * @regression-proof
   *
   * Phase-5 close-out: the mpv-exit listener must `await flushProgress()`
   * before clearing `setExternalMpvSessionActive(false)`. The prior
   * fire-and-forget `.finally()` shape let the listener return while the
   * IPC round-trip (renderer → main → runtime → SQLite write +
   * snapshot push) was still in flight, which leaves the renderer with
   * stale progressPct for users who navigate to the title immediately
   * after stopping playback. Tests downstream of mpv-exit (pipeline-smoke,
   * playback-e2e) raced the same window.
   */
  it("@bugfix @regression-proof mpv exit handler awaits flushProgress before clearing session-active flag", () => {
    const source = readSource("src/renderer/src/lib/useMpvPlaybackEngine.ts");
    const exitBlock =
      source.match(/onMpvExternalMessage\?\.\(async \(msg\)[\s\S]*?\n {4}\}\)/)?.[0] ?? "";
    const finallyIndex = exitBlock.indexOf("} finally {");
    const clearIndex = exitBlock.indexOf("setExternalMpvSessionActive(false)");
    console.info(
      `[playback-progress-exit-source:await-flush] hasAwaitFlush=${exitBlock.includes("await flushProgress()")} finallyIndex=${finallyIndex} clearIndex=${clearIndex}`,
    );
    if (
      !exitBlock ||
      !/onMpvExternalMessage\?\.\(async\s+\(msg\)/.test(exitBlock) ||
      !exitBlock.includes("await flushProgress()") ||
      finallyIndex < 0 ||
      clearIndex <= finallyIndex
    ) {
      dumpProgressExitSnapshot("await-flush-block", { finallyIndex, clearIndex, exitBlock });
    }
    expect(exitBlock).toBeTruthy();
    // The listener must be `async` so we can `await` inside it.
    expect(exitBlock).toMatch(/onMpvExternalMessage\?\.\(async\s+\(msg\)/);
    // The flush must be awaited (NOT fire-and-forget via `.finally`).
    expect(exitBlock).toContain("await flushProgress()");
    // The session-active flag must be cleared in a finally block so it
    // still runs even when flushProgress throws.
    expect(finallyIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(finallyIndex);
  });

  /**
   * @test-id DESKTOP-PLAYBACK-PROGRESS-003
   * @level source-contract
   * @bugfix
   * @regression-proof
   *
   * Phase-5 close-out: setProgress writes must bypass the 200ms snapshot
   * emit throttle so the renderer observes the new progressPct with
   * sub-frame latency. The accessor calls
   * `refreshAndEmitProxySnapshot({ force: true })` for setProgress and
   * other future force-flush methods registered in
   * `FORCE_FLUSH_METHODS`. Without this, a user stopping playback then
   * navigating back to the title sees the stale resume position for up
   * to 200ms — and integration tests reading getMediaDetails 500ms after
   * playback exit raced the throttle window.
   */
  it("@bugfix @regression-proof libraryDbAccessor force-flushes the snapshot for setProgress writes", () => {
    const source = readSource("src/main/libraryDbAccessor.ts");
    // The set must include "setProgress" specifically.
    const forceFlushSet =
      source.match(/FORCE_FLUSH_METHODS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    console.info(
      `[playback-progress-exit-source:force-flush] hasConst=${source.includes("FORCE_FLUSH_METHODS")} setBody=${JSON.stringify(forceFlushSet.trim())}`,
    );
    if (
      !source.includes("FORCE_FLUSH_METHODS") ||
      !forceFlushSet.includes('"setProgress"') ||
      !/refreshAndEmitProxySnapshot\(\s*\{\s*force\b/.test(source)
    ) {
      dumpProgressExitSnapshot("force-flush-set", { forceFlushSet });
    }
    expect(source).toContain("FORCE_FLUSH_METHODS");
    expect(forceFlushSet).toContain('"setProgress"');
    // The accessor must call refreshAndEmitProxySnapshot with `{ force }`
    // (or an equivalent shape) so the throttle is bypassed.
    expect(source).toMatch(/refreshAndEmitProxySnapshot\(\s*\{\s*force\b/);
  });
});
