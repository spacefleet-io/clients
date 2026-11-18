/**
 * @bugfix @regression-proof
 *
 * effervescent-teapot Round 11 K2: commit and uploadOutputs must fall back
 * to disk-loaded `${jobDir}/job_state.json` when the in-memory
 * `producedCache` is empty.
 *
 * Background — round-10 forensics:
 * - User-facing failure: "ingest job failed, yet the movie became playable
 *   anyway".
 * - Pre-fix: a second runtime process spawned mid-job (HMR re-eval, or
 *   port-conflicting respawn). The new process saw an empty in-memory
 *   `producedCache` and threw `STEP_COMMIT_PRODUCED_MISSING`, overwriting
 *   `runtime_jobs.db` with status=failed even though the FIRST runtime had
 *   already written all the library rows correctly.
 * - K1 (globalThis-stash) prevents same-process HMR from wiping the cache.
 * - K2 (this fix) handles the cross-process case: a fresh runtime can
 *   reconstruct `ProducedMedia` from `${jobDir}/job_state.json` which the
 *   legacy mediaFinalize keeps in sync with each upload completion.
 *
 * Round 11 K2 fix (this test guards):
 * - Both `uploadOutputs` and `commit` chain
 *   `cache → recoverProducedMediaFromState() → throw`. The disk-fallback
 *   reads `${jobDir}/job_state.json` and rebuilds the same shape.
 * - The reconstructed `ProducedMedia` is structurally equivalent to what
 *   `processMediaJob` returned in-memory — same videoFormats, audioTracks,
 *   subtitleTracks shape with `initKey + chunks[]`.
 *
 * The shape used here matches a real round-10 `job_state.json` captured
 * from `<repo>/apps/runtime/.runtime/transcode/...`
 * — `init` with `key + uploaded:true + sizeBytes`, segments with `key +
 * uploaded:true + sizeBytes + startSeconds`, `encodingComplete:true`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBadgerStepDepsAdapter,
  buildBadgerStepDeps,
  recoverProducedMediaFromState,
  type ProcessMediaJobFn,
} from "../src/modules/badger/steps/deps-adapter";

const ORIGINAL_TRANSCODE_DIR = process.env.SF_TRANSCODE_DIR;

const buildLibraryDb = () =>
  ({
    call: vi.fn(async (method: string) => {
      if (method === "linkFileToMedia") return "file-1";
      if (method === "addMediaFormat") return "fmt-1";
      return null;
    }),
  }) as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

const buildProcessMediaJobMock = (): ProcessMediaJobFn =>
  vi.fn(async () => {
    throw new Error("processMediaJob should NOT be invoked — disk-fallback path runs");
  }) as unknown as ProcessMediaJobFn;

/**
 * Real-shape job_state.json fragment — mirrors a round-10 captured state
 * (see apps/runtime/.runtime/transcode/<userId>/<jobId>/job_state.json).
 */
const buildPersistedJobState = () => ({
  version: 1,
  inputPath: "/tmp/movie.mkv",
  userId: "u1",
  createdAt: "2026-04-28T15:47:32.525Z",
  outputs: [
    {
      id: "video-source",
      kind: "video",
      segmentSeconds: 12,
      outputDir: "/tmp/jobs/j1/outputs/video-source",
      init: {
        path: "/tmp/jobs/j1/outputs/video-source/init-0.mp4",
        key: "shards/dev/init-1080p",
        uploaded: true,
        sizeBytes: 2963,
        checksum: "abcd",
      },
      segments: [
        {
          path: "/tmp/jobs/j1/outputs/video-source/seg-00001.m4s",
          startSeconds: 0,
          uploaded: true,
          key: "shards/dev/seg-1080p-1",
          sizeBytes: 6_031_960,
          checksum: "ef01",
        },
        {
          path: "/tmp/jobs/j1/outputs/video-source/seg-00002.m4s",
          startSeconds: 12.762,
          uploaded: true,
          key: "shards/dev/seg-1080p-2",
          sizeBytes: 10_230_176,
          checksum: "ef02",
        },
      ],
      quality: "1080p",
      codec: "h264",
      durationSeconds: 60,
      encodingComplete: true,
      codecString: "avc1.640028",
      chapters: [{ title: "Opening", startSeconds: 0 }],
    },
  ],
  subtitles: [],
});

let scratchDir = "";

