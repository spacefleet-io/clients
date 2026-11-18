/**
 * @bugfix @regression-proof
 *
 * effervescent-teapot Round 11 K1: produced-cache must survive `bun --hot`
 * re-evaluation of `deps-adapter.ts`.
 *
 * Background — round-10 forensics:
 * - User-facing failure: "ingest job failed, yet the movie became playable
 *   anyway". `runtime_jobs.db` showed status=failed for the source job, but
 *   the local library SQLite had the 1080p row already written.
 * - Root cause: a SECOND `bun --hot src/index.ts` runtime process spawned
 *   mid-job (port-3020 conflict during a supervised restart). The new
 *   process re-evaluated `deps-adapter.ts`, which re-initialized the
 *   module-scoped `producedCache: Map = new Map()` to empty. The engine
 *   then ticked once, hit `STEP_COMMIT_PRODUCED_MISSING` because the cache
 *   miss propagated through commit, and overwrote runtime_jobs.db with
 *   status=failed before crashing on EADDRINUSE.
 * - The library write itself had completed in the FIRST runtime, so the
 *   movie became playable — but the user-visible job status was wrong.
 *
 * Round 11 K1 fix (this test guards):
 * - Pivot `producedCache` to a `globalThis`-keyed slot via
 *   `Symbol.for("@space/runtime/badger-step-deps/produced-cache/v1")`. The
 *   slot lives at the JS-realm level, so a hot re-evaluation of
 *   deps-adapter.ts does NOT wipe the cache. Same pattern as round-8
 *   (deps registry) and round-9 I2 (badgerModule slot).
 * - This is documented Bun pattern for HMR state preservation:
 *   https://bun.sh/docs/runtime/watch-mode#hot-mode (`globalThis.x ??=`).
 *
 * What this test does NOT cover:
 * - Cross-process restart (different PID, fresh JS realm). That case is
 *   handled by the K2 disk-fallback (`recoverProducedMediaFromState`); see
 *   `badger-deps-commit-disk-fallback.test.ts`.
 *
 * The test simulates HMR via `vi.resetModules()` + dynamic re-import — the
 * closest analog to `bun --hot` available in vitest. The module's top-level
 * code runs again in a fresh module instance, but `globalThis` is shared,
 * so the cache must remain reachable from the reloaded module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBadgerStepDepsAdapter,
  buildBadgerStepDeps,
  type ProcessMediaJobFn,
} from "../src/modules/badger/steps/deps-adapter";

const buildLibraryDb = () =>
  ({ call: vi.fn(async () => null) }) as unknown as Parameters<
    typeof buildBadgerStepDeps
  >[0]["libraryDb"];

const buildProducedFixture = () => ({
  videoFormats: [
    {
      quality: "1080p",
      codec: "h264",
      codecString: "avc1.640028",
      initKey: "shards/dev/init-1",
      initSize: 2048,
      durationSeconds: 60,
      totalSize: 1_048_576,
      chunks: [{ key: "shards/dev/seg-1", sizeBytes: 1_046_528, startSeconds: 0 }],
    },
  ],
  audioTracks: [],
  subtitleTracks: [],
});

const buildProcessMediaJobMock = (produced: ReturnType<typeof buildProducedFixture>): ProcessMediaJobFn =>
  vi.fn(async () => ({ produced, encoder: "cpu" as const })) as unknown as ProcessMediaJobFn;

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps uploaded result + module-scope cache shape on
// assertion failure. Wrapped in try/catch so a dump-failure cannot mask the
// original assertion failure.
// ---------------------------------------------------------------------------
const dumpHmrCacheSnapshot = (
  label: string,
  ctx: {
    uploaded?: unknown;
    producedExpected?: unknown;
    captured?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-deps-produced-cache-hmr-resilience:${label}] snapshot ===`);
    if (ctx.uploaded !== undefined) {
      const u = ctx.uploaded as { produced?: { videoFormats?: Array<{ quality?: string; initKey?: string }> } };
      console.error(
        `uploaded.produced.videoFormats=\n${JSON.stringify(u?.produced?.videoFormats, null, 2)}`,
      );
    }
    if (ctx.producedExpected !== undefined) {
      const p = ctx.producedExpected as { videoFormats?: Array<{ quality?: string; initKey?: string }> };
      console.error(
        `producedExpected.videoFormats=\n${JSON.stringify(p?.videoFormats, null, 2)}`,
      );
    }
    if (ctx.captured !== undefined) {
      const message =
        ctx.captured instanceof Error ? ctx.captured.message : String(ctx.captured);
      console.error(`captured error=${JSON.stringify(message)}`);
    }
    // Reveal whether the global slot is present + count entries.
    const slotKey = Symbol.for("@space/runtime/badger-step-deps/produced-cache/v1");
    const slot = (globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>)[slotKey];
    console.error(
      `globalThis-slot present=${slot !== undefined} entries=${slot instanceof Map ? slot.size : "(not-a-map)"}`,
    );
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  console.info(`[badger-deps-produced-cache-hmr-resilience:setup] resetting adapter`);
  __resetBadgerStepDepsAdapter();
});

afterEach(() => {
  console.info(`[badger-deps-produced-cache-hmr-resilience:teardown] resetting adapter`);
  __resetBadgerStepDepsAdapter();
});

describe("@bugfix @regression-proof Round-11 K1 — produced-cache survives HMR re-eval (globalThis-stash)", () => {
  it("after a cache populate, the same `produced` is retrievable via uploadOutputs", async () => {
    console.info(`[badger-deps-produced-cache-hmr-resilience:populate] building deps + producing fixture`);
    const produced = buildProducedFixture();
    const deps = buildBadgerStepDeps({
      libraryDb: buildLibraryDb(),
      processMediaJob: buildProcessMediaJobMock(produced),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    try {
      const ctrl = new AbortController();
      console.info(`[badger-deps-produced-cache-hmr-resilience:populate] calling extractSource`);
      await deps.extractSource({
        userId: "u1",
        jobId: "j1",
        placementId: "placement-j1",
        inputPath: "/tmp/movie.mkv",
        signal: ctrl.signal,
      });

      // Sanity: the cache is now populated. Calling uploadOutputs reads from
      // the same cache and finds the produced object.
      console.info(`[badger-deps-produced-cache-hmr-resilience:populate] calling uploadOutputs`);
      const uploaded = await deps.uploadOutputs({
        userId: "u1",
        jobId: "j1",
        placementId: "placement-j1",
        token: "tok",
        scope: "source",
        signal: ctrl.signal,
      });
      console.info(`[badger-deps-produced-cache-hmr-resilience:populate] uploaded.produced same-ref=${uploaded.produced === produced}`);
      expect(uploaded.produced).toBe(produced);
    } catch (err) {
      dumpHmrCacheSnapshot("populate-failure", { producedExpected: produced, captured: err });
      throw err;
    }
  });

  it("registry survives hot re-evaluation of deps-adapter.ts (globalThis-backed slot)", async () => {
    console.info(`[badger-deps-produced-cache-hmr-resilience:hmr] populating cache before hot re-eval`);
    // Walk the same anti-pattern that round-10 hit in production:
    //   1) populate the cache via the current module instance
    //   2) `vi.resetModules()` simulates `bun --hot` re-evaluating the file
    //   3) re-import — top-level code runs fresh, including `producedCache =
    //      new Map()` — but the slot is on globalThis, so the cache
    //      contents must still be reachable from the reloaded module.
    const produced = buildProducedFixture();
    const deps = buildBadgerStepDeps({
      libraryDb: buildLibraryDb(),
      processMediaJob: buildProcessMediaJobMock(produced),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    let uploaded: Awaited<ReturnType<typeof deps.uploadOutputs>> | undefined;
    try {
      const ctrl = new AbortController();
      await deps.extractSource({
        userId: "u1",
        jobId: "j1",
        placementId: "placement-j1",
        inputPath: "/tmp/movie.mkv",
        signal: ctrl.signal,
      });

      // Simulate hot re-eval: drop the module-cache entry and re-import. Top-
      // level module code runs again. With the OLD module-scoped Map this
      // would reset and the next uploadOutputs would throw
      // STEP_UPLOAD_PRODUCED_MISSING (the round-10 commit-stage failure mode).
      // With globalThis-backed storage it survives.
      console.info(`[badger-deps-produced-cache-hmr-resilience:hmr] vi.resetModules() + dynamic re-import`);
      vi.resetModules();
      const reloaded = await import("../src/modules/badger/steps/deps-adapter");
      const reloadedDeps = reloaded.buildBadgerStepDeps({
        libraryDb: buildLibraryDb(),
        // The reloaded module has a fresh `processMediaJob` mock, but we don't
        // call extract this time — we go straight to uploadOutputs to prove
        // the cache from the previous module's extract is still visible.
        processMediaJob: vi.fn(async () => {
          throw new Error("processMediaJob should NOT be called — uploadOutputs reads from cache");
        }) as unknown as ProcessMediaJobFn,
        resolveToken: () => "tok",
        resolveLibraryKey: () => "lk",
      });

      console.info(`[badger-deps-produced-cache-hmr-resilience:hmr] uploadOutputs via reloaded module`);
      uploaded = await reloadedDeps.uploadOutputs({
        userId: "u1",
        jobId: "j1",
        placementId: "placement-j1",
        token: "tok",
        scope: "source",
        signal: ctrl.signal,
      });
      console.info(
        `[badger-deps-produced-cache-hmr-resilience:hmr] uploaded.produced.videoFormats[0]=${JSON.stringify({ quality: uploaded!.produced.videoFormats[0]?.quality, initKey: uploaded!.produced.videoFormats[0]?.initKey })}`,
      );

      // Structural equality — the cache survived the re-eval.
      expect(uploaded!.produced.videoFormats[0]?.quality).toBe("1080p");
      expect(uploaded!.produced.videoFormats[0]?.initKey).toBe("shards/dev/init-1");
      expect(uploaded!.produced.videoFormats[0]?.chunks[0]?.key).toBe("shards/dev/seg-1");
    } catch (err) {
      dumpHmrCacheSnapshot("hmr-failure", { uploaded, producedExpected: produced, captured: err });
      throw err;
    }
  });

  it("__resetBadgerStepDepsAdapter clears the slot's Map in place — visible through subsequent uploadOutputs", async () => {
    console.info(`[badger-deps-produced-cache-hmr-resilience:reset] populating before reset`);
    // The reset helper must clear the same Map that the slot holds, so a
    // re-import after reset doesn't see stale entries. This proves the
    // reset clears the slot's *contents* (not just rebinding to a new Map),
    // which is the right semantics: external holders of the same Map ref
    // see the clear too.
    const produced = buildProducedFixture();
    const deps = buildBadgerStepDeps({
      libraryDb: buildLibraryDb(),
      processMediaJob: buildProcessMediaJobMock(produced),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    try {
      const ctrl = new AbortController();
      await deps.extractSource({
        userId: "u1",
        jobId: "j1",
        placementId: "placement-j1",
        inputPath: "/tmp/movie.mkv",
        signal: ctrl.signal,
      });

      console.info(`[badger-deps-produced-cache-hmr-resilience:reset] calling __resetBadgerStepDepsAdapter`);
      __resetBadgerStepDepsAdapter();

      // After reset, the cache is empty. uploadOutputs throws the
      // round-11-updated error message which now mentions disk-recover failure.
      console.info(`[badger-deps-produced-cache-hmr-resilience:reset] expecting STEP_UPLOAD_PRODUCED_MISSING throw`);
      await expect(
        deps.uploadOutputs({
          userId: "u1",
          jobId: "j1",
          placementId: "placement-j1",
          token: "tok",
          scope: "source",
          signal: ctrl.signal,
        })
      ).rejects.toThrow(/STEP_UPLOAD_PRODUCED_MISSING/);
    } catch (err) {
      dumpHmrCacheSnapshot("reset-failure", { producedExpected: produced, captured: err });
      throw err;
    }
  });
});
