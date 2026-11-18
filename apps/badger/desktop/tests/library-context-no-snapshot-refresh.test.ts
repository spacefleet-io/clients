/**
 * @bugfix @regression-proof
 *
 * Pre-fix bug: runOptimisticWrite called `requestSnapshotRefresh(db)` after
 * every successful optimistic write. That refresh IPC-invokes
 * `db.getSnapshot()` on main, which walks the entire library (N+1
 * getMediaDetails) and blocks the main process event loop. User symptom:
 * "changing the default audio/sub track ... slows down the ui for a good
 * 5-10s after the radio button is checked".
 *
 * Post-fix: runOptimisticWrite no longer issues a snapshot refresh on
 * success. The optimistic transform itself is the complete state update —
 * every existing caller (setDefaultAudio/SubtitleTrack, update/remove
 * audio/subtitle tracks, setProgress) precisely mirrors what the DB will
 * write. A round-trip "confirmation" of the same data is wasteful AND
 * blocks UI.
 *
 * This source-pin test prevents a regression that re-introduces the
 * post-success snapshot refresh. If a future refactor adds back
 * `requestSnapshotRefresh` inside the runOptimisticWrite success path,
 * the assertion fails loudly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Dump the extracted runOptimisticWrite body (or its absence) on assertion
// failure so a regex/source drift is diagnosable offline. try/catch so a dump
// failure can't mask the real expect().
const dumpLibraryContextSnapshot = (
  label: string,
  ctx: { sourcePath: string; sourceLen: number; body: string; matched: boolean },
) => {
  try {
    console.error(`=== [library-context-no-snapshot-refresh:${label}] snapshot ===`);
    console.error(`sourcePath=${ctx.sourcePath} sourceLen=${ctx.sourceLen} bodyMatched=${ctx.matched}`);
    console.error(`runOptimisticWrite body:\n${ctx.body || "(no match — regex failed to capture body)"}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@bugfix @regression-proof runOptimisticWrite has no auto snapshot refresh", () => {
  const sourcePath = resolve(process.cwd(), "src/renderer/src/lib/libraryContext.tsx");
  console.info(`[library-context-no-snapshot-refresh:setup] reading source ${sourcePath}`);
  const source = readFileSync(sourcePath, "utf8");
  console.info(`[library-context-no-snapshot-refresh:setup] source length=${source.length} chars`);

  it("does not call requestSnapshotRefresh inside runOptimisticWrite", () => {
    // Capture the runOptimisticWrite body and assert no snapshot refresh
    // sneaks back in. The body extends until the closing }, [...]); of the
    // useCallback.
    const match = source.match(
      /const runOptimisticWrite = useCallback\([\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\);/,
    );
    const body = match?.[0] ?? "";
    const hasRequestRefresh = /requestSnapshotRefresh\s*\(/.test(body);
    const hasRefreshSnapshot = /refreshSnapshot\s*\(/.test(body);
    console.info(
      `[library-context-no-snapshot-refresh:no-refresh] bodyMatched=${match !== null} bodyLen=${body.length} hasRequestSnapshotRefresh=${hasRequestRefresh} hasRefreshSnapshot=${hasRefreshSnapshot}`,
    );
    if (match === null || hasRequestRefresh || hasRefreshSnapshot) {
      dumpLibraryContextSnapshot("no-refresh", {
        sourcePath,
        sourceLen: source.length,
        body,
        matched: match !== null,
      });
    }
    expect(match).not.toBeNull();
    expect(body).not.toMatch(/requestSnapshotRefresh\s*\(/);
    expect(body).not.toMatch(/refreshSnapshot\s*\(/);
  });

  it("explicitly resolves immediately after triggering the background write", () => {
    // The function returns `Promise.resolve()` so callers that `await`
    // don't perceive latency. If a refactor changes this to await the
    // write or a refresh, ABR + track-editor latency regresses.
    const match = source.match(
      /const runOptimisticWrite = useCallback\([\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\);/,
    );
    const body = match?.[0] ?? "";
    const resolvesImmediately = /return Promise\.resolve\(\);/.test(body);
    console.info(
      `[library-context-no-snapshot-refresh:resolve-immediate] bodyMatched=${match !== null} bodyLen=${body.length} resolvesImmediately=${resolvesImmediately}`,
    );
    if (!resolvesImmediately) {
      dumpLibraryContextSnapshot("resolve-immediate", {
        sourcePath,
        sourceLen: source.length,
        body,
        matched: match !== null,
      });
    }
    expect(body).toMatch(/return Promise\.resolve\(\);/);
  });
});
