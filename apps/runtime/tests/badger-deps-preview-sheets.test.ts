/**
 * @test-id RUNTIME-BADGER-PREVIEW-SHEETS-001
 * @level unit
 * @why MPV-PREV-02 (runtime half): the seek-bar preview sheets are made after the source commit, never in front
 *      of it, and either land on the source format or leave storage.
 *        1. The source commit returns (the video is committed and the commit step marks it playable) while the
 *           preview step is still blocked; once it finishes, the record goes on the source row only.
 *        2. A preview failure releases the sheets it had already uploaded.
 *        3. A format that went away before the record landed gets its sheets released too.
 *        4. RT-LIFE-04: a runtime restart mid-preview loses nothing. The pending run is kept on disk beside the job
 *           dir; the next start releases the sheets the cut run had uploaded and runs it again to a record.
 *           A pending run whose source file is gone, or whose format already has its record, is dropped.
 *        5. A start removes the work dir a cut run left (unencrypted frames).
 *        6. Shutdown aborts the decode and keeps the run pending; a media deleted mid-run aborts the decode and
 *           releases the sheets already uploaded.
 *        7. A queued run belongs to the user whose import committed it: after a switch to another user (or while
 *           no user is signed in, only a replayed key loaded) it is kept pending and never encrypted or uploaded
 *           with the other session's key and token.
 * @covers apps/runtime/src/modules/badger/steps/deps-adapter.ts: commit
 * @covers apps/runtime/src/modules/badger/steps/previewSheetsAfterCommit.ts: createPreviewSheetsRunner
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { __resetBadgerStepDepsAdapter, buildBadgerStepDeps } from "../src/modules/badger/steps/deps-adapter";
import type { ProducePreviewSheetsFn } from "../src/modules/badger/steps/previewSheetsAfterCommit";

const SUITE = "badger-deps-preview-sheets";
const PLACEMENT = "0123456789abcdef0123456789abcdef";

const PREVIEWS: MediaPreviewSheets = {
  version: 1,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 90,
  columns: 10,
  rows: 10,
  pictureCount: 12,
  sheets: [{ objectKey: "obj-preview-0", sizeBytes: 9_000, firstPicture: 0, pictureCount: 12 }],
};

const format = (quality: string): ProducedMedia["videoFormats"][number] => ({
  quality,
  codec: "h264",
  codecString: "avc1.640028",
  initKey: `media/${PLACEMENT}/init-${quality}`,
  initSize: 900,
  durationSeconds: 60,
  totalSize: 10_000,
  chunks: [{ key: `media/${PLACEMENT}/seg-${quality}`, sizeBytes: 9_100, startSeconds: 0 }],
});

type Call = { method: string; args: unknown[] };

const setup = (opts: {
  produce: ProducePreviewSheetsFn;
  recordAnswer?: boolean;
  /** What `getMediaFormatPreviewSheets` answers on resume (default: the format exists without a record). */
  stored?:
    | { previewSheets: MediaPreviewSheets | null }
    | null
    | (() => { previewSheets: MediaPreviewSheets | null } | null | Promise<{ previewSheets: MediaPreviewSheets | null } | null>);
  inputPath?: string;
  /** Backend token (default "tok"); null while the session is not back. */
  token?: () => string | null;
  /** Library key (default "lk"). */
  libraryKey?: () => string | null;
  /** The user the runtime's open session belongs to (default "u1", the importing user); a function when it changes mid-test. */
  activeUserId?: string | null | (() => string | null);
  authPollMs?: number;
}) => {
  const calls: Call[] = [];
  const released: string[][] = [];
  let nextFormatId = 1;
  const libraryDb = {
    call: vi.fn(async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      if (method === "getMediaDetails") return { id: "m1", title: "Movie", type: "movie" };
      if (method === "linkFileToMedia") return "file-1";
      if (method === "addMediaFormat") return `fmt-${nextFormatId++}`;
      if (method === "setMediaFormatPreviewSheets") return opts.recordAnswer ?? true;
      if (method === "getMediaFormatPreviewSheets") {
        const stored = typeof opts.stored === "function" ? opts.stored() : opts.stored;
        return stored === undefined ? { previewSheets: null } : stored;
      }
      return null;
    }),
  } as unknown as BadgerLibraryDbService;
  const deps = buildBadgerStepDeps({
    libraryDb,
    processMediaJob: async () => {
      throw new Error("processMediaJob must not run in this suite");
    },
    resolveToken: opts.token ?? (() => "tok"),
    resolveLibraryKey: opts.libraryKey ?? (() => "lk"),
    resolveActiveUserId: () => (typeof opts.activeUserId === "function" ? opts.activeUserId() : opts.activeUserId === undefined ? "u1" : opts.activeUserId),
    authPollMs: opts.authPollMs,
    deleteStorageKeys: async (_token, keys) => {
      released.push([...keys]);
      return { deleted: keys.length, reclaimedBytes: 0 };
    },
    producePreviewSheets: opts.produce,
    previewFormatCheckMs: 10,
  });
  const commit = (jobId = "j1") =>
    deps.commit({
      userId: "u1",
      jobId,
      mediaId: "m1",
      filename: opts.inputPath ?? "/media/Movie.mkv",
      scope: "source",
      sourceQuality: "1080p",
      produced: { videoFormats: [format("1080p"), format("360p")], audioTracks: [], subtitleTracks: [] },
      signal: new AbortController().signal,
    });
  return { calls, released, commit, deps };
};

