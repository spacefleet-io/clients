/**
 * @bugfix @regression-proof
 *
 * effervescent-teapot Round-12 #1: source-job commit must fail-fast with a
 * loud, actionable error when the `media_items` row referenced by the job's
 * `mediaId` is missing — instead of letting `linkFileToMedia` blow up with the
 * cryptic SQLite chain `errno: 787 / SQLITE_CONSTRAINT_FOREIGNKEY / FOREIGN
 * KEY constraint failed`.
 *
 * Background — rounds 6/9/10/11 forensics:
 * - User-facing failure: source job stalls at "Committing", error message
 *   `FOREIGN KEY constraint failed` persists in `runtime_jobs.db`. The
 *   underlying constraint is `media_files.media_id → media_items(id)` defined
 *   in `packages/library-db-definition/src/migrations.ts:323`.
 * - Reproduces when the desktop's `addMediaFromTmdb` either (a) hasn't been
 *   called for the job's `hints.mediaId` yet, or (b) was called but the row
 *   was deleted before commit ran (logout, attachMetadata-vs-engine race).
 * - Round-10 evidence: media_id `38fb783b-...`, group `4373f4f8-...`. Same
 *   shape on every reproduction across rounds 6, 9, 10, 11.
 *
 * Round-12 #1 fix (this test guards):
 * - Before invoking `linkFileToMedia`, the source-scope commit calls
 *   `getMediaDetails(mediaId)`. A null result throws
 *   `STEP_COMMIT_MEDIA_ITEM_MISSING:<mediaId>` with a hint pointing at the
 *   desktop addMediaFromTmdb / attach_metadata pipeline.
 * - linkFileToMedia is NOT invoked when the row is missing — runtime_jobs.db
 *   gets the actionable error code instead of the opaque SQLite FK chain.
 *
 * What this test does NOT cover:
 * - Submit-time validation (a separate, larger fix that'd require the runtime
 *   to read the library DB during submitSources). The commit-time guard is
 *   the minimal defensive layer that converts the FK failure into a
 *   diagnosable error AND survives the "row deleted mid-job" race that any
 *   submit-time check can't guarantee against.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBadgerStepDepsAdapter,
  buildBadgerStepDeps,
  type ProcessMediaJobFn,
} from "../src/modules/badger/steps/deps-adapter";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";

const buildProducedFixture = (): ProducedMedia => ({
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

const buildProcessMediaJobMock = (): ProcessMediaJobFn =>
  vi.fn(async () => {
    throw new Error("processMediaJob should NOT be called from commit-only test");
  }) as unknown as ProcessMediaJobFn;

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps recorded libraryDb calls + mediaId on assertion
// failure. Wrapped in try/catch so the dump itself can't mask the original.
// ---------------------------------------------------------------------------
const dumpFkGuardSnapshot = (
  label: string,
  ctx: {
    calls?: Array<{ method: string; args: unknown[] }>;
    libraryDb?: unknown;
    captured?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-deps-commit-fk-guard:${label}] snapshot ===`);
    if (ctx.calls) {
      console.error(
        `libraryDb.calls (${ctx.calls.length})=\n${JSON.stringify(ctx.calls, null, 2)}`,
      );
    }
    if (ctx.libraryDb) {
      const maybeFn = (ctx.libraryDb as { call?: { mock?: { calls?: unknown[] } } }).call;
      console.error(
        `libraryDb.call.callCount=${maybeFn?.mock?.calls?.length ?? "(not-a-vi-fn)"}`,
      );
    }
    if (ctx.captured !== undefined) {
      const message =
        ctx.captured instanceof Error ? ctx.captured.message : String(ctx.captured);
      console.error(`captured error=${JSON.stringify(message)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

beforeEach(() => {
  console.info(`[badger-deps-commit-fk-guard:setup] resetting adapter`);
  __resetBadgerStepDepsAdapter();
});

afterEach(() => {
  console.info(`[badger-deps-commit-fk-guard:teardown] resetting adapter`);
  __resetBadgerStepDepsAdapter();
});

describe("@bugfix @regression-proof Round-12 #1 — commit guards against missing media_items row", () => {
  it("source-scope commit throws STEP_COMMIT_MEDIA_ITEM_MISSING when getMediaDetails returns null", async () => {
    console.info(
      `[badger-deps-commit-fk-guard:missing-throws] setup — getMediaDetails returns null`,
    );
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        calls.push({ method, args: args ?? [] });
        // Simulate the user-visible repro: media_items row is absent for the
        // mediaId carried by the source job. Pre-fix, this returned null at
        // getMediaDetails (or wasn't called) and linkFileToMedia would FK-fail
        // inside SQLite. Post-fix, the commit step catches it BEFORE
        // linkFileToMedia.
        if (method === "getMediaDetails") return null;
        if (method === "linkFileToMedia") return "file-1";
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    try {
      const ctrl = new AbortController();
      await expect(
        deps.commit({
          userId: "u1",
          jobId: "j1",
          mediaId: "38fb783b-2aaa-47db-be68-3513f9e6b8d0",
          filename: "movie.mkv",
          scope: "source",
          produced: buildProducedFixture(),
          signal: ctrl.signal,
        })
      ).rejects.toThrow(/STEP_COMMIT_MEDIA_ITEM_MISSING:38fb783b-2aaa-47db-be68-3513f9e6b8d0/);

      console.info(
        `[badger-deps-commit-fk-guard:missing-throws] after commit; calls=${JSON.stringify(calls.map((c) => c.method))}`,
      );
      // Critical: linkFileToMedia must NOT have been invoked. Pre-fix this is
      // exactly the call that surfaced the cryptic SQLite FK error.
      expect(calls.find((c) => c.method === "getMediaDetails")).toBeDefined();
      expect(calls.find((c) => c.method === "linkFileToMedia")).toBeUndefined();
    } catch (err) {
      dumpFkGuardSnapshot("missing-throws", { calls, libraryDb });
      throw err;
    }
  });

  it("source-scope commit error message points at the addMediaFromTmdb / attach_metadata pipeline", async () => {
    console.info(`[badger-deps-commit-fk-guard:error-message] setup`);
    const libraryDb = {
      call: vi.fn(async (method: string) => {
        if (method === "getMediaDetails") return null;
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    let captured: unknown;
    try {
      await deps.commit({
        userId: "u1",
        jobId: "j1",
        mediaId: "stale-uuid",
        filename: "movie.mkv",
        scope: "source",
        produced: buildProducedFixture(),
        signal: ctrl.signal,
      });
    } catch (err) {
      captured = err;
    }
    const message = captured instanceof Error ? captured.message : String(captured);
    console.info(
      `[badger-deps-commit-fk-guard:error-message] captured message=${JSON.stringify(message)}`,
    );
    try {
      // Operator-facing diagnostic must mention the desktop pipeline that owns
      // creating the row, so log readers can route the fix without spelunking.
      expect(message).toContain("addMediaFromTmdb");
      expect(message).toContain("attach_metadata");
    } catch (err) {
      dumpFkGuardSnapshot("error-message", { captured, libraryDb });
      throw err;
    }
  });

  it("source-scope commit proceeds normally when getMediaDetails returns a row", async () => {
    console.info(`[badger-deps-commit-fk-guard:source-happy-path] setup`);
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        calls.push({ method, args: args ?? [] });
        if (method === "getMediaDetails") {
          // Real getMediaDetails returns a MediaDetails object; we only need
          // truthiness here.
          return { id: "media-orchard", title: "Orchard", type: "movie" };
        }
        if (method === "linkFileToMedia") return "file-orchard-src";
        if (method === "addMediaFormat") return "fmt-1080p-row";
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    const result = await deps.commit({
      userId: "u1",
      jobId: "j1",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "source",
      produced: buildProducedFixture(),
      signal: ctrl.signal,
    });
    console.info(
      `[badger-deps-commit-fk-guard:source-happy-path] commit returned; fileId=${result.fileId} formatIds=${JSON.stringify(result.formatIds)} call-order=${JSON.stringify(calls.map((c) => c.method))}`,
    );

    try {
      expect(result.fileId).toBe("file-orchard-src");
      expect(result.formatIds).toEqual(["fmt-1080p-row"]);

      // Order-of-operations assertion: the existence check fires BEFORE
      // linkFileToMedia (the FK-bearing INSERT). Without this ordering the
      // pre-fix FK error returns.
      const checkIdx = calls.findIndex((c) => c.method === "getMediaDetails");
      const linkIdx = calls.findIndex((c) => c.method === "linkFileToMedia");
      expect(checkIdx).toBeGreaterThanOrEqual(0);
      expect(linkIdx).toBeGreaterThanOrEqual(0);
      expect(checkIdx).toBeLessThan(linkIdx);
    } catch (err) {
      dumpFkGuardSnapshot("source-happy-path", {
        calls,
        libraryDb,
        extra: { result },
      });
      throw err;
    }
  });

  it("format-scope commit does NOT pre-check media_items (parent source job already wrote it)", async () => {
    console.info(`[badger-deps-commit-fk-guard:format-no-precheck] setup`);
    // The format-job branch passes sourceFileId from the parent source job.
    // The parent already pre-checked + wrote media_items. Adding another
    // getMediaDetails round-trip per format would double the calls without
    // catching anything new — the source job FK-pre-check is the single
    // chokepoint.
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        calls.push({ method, args: args ?? [] });
        if (method === "addMediaFormat") return "fmt-360p-row";
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    const result = await deps.commit({
      userId: "u1",
      jobId: "fmt-360p",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "format",
      variant: "360p",
      produced: buildProducedFixture(),
      sourceFileId: "file-orchard-src",
      signal: ctrl.signal,
    });
    console.info(
      `[badger-deps-commit-fk-guard:format-no-precheck] commit returned; fileId=${result.fileId} methods-called=${JSON.stringify(calls.map((c) => c.method))}`,
    );

    try {
      expect(result.fileId).toBe("file-orchard-src");
      // Format branch must NOT add the new pre-check round-trip — it would be
      // wasted work and would also invert the rationale (format-job mediaId is
      // sourced from the same source-job groupId, already validated).
      expect(calls.find((c) => c.method === "getMediaDetails")).toBeUndefined();
    } catch (err) {
      dumpFkGuardSnapshot("format-no-precheck", {
        calls,
        libraryDb,
        extra: { result },
      });
      throw err;
    }
  });
});
