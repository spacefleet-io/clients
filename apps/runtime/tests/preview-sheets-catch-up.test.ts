/**
 * @test-id RUNTIME-PREVIEW-CATCH-UP-001
 * @level unit
 * @why MPV-PREV-03: the videos already in the library get their seek-bar previews without a re-import. A background
 *      pass on this computer's runtime goes through the signed-in user's videos that have none (the title watched last first, LibraryDb's order), one at
 *      a time, and stands down while an import or a playback runs. Its input is only ever read from the vault
 *      (Chris 2026-11-24): the stored source downloaded and decrypted, or the 360p copy when the stored source is too
 *      heavy, or the smallest stored copy when only the skip signature is missing, plus the file's default audio
 *      track for the signature's sound. A failed video is retried at most 3 times, an hour apart, and the count survives
 *      a restart (RT-LIFE-04).
 * @covers apps/runtime/src/modules/badger/previewSheetsCatchUp.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewSheetCandidate, SkipCatchUpVideo } from "@space/shared/libraryTypes";
import { StorageTunnelError } from "@space/shared/storageTunnel";
import {
  chooseCatchUpSource,
  createPreviewSheetsCatchUp,
  type PreviewCatchUpAudioTrack,
  type PreviewCatchUpDeps,
  type PreviewCatchUpFormat,
} from "../src/modules/badger/previewSheetsCatchUp";
import {
  PreviewCatchUpSkip,
  type PreviewSheetsCatchUpOptions,
  type PreviewSheetsJob,
  type PreviewSheetsOutcome,
} from "../src/modules/badger/steps/previewSheetsAfterCommit";

const SUITE = "preview-catch-up";
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

let root = "";

const candidate = (formatId: string, addedAt: string, extra: Partial<PreviewSheetCandidate> = {}): PreviewSheetCandidate => ({
  formatId,
  mediaId: `m-${formatId}`,
  fileId: `file-${formatId}`,
  // An episode: a film gets no signature, so no sound is downloaded for it (PLAY-SKIP-11).
  season: 1,
  episode: 1,
  addedAt,
  durationSeconds: 60,
  initKey: `media/p/init-${formatId}`,
  ...extra,
});

const audio = (id: string, fileId: string, isDefault: boolean): PreviewCatchUpAudioTrack => ({
  id,
  fileId,
  isDefault,
  initKey: `init-${id}`,
  totalSize: 30 * MiB,
  chunks: [{ key: `${id}-c0`, sizeBytes: 30 * MiB }],
});

const format = (id: string, fileId: string, quality: string, bytes: number): PreviewCatchUpFormat => ({
  id,
  fileId,
  quality,
  isSource: quality === "source",
  initKey: `init-${id}`,
  totalSize: bytes,
  chunks: [
    { key: `${id}-c0`, sizeBytes: bytes / 2 },
    { key: `${id}-c1`, sizeBytes: bytes / 2 },
  ],
});

type Harness = {
  deps: PreviewCatchUpDeps;
  runs: Array<{ job: PreviewSheetsJob; options: PreviewSheetsCatchUpOptions }>;
  logs: Array<{ event: string; payload: Record<string, unknown> }>;
  candidates: PreviewSheetCandidate[];
  /** What `listSkipCatchUpVideos` answers: every counted video with what its signature found. */
  library: SkipCatchUpVideo[];
  state: { busy: number; playback: boolean; now: number; total: number; open: boolean };
};