// ---------------------------------------------------------------------------
// Diagnostic snapshot helper — dumps scratch dir, mock call args, env state on
// assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpDepsDiskFallbackSnapshot = (
  label: string,
  ctx: {
    libraryDb?: { call: ReturnType<typeof vi.fn> };
    processMediaJob?: ReturnType<typeof vi.fn>;
    libraryDbCalls?: Array<{ method: string; args: unknown }>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(
      `=== [badger-deps-disk-fallback:${label}] snapshot ===`,
    );
    console.error(
      `scratchDir=${scratchDir} SF_TRANSCODE_DIR=${process.env.SF_TRANSCODE_DIR}`,
    );
    if (ctx.libraryDb) {
      console.error(
        `libraryDb.call.calls=${JSON.stringify(ctx.libraryDb.call.mock?.calls ?? "(not-a-vi-fn)", null, 2)}`,
      );
    }
    if (ctx.libraryDbCalls) {
      console.error(
        `recorded libraryDb calls (${ctx.libraryDbCalls.length})=\n${JSON.stringify(ctx.libraryDbCalls, null, 2)}`,
      );
    }
    if (ctx.processMediaJob) {
      console.error(
        `processMediaJob.callCount=${ctx.processMediaJob.mock?.calls?.length ?? "(not-a-vi-fn)"}`,
      );
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
  __resetBadgerStepDepsAdapter();
  scratchDir = mkdtempSync(joinPath(tmpdir(), "round11-k2-disk-fallback-"));
  process.env.SF_TRANSCODE_DIR = scratchDir;
  console.info(
    `[badger-deps-disk-fallback:setup] reset adapter; scratchDir=${scratchDir}`,
  );
});

