/**
 * @test-id RUNTIME-PREVIEW-CATCH-UP-RUNNER-001
 * @level unit
 * @why The catch-up pass (MPV-PREV-03) makes the sheets of videos already in the library through the same
 *      one-at-a-time runner as the imports (MPV-PREV-02). Its input is prepared per run (the stored copy and,
 *      for a skip signature, its audio track, downloaded and decrypted next to the job dir); the run gives way when an import or a playback
 *      starts; and a run cut by a restart is released and dropped, since the pass simply picks the video again.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import type { SkipSignature as SkipSignatureArg } from "@space/ingest-core/skipDetect";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import {
  createPreviewSheetsRunner,
  PreviewCatchUpSkip,
  type PreviewSheetsJob,
  type ProducePreviewSheetsFn,
  type ProduceSkipSignatureFn,
  skipJobFor,
} from "../src/modules/badger/steps/previewSheetsAfterCommit";

const SUITE = "preview-catch-up-runner";

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

let root = "";

const JOB: PreviewSheetsJob = {
  userId: "u1",
  jobId: "catch-up-fmt-1",
  mediaId: "m1",
  formatId: "fmt-1",
  inputPath: "",
  durationSeconds: 60,
  initKey: "media/0123456789abcdef0123456789abcdef/init",
  origin: "catch-up",
};

const setup = (opts: {
  produce: ProducePreviewSheetsFn;
  stored?: { previewSheets: MediaPreviewSheets | null } | null;
  produceSignature?: ProduceSkipSignatureFn;
  onSkipSignature?: Parameters<typeof createPreviewSheetsRunner>[0]["onSkipSignature"];
  analyzeSkipAudio?: Parameters<typeof createPreviewSheetsRunner>[0]["analyzeSkipAudio"];
  formatCheckMs?: number;
}) => {
  const released: string[][] = [];
  const methods: string[] = [];
  const records: MediaPreviewSheets[] = [];
  const libraryDb = {
    call: vi.fn(async (method: string, args: unknown[]) => {
      methods.push(method);
      if (method === "setMediaFormatPreviewSheets") {
        records.push(args[1] as MediaPreviewSheets);
        return true;
      }
      if (method === "getMediaFormatPreviewSheets") return opts.stored === undefined ? { previewSheets: null } : opts.stored;
      return null;
    }),
  } as unknown as BadgerLibraryDbService;
  const runner = createPreviewSheetsRunner({
    libraryDb,
    resolveToken: () => "tok",
    resolveLibraryKey: () => "lk",
    deleteStorageKeys: async (_token, keys) => {
      released.push([...keys]);
      return { deleted: keys.length, reclaimedBytes: 0 };
    },
    produce: opts.produce,
    produceSignature: opts.produceSignature,
    onSkipSignature: opts.onSkipSignature,
    analyzeSkipAudio: opts.analyzeSkipAudio,
    transcodeRoot: () => root,
    formatCheckMs: opts.formatCheckMs ?? 10,
  });
  return { runner, released, methods, records };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-preview-catch-up-"));
  console.info(`[${SUITE}:setup] root=${root}`);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("catch-up runs on the preview runner (MPV-PREV-03)", () => {
  it("@req MPV-PREV-03 prepares the input beside the job dir, decodes it, records the sheets and removes the copy", async () => {
    let seenInput = "";
    let inputExistedDuringDecode = false;
    const produce = vi.fn<ProducePreviewSheetsFn>(async (args) => {
      seenInput = args.inputPath;
      inputExistedDuringDecode = existsSync(args.inputPath);
      args.onSheetUploaded?.("obj-preview-0");
      return PREVIEWS;
    });
    const { runner, released, methods } = setup({ produce });
    const outcome = await runner.runCatchUp(JOB, {
      prepareInput: async (dir) => {
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "source.mp4");
        writeFileSync(path, "decrypted video");
        return { inputPath: path, audioPath: null };
      },
      shouldYield: () => false,
    });
    console.info(`[${SUITE}:recorded] outcome=${outcome} input=${seenInput} methods=${JSON.stringify(methods)} left=${JSON.stringify(readdirSync(join(root, "u1")))}`);
    expect(outcome).toBe("recorded");
    expect(seenInput).toBe(join(root, "u1", "catch-up-fmt-1.previews-source", "source.mp4"));
    expect(inputExistedDuringDecode).toBe(true);
    expect(methods).toContain("setMediaFormatPreviewSheets");
    expect(released).toEqual([]);
    expect(readdirSync(join(root, "u1"))).toEqual([]);
  });

  it("@req MPV-PREV-03 gives way when an import or a playback starts: decode cut, sheets released, not a failure", async () => {
    let busy = false;
    const produce = vi.fn<ProducePreviewSheetsFn>(
      (args) =>
        new Promise((_resolve, reject) => {
          args.onSheetUploaded?.("obj-partial-0");
          busy = true;
          args.signal?.addEventListener("abort", () => reject(args.signal?.reason));
        })
    );
    const { runner, released } = setup({ produce });
    const outcome = await runner.runCatchUp(JOB, { prepareInput: async () => ({ inputPath: "/videos/Local.mkv", audioPath: null }), shouldYield: () => busy });
    console.info(`[${SUITE}:yield] outcome=${outcome} released=${JSON.stringify(released)}`);
    expect(outcome).toBe("yielded");
    expect(released).toEqual([["obj-partial-0"]]);
    expect(existsSync(join(root, "u1", "catch-up-fmt-1.previews.json"))).toBe(false);
  });

  it("@req MPV-PREV-03 a failed decode is reported as failed, with its sheets released", async () => {
    const produce = vi.fn<ProducePreviewSheetsFn>(async (args) => {
      args.onSheetUploaded?.("obj-partial-0");
      throw new Error("ffmpeg exited 1");
    });
    const { runner, released } = setup({ produce });
    const outcome = await runner.runCatchUp(JOB, { prepareInput: async () => ({ inputPath: "/videos/Local.mkv", audioPath: null }), shouldYield: () => false });
    console.info(`[${SUITE}:failed] outcome=${outcome} released=${JSON.stringify(released)}`);
    expect(outcome).toBe("failed");
    expect(released).toEqual([["obj-partial-0"]]);
  });

  it("@req MPV-PREV-03 a catch-up run cut by a restart is released and dropped at the next start, never re-queued", async () => {
    mkdirSync(join(root, "u1"), { recursive: true });
    const pending = join(root, "u1", "catch-up-fmt-1.previews.json");
    writeFileSync(pending, JSON.stringify({ version: 1, job: JOB, uploaded: ["obj-cut-0"] }));
    // The decrypted copy a cut run left.
    mkdirSync(join(root, "u1", "catch-up-fmt-1.previews-source"), { recursive: true });
    writeFileSync(join(root, "u1", "catch-up-fmt-1.previews-source", "source.mp4"), "decrypted video");
    const produce = vi.fn<ProducePreviewSheetsFn>(async () => PREVIEWS);
    const { runner, released } = setup({ produce });
    await runner.resume();
    console.info(`[${SUITE}:resume] released=${JSON.stringify(released)} left=${JSON.stringify(readdirSync(join(root, "u1")))}`);
    expect(released).toEqual([["obj-cut-0"]]);
    expect(produce).not.toHaveBeenCalled();
    expect(readdirSync(join(root, "u1"))).toEqual([]);
  });

  it("@req MPV-PREV-03 a video whose sheets were recorded meanwhile is not decoded again", async () => {
    const produce = vi.fn<ProducePreviewSheetsFn>(async () => PREVIEWS);
    const prepareInput = vi.fn(async () => ({ inputPath: "/videos/Local.mkv", audioPath: null }));
    const { runner, methods } = setup({ produce, stored: { previewSheets: PREVIEWS } });
    const outcome = await runner.runCatchUp(JOB, { prepareInput, shouldYield: () => false });
    console.info(`[${SUITE}:already] outcome=${outcome} methods=${JSON.stringify(methods)}`);
    expect(outcome).toBe("already-recorded");
    expect(prepareInput).not.toHaveBeenCalled();
    expect(produce).not.toHaveBeenCalled();
    expect(methods).not.toContain("setMediaFormatPreviewSheets");
  });

  it("@req MPV-PREV-03 previews recorded before signatures get a signatures-only run, kept beside the sheets and handed to matching", async () => {
    const produce = vi.fn<ProducePreviewSheetsFn>(async () => PREVIEWS);
    const signature = { version: 1 } as unknown as SkipSignatureArg;
    const produceSignature = vi.fn<ProduceSkipSignatureFn>(async (args) => {
      await args.skip.analyzeAudio?.();
      args.skip.onSignature?.(signature);
      args.onSheetUploaded?.("obj-skip-0");
      return { objectKey: "obj-skip-0", sizeBytes: 33_000, version: 1 };
    });
    const handed: Array<{ objectKey: string; skip: unknown }> = [];
    // The stored video copy has no sound: the audio half of the signature reads the downloaded audio track.
    const audioInputs: string[] = [];
    const { runner, records } = setup({
      produce,
      produceSignature,
      stored: { previewSheets: PREVIEWS },
      onSkipSignature: async (job, objectKey, made) => {
        expect(made).toBe(signature);
        handed.push({ objectKey, skip: job.skip });
      },
      analyzeSkipAudio: async (args) => {
        audioInputs.push(args.inputPath);
        return null;
      },
    });
    const job = { ...JOB, skip: skipJobFor(2, 1) };
    const outcome = await runner.runCatchUp(job, {
      prepareInput: async () => ({ inputPath: "/vault/360p.mp4", audioPath: "/vault/audio.mp4" }),
      shouldYield: () => false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    console.info(`[${SUITE}:signature-only] outcome=${outcome} handed=${JSON.stringify(handed)}`);
    expect(outcome).toBe("recorded");
    expect(produce).not.toHaveBeenCalled();
    expect(produceSignature).toHaveBeenCalledTimes(1);
    expect(records).toEqual([{ ...PREVIEWS, skipSignature: { objectKey: "obj-skip-0", sizeBytes: 33_000, version: 1 } }]);
    expect(handed).toEqual([{ objectKey: "obj-skip-0", skip: { season: 2, episode: 1 } }]);
    expect(audioInputs).toEqual(["/vault/audio.mp4"]);
  });

  it("@req MPV-PREV-03 a video with sheets and a signature is not decoded again; without a skip request, sheets alone suffice", async () => {
    const produce = vi.fn<ProducePreviewSheetsFn>(async () => PREVIEWS);
    const signed = { ...PREVIEWS, skipSignature: { objectKey: "obj-skip-0", sizeBytes: 33_000, version: 1 } };
    const { runner } = setup({ produce, stored: { previewSheets: signed } });
    const outcome = await runner.runCatchUp({ ...JOB, skip: skipJobFor(null, null) }, { prepareInput: async () => ({ inputPath: "/videos/Local.mkv", audioPath: null }), shouldYield: () => false });
    expect(outcome).toBe("already-recorded");
    expect(produce).not.toHaveBeenCalled();
  });

  it("@req MPV-PREV-03 the runner tells which formats have an import run queued or running", async () => {
    let finish: (() => void) | null = null;
    const produce = vi.fn<ProducePreviewSheetsFn>(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(PREVIEWS);
        })
    );
    const { runner } = setup({ produce });
    const importJob: PreviewSheetsJob = { ...JOB, jobId: "import-1", formatId: "fmt-import", inputPath: "/videos/New.mkv", origin: undefined };
    runner.schedule(importJob);
    await vi.waitFor(() => expect(produce).toHaveBeenCalled());
    console.info(`[${SUITE}:queued] running=${JSON.stringify(runner.queuedImportFormatIds())}`);
    expect(runner.queuedImportFormatIds()).toEqual(["fmt-import"]);
    finish!();
    await vi.waitFor(() => expect(runner.queuedImportFormatIds()).toEqual([]));
  });

  it("@req MPV-PREV-03 a source skipped for lack of disk space is a skip, not a failure", async () => {
    const produce = vi.fn<ProducePreviewSheetsFn>(async () => PREVIEWS);
    const { runner, released } = setup({ produce });
    const outcome = await runner.runCatchUp(JOB, {
      prepareInput: async () => {
        throw new PreviewCatchUpSkip("disk_full");
      },
      shouldYield: () => false,
    });
    console.info(`[${SUITE}:skip] outcome=${outcome}`);
    expect(outcome).toBe("skipped");
    expect(produce).not.toHaveBeenCalled();
    expect(released).toEqual([]);
  });

  it("@req MPV-PREV-03 a run cut by a network outage reports unreachable, not failed", async () => {
    const produce = vi.fn<ProducePreviewSheetsFn>(async () => {
      throw new Error("fetch failed");
    });
    const { runner } = setup({ produce });
    const outcome = await runner.runCatchUp(JOB, { prepareInput: async () => ({ inputPath: "/videos/Local.mkv", audioPath: null }), shouldYield: () => false });
    console.info(`[${SUITE}:unreachable] outcome=${outcome}`);
    expect(outcome).toBe("unreachable");
  });
});

describe("imports always first (MPV-PREV-07)", () => {
  /** A step that only ends when its signal is cut, as the real download and decoders do. */
  const hangUntilAborted = (signal: AbortSignal | undefined) =>
    new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  it.each(["download", "pictures"] as const)(
    "@req MPV-PREV-07 a catch-up video gives way within 2 s of an import starting, inside the %s step",
    async (step) => {
      let busy = false;
      let flippedAt = 0;
      const produce = vi.fn<ProducePreviewSheetsFn>((args) => {
        if (step === "pictures") busy = true;
        return hangUntilAborted(args.signal);
      });
      // The format check (5 s by default) is not what cuts it: the yield check runs on its own.
      const { runner } = setup({ produce, formatCheckMs: 60_000 });
      const outcome = runner.runCatchUp(JOB, {
        prepareInput: async (_dir, signal) => {
          if (step === "download") {
            busy = true;
            return hangUntilAborted(signal);
          }
          return { inputPath: "/videos/Local.mkv", audioPath: null };
        },
        shouldYield: () => {
          if (busy && flippedAt === 0) flippedAt = Date.now();
          return busy;
        },
      });
      const settled = await outcome;
      const ms = Date.now() - flippedAt;
      console.info(`[${SUITE}:yield-${step}] outcome=${settled} ms=${ms}`);
      expect(settled).toBe("yielded");
      expect(ms).toBeLessThan(2_000);
    }
  );

  it("@req MPV-PREV-07 an import's run cuts the running catch-up video at once and runs before any other catch-up video", async () => {
    const order: string[] = [];
    const produce = vi.fn<ProducePreviewSheetsFn>(async (args) => {
      order.push(`start:${args.inputPath}`);
      if (args.inputPath === "/videos/Old.mkv") return hangUntilAborted(args.signal);
      return PREVIEWS;
    });
    const { runner } = setup({ produce, formatCheckMs: 60_000 });
    const options = (inputPath: string) => ({
      prepareInput: async () => ({ inputPath, audioPath: null }),
      shouldYield: () => false,
    });
    const startedAt = Date.now();
    const catchUp = runner.runCatchUp(JOB, options("/videos/Old.mkv"));
    await vi.waitFor(() => expect(produce).toHaveBeenCalledTimes(1));
    const importJob: PreviewSheetsJob = { ...JOB, jobId: "import-1", formatId: "fmt-import", inputPath: "/videos/New.mkv", origin: undefined };
    const imported = runner.schedule(importJob);
    const nextCatchUp = runner.runCatchUp({ ...JOB, jobId: "catch-up-fmt-2", formatId: "fmt-2" }, options("/videos/Other.mkv"));
    const cut = await catchUp;
    const cutMs = Date.now() - startedAt;
    await imported;
    await nextCatchUp;
    console.info(`[${SUITE}:import-first] cut=${cut} ms=${cutMs} order=${JSON.stringify(order)}`);
    expect(cut).toBe("yielded");
    expect(cutMs).toBeLessThan(2_000);
    expect(order).toEqual(["start:/videos/Old.mkv", "start:/videos/New.mkv", "start:/videos/Other.mkv"]);
  });
});