let transcodeDir = "";

/** A run a previous runtime left pending, as `<job dir>.previews.json`. */
const writePendingRun = (userId: string, jobId: string, inputPath: string, uploaded: string[]) => {
  mkdirSync(join(transcodeDir, userId), { recursive: true });
  const path = join(transcodeDir, userId, `${jobId}.previews.json`);
  const job = { userId, jobId, mediaId: "m1", formatId: "fmt-1", inputPath, durationSeconds: 60, initKey: `media/${PLACEMENT}/init-1080p` };
  writeFileSync(path, JSON.stringify({ version: 1, job, uploaded }));
  return path;
};
beforeEach(() => {
  __resetBadgerStepDepsAdapter();
  transcodeDir = mkdtempSync(join(tmpdir(), "sf-preview-runs-"));
  process.env.SF_TRANSCODE_DIR = transcodeDir;
});
afterEach(() => {
  delete process.env.SF_TRANSCODE_DIR;
  rmSync(transcodeDir, { recursive: true, force: true });
  __resetBadgerStepDepsAdapter();
  vi.restoreAllMocks();
});

describe("seek-bar preview sheets after the source commit (MPV-PREV-02)", () => {
  it("@req MPV-PREV-02 the source commit returns while the preview step is blocked; the record then lands on the source row", async () => {
    const { promise: blocked, resolve: unblock } = Promise.withResolvers<void>();
    const produceArgs: Array<Parameters<ProducePreviewSheetsFn>[0]> = [];
    const { calls, released, commit } = setup({
      produce: async (args) => {
        produceArgs.push(args);
        await blocked;
        args.onSheetUploaded?.("obj-preview-0");
        return PREVIEWS;
      },
    });

    const result = await commit();
    console.info(`[${SUITE}:blocked] commit=${JSON.stringify(result)} produceCalls=${produceArgs.length} methods=${JSON.stringify(calls.map((c) => c.method))}`);
    expect(result.formatIds).toEqual(["fmt-1", "fmt-2"]);
    await vi.waitFor(() => expect(produceArgs).toHaveLength(1));
    expect(calls.some((c) => c.method === "setMediaFormatPreviewSheets")).toBe(false);
    // The formats were written without any preview record.
    for (const call of calls.filter((c) => c.method === "addMediaFormat")) {
      expect(call.args[7]).not.toHaveProperty("previewSheets");
    }
    // The sheets are encrypted with the user's library key; the run is queued outside any import's key context.
    expect(produceArgs[0]).toMatchObject({ token: "tok", libraryKeyBase64: "lk", inputPath: "/media/Movie.mkv", durationSeconds: 60, placementId: PLACEMENT });
    expect(produceArgs[0]!.workDir.endsWith("j1.previews")).toBe(true);

    unblock();
    await vi.waitFor(() => expect(calls.some((c) => c.method === "setMediaFormatPreviewSheets")).toBe(true));
    const recorded = calls.filter((c) => c.method === "setMediaFormatPreviewSheets");
    console.info(`[${SUITE}:blocked] recorded=${JSON.stringify(recorded)} released=${JSON.stringify(released)}`);
    expect(recorded).toEqual([{ method: "setMediaFormatPreviewSheets", args: ["fmt-1", PREVIEWS] }]);
    expect(released).toEqual([]);
  });

  it("@req MPV-PREV-02 a preview failure releases the sheets it had already uploaded and records nothing", async () => {
    const { calls, released, commit } = setup({
      produce: async (args) => {
        args.onSheetUploaded?.("obj-preview-0");
        throw new Error("UPLOAD_QUOTA_EXCEEDED");
      },
    });
    await commit();
    await vi.waitFor(() => expect(released).toHaveLength(1));
    console.info(`[${SUITE}:failure] released=${JSON.stringify(released)}`);
    expect(released).toEqual([["obj-preview-0"]]);
    expect(calls.some((c) => c.method === "setMediaFormatPreviewSheets")).toBe(false);
  });

  it("@req MPV-PREV-02 a format gone before the record lands gets its sheets released", async () => {
    const { released, commit } = setup({
      recordAnswer: false,
      produce: async (args) => {
        args.onSheetUploaded?.("obj-preview-0");
        return PREVIEWS;
      },
    });
    await commit();
    await vi.waitFor(() => expect(released).toHaveLength(1));
    console.info(`[${SUITE}:gone] released=${JSON.stringify(released)}`);
    expect(released).toEqual([["obj-preview-0"]]);
  });
  it("@req MPV-PREV-02 a restart mid-preview releases the cut run's sheets and runs it again to a record (RT-LIFE-04)", async () => {
    const source = join(transcodeDir, "Movie.mkv");
    writeFileSync(source, "video");
    // First runtime: the run uploads one sheet, then the runtime stops before it finishes.
    const cut = setup({
      inputPath: source,
      produce: async (args) => {
        args.onSheetUploaded?.("obj-cut-0");
        await new Promise<never>(() => {});
        return PREVIEWS;
      },
    });
    await cut.commit();
    await vi.waitFor(() => expect(cut.calls.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    console.info(`[${SUITE}:restart] cut run pending, uploaded obj-cut-0`);

    // Next start: a fresh runtime (new deps, nothing in memory) finds the pending run on disk.
    __resetBadgerStepDepsAdapter();
    const produceArgs: Array<Parameters<ProducePreviewSheetsFn>[0]> = [];
    const next = setup({
      inputPath: source,
      produce: async (args) => {
        produceArgs.push(args);
        args.onSheetUploaded?.("obj-preview-0");
        return PREVIEWS;
      },
    });
    await next.deps.resumePreviewSheets?.();
    const recorded = next.calls.filter((c) => c.method === "setMediaFormatPreviewSheets");
    console.info(`[${SUITE}:restart] released=${JSON.stringify(next.released)} recorded=${JSON.stringify(recorded)}`);
    expect(next.released).toEqual([["obj-cut-0"]]);
    expect(produceArgs).toHaveLength(1);
    expect(produceArgs[0]).toMatchObject({ inputPath: source, durationSeconds: 60, placementId: PLACEMENT });
    expect(recorded).toEqual([{ method: "setMediaFormatPreviewSheets", args: ["fmt-1", PREVIEWS] }]);

    // Done means done: a later start finds nothing left to run.
    __resetBadgerStepDepsAdapter();
    const after = setup({ inputPath: source, produce: async () => PREVIEWS });
    await after.deps.resumePreviewSheets?.();
    expect(after.calls).toEqual([]);
  });

  it("@req MPV-PREV-02 a pending run whose source file is gone, or whose format already has its record, is dropped", async () => {
    for (const [label, inputPath, stored] of [
      ["source gone", join(transcodeDir, "gone.mkv"), { previewSheets: null }],
      ["already recorded", join(transcodeDir, "Movie.mkv"), { previewSheets: PREVIEWS }],
    ] as const) {
      writeFileSync(join(transcodeDir, "Movie.mkv"), "video");
      __resetBadgerStepDepsAdapter();
      const cut = setup({ inputPath, produce: () => new Promise<never>(() => {}) });
      await cut.commit();
      __resetBadgerStepDepsAdapter();
      const produce = vi.fn(async () => PREVIEWS);
      const next = setup({ inputPath, stored, produce });
      await next.deps.resumePreviewSheets?.();
      console.info(`[${SUITE}:drop] ${label} produce=${produce.mock.calls.length} methods=${JSON.stringify(next.calls.map((c) => c.method))}`);
      expect(produce).not.toHaveBeenCalled();
      expect(next.calls.some((c) => c.method === "setMediaFormatPreviewSheets")).toBe(false);
      __resetBadgerStepDepsAdapter();
      const after = setup({ inputPath, produce });
      await after.deps.resumePreviewSheets?.();
      expect(after.calls).toEqual([]);
    }
  });
  it("@req MPV-PREV-02 a start removes the work dir a cut run left (unencrypted frames)", async () => {
    const stale = join(transcodeDir, "u1", "j-old.previews");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "pic-0001.png"), "frame");
    const { deps, calls } = setup({ produce: async () => PREVIEWS });
    await deps.resumePreviewSheets?.();
    console.info(`[${SUITE}:stale] exists=${existsSync(stale)} methods=${JSON.stringify(calls.map((c) => c.method))}`);
    expect(existsSync(stale)).toBe(false);
  });

  it("@req MPV-PREV-02 shutdown aborts the decode and keeps the run pending for the next start", async () => {
    let signal: AbortSignal | undefined;
    const { deps, released, commit } = setup({
      produce: (args) =>
        new Promise((_, reject) => {
          signal = args.signal;
          args.onSheetUploaded?.("obj-cut-0");
          args.signal?.addEventListener("abort", () => reject(new Error("ffmpeg killed")));
        }),
    });
    await commit();
    await vi.waitFor(() => expect(signal).toBeDefined());
    deps.stopPreviewSheets?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = join(transcodeDir, "u1", "j1.previews.json");
    console.info(`[${SUITE}:shutdown] aborted=${signal?.aborted} pending=${existsSync(pending)} released=${JSON.stringify(released)}`);
    expect(signal?.aborted).toBe(true);
    expect(released).toEqual([]);
    expect(existsSync(pending)).toBe(true);
  });

  it("@req MPV-PREV-02 a media deleted mid-run aborts the decode and releases the sheets already uploaded", async () => {
    let deleted = false;
    let signal: AbortSignal | undefined;
    const { calls, released, commit } = setup({
      stored: () => (deleted ? null : { previewSheets: null }),
      produce: (args) =>
        new Promise((_, reject) => {
          signal = args.signal;
          args.onSheetUploaded?.("obj-preview-0");
          args.signal?.addEventListener("abort", () => reject(new Error("ffmpeg killed")));
        }),
    });
    await commit();
    await vi.waitFor(() => expect(signal).toBeDefined());
    deleted = true;
    await vi.waitFor(() => expect(released).toHaveLength(1));
    console.info(`[${SUITE}:deleted] aborted=${signal?.aborted} released=${JSON.stringify(released)}`);
    expect(signal?.aborted).toBe(true);
    expect(released).toEqual([["obj-preview-0"]]);
    expect(calls.some((c) => c.method === "setMediaFormatPreviewSheets")).toBe(false);
    expect(existsSync(join(transcodeDir, "u1", "j1.previews.json"))).toBe(false);
  });
  it("@req MPV-PREV-02 a resumed run whose format already has its record never releases the sheets that record holds", async () => {
    const source = join(transcodeDir, "Movie.mkv");
    writeFileSync(source, "video");
    // The cut runtime recorded the sheets but died before removing its pending file; obj-cut-1 is a stray upload.
    const path = writePendingRun("u1", "j1", source, ["obj-preview-0", "obj-cut-1"]);
    const produce = vi.fn(async () => PREVIEWS);
    const { deps, released, calls } = setup({ inputPath: source, stored: { previewSheets: PREVIEWS }, produce });
    await deps.resumePreviewSheets?.();
    console.info(`[${SUITE}:recorded] released=${JSON.stringify(released)} methods=${JSON.stringify(calls.map((c) => c.method))}`);
    expect(released).toEqual([["obj-cut-1"]]);
    expect(produce).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("@req MPV-PREV-02 a resume skips a run this runtime queued while it waited for the session", async () => {
    const source = join(transcodeDir, "Movie.mkv");
    writeFileSync(source, "video");
    writePendingRun("u1", "j1", source, []);
    let token: string | null = null;
    const produce = vi.fn((): Promise<MediaPreviewSheets> => new Promise(() => {}));
    const { deps, commit } = setup({ inputPath: source, token: () => token, authPollMs: 300, produce });
    const resumed = deps.resumePreviewSheets?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The session comes back and the same job's commit queues its run before the resume wakes up.
    token = "tok";
    await commit();
    await vi.waitFor(() => expect(produce).toHaveBeenCalledTimes(1));
    await resumed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.info(`[${SUITE}:active] produce=${produce.mock.calls.length}`);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("@req MPV-PREV-02 another user's pending run is kept for when that user's session is back", async () => {
    const source = join(transcodeDir, "Movie.mkv");
    writeFileSync(source, "video");
    const path = writePendingRun("u1", "j1", source, ["obj-cut-0"]);
    const produce = vi.fn(async () => PREVIEWS);
    const { deps, released, calls } = setup({ inputPath: source, activeUserId: "u2", produce });
    await deps.resumePreviewSheets?.();
    console.info(`[${SUITE}:other-user] kept=${existsSync(path)} released=${JSON.stringify(released)} methods=${JSON.stringify(calls.map((c) => c.method))}`);
    expect(existsSync(path)).toBe(true);
    expect(released).toEqual([]);
    expect(produce).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("@req MPV-PREV-02 another user's run is kept when that user's session only shows up during the session wait", async () => {
    const source = join(transcodeDir, "Movie.mkv");
    writeFileSync(source, "video");
    const path = writePendingRun("u1", "j1", source, ["obj-cut-0"]);
    // At boot the replayed key set does not name the user: no token and no active user until the session attaches,
    // which here happens on the session wait's third poll.
    let polls = 0;
    let activeUserId: string | null = null;
    const token = () => {
      polls += 1;
      if (polls < 3) return null;
      activeUserId = "u2";
      return "tok-u2";
    };
    const produce = vi.fn(async () => PREVIEWS);
    const { deps, released, calls } = setup({ inputPath: source, token, activeUserId: () => activeUserId, authPollMs: 5, produce });
    await deps.resumePreviewSheets?.();
    console.info(`[${SUITE}:late-user] kept=${existsSync(path)} released=${JSON.stringify(released)} methods=${JSON.stringify(calls.map((c) => c.method))}`);
    expect(existsSync(path)).toBe(true);
    expect(released).toEqual([]);
    expect(produce).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("@req MPV-PREV-02 a commit that queues the same run while the resume reads the record runs it once", async () => {
    const source = join(transcodeDir, "Movie.mkv");
    writeFileSync(source, "video");
    writePendingRun("u1", "j1", source, ["obj-cut-0"]);
    const produce = vi.fn(async () => PREVIEWS);
    let reads = 0;
    let commitDuringRead: (() => Promise<unknown>) | null = null;
    const { deps, commit } = setup({
      inputPath: source,
      produce,
      // The resume's record read is the first one; the same job's commit lands (and queues its run) meanwhile.
      stored: async () => {
        reads += 1;
        if (reads === 1) await commitDuringRead?.();
        return { previewSheets: null };
      },
    });
    commitDuringRead = commit;
    await deps.resumePreviewSheets?.();
    await vi.waitFor(() => expect(produce).toHaveBeenCalled());
    console.info(`[${SUITE}:race] reads=${reads} produce=${produce.mock.calls.length}`);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("@req MPV-PREV-02 a run queued for one user is kept pending, not encrypted with the next user's key, after a user switch", async () => {
    const { promise: blocked, resolve: unblock } = Promise.withResolvers<void>();
    const session = { userId: "u1", token: "tok-a", key: "lk-a" };
    const produceArgs: Array<Parameters<ProducePreviewSheetsFn>[0]> = [];
    const { released, calls, commit } = setup({
      token: () => session.token,
      libraryKey: () => session.key,
      activeUserId: () => session.userId,
      produce: async (args) => {
        produceArgs.push(args);
        if (produceArgs.length === 1) await blocked;
        args.onSheetUploaded?.("obj-preview-0");
        return PREVIEWS;
      },
    });
    // User A's first run is decoding; A's second import commits and its run queues behind it.
    await commit("j0");
    await vi.waitFor(() => expect(produceArgs).toHaveLength(1));
    await commit("j1");
    const pendingA = join(transcodeDir, "u1", "j1.previews.json");
    expect(existsSync(pendingA)).toBe(true);
    const info = vi.spyOn(console, "info");
    const keptLogged = () => info.mock.calls.some((c) => String(c[0]).startsWith("[preview-sheets] skipped: not the signed-in user's run"));

    // The runtime switches to user B (the production key resolver ignores the user id: it answers B's key now).
    Object.assign(session, { userId: "u2", token: "tok-b", key: "lk-b" });
    unblock();
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "setMediaFormatPreviewSheets")).toHaveLength(1));
    // A's queued run settles: kept (fixed) or run with B's session (the bug).
    await vi.waitFor(() => expect(keptLogged() || produceArgs.length === 2).toBe(true));

    console.info(`[${SUITE}:user-switch] produce=${JSON.stringify(produceArgs.map((a) => ({ token: a.token, key: a.libraryKeyBase64, workDir: a.workDir })))} kept=${existsSync(pendingA)} released=${JSON.stringify(released)}`);
    expect(produceArgs.map((a) => a.libraryKeyBase64)).toEqual(["lk-a"]);
    expect(produceArgs.some((a) => a.token === "tok-b")).toBe(false);
    expect(existsSync(pendingA)).toBe(true);
    expect(released).toEqual([]);
  });

  it("@req MPV-PREV-02 with no signed-in user (only a replayed key loaded) a queued run is kept pending, not run with that key", async () => {
    const produce = vi.fn(async () => PREVIEWS);
    const { calls, released, commit } = setup({ activeUserId: null, produce });
    const info = vi.spyOn(console, "info");
    await commit();
    await vi.waitFor(() =>
      expect(produce.mock.calls.length > 0 || info.mock.calls.some((c) => String(c[0]).startsWith("[preview-sheets] skipped: not the signed-in user's run"))).toBe(true)
    );
    console.info(`[${SUITE}:no-user] produceCalls=${produce.mock.calls.length} kept=${existsSync(join(transcodeDir, "u1", "j1.previews.json"))}`);
    expect(produce).not.toHaveBeenCalled();
    expect(existsSync(join(transcodeDir, "u1", "j1.previews.json"))).toBe(true);
    expect(calls.some((c) => c.method === "setMediaFormatPreviewSheets")).toBe(false);
    expect(released).toEqual([]);
  });
});
