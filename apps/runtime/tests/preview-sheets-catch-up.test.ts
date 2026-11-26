/**
 * @test-id RUNTIME-PREVIEW-CATCH-UP-001
 * @level unit
 * @why MPV-PREV-03: the videos already in the library get their seek-bar previews without a re-import. A background
 *      pass on this computer's runtime goes through the signed-in user's videos that have none, newest first, one at
 *      a time, and stands down while an import or a playback runs. Its input is the local import file when it is
 *      still there at the same size; otherwise the stored source downloaded and decrypted, or the 360p copy when the
 *      stored source is too heavy. A failed video is retried at most 3 times, an hour apart, and the count survives
 *      a restart (RT-LIFE-04).
 * @covers apps/runtime/src/modules/badger/previewSheetsCatchUp.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewSheetCandidate } from "@space/shared/libraryTypes";
import { StorageTunnelError } from "@space/shared/storageTunnel";
import {
  chooseCatchUpSource,
  createPreviewSheetsCatchUp,
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
  season: null,
  episode: null,
  addedAt,
  durationSeconds: 60,
  initKey: `media/p/init-${formatId}`,
  ...extra,
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
  state: { busy: number; playback: boolean; now: number };
};

const setup = (opts: {
  candidates: PreviewSheetCandidate[];
  outcome?: (job: PreviewSheetsJob, options: PreviewSheetsCatchUpOptions) => Promise<PreviewSheetsOutcome>;
  formats?: Record<string, PreviewCatchUpFormat[]>;
  local?: (candidate: PreviewSheetCandidate) => { path: string; sizeMb: number } | null;
}): Harness => {
  const runs: Harness["runs"] = [];
  const logs: Harness["logs"] = [];
  const state = { busy: 0, playback: false, now: Date.parse("2026-10-30T12:00:00Z") };
  const candidates = [...opts.candidates];
  const deps: PreviewCatchUpDeps = {
    libraryDb: {
      isOpen: () => true,
      call: async (method: string, args: unknown[] = []) => {
        if (method === "listPreviewSheetCandidates") {
          const input = args[0] as { limit: number; excludeFormatIds: string[] };
          return candidates
            .filter((c) => !input.excludeFormatIds.includes(c.formatId))
            .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
            .slice(0, input.limit);
        }
        if (method === "listMediaFormats") {
          const mediaId = args[0] as string;
          return opts.formats?.[mediaId] ?? [];
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
    findLocalImport: async (_userId, c) => opts.local?.(c) ?? null,
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
  return { deps, runs, logs, candidates, state };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-preview-catch-up-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("seek-bar preview catch-up pass (MPV-PREV-03)", () => {
  it("@req MPV-PREV-03 the source is the local import when its size still matches, else the stored source, else the 360p copy when the source is heavy", () => {
    const formats = [format("src", "f1", "source", 2 * GiB), format("p360", "f1", "360p", 100 * MiB), format("other360", "f2", "360p", 50 * MiB)];
    const heavyFormats = [format("src", "f1", "source", 6 * GiB), ...formats.slice(1)];
    const base = { formatId: "src", heavySourceBytes: 4 * GiB };

    const local = chooseCatchUpSource({ ...base, local: { path: "/v/a.mkv", sizeMb: 2048, actualBytes: 2048 * MiB + 1000 }, formats });
    const moved = chooseCatchUpSource({ ...base, local: { path: "/v/a.mkv", sizeMb: 2048, actualBytes: 1000 * MiB }, formats });
    const gone = chooseCatchUpSource({ ...base, local: null, formats });
    const heavy = chooseCatchUpSource({ ...base, local: null, formats: heavyFormats });
    const heavyNo360 = chooseCatchUpSource({ ...base, local: null, formats: [heavyFormats[0]!] });
    console.info(`[${SUITE}:source] ${JSON.stringify({ local, moved, gone, heavy, heavyNo360 })}`);

    expect(local).toEqual({ kind: "local", path: "/v/a.mkv" });
    expect(moved).toMatchObject({ kind: "stored", formatId: "src", keys: ["init-src", "src-c0", "src-c1"] });
    expect(gone).toMatchObject({ kind: "stored", formatId: "src", bytes: 2 * GiB });
    expect(heavy).toMatchObject({ kind: "stored", formatId: "p360", quality: "360p", keys: ["init-p360", "p360-c0", "p360-c1"] });
    expect(heavyNo360).toMatchObject({ kind: "stored", formatId: "src" });
    expect(chooseCatchUpSource({ ...base, local: null, formats: [] })).toBeNull();
  });

  it("@req MPV-PREV-03 one pass makes every missing video newest first, one at a time, through the preview runner", async () => {
    const h = setup({
      candidates: [candidate("old", "2026-10-01T00:00:00Z"), candidate("new", "2026-10-29T00:00:00Z"), candidate("mid", "2026-10-15T00:00:00Z")],
      local: (c) => (c.formatId === "new" ? { path: join(root, "new.mkv"), sizeMb: 0 } : null),
      formats: {
        "m-old": [format("old", "file-old", "source", 4 * MiB)],
        "m-mid": [format("mid", "file-mid", "source", 4 * MiB)],
      },
    });
    writeFileSync(join(root, "new.mkv"), "local bytes");
    let running = 0;
    let maxRunning = 0;
    const inputs: string[] = [];
    const orig = h.deps.runCatchUp;
    h.deps.runCatchUp = async (job, options) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      const dir = join(root, "src-dir", job.formatId);
      const path = await options.prepareInput(dir, new AbortController().signal);
      inputs.push(`${job.formatId}:${path.startsWith(dir) ? readFileSync(path, "utf8") : path}`);
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
      `new:${join(root, "new.mkv")}`,
      "mid:<init-mid><mid-c0><mid-c1>",
      "old:<init-old><old-c0><old-c1>",
    ]);
    expect(result).toMatchObject({ stoppedBy: null, processed: 3, recorded: 3, failed: 0 });
  });

  it("@req MPV-PREV-03 it stands down while an import or a playback runs, and a run gives way when one starts", async () => {
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z"), candidate("b", "2026-10-01T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }) });
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
      local: () => ({ path: "/x", sizeMb: 0 }),
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
    const h = setup({ candidates: [candidate("bad", "2026-10-02T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }), outcome: async () => "failed" });
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
    const h = setup({ candidates: [candidate("bad", "2026-10-02T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }), outcome: async () => "failed" });
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

  it("@req MPV-PREV-03 three failures in a row end the pass, and they count: three broken videos reach 3 tries and stop being picked", async () => {
    const h = setup({
      candidates: ["a", "b", "c"].map((id, i) => candidate(id, `2026-10-0${9 - i}T00:00:00Z`)),
      local: () => ({ path: "/x", sizeMb: 0 }),
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
  });

  it("@req MPV-PREV-03 only a network error or a refused session (401/403) on the backend check stops the pass as offline", async () => {
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }) });
    h.deps.probeBackend = async () => {
      throw new StorageTunnelError(400, { error: "invalid_key" });
    };
    const refusedKey = await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    console.info(`[${SUITE}:probe-4xx] result=${JSON.stringify(refusedKey)}`);
    expect(refusedKey).toMatchObject({ stoppedBy: null, recorded: 1 });

    const h2 = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }) });
    h2.deps.probeBackend = async () => {
      throw new StorageTunnelError(401, { error: "unauthorized" });
    };
    expect(await createPreviewSheetsCatchUp(h2.deps).runPass("manual")).toMatchObject({ stoppedBy: "offline", processed: 0 });
    expect(h2.runs).toHaveLength(0);
  });

  it("@req MPV-PREV-03 offline: an unreachable backend stops the pass before any decode, and an outage mid-run is not counted", async () => {
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z"), candidate("b", "2026-10-01T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }) });
    h.deps.probeBackend = async () => {
      throw new Error("fetch failed");
    };
    const offline = await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    console.info(`[${SUITE}:offline] probe=${JSON.stringify(offline)}`);
    expect(offline).toMatchObject({ stoppedBy: "offline", processed: 0 });
    expect(h.runs).toHaveLength(0);

    // The probe passes but the run hits the outage: the pass stops at once, the video waits an hour, uncounted.
    const h2 = setup({
      candidates: [candidate("a", "2026-10-02T00:00:00Z"), candidate("b", "2026-10-01T00:00:00Z")],
      local: () => ({ path: "/x", sizeMb: 0 }),
      outcome: async () => "unreachable",
    });
    const cut = await createPreviewSheetsCatchUp(h2.deps).runPass("manual");
    const stored = JSON.parse(readFileSync(join(root, "transcode", "u1", "previews-catch-up.json"), "utf8"));
    console.info(`[${SUITE}:offline] mid-run=${JSON.stringify(cut)} state=${JSON.stringify(stored)}`);
    expect(cut).toMatchObject({ stoppedBy: "offline", processed: 0, failed: 0 });
    expect(h2.runs.map((r) => r.job.formatId)).toEqual(["a"]);
    expect(stored.formats.a.failures).toBe(0);
  });

  it("@req MPV-PREV-03 a video whose import preview run is still queued is not listed", async () => {
    const h = setup({ candidates: [candidate("new", "2026-10-29T00:00:00Z"), candidate("old", "2026-10-01T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }) });
    h.deps.queuedImportFormatIds = () => ["new"];
    const result = await createPreviewSheetsCatchUp(h.deps).runPass("manual");
    console.info(`[${SUITE}:queued-import] result=${JSON.stringify(result)} runs=${JSON.stringify(h.runs.map((r) => r.job.formatId))}`);
    expect(h.runs.map((r) => r.job.formatId)).toEqual(["old"]);
  });

  it("@req MPV-PREV-03 a stored source that does not fit on the disk is skipped before any download, without counting a failure", async () => {
    const downloaded: string[] = [];
    const h = setup({
      candidates: [candidate("big", "2026-10-02T00:00:00Z")],
      formats: { "m-big": [format("big", "file-big", "source", 4 * MiB)] },
      outcome: async (job, options) => {
        try {
          await options.prepareInput(join(root, "d", job.formatId), new AbortController().signal);
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

  it("@req MPV-PREV-03 giving way or shutting down cuts the stored-copy download, and a sign-out makes the run give way", async () => {
    let userId: string | null = "u1";
    let prepared: Promise<string> | null = null;
    const controller = new AbortController();
    let yieldCheck: PreviewSheetsCatchUpOptions["shouldYield"] | null = null;
    const h = setup({
      candidates: [candidate("a", "2026-10-02T00:00:00Z")],
      formats: { "m-a": [format("a", "file-a", "source", 4 * MiB)] },
      outcome: async (job, options) => {
        yieldCheck = options.shouldYield;
        prepared = options.prepareInput(join(root, "d", job.formatId), controller.signal);
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
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }) });
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
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }) });
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
    const h = setup({ candidates: [candidate("a", "2026-10-02T00:00:00Z")], local: () => ({ path: "/x", sizeMb: 0 }) });
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
          await options.prepareInput(join(root, "d", job.formatId), new AbortController().signal);
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
});