afterEach(() => {
  console.info(
    `[badger-deps-disk-fallback:teardown] reset adapter; removing scratchDir=${scratchDir}`,
  );
  __resetBadgerStepDepsAdapter();
  if (ORIGINAL_TRANSCODE_DIR === undefined) delete process.env.SF_TRANSCODE_DIR;
  else process.env.SF_TRANSCODE_DIR = ORIGINAL_TRANSCODE_DIR;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("@bugfix @regression-proof Round-11 K2 — recoverProducedMediaFromState reconstruction", () => {
  it("returns null when state file is missing", () => {
    console.info(
      `[badger-deps-disk-fallback:recover-missing] no state file on disk; expect null`,
    );
    const result = recoverProducedMediaFromState("u-missing", "j-missing");
    console.info(
      `[badger-deps-disk-fallback:recover-missing] result=${result === null ? "null" : "(non-null)"}`,
    );
    try {
      expect(result).toBeNull();
    } catch (err) {
      dumpDepsDiskFallbackSnapshot("recover-missing-failure", {
        extra: { result },
      });
      throw err;
    }
  });

  it("rebuilds ProducedMedia from a real-shape job_state.json (uploaded segments + init)", () => {
    const userId = "u1";
    const jobId = "j1";
    const jobDir = joinPath(scratchDir, userId, jobId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      joinPath(jobDir, "job_state.json"),
      JSON.stringify(buildPersistedJobState())
    );
    console.info(
      `[badger-deps-disk-fallback:recover-real-shape] wrote state to ${jobDir}/job_state.json`,
    );

    const result = recoverProducedMediaFromState(userId, jobId);
    console.info(
      `[badger-deps-disk-fallback:recover-real-shape] result.videoFormats=${result?.videoFormats.length} audio=${result?.audioTracks.length} subs=${result?.subtitleTracks.length}`,
    );
    try {
      expect(result).not.toBeNull();
      expect(result?.videoFormats).toHaveLength(1);
      expect(result?.videoFormats[0]?.quality).toBe("1080p");
      expect(result?.videoFormats[0]?.codec).toBe("h264");
      expect(result?.videoFormats[0]?.codecString).toBe("avc1.640028");
      expect(result?.videoFormats[0]?.initKey).toBe("shards/dev/init-1080p");
      expect(result?.videoFormats[0]?.initSize).toBe(2963);
      expect(result?.videoFormats[0]?.durationSeconds).toBe(60);
      expect(result?.videoFormats[0]?.chunks).toHaveLength(2);
      expect(result?.videoFormats[0]?.chunks[0]?.key).toBe("shards/dev/seg-1080p-1");
      expect(result?.videoFormats[0]?.chunks[0]?.sizeBytes).toBe(6_031_960);
      expect(result?.videoFormats[0]?.chunks[1]?.startSeconds).toBeCloseTo(12.762);
      expect(result?.audioTracks).toHaveLength(0);
      expect(result?.subtitleTracks).toHaveLength(0);
    } catch (err) {
      dumpDepsDiskFallbackSnapshot("recover-real-shape-failure", {
        extra: { userId, jobId, jobDir, result },
      });
      throw err;
    }
  });

  it("returns null when an output is missing init.uploaded (incomplete encode)", () => {
    const userId = "u2";
    const jobId = "j2";
    const jobDir = joinPath(scratchDir, userId, jobId);
    mkdirSync(jobDir, { recursive: true });
    const incomplete = buildPersistedJobState();
    incomplete.outputs[0]!.init!.uploaded = false;
    writeFileSync(
      joinPath(jobDir, "job_state.json"),
      JSON.stringify(incomplete)
    );
    console.info(
      `[badger-deps-disk-fallback:recover-init-not-uploaded] wrote state with init.uploaded=false; expect null`,
    );

    const result = recoverProducedMediaFromState(userId, jobId);
    try {
      expect(result).toBeNull();
    } catch (err) {
      dumpDepsDiskFallbackSnapshot("recover-init-not-uploaded-failure", {
        extra: { userId, jobId, result },
      });
      throw err;
    }
  });

  it("returns null when no segments are uploaded", () => {
    const userId = "u3";
    const jobId = "j3";
    const jobDir = joinPath(scratchDir, userId, jobId);
    mkdirSync(jobDir, { recursive: true });
    const incomplete = buildPersistedJobState();
    for (const seg of incomplete.outputs[0]!.segments) seg.uploaded = false;
    writeFileSync(
      joinPath(jobDir, "job_state.json"),
      JSON.stringify(incomplete)
    );
    console.info(
      `[badger-deps-disk-fallback:recover-segs-not-uploaded] wrote state with all segments uploaded=false; expect null`,
    );

    const result = recoverProducedMediaFromState(userId, jobId);
    try {
      expect(result).toBeNull();
    } catch (err) {
      dumpDepsDiskFallbackSnapshot("recover-segs-not-uploaded-failure", {
        extra: { userId, jobId, result },
      });
      throw err;
    }
  });

  it("returns null on JSON parse failure", () => {
    const userId = "u4";
    const jobId = "j4";
    const jobDir = joinPath(scratchDir, userId, jobId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(joinPath(jobDir, "job_state.json"), "{not json");
    console.info(
      `[badger-deps-disk-fallback:recover-bad-json] wrote malformed json; expect null (no throw)`,
    );

    const result = recoverProducedMediaFromState(userId, jobId);
    try {
      expect(result).toBeNull();
    } catch (err) {
      dumpDepsDiskFallbackSnapshot("recover-bad-json-failure", {
        extra: { userId, jobId, result },
      });
      throw err;
    }
  });
});

describe("@bugfix @regression-proof Round-11 K2 — uploadOutputs falls back to disk on cache miss", () => {
  it("uploadOutputs returns the disk-recovered produced when cache is empty", async () => {
    const userId = "u1";
    const jobId = "j1";
    const jobDir = joinPath(scratchDir, userId, jobId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      joinPath(jobDir, "job_state.json"),
      JSON.stringify(buildPersistedJobState())
    );
    console.info(
      `[badger-deps-disk-fallback:upload-disk-recover] wrote state file; cache reset; calling uploadOutputs`,
    );

    // Cache is empty (the beforeEach reset cleared it). uploadOutputs would
    // pre-fix throw STEP_UPLOAD_PRODUCED_MISSING; with K2 it falls through
    // to the disk-recover and returns the reconstructed produced.
    const libraryDb = buildLibraryDb();
    const processMediaJob = buildProcessMediaJobMock();
    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob,
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    const result = await deps.uploadOutputs({
      userId,
      jobId,
      placementId: "placement-disk-fallback",
      token: "tok",
      scope: "source",
      signal: ctrl.signal,
    });
    console.info(
      `[badger-deps-disk-fallback:upload-disk-recover] result.videoFormats=${result.produced.videoFormats.length} uploadedKeys=${JSON.stringify(result.uploadedKeys)}`,
    );
    try {
      expect(result.produced.videoFormats).toHaveLength(1);
      expect(result.produced.videoFormats[0]?.initKey).toBe("shards/dev/init-1080p");
      expect(result.uploadedKeys).toContain("shards/dev/init-1080p");
      expect(result.uploadedKeys).toContain("shards/dev/seg-1080p-1");
      expect(result.uploadedKeys).toContain("shards/dev/seg-1080p-2");
    } catch (err) {
      dumpDepsDiskFallbackSnapshot("upload-disk-recover-failure", {
        libraryDb: libraryDb as unknown as { call: ReturnType<typeof vi.fn> },
        processMediaJob: processMediaJob as ReturnType<typeof vi.fn>,
        extra: { userId, jobId, result },
      });
      throw err;
    }
  });

  it("uploadOutputs throws the round-11-updated error when both cache AND disk are empty", async () => {
    console.info(
      `[badger-deps-disk-fallback:upload-both-empty] no state file; cache empty; expect STEP_UPLOAD_PRODUCED_MISSING + "cache miss + disk reconstruction failed"`,
    );
    // No state file written. Cache is empty. Both paths fail.
    const libraryDb = buildLibraryDb();
    const processMediaJob = buildProcessMediaJobMock();
    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob,
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    try {
      await expect(
        deps.uploadOutputs({
          userId: "no-such-user",
          jobId: "no-such-job",
          placementId: "placement-no-such-job",
          token: "tok",
          scope: "source",
          signal: ctrl.signal,
        })
      ).rejects.toThrow(/STEP_UPLOAD_PRODUCED_MISSING.*cache miss \+ disk reconstruction failed/);
    } catch (err) {
      dumpDepsDiskFallbackSnapshot("upload-both-empty-failure", {
        libraryDb: libraryDb as unknown as { call: ReturnType<typeof vi.fn> },
        processMediaJob: processMediaJob as ReturnType<typeof vi.fn>,
      });
      throw err;
    }
  });
});

describe("@bugfix @regression-proof Round-11 K2 — commit falls back to disk on cache miss", () => {
  it("commit reconstructs produced from disk and proceeds with library writes", async () => {
    const userId = "u1";
    const jobId = "j1";
    const jobDir = joinPath(scratchDir, userId, jobId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      joinPath(jobDir, "job_state.json"),
      JSON.stringify(buildPersistedJobState())
    );
    console.info(
      `[badger-deps-disk-fallback:commit-disk-recover] wrote state file; calling commit (input.produced undefined; cache empty)`,
    );

    const libraryDbCalls: Array<{ method: string; args: unknown }> = [];
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown) => {
        libraryDbCalls.push({ method, args });
        // Round-12 #1: the source-scope commit pre-checks media_items via
        // getMediaDetails before linkFileToMedia (FK guard). Return a truthy
        // value here so the pre-check passes and the disk-fallback exercise
        // proceeds to the library writes it actually validates.
        if (method === "getMediaDetails") return { id: "media-1", title: "Movie", type: "movie" };
        if (method === "linkFileToMedia") return "file-1";
        if (method === "addMediaFormat") return "fmt-1";
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const processMediaJob = buildProcessMediaJobMock();
    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob,
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    // Note: input.produced is undefined (the engine's payload may not carry
    // it after a process restart) AND the in-memory cache is empty. Disk-
    // fallback is the ONLY way commit can find the produced shape.
    const result = await deps.commit({
      userId,
      jobId,
      mediaId: "media-1",
      filename: "movie.mkv",
      scope: "source",
      signal: ctrl.signal,
    });
    console.info(
      `[badger-deps-disk-fallback:commit-disk-recover] result.fileId=${result.fileId} formatIds=${JSON.stringify(result.formatIds)}; libraryDb methods=${JSON.stringify(libraryDbCalls.map((c) => c.method))}`,
    );

    try {
      expect(result.fileId).toBe("file-1");
      expect(result.formatIds).toEqual(["fmt-1"]);
      // linkFileToMedia + addMediaFormat (+ chapters) — proves we drove
      // through the source-job commit branch with reconstructed produced.
      expect(libraryDbCalls.find((c) => c.method === "linkFileToMedia")).toBeDefined();
      expect(libraryDbCalls.find((c) => c.method === "addMediaFormat")).toBeDefined();
    } catch (err) {
      dumpDepsDiskFallbackSnapshot("commit-disk-recover-failure", {
        libraryDb: libraryDb as unknown as { call: ReturnType<typeof vi.fn> },
        libraryDbCalls,
        processMediaJob: processMediaJob as ReturnType<typeof vi.fn>,
        extra: { userId, jobId, result },
      });
      throw err;
    }
  });

  it("commit throws the round-11-updated error when both cache AND disk are empty", async () => {
    console.info(
      `[badger-deps-disk-fallback:commit-both-empty] no state file; cache empty; expect STEP_COMMIT_PRODUCED_MISSING + "cache miss + disk reconstruction failed"`,
    );
    const libraryDb = buildLibraryDb();
    const processMediaJob = buildProcessMediaJobMock();
    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob,
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    try {
      await expect(
        deps.commit({
          userId: "no-such-user",
          jobId: "no-such-job",
          mediaId: "media-1",
          filename: "movie.mkv",
          scope: "source",
          signal: ctrl.signal,
        })
      ).rejects.toThrow(/STEP_COMMIT_PRODUCED_MISSING.*cache miss \+ disk reconstruction failed/);
    } catch (err) {
      dumpDepsDiskFallbackSnapshot("commit-both-empty-failure", {
        libraryDb: libraryDb as unknown as { call: ReturnType<typeof vi.fn> },
        processMediaJob: processMediaJob as ReturnType<typeof vi.fn>,
      });
      throw err;
    }
  });
});