const setup = (opts: {
  candidates: PreviewSheetCandidate[];
  outcome?: (job: PreviewSheetsJob, options: PreviewSheetsCatchUpOptions) => Promise<PreviewSheetsOutcome>;
  formats?: Record<string, PreviewCatchUpFormat[]>;
  audioTracks?: Record<string, PreviewCatchUpAudioTrack[]>;
}): Harness => {
  const runs: Harness["runs"] = [];
  const logs: Harness["logs"] = [];
  const state = { busy: 0, playback: false, now: Date.parse("2026-10-30T12:00:00Z"), total: opts.candidates.length, open: true };
  const candidates = [...opts.candidates];
  const library: SkipCatchUpVideo[] = opts.candidates.map((c) => ({
    formatId: c.formatId,
    mediaId: c.mediaId,
    fileId: c.fileId,
    season: c.season,
    episode: c.episode,
    signed: false,
    intro: false,
    credits: false,
  }));
  const deps: PreviewCatchUpDeps = {
    libraryDb: {
      isOpen: () => state.open,
      call: async (method: string, args: unknown[] = []) => {
        if (method === "listPreviewSheetCandidates") {
          const input = args[0] as { limit: number; excludeFormatIds: string[] };
          return candidates
            .filter((c) => !input.excludeFormatIds.includes(c.formatId))
            .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
            .slice(0, input.limit);
        }
        if (method === "countPreviewSheetVideos") return state.total;
        if (method === "listSkipCatchUpVideos") return library;
        if (method === "listMediaFormats") {
          const mediaId = args[0] as string;
          return opts.formats?.[mediaId] ?? [];
        }
        if (method === "getMediaDetails") {
          const mediaId = args[0] as string;
          return { audioTracks: opts.audioTracks?.[mediaId] ?? [] };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    runCatchUp: async (job, options) => {
      runs.push({ job, options });
      const outcome = opts.outcome ? await opts.outcome(job, options) : "recorded";
      // A recorded video leaves the candidate list, as the library does once the record lands.
      if (outcome === "recorded") candidates.splice(candidates.findIndex((c) => c.formatId === job.formatId), 1);
      return outcome;
    },
    resolveUserId: () => "u1",
    resolveToken: () => "tok",
    resolveLibraryKey: () => "lk",
    countBusyIngestJobs: async () => state.busy,
    isPlaybackActive: () => state.playback,
    downloadObject: async (_token, key) => Buffer.from(`<${key}>`),
    probeBackend: async () => {},
    queuedImportFormatIds: () => [],
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stateRoot: () => join(root, "transcode"),
    log: (event, payload) => {
      logs.push({ event, payload });
      console.info(`[${SUITE}:log] ${event} ${JSON.stringify(payload)}`);
    },
    now: () => state.now,
    startDelayMs: 1_000,
    idleIntervalMs: 60_000,
  };
  return { deps, runs, logs, candidates, library, state };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-preview-catch-up-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("seek-bar preview catch-up pass (MPV-PREV-03)", () => {
  it("@req MPV-PREV-03 the input comes from the vault only: the stored source, the 360p copy when the source is heavy, the smallest copy for a signature alone, plus the default audio track", () => {
    const formats = [format("src", "f1", "1080p", 2 * GiB), format("p360", "f1", "360p", 100 * MiB), format("p720", "f1", "720p", 400 * MiB), format("other360", "f2", "360p", 50 * MiB)];
    const heavyFormats = [format("src", "f1", "1080p", 6 * GiB), ...formats.slice(1)];
    const audioTracks = [audio("fr", "f1", false), audio("en", "f1", true), audio("other", "f2", true)];
    const base = { formatId: "src", heavySourceBytes: 4 * GiB, audioTracks, withAudio: true };

    const full = chooseCatchUpSource({ ...base, formats, signatureOnly: false });
    const heavy = chooseCatchUpSource({ ...base, formats: heavyFormats, signatureOnly: false });
    const heavyNo360 = chooseCatchUpSource({ ...base, formats: [heavyFormats[0]!], signatureOnly: false });
    const signatureOnly = chooseCatchUpSource({ ...base, formats, signatureOnly: true });
    const sourceOnly = chooseCatchUpSource({ ...base, formats: [formats[0]!], signatureOnly: true });
    const noAudio = chooseCatchUpSource({ ...base, formats, signatureOnly: false, withAudio: false });
    console.info(`[${SUITE}:source] ${JSON.stringify({ full, heavy, heavyNo360, signatureOnly, sourceOnly, noAudio })}`);

    expect(full).toEqual({
      video: { id: "src", label: "1080p", keys: ["init-src", "src-c0", "src-c1"], bytes: 2 * GiB },
      audio: { id: "en", label: "audio", keys: ["init-en", "en-c0"], bytes: 30 * MiB },
    });
    expect(heavy?.video).toMatchObject({ id: "p360", label: "360p", keys: ["init-p360", "p360-c0", "p360-c1"] });
    expect(heavyNo360?.video).toMatchObject({ id: "src" });
    expect(signatureOnly?.video).toMatchObject({ id: "p360", bytes: 100 * MiB });
    expect(signatureOnly?.audio).toMatchObject({ id: "en" });
    expect(sourceOnly?.video).toMatchObject({ id: "src" });
    expect(noAudio?.audio).toBeNull();
    expect(chooseCatchUpSource({ ...base, formats, signatureOnly: true, audioTracks: [] })?.audio).toBeNull();
    expect(chooseCatchUpSource({ ...base, formats: [], signatureOnly: false })).toBeNull();
  });

  it("@req MPV-PREV-03 one pass makes every missing video newest first, one at a time, through the preview runner, downloading video and audio", async () => {
    const h = setup({
      candidates: [candidate("old", "2026-10-01T00:00:00Z"), candidate("new", "2026-10-29T00:00:00Z"), candidate("mid", "2026-10-15T00:00:00Z")],
      formats: {
        "m-new": [format("new", "file-new", "1080p", 4 * MiB)],
        "m-old": [format("old", "file-old", "1080p", 4 * MiB)],
        "m-mid": [format("mid", "file-mid", "1080p", 4 * MiB)],
      },
      audioTracks: { "m-new": [audio("new-a", "file-new", true)] },
    });
    let running = 0;
    let maxRunning = 0;
    const inputs: string[] = [];
    const orig = h.deps.runCatchUp;
    h.deps.runCatchUp = async (job, options) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      const dir = join(root, "src-dir", job.formatId);
      const { inputPath, audioPath } = await options.prepareInput(dir, new AbortController().signal, { signatureOnly: false });
      inputs.push(`${job.formatId}:${readFileSync(inputPath, "utf8")}|${audioPath ? readFileSync(audioPath, "utf8") : "-"}`);
      const outcome = await orig(job, options);
      running -= 1;
      return outcome;
    };
    const worker = createPreviewSheetsCatchUp(h.deps);

    const result = await worker.runPass("manual");
    console.info(`[${SUITE}:pass] result=${JSON.stringify(result)} inputs=${JSON.stringify(inputs)}`);

    expect(h.runs.map((r) => r.job.formatId)).toEqual(["new", "mid", "old"]);
    expect(maxRunning).toBe(1);
    expect(h.runs[0]!.job).toMatchObject({ userId: "u1", jobId: "catch-up-new", mediaId: "m-new", formatId: "new", durationSeconds: 60, initKey: "media/p/init-new" });
    expect(inputs).toEqual([
      "new:<init-new><new-c0><new-c1>|<init-new-a><new-a-c0>",
      "mid:<init-mid><mid-c0><mid-c1>|-",
      "old:<init-old><old-c0><old-c1>|-",
    ]);
    expect(result).toMatchObject({ stoppedBy: null, processed: 3, recorded: 3, failed: 0 });
  });

  it("@req MPV-PREV-03 a signatures-only run downloads the smallest stored copy and the audio track, never the source", async () => {
    const h = setup({
      candidates: [candidate("old", "2026-10-01T00:00:00Z", { season: 2, episode: 3 })],
      formats: { "m-old": [format("old", "file-old", "1080p", 4 * GiB), format("old360", "file-old", "360p", 100 * MiB)] },
      audioTracks: { "m-old": [audio("old-a", "file-old", true)] },
    });
    const downloads: string[] = [];
    h.deps.downloadObject = async (_token, key) => {
      downloads.push(key);
      return Buffer.from(`<${key}>`);
    };
    h.deps.runCatchUp = async (job, options) => {
      await options.prepareInput(join(root, "d", job.formatId), new AbortController().signal, { signatureOnly: true });
      return "recorded";
    };
    const result = await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    console.info(`[${SUITE}:signature-only] result=${JSON.stringify(result)} downloads=${JSON.stringify(downloads)}`);
    expect(downloads).toEqual(["init-old360", "old360-c0", "old360-c1", "init-old-a", "old-a-c0"]);
    expect(result).toMatchObject({ recorded: 1, failed: 0 });
  });

  it("@req MPV-PREV-03 it stands down while an import or a playback runs, and a run gives way when one starts", async () => {
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z"), candidate("b", "2026-10-01T00:00:00Z")] });
    const worker = createPreviewSheetsCatchUp(h.deps);

    h.state.busy = 1;
    expect(await worker.runPass("manual")).toMatchObject({ stoppedBy: "ingest_busy", processed: 0 });
    h.state.busy = 0;
    h.state.playback = true;
    expect(await worker.runPass("manual")).toMatchObject({ stoppedBy: "playback", processed: 0 });
    h.state.playback = false;
    expect(h.runs).toHaveLength(0);

    // A playback starts during the first run: the run sees it through shouldYield and gives way.
    const h2 = setup({
      candidates: [candidate("a", "2026-10-02T00:00:00Z"), candidate("b", "2026-10-01T00:00:00Z")],
      outcome: async (_job, options) => {
        expect(await options.shouldYield()).toBe(false);
        h2.state.playback = true;
        expect(await options.shouldYield()).toBe(true);
        return "yielded";
      },
    });
    const result = await createPreviewSheetsCatchUp(h2.deps).runPass("manual");
    console.info(`[${SUITE}:yield] result=${JSON.stringify(result)}`);
    expect(result).toMatchObject({ stoppedBy: "yielded", failed: 0 });
    expect(h2.runs.map((r) => r.job.formatId)).toEqual(["a"]);
    // Giving way is not a failure: nothing is written to the retry state.
    expect(() => readFileSync(join(root, "transcode", "u1", "previews-catch-up.json"), "utf8")).toThrow();
  });

  it("@req MPV-PREV-03 a failed video is retried at most 3 times, an hour apart, and the count survives a restart", async () => {
    const h = setup({ candidates: [candidate("bad", "2026-10-02T00:00:00Z")], outcome: async () => "failed" });
    const passAt = async (worker: ReturnType<typeof createPreviewSheetsCatchUp>) => worker.runPass("interval");

    expect(await passAt(createPreviewSheetsCatchUp(h.deps))).toMatchObject({ processed: 1, failed: 1 });
    // Within the hour: skipped. A fresh worker (a runtime restart) reads the same count.
    h.state.now += 30 * 60_000;
    expect(await passAt(createPreviewSheetsCatchUp(h.deps))).toMatchObject({ processed: 0 });
    h.state.now += 31 * 60_000;
    expect(await passAt(createPreviewSheetsCatchUp(h.deps))).toMatchObject({ processed: 1, failed: 1 });
    h.state.now += 61 * 60_000;
    expect(await passAt(createPreviewSheetsCatchUp(h.deps))).toMatchObject({ processed: 1, failed: 1 });
    h.state.now += 24 * 60 * 60_000;
    expect(await passAt(createPreviewSheetsCatchUp(h.deps))).toMatchObject({ processed: 0 });

    const stored = JSON.parse(readFileSync(join(root, "transcode", "u1", "previews-catch-up.json"), "utf8"));
    console.info(`[${SUITE}:retry] state=${JSON.stringify(stored)}`);
    expect(stored.formats.bad.failures).toBe(3);
    expect(h.runs).toHaveLength(3);
    const failures = h.logs.filter((l) => l.event === "[preview-catch-up] video.failed");
    expect(failures.map((l) => l.payload.giveUp)).toEqual([false, false, true]);
  });

  it("@req MPV-PREV-06 previewStatus tells the player a video is still waiting for its previews until the pass gives up on it", async () => {
    const h = setup({ candidates: [candidate("bad", "2026-10-02T00:00:00Z")], outcome: async () => "failed" });
    const worker = createPreviewSheetsCatchUp(h.deps);
    const status = () => {
      const s = worker.previewStatus("bad");
      console.info(`[${SUITE}:status] bad=${JSON.stringify(s)} now=${new Date(h.state.now).toISOString()}`);
      return s;
    };
    // Never tried, and a video the pass does not know: still to come.
    expect(status()).toEqual({ state: "pending", failures: 0, maxAttempts: 3 });
    expect(worker.previewStatus("unknown")).toEqual({ state: "pending", failures: 0, maxAttempts: 3 });
    await worker.runPass("interval");
    expect(status()).toEqual({ state: "pending", failures: 1, maxAttempts: 3 });
    h.state.now += 61 * 60_000;
    await worker.runPass("interval");
    h.state.now += 61 * 60_000;
    await worker.runPass("interval");
    // Third failure: the pass will not pick it again, so the player must not promise previews. A restart reads it too.
    expect(status()).toEqual({ state: "failed", failures: 3, maxAttempts: 3 });
    expect(createPreviewSheetsCatchUp(h.deps).previewStatus("bad")).toEqual({ state: "failed", failures: 3, maxAttempts: 3 });
    // Nobody signed in: no state to read, still to come.
    h.deps.resolveUserId = () => null;
    expect(createPreviewSheetsCatchUp(h.deps).previewStatus("bad")).toEqual({ state: "pending", failures: 0, maxAttempts: 3 });
  });

  it("@req MPV-PREV-07 catchUpStatus counts handled videos from the library, names the one running and the next, says why it waits, and lists the ones given up on", async () => {
    const h = setup({
      candidates: [
        candidate("e1", "2026-10-03T00:00:00Z", { mediaId: "show", season: 1, episode: 1 }),
        candidate("e2", "2026-10-02T00:00:00Z", { mediaId: "show", season: 1, episode: 2 }),
        candidate("bad", "2026-10-01T00:00:00Z", { mediaId: "film" }),
      ],
      outcome: async (job) => (job.formatId === "bad" ? "failed" : "recorded"),
    });
    h.state.total = 5; // two videos were done before
    const worker = createPreviewSheetsCatchUp(h.deps);
    const log = async (label: string) => {
      const s = await worker.catchUpStatus();
      console.info(`[${SUITE}:catch-up-status] ${label} ${JSON.stringify(s)}`);
      return s;
    };
    const first = await log("before");
    expect(first).toMatchObject({ state: "running", handled: 2, total: 5, failed: [], finishedAt: null });
    expect(first.current).toEqual({
      formatId: "e1",
      mediaId: "show",
      season: 1,
      episode: 1,
      running: false,
      phase: null,
      downloaded: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
    });

    // While a video runs it is the one named, marked running.
    let during: Awaited<ReturnType<typeof worker.catchUpStatus>> | null = null;
    const orig = h.deps.runCatchUp;
    h.deps.runCatchUp = async (job, options) => {
      if (job.formatId === "e2") during = await worker.catchUpStatus();
      return orig(job, options);
    };
    h.state.playback = false;
    // Give up on "bad" over three passes an hour apart.
    await worker.runPass("interval");
    expect(during).toMatchObject({ state: "running", handled: 3, current: { formatId: "e2", running: true } });
    h.state.now += 61 * 60_000;
    await worker.runPass("interval");
    h.state.now += 61 * 60_000;
    await worker.runPass("interval");
    const done = await log("done");
    expect(done).toMatchObject({ state: "done", handled: 5, total: 5, current: null });
    expect(done.failed).toEqual([{ formatId: "bad", mediaId: "film", season: 1, episode: 1 }]);
    expect(done.finishedAt).toBe(new Date(h.state.now).toISOString());
    // A restart reads the same counts from the library and the retry file; only finishedAt is this runtime's memory.
    expect(await createPreviewSheetsCatchUp(h.deps).catchUpStatus()).toMatchObject({ state: "done", handled: 5, failed: done.failed, finishedAt: null });

    // A new import adds a video: why it waits, in order playback, import, offline.
    h.candidates.push(candidate("new", "2026-10-29T00:00:00Z"));
    h.state.total = 6;
    h.state.playback = true;
    worker.playbackChanged(true);
    expect(await log("playback")).toMatchObject({ state: "paused_playback", handled: 5, total: 6, current: { formatId: "new", running: false }, finishedAt: null });
    worker.playbackChanged(false);
    h.state.playback = false;
    h.state.busy = 1;
    expect((await log("import")).state).toBe("paused_import");
    h.state.busy = 0;
    h.deps.probeBackend = async () => {
      throw new Error("fetch failed");
    };
    expect(await worker.runPass("interval")).toMatchObject({ stoppedBy: "offline" });
    expect((await log("offline")).state).toBe("offline");
    await worker.stop();

    // Nobody signed in: nothing to show.
    h.deps.resolveUserId = () => null;
    expect(await createPreviewSheetsCatchUp(h.deps).catchUpStatus()).toEqual({ state: "done", retryAt: null, handled: 0, total: 0, current: null, failed: [], cancelled: [], videos: [], finishedAt: null });
  });

  it("@req MPV-PREV-07 a video waiting out its hour after a failed try is never named next or queued: Jobs reads 'trying again at' until the pass takes it again", async () => {
    // Chris 2026-11-24 (Mad Men stuck in Jobs): A failed once and B ran; A sat "waiting, 1st in line" while the pass left it out.
    let aTries = 0;
    const h = setup({
      candidates: [
        candidate("a", "2026-10-03T00:00:00Z", { mediaId: "show", season: 1, episode: 6 }),
        candidate("b", "2026-10-02T00:00:00Z", { mediaId: "show", season: 1, episode: 7 }),
      ],
      outcome: async (job) => (job.formatId === "a" && aTries++ === 0 ? "failed" : "recorded"),
    });
    const worker = createPreviewSheetsCatchUp(h.deps);
    const log = async (label: string) => {
      const s = await worker.catchUpStatus();
      console.info(`[${SUITE}:retry-wait] ${label} ${JSON.stringify(s)}`);
      return s;
    };
    const failedAt = h.state.now;
    expect(await worker.runPass("interval")).toMatchObject({ processed: 2, failed: 1, recorded: 1 });
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a", "b"]);

    // Within the hour: A is neither current nor queued; the catch-up says when it tries again.
    h.state.now += 30 * 60_000;
    const retryAt = new Date(failedAt + 60 * 60_000).toISOString();
    const held = await log("held");
    expect(held).toMatchObject({ state: "retry_wait", retryAt, current: null, failed: [] });
    expect(held.videos.filter((v) => v.status !== "done")).toEqual([
      { formatId: "a", mediaId: "show", season: 1, episode: 6, status: "retry_waiting", result: null, failedStep: "download", retryAt },
    ]);
    expect(held.videos.some((v) => v.status === "queued")).toBe(false);
    // A restart reads the same hold from the retry file.
    expect(await createPreviewSheetsCatchUp(h.deps).catchUpStatus()).toMatchObject({ state: "retry_wait", retryAt, current: null });

    // Another video to make: it is next, the held one is listed after the queue.
    h.candidates.push(candidate("c", "2026-10-01T00:00:00Z", { mediaId: "show", season: 1, episode: 8 }));
    h.library.push({ formatId: "c", mediaId: "show", fileId: "file-c", season: 1, episode: 8, signed: false, intro: false, credits: false });
    const withC = await log("with-c");
    expect(withC).toMatchObject({ state: "running", retryAt: null, current: { formatId: "c", running: false } });
    expect(withC.videos.filter((v) => v.status !== "done").map((v) => [v.formatId, v.status])).toEqual([
      ["c", "queued"],
      ["a", "retry_waiting"],
    ]);
    expect(await worker.runPass("interval")).toMatchObject({ processed: 1, recorded: 1 });
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a", "b", "c"]);

    // After the hour: A is next again and the pass makes it.
    h.state.now += 31 * 60_000;
    expect(await log("after")).toMatchObject({ state: "running", retryAt: null, current: { formatId: "a" } });
    expect(await worker.runPass("interval")).toMatchObject({ processed: 1, recorded: 1 });
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a", "b", "c", "a"]);
    expect(await log("done")).toMatchObject({ state: "done", retryAt: null, current: null });
  });

  it("@req MPV-PREV-07 a video left for lack of disk room reads 'trying again at' with the room reason, and Try again now lets the pass take it at once", async () => {
    let room = false;
    const h = setup({
      candidates: [candidate("a", "2026-10-03T00:00:00Z", { mediaId: "show", season: 1, episode: 1 })],
      outcome: async () => (room ? "recorded" : "skipped"),
    });
    const worker = createPreviewSheetsCatchUp(h.deps);
    expect(await worker.runPass("interval")).toMatchObject({ processed: 0, skipped: 1 });
    h.state.now += 5 * 60_000;
    const held = await worker.catchUpStatus();
    console.info(`[${SUITE}:retry-wait-room] ${JSON.stringify(held)}`);
    expect(held).toMatchObject({ state: "retry_wait", current: null });
    expect(held.videos).toEqual([
      expect.objectContaining({ formatId: "a", status: "retry_waiting", failedStep: "room", retryAt: held.retryAt }),
    ]);
    room = true;
    worker.retry("a");
    expect(await worker.catchUpStatus()).toMatchObject({ state: "running", retryAt: null, current: { formatId: "a" } });
    expect(await worker.runPass("interval")).toMatchObject({ processed: 1, recorded: 1 });
  });

  it("@req MPV-PREV-03 three failures in a row end the pass, and they count: three broken videos reach 3 tries and stop being picked", async () => {
    const h = setup({
      candidates: ["a", "b", "c"].map((id, i) => candidate(id, `2026-10-0${9 - i}T00:00:00Z`)),
      outcome: async () => "failed",
    });
    const statePath = join(root, "transcode", "u1", "previews-catch-up.json");
    const passes = [];
    // Five hourly passes: the three tries land in the first three, the last two pick nothing.
    for (let i = 0; i < 5; i += 1) {
      passes.push(await createPreviewSheetsCatchUp(h.deps).runPass("interval"));
      h.state.now += 61 * 60_000;
    }
    const stored = JSON.parse(readFileSync(statePath, "utf8"));
    console.info(`[${SUITE}:broken] passes=${JSON.stringify(passes.map((p) => [p.stoppedBy, p.processed]))} state=${JSON.stringify(stored)}`);
    expect(passes[0]).toMatchObject({ stoppedBy: "failures", processed: 3, failed: 3 });
    expect([stored.formats.a.failures, stored.formats.b.failures, stored.formats.c.failures]).toEqual([3, 3, 3]);
    expect(h.runs).toHaveLength(9);
    expect(passes.slice(3).map((p) => p.processed)).toEqual([0, 0]);
    // MPV-PREV-07 Clear finished: a removed failed video leaves the Jobs history but stays left out (`failed`), and
    // Try again brings it back.
    const worker = createPreviewSheetsCatchUp(h.deps);
    expect(worker.setVideo("a", "dismiss")).toBe(true);
    const cleared = await worker.catchUpStatus();
    expect(cleared.videos.map((v) => v.formatId).sort()).toEqual(["b", "c"]);
    expect(cleared.failed.map((v) => v.formatId).sort()).toEqual(["a", "b", "c"]);
    expect(worker.retry("a")).toBe(1);
    expect((await worker.catchUpStatus()).videos.map((v) => v.formatId)).toContain("a");
  });

  it("@req MPV-PREV-03 only a network error or a refused session (401/403) on the backend check stops the pass as offline", async () => {
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")] });
    h.deps.probeBackend = async () => {
      throw new StorageTunnelError(400, { error: "invalid_key" });
    };
    const refusedKey = await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    console.info(`[${SUITE}:probe-4xx] result=${JSON.stringify(refusedKey)}`);
    expect(refusedKey).toMatchObject({ stoppedBy: null, recorded: 1 });

    const h2 = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")] });
    h2.deps.probeBackend = async () => {
      throw new StorageTunnelError(401, { error: "unauthorized" });
    };
    expect(await createPreviewSheetsCatchUp(h2.deps).runPass("manual")).toMatchObject({ stoppedBy: "offline", processed: 0 });
    expect(h2.runs).toHaveLength(0);
  });

  it("@req MPV-PREV-03 offline: an unreachable backend stops the pass before any decode, and an outage mid-run is not counted", async () => {
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z"), candidate("b", "2026-10-01T00:00:00Z")] });
    h.deps.probeBackend = async () => {
      throw new Error("fetch failed");
    };
    const probed = createPreviewSheetsCatchUp(h.deps);
    const offline = await probed.runPass("manual");
    await probed.stop();
    console.info(`[${SUITE}:offline] probe=${JSON.stringify(offline)}`);
    expect(offline).toMatchObject({ stoppedBy: "offline", processed: 0 });
    expect(h.runs).toHaveLength(0);

    // The probe passes but the run hits the outage: the pass stops at once, the video is not counted and does not wait.
    const h2 = setup({
      candidates: [candidate("a", "2026-10-02T00:00:00Z"), candidate("b", "2026-10-01T00:00:00Z")],
      outcome: async () => "unreachable",
    });
    const cutWorker = createPreviewSheetsCatchUp(h2.deps);
    const cut = await cutWorker.runPass("manual");
    await cutWorker.stop();
    const statePath = join(root, "transcode", "u1", "previews-catch-up.json");
    // Nothing to remember about the video: the state file need not even exist.
    const stored = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { formats: {} };
    console.info(`[${SUITE}:offline] mid-run=${JSON.stringify(cut)} state=${JSON.stringify(stored)}`);
    expect(cut).toMatchObject({ stoppedBy: "offline", processed: 0, failed: 0 });
    expect(h2.runs.map((r) => r.job.formatId)).toEqual(["a"]);
    expect(stored.formats.a?.failures ?? 0).toBe(0);
    expect(stored.formats.a?.lastFailedAt).toBeUndefined();
    expect(h2.logs.filter((l) => l.event === "[preview-catch-up] kick.scheduled").map((l) => l.payload)).toEqual([{ reason: "offline_retry", delayMs: 15_000, replaced: null }]);
  });

  it("@req MPV-PREV-03 offline: the next pass is tried after 15 s, then twice as long up to 5 min, and the work goes on soon after the network is back", async () => {
    vi.useFakeTimers();
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")] });
    let online = false;
    h.deps.probeBackend = async () => {
      if (!online) throw new Error("fetch failed");
    };
    h.deps.idleIntervalMs = 300_000;
    const worker = createPreviewSheetsCatchUp(h.deps);
    expect(await worker.runPass("manual")).toMatchObject({ stoppedBy: "offline" });
    // Kept apart from the idle tick: these passes are the ones the offline wait armed.
    const waits = () => h.logs.filter((l) => l.event === "[preview-catch-up] kick.scheduled").map((l) => (l.payload as { delayMs: number }).delayMs);
    for (const step of [15_000, 30_000, 60_000, 120_000, 240_000]) await vi.advanceTimersByTimeAsync(step);
    console.info(`[${SUITE}:offline-backoff] waits=${JSON.stringify(waits())}`);
    expect(waits()).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000]);
    expect(h.runs).toHaveLength(0);

    // The network is back: the pass already armed runs the video, and the wait starts over from 15 s.
    online = true;
    await vi.advanceTimersByTimeAsync(300_000);
    console.info(`[${SUITE}:offline-backoff] back runs=${h.runs.length}`);
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a"]);
    online = false;
    h.candidates.push(candidate("b", "2026-10-03T00:00:00Z"));
    expect(await worker.runPass("manual")).toMatchObject({ stoppedBy: "offline" });
    expect(waits().at(-1)).toBe(15_000);
    await worker.stop();
  });

  it("@req MPV-PREV-07 imports always first: no video starts while an import's preview run is queued, and the pass resumes as soon as every import is done", async () => {
    vi.useFakeTimers();
    const h = setup({ candidates: [candidate("old", "2026-10-01T00:00:00Z")] });
    let importRuns = ["new"];
    h.deps.queuedImportFormatIds = () => importRuns;
    h.deps.startDelayMs = 1_000;
    h.deps.idleIntervalMs = 600_000;
    h.deps.kickDelayMs = 1_000;
    h.deps.importWaitPollMs = 2_000;
    const worker = createPreviewSheetsCatchUp(h.deps);
    worker.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.logs.find((l) => l.event === "[preview-catch-up] pass.done")?.payload).toMatchObject({ reason: "startup", stoppedBy: "ingest_busy" });
    expect(await worker.catchUpStatus()).toMatchObject({ state: "paused_import" });
    // The import's preview run is done but its transcode is still unfinished: still waiting.
    importRuns = [];
    h.state.busy = 1;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.runs).toHaveLength(0);
    // Every import done: the pass resumes within a poll and a kick, well before the idle tick.
    h.state.busy = 0;
    await vi.advanceTimersByTimeAsync(3_000);
    const reasons = h.logs.filter((l) => l.event === "[preview-catch-up] pass.start").map((l) => l.payload.reason);
    console.info(`[${SUITE}:imports-first] reasons=${JSON.stringify(reasons)} runs=${JSON.stringify(h.runs.map((r) => r.job.formatId))}`);
    expect(reasons).toEqual(["startup", "imports_done"]);
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["old"]);
    await worker.stop();
  });

  it("@req MPV-PREV-07 a video cut by an import uses no try and runs again once the imports are done", async () => {
    vi.useFakeTimers();
    const h = setup({
      candidates: [candidate("a", "2026-10-02T00:00:00Z")],
      outcome: async () => {
        if (h.runs.length > 1) return "recorded";
        h.state.busy = 1;
        return "yielded";
      },
    });
    h.deps.startDelayMs = 1_000;
    h.deps.idleIntervalMs = 600_000;
    h.deps.kickDelayMs = 1_000;
    h.deps.importWaitPollMs = 2_000;
    const worker = createPreviewSheetsCatchUp(h.deps);
    worker.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.logs.find((l) => l.event === "[preview-catch-up] pass.done")?.payload).toMatchObject({ stoppedBy: "yielded", failed: 0 });
    expect(worker.previewStatus("a")).toMatchObject({ state: "pending", failures: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runs).toHaveLength(1);
    h.state.busy = 0;
    await vi.advanceTimersByTimeAsync(3_000);
    console.info(`[${SUITE}:cut-no-try] runs=${JSON.stringify(h.runs.map((r) => r.job.formatId))}`);
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a", "a"]);
    expect(h.logs.filter((l) => l.event === "[preview-catch-up] pass.start").map((l) => l.payload.reason)).toEqual(["startup", "imports_done"]);
    await worker.stop();
  });

  it("@req MPV-PREV-03 a stored source that does not fit on the disk is skipped before any download, without counting a failure", async () => {
    const downloaded: string[] = [];
    const h = setup({
      candidates: [candidate("big", "2026-10-02T00:00:00Z")],
      formats: { "m-big": [format("big", "file-big", "source", 4 * MiB)] },
      outcome: async (job, options) => {
        try {
          await options.prepareInput(join(root, "d", job.formatId), new AbortController().signal, { signatureOnly: false });
          return "recorded";
        } catch (error) {
          return error instanceof PreviewCatchUpSkip ? "skipped" : "failed";
        }
      },
    });
    h.deps.downloadObject = async (_token, key) => {
      downloaded.push(key);
      return Buffer.from("x");
    };
    // 4 MiB of source with a 1 GiB margin does not fit in 512 MiB.
    h.deps.freeBytes = () => 512 * MiB;
    let probes = 0;
    h.deps.probeBackend = async () => {
      probes += 1;
    };
    const result = await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    console.info(`[${SUITE}:disk] result=${JSON.stringify(result)} downloaded=${JSON.stringify(downloaded)}`);
    expect(downloaded).toEqual([]);
    expect(result).toMatchObject({ failed: 0, skipped: 1 });
    const stored = JSON.parse(readFileSync(join(root, "transcode", "u1", "previews-catch-up.json"), "utf8"));
    expect(stored.formats.big.failures).toBe(0);

    // The skip waits the hour like a failure, without a try: the 5-minute passes in between cost no call.
    h.state.now += 5 * 60_000;
    expect(await createPreviewSheetsCatchUp(h.deps).runPass("interval")).toMatchObject({ processed: 0, skipped: 0 });
    console.info(`[${SUITE}:disk] probes=${probes} runs=${h.runs.length}`);
    expect(probes).toBe(1);
    expect(h.runs).toHaveLength(1);
  });

  it("@req MPV-PREV-03 the stored objects of one video download several at a time and land in the file in order", async () => {
    // 1 init + 23 chunks, answered out of order: a later object often arrives before an earlier one.
    const chunks = Array.from({ length: 23 }, (_, i) => ({ key: `v-c${i}`, sizeBytes: 1000 }));
    const stored: PreviewCatchUpFormat = { id: "v", fileId: "file-v", quality: "source", isSource: true, initKey: "init-v", totalSize: 24_000, chunks };
    const h = setup({ candidates: [candidate("v", "2026-10-02T00:00:00Z")], formats: { "m-v": [stored] } });
    const latencyMs = 20;
    let inFlight = 0;
    let maxInFlight = 0;
    h.deps.downloadObject = async (_token, key) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const index = key === "init-v" ? 0 : Number(key.slice(3)) + 1;
      await new Promise((resolve) => setTimeout(resolve, latencyMs + ((index * 7) % 11)));
      inFlight -= 1;
      return Buffer.from(`<${key}>`);
    };
    let inputPath = "";
    let elapsedMs = 0;
    h.deps.runCatchUp = async (job, options) => {
      const started = performance.now();
      ({ inputPath } = await options.prepareInput(join(root, "d", job.formatId), new AbortController().signal, { signatureOnly: false }));
      elapsedMs = performance.now() - started;
      return "recorded";
    };
    await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    const sequentialMs = 24 * latencyMs;
    console.info(`[${SUITE}:parallel] maxInFlight=${maxInFlight} elapsedMs=${Math.round(elapsedMs)} sequentialAtLeastMs=${sequentialMs}`);
    expect(maxInFlight).toBe(6);
    expect(readFileSync(inputPath, "utf8")).toBe(["init-v", ...chunks.map((chunk) => chunk.key)].map((key) => `<${key}>`).join(""));
    expect(elapsedMs).toBeLessThan(sequentialMs / 2);
  });

  it("@req MPV-PREV-03 a stop in the middle of a window abandons the objects in flight without an unhandled rejection", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")], formats: { "m-a": [format("a", "file-a", "source", 4 * MiB)] } });
    h.deps.downloadConcurrency = 2;
    // Each object fails a little after the stop: nobody is left to read those failures.
    h.deps.downloadObject = (_token, key) => {
      started.push(key);
      // The stop comes once the window is full.
      if (started.length === 2) queueMicrotask(() => controller.abort(new Error("PREVIEW_SHEETS_YIELD")));
      return new Promise<Buffer>((_resolve, reject) => setTimeout(() => reject(new Error(`late ${key}`)), 15));
    };
    let prepared: Promise<unknown> | null = null;
    h.deps.runCatchUp = async (job, options) => {
      prepared = options.prepareInput(join(root, "d", job.formatId), controller.signal, { signatureOnly: false });
      await prepared.catch(() => {});
      return "yielded";
    };
    await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    await expect(prepared).rejects.toThrow("PREVIEW_SHEETS_YIELD");
    await new Promise((resolve) => setTimeout(resolve, 40));
    console.info(`[${SUITE}:abort-window] started=${JSON.stringify(started)}`);
    expect(started).toEqual(["init-a", "a-c0"]);
  });

  it("@req MPV-PREV-07 catchUpStatus reports the running video's download, then its pictures and its sound, so the card's bar moves within a video", async () => {
    const chunks = Array.from({ length: 9 }, (_, i) => ({ key: `v-c${i}`, sizeBytes: 100 }));
    const stored: PreviewCatchUpFormat = { id: "v", fileId: "file-v", quality: "360p", isSource: false, initKey: "init-v", totalSize: 1000, chunks };
    const h = setup({ candidates: [candidate("v", "2026-10-02T00:00:00Z", { season: 1, episode: 1 })], formats: { "m-v": [stored] } });
    h.deps.downloadConcurrency = 1;
    h.deps.downloadObject = async () => Buffer.alloc(100);
    const worker = createPreviewSheetsCatchUp(h.deps);
    const seen: Array<{ phase: unknown; downloaded: number; bytes: string; progress: number }> = [];
    const snap = async () => {
      const current = (await worker.catchUpStatus()).current!;
      seen.push({ phase: current.phase, downloaded: current.downloaded, bytes: `${current.downloadedBytes}/${current.totalBytes}`, progress: current.progress });
    };
    const download = h.deps.downloadObject;
    h.deps.downloadObject = async (token, key, libraryKey) => {
      await snap();
      return download(token, key, libraryKey);
    };
    h.deps.runCatchUp = async (job, options) => {
      await snap();
      await options.prepareInput(join(root, "d", job.formatId), new AbortController().signal, { signatureOnly: true });
      await snap();
      options.onStep?.("sound");
      await snap();
      h.candidates.length = 0;
      return "recorded";
    };
    await worker.runPass("manual");
    console.info(`[${SUITE}:progress] ${JSON.stringify(seen)}`);
    // Waiting its turn, then 10 objects of 100 bytes (0..0.9 of the video, the sound alone being quick), then the sound.
    expect(seen[0]).toEqual({ phase: null, downloaded: 0, bytes: "0/0", progress: 0 });
    expect(seen.slice(1, 11).map((entry) => entry.phase)).toEqual(Array(10).fill("download"));
    expect(seen.slice(1, 11).map((entry) => Math.round(entry.downloaded * 100))).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(seen.slice(1, 11).map((entry) => Math.round(entry.progress * 100))).toEqual([0, 9, 18, 27, 36, 45, 54, 63, 72, 81]);
    expect(seen.slice(1, 11).map((entry) => entry.bytes)).toEqual(Array.from({ length: 10 }, (_, i) => `${i * 100}/1000`));
    expect(seen[11]).toEqual({ phase: "download", downloaded: 1, bytes: "1000/1000", progress: 0.9 });
    expect(seen[12]).toEqual({ phase: "sound", downloaded: 1, bytes: "1000/1000", progress: 0.95 });
    expect(await worker.catchUpStatus()).toMatchObject({ state: "done", current: null });
  });

  it("@req MPV-PREV-07 a recorded video logs how long its download, its pictures and its sound took", async () => {
    const h = setup({
      candidates: [candidate("v", "2026-10-02T00:00:00Z")],
      outcome: async (_job, options) => {
        h.state.now += 40_000;
        options.onStep?.("pictures");
        h.state.now += 12_000;
        options.onStep?.("sound");
        h.state.now += 3_000;
        return "recorded";
      },
    });
    await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    const recorded = h.logs.find((entry) => entry.event === "[preview-catch-up] video.recorded");
    expect(recorded?.payload).toMatchObject({ formatId: "v", downloadMs: 40_000, picturesMs: 12_000, soundMs: 3_000, totalMs: 55_000 });
  });

  it("@req MPV-PREV-03 giving way or shutting down cuts the stored-copy download, and a sign-out makes the run give way", async () => {
    let userId: string | null = "u1";
    let prepared: Promise<{ inputPath: string; audioPath: string | null }> | null = null;
    const controller = new AbortController();
    let yieldCheck: PreviewSheetsCatchUpOptions["shouldYield"] | null = null;
    const h = setup({
      candidates: [candidate("a", "2026-10-02T00:00:00Z")],
      formats: { "m-a": [format("a", "file-a", "source", 4 * MiB)] },
      outcome: async (job, options) => {
        yieldCheck = options.shouldYield;
        prepared = options.prepareInput(join(root, "d", job.formatId), controller.signal, { signatureOnly: false });
        prepared.catch(() => {});
        return "yielded";
      },
    });
    h.deps.resolveUserId = () => userId;
    // The gateway sends nothing (a saturated silo): the download never settles by itself.
    h.deps.downloadObject = () => new Promise<Buffer>(() => {});
    await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    controller.abort(new Error("PREVIEW_SHEETS_YIELD"));
    await expect(prepared).rejects.toThrow("PREVIEW_SHEETS_YIELD");

    expect(await yieldCheck!()).toBe(false);
    userId = null;
    expect(await yieldCheck!()).toBe(true);
  });

  it("@req MPV-PREV-03 the pass runs shortly after start and on an idle timer, and stops cleanly", async () => {
    vi.useFakeTimers();
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")] });
    const worker = createPreviewSheetsCatchUp(h.deps);
    worker.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.runs).toHaveLength(1);
    h.candidates.push(candidate("b", "2026-10-03T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a", "b"]);
    await worker.stop();
    h.candidates.push(candidate("c", "2026-10-04T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.runs).toHaveLength(2);
  });

  it("@req MPV-PREV-03 closing the player starts a pass after a short debounce, reason player_closed", async () => {
    vi.useFakeTimers();
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")] });
    h.deps.startDelayMs = 600_000;
    h.deps.idleIntervalMs = 600_000;
    h.deps.afterPlaybackDelayMs = 5_000;
    const worker = createPreviewSheetsCatchUp(h.deps);
    worker.start();
    h.state.playback = true;
    worker.playbackChanged(true);
    console.info(`[${SUITE}:player-closed] phase=playing runs=${h.runs.length}`);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.runs).toHaveLength(0);

    h.state.playback = false;
    worker.playbackChanged(false);
    console.info(`[${SUITE}:player-closed] phase=closed runs=${h.runs.length}`);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    console.info(`[${SUITE}:player-closed] phase=after-debounce runs=${h.runs.length} logs=${JSON.stringify(h.logs.map((l) => l.event))}`);
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a"]);
    expect(h.logs.find((l) => l.event === "[preview-catch-up] kick.scheduled")?.payload).toMatchObject({ reason: "player_closed", delayMs: 5_000 });
    expect(h.logs.find((l) => l.event === "[preview-catch-up] pass.start")?.payload).toEqual({ reason: "player_closed" });
    // A repeated "not playing" (a policy change while closed) is not a second close.
    worker.playbackChanged(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.logs.filter((l) => l.event === "[preview-catch-up] kick.scheduled")).toHaveLength(1);
    await worker.stop();
  });

  it("@req MPV-PREV-03 reopening the player within the debounce cancels the pass; the interval still runs", async () => {
    vi.useFakeTimers();
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")] });
    h.deps.startDelayMs = 600_000;
    h.deps.idleIntervalMs = 60_000;
    h.deps.afterPlaybackDelayMs = 5_000;
    const worker = createPreviewSheetsCatchUp(h.deps);
    worker.start();
    h.state.playback = true;
    worker.playbackChanged(true);
    h.state.playback = false;
    worker.playbackChanged(false);
    await vi.advanceTimersByTimeAsync(2_000);
    h.state.playback = true;
    worker.playbackChanged(true);
    await vi.advanceTimersByTimeAsync(10_000);
    console.info(`[${SUITE}:reopen] phase=reopened runs=${h.runs.length} logs=${JSON.stringify(h.logs.map((l) => l.event))}`);
    expect(h.runs).toHaveLength(0);
    expect(h.logs.some((l) => l.event === "[preview-catch-up] pass.start")).toBe(false);
    expect(h.logs.find((l) => l.event === "[preview-catch-up] kick.cancelled")?.payload).toMatchObject({ reason: "player_closed", by: "playback_started" });

    // Still playing at the interval tick: the pass stands down.
    await vi.advanceTimersByTimeAsync(48_000);
    expect(h.logs.find((l) => l.event === "[preview-catch-up] pass.done")?.payload).toMatchObject({ reason: "interval", stoppedBy: "playback" });
    expect(h.runs).toHaveLength(0);

    // Closed for good: the debounce runs the video; the next interval tick still fires.
    h.state.playback = false;
    worker.playbackChanged(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a"]);
    h.candidates.push(candidate("b", "2026-10-03T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    const reasons = h.logs.filter((l) => l.event === "[preview-catch-up] pass.start").map((l) => l.payload.reason);
    console.info(`[${SUITE}:reopen] phase=done runs=${JSON.stringify(h.runs.map((r) => r.job.formatId))} reasons=${JSON.stringify(reasons)}`);
    expect(reasons).toEqual(["interval", "player_closed", "interval"]);
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a", "b"]);
    await worker.stop();
  });

  it("@req MPV-PREV-03 a stored copy that fails to download fails the video, and a missing credential stops the pass", async () => {
    const h = setup({
      candidates: [candidate("a", "2026-10-02T00:00:00Z")],
      formats: { "m-a": [format("a", "file-a", "source", 4 * MiB)] },
      outcome: async (job, options) => {
        mkdirSync(join(root, "d"), { recursive: true });
        try {
          await options.prepareInput(join(root, "d", job.formatId), new AbortController().signal, { signatureOnly: false });
          return "recorded";
        } catch {
          return "failed";
        }
      },
    });
    h.deps.downloadObject = async () => {
      throw new Error("media_decrypt_failed");
    };
    expect(await createPreviewSheetsCatchUp(h.deps).runPass("manual")).toMatchObject({ processed: 1, failed: 1 });

    const h2 = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")] });
    h2.deps.resolveLibraryKey = () => null;
    expect(await createPreviewSheetsCatchUp(h2.deps).runPass("manual")).toMatchObject({ stoppedBy: "credentials_missing", processed: 0 });
  });

  it("@req MPV-PREV-07 catchUpStatus lists every video: the running one, the given-up ones with the step that failed, the queue in pass order, then the done ones with what was found", async () => {
    const show = (id: string, episode: number, addedAt: string) => candidate(id, addedAt, { mediaId: "show", fileId: `f-${id}`, season: 1, episode });
    const h = setup({
      candidates: [show("e3", 3, "2026-10-03T00:00:00Z"), show("e4", 4, "2026-10-02T00:00:00Z"), candidate("film", "2026-10-01T00:00:00Z")],
      outcome: async (job, options) => {
        if (job.formatId !== "film") return "recorded";
        options.onStep?.("pictures");
        return "failed";
      },
    });
    // Done before: E1 found both, E2 its intro alone; a lone episode of another show waits for a second one.
    h.library.unshift(
      { formatId: "e1", mediaId: "show", fileId: "f-e1", season: 1, episode: 1, signed: true, intro: true, credits: true },
      { formatId: "e2", mediaId: "show", fileId: "f-e2", season: 1, episode: 2, signed: true, intro: true, credits: false }
    );
    h.library.push(
      { formatId: "solo", mediaId: "other", fileId: "f-solo", season: 2, episode: 5, signed: true, intro: false, credits: false },
      { formatId: "doc", mediaId: "doc", fileId: "f-doc", season: null, episode: null, signed: true, intro: false, credits: false }
    );
    h.state.total = 7;
    const worker = createPreviewSheetsCatchUp(h.deps);
    let during: Awaited<ReturnType<typeof worker.catchUpStatus>> | null = null;
    const short = (s: Awaited<ReturnType<typeof worker.catchUpStatus>>) =>
      s.videos.map((v) => [v.formatId, v.status, v.result ?? v.failedStep ?? "-"].join(":"));
    expect(short(await worker.catchUpStatus())).toEqual([
      "e3:queued:-",
      "e4:queued:-",
      "film:queued:-",
      "e1:done:found_both",
      "e2:done:found_intro",
      "solo:done:waiting_other_episode",
      // A film: previews only (PLAY-SKIP-11).
      "doc:done:previews_made",
    ]);
    // A recorded video leaves the owed list; the fake library marks it signed with nothing found.
    const orig = h.deps.runCatchUp;
    h.deps.runCatchUp = async (job, options) => {
      if (job.formatId === "e4") during = await worker.catchUpStatus();
      const outcome = await orig(job, options);
      const row = h.library.find((v) => v.formatId === job.formatId);
      if (row && outcome === "recorded") row.signed = true;
      return outcome;
    };
    for (let i = 0; i < 3; i += 1) {
      await worker.runPass("interval");
      h.state.now += 61 * 60_000;
    }
    console.info(`[${SUITE}:videos] during=${JSON.stringify(short(during!))}`);
    expect(short(during!)).toEqual(["e4:running:-", "film:queued:-", "e1:done:found_both", "e2:done:found_intro", "e3:done:nothing_found", "solo:done:waiting_other_episode", "doc:done:previews_made"]);
    const done = await worker.catchUpStatus();
    console.info(`[${SUITE}:videos] done=${JSON.stringify(short(done))}`);
    // The film failed in its pictures: "read", never the raw error.
    expect(short(done)[0]).toBe("film:failed:read");
    expect(done.videos).toHaveLength(7);
  });

  it("@req MPV-PREV-07 a failed try stores the step it stopped in: download before the input was ready, read after", async () => {
    const h = setup({
      candidates: [candidate("dl", "2026-10-02T00:00:00Z"), candidate("rd", "2026-10-01T00:00:00Z")],
      outcome: async (job, options) => {
        if (job.formatId === "rd") options.onStep?.("sound");
        return "failed";
      },
    });
    await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    const stored = JSON.parse(readFileSync(join(root, "transcode", "u1", "previews-catch-up.json"), "utf8"));
    console.info(`[${SUITE}:step] ${JSON.stringify(stored.formats)}`);
    expect([stored.formats.dl.step, stored.formats.rd.step]).toEqual(["download", "read"]);
  });

  it("@req MPV-PREV-07 Try again resets one given-up video, or all of them, and starts a pass after the debounce", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-30T12:00:00Z") });
    const h = setup({
      candidates: [candidate("a", "2026-10-02T00:00:00Z"), candidate("b", "2026-10-01T00:00:00Z")],
      outcome: async () => "failed",
    });
    h.deps.maxConsecutiveFailures = 10;
    const worker = createPreviewSheetsCatchUp(h.deps);
    for (let i = 0; i < 3; i += 1) {
      await worker.runPass("interval");
      h.state.now += 61 * 60_000;
    }
    expect((await worker.catchUpStatus()).failed.map((v) => v.formatId)).toEqual(["a", "b"]);
    expect(worker.retry("a")).toBe(1);
    expect((await worker.catchUpStatus()).failed.map((v) => v.formatId)).toEqual(["b"]);
    const before = h.runs.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.runs.slice(before).map((r) => r.job.formatId)).toEqual(["a"]);
    expect(worker.retry(null)).toBe(2);
    expect((await worker.catchUpStatus()).failed).toEqual([]);
    await worker.stop();
  });

  it("@req MPV-PREV-07 a library re-open or a replaced session mid-video pauses the pass without counting a failure, and the same video resumes first", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-30T12:00:00Z") });
    const statePath = join(root, "transcode", "u1", "previews-catch-up.json");
    let mode: "close" | "cut" | "relogin" | "ok" = "close";
    let token = "tok";
    const h = setup({
      candidates: [candidate("e7", "2026-10-02T00:00:00Z"), candidate("e8", "2026-10-01T00:00:00Z")],
      outcome: async () => {
        if (mode === "close") {
          // badger.db.open closes the library first: the download under it fails.
          h.state.open = false;
          return "failed";
        }
        if (mode === "cut") return "interrupted";
        if (mode === "relogin") {
          token = "tok2";
          return "failed";
        }
        return "recorded";
      },
    });
    h.deps.resolveToken = () => token;
    const worker = createPreviewSheetsCatchUp(h.deps);
    const closed = await worker.runPass("interval");
    expect(closed).toMatchObject({ stoppedBy: "library_closed", processed: 0, failed: 0 });
    expect(existsSync(statePath)).toBe(false);
    // Still closed: nothing runs.
    expect(await worker.runPass("interval")).toMatchObject({ stoppedBy: "library_closed", processed: 0 });
    h.state.open = true;

    mode = "cut";
    expect(await worker.runPass("library_opened")).toMatchObject({ stoppedBy: "interrupted", failed: 0 });
    mode = "relogin";
    expect(await worker.runPass("interval")).toMatchObject({ stoppedBy: "interrupted", failed: 0 });
    expect(existsSync(statePath)).toBe(false);
    // An interruption with the library open kicks the next pass by itself, which starts again with e7.
    mode = "ok";
    await vi.advanceTimersByTimeAsync(5_000);
    const order = h.runs.map((r) => r.job.formatId);
    const passes = h.logs.filter((l) => l.event.endsWith("pass.done")).map((l) => [l.payload.reason, l.payload.stoppedBy]);
    console.info(`[${SUITE}:reopen] runs=${JSON.stringify(order)} passes=${JSON.stringify(passes)}`);
    expect(order).toEqual(["e7", "e7", "e7", "e7", "e8"]);
    expect(passes.at(-1)).toEqual(["resume", null]);
    expect(h.logs.filter((l) => l.event.endsWith("video.failed"))).toEqual([]);
    await worker.stop();
  });
  it("@req MPV-PREV-07 Cancel leaves a queued video out and stops the running one without a failure; Try again brings it back; Remove from history hides a done one", async () => {
    let worker: ReturnType<typeof createPreviewSheetsCatchUp> | null = null;
    const h = setup({
      candidates: [candidate("a", "2026-10-03T00:00:00Z"), candidate("b", "2026-10-02T00:00:00Z"), candidate("c", "2026-10-01T00:00:00Z")],
      outcome: async (job, options) => {
        if (job.formatId === "a") {
          // The user presses Cancel while "a" runs: its run gives way at the next check.
          expect(worker!.setVideo("a", "cancel")).toBe(true);
          return (await options.shouldYield()) ? "yielded" : "recorded";
        }
        h.library.find((v) => v.formatId === job.formatId)!.signed = true;
        return "recorded";
      },
    });
    worker = createPreviewSheetsCatchUp(h.deps);
    const short = (s: Awaited<ReturnType<typeof worker.catchUpStatus>>) => s.videos.map((v) => `${v.formatId}:${v.status}`);
    // "c" is cancelled while it waits in the queue; a cancelled video goes to the bottom and the rest stays in place.
    expect(worker.setVideo("c", "cancel")).toBe(true);
    expect(short(await worker.catchUpStatus())).toEqual(["a:queued", "b:queued", "c:cancelled"]);
    const pass = await worker.runPass("manual");
    const after = await worker.catchUpStatus();
    console.info(`[${SUITE}:cancel] pass=${JSON.stringify(pass)} runs=${JSON.stringify(h.runs.map((r) => r.job.formatId))} videos=${JSON.stringify(short(after))}`);
    // "a" gave way, the pass went on with "b", and "c" never ran.
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["a", "b"]);
    expect(pass).toMatchObject({ failed: 0 });
    expect(short(after)).toEqual(["b:done", "a:cancelled", "c:cancelled"]);
    expect(h.logs.filter((l) => l.event.endsWith("video.cancelled")).map((l) => l.payload.formatId)).toEqual(["a"]);
    expect(h.logs.filter((l) => l.event.endsWith("video.failed"))).toEqual([]);
    // No try was counted against it.
    expect(worker.previewStatus("a")).toMatchObject({ failures: 0 });

    // Try again un-cancels it: back in the queue, and the next pass makes it.
    expect(worker.retry("a")).toBe(1);
    expect(short(await worker.catchUpStatus())).toEqual(["a:queued", "b:done", "c:cancelled"]);
    // Remove from history hides the done one; the cancelled one stays with its Try again.
    expect(worker.setVideo("b", "dismiss")).toBe(true);
    expect(short(await worker.catchUpStatus())).toEqual(["a:queued", "c:cancelled"]);
    // Clear finished also removes the cancelled one from the history; it stays left out (the title's details list
    // it with its Try again, PLAY-SKIP-09), and trying again brings it back to the history.
    expect(worker.setVideo("c", "dismiss")).toBe(true);
    const cleared = await worker.catchUpStatus();
    expect(short(cleared)).toEqual(["a:queued"]);
    expect(cleared.cancelled.map((v) => v.formatId)).toEqual(["c"]);
    expect(worker.retry("c")).toBe(1);
    const back = await worker.catchUpStatus();
    expect(short(back)).toEqual(["a:queued", "c:queued"]);
    expect(back.cancelled).toEqual([]);
  });
});
