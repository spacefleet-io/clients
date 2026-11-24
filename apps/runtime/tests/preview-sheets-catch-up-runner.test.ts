/**
 * @test-id RUNTIME-PREVIEW-CATCH-UP-RUNNER-001
 * @level unit
 * @why The catch-up pass (MPV-PREV-03) makes the sheets of videos already in the library through the same
 *      one-at-a-time runner as the imports (MPV-PREV-02). Its input is prepared per run (the local file, or the
 *      stored copy downloaded and decrypted next to the job dir); the run gives way when an import or a playback
 *      starts; and a run cut by a restart is released and dropped, since the pass simply picks the video again.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import {
  createPreviewSheetsRunner,
  PreviewCatchUpSkip,
  type PreviewSheetsJob,
  type ProducePreviewSheetsFn,
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

const setup = (opts: { produce: ProducePreviewSheetsFn; stored?: { previewSheets: MediaPreviewSheets | null } | null }) => {
  const released: string[][] = [];
  const methods: string[] = [];
  const libraryDb = {
    call: vi.fn(async (method: string) => {
      methods.push(method);
      if (method === "setMediaFormatPreviewSheets") return true;
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
    transcodeRoot: () => root,
    formatCheckMs: 10,
  });
  return { runner, released, methods };
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
        return path;
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
    const outcome = await runner.runCatchUp(JOB, { prepareInput: async () => "/videos/Local.mkv", shouldYield: () => busy });
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
    const outcome = await runner.runCatchUp(JOB, { prepareInput: async () => "/videos/Local.mkv", shouldYield: () => false });
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
    const prepareInput = vi.fn(async () => "/videos/Local.mkv");
    const { runner, methods } = setup({ produce, stored: { previewSheets: PREVIEWS } });
    const outcome = await runner.runCatchUp(JOB, { prepareInput, shouldYield: () => false });
    console.info(`[${SUITE}:already] outcome=${outcome} methods=${JSON.stringify(methods)}`);
    expect(outcome).toBe("already-recorded");
    expect(prepareInput).not.toHaveBeenCalled();
    expect(produce).not.toHaveBeenCalled();
    expect(methods).not.toContain("setMediaFormatPreviewSheets");
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
    const outcome = await runner.runCatchUp(JOB, { prepareInput: async () => "/videos/Local.mkv", shouldYield: () => false });
    console.info(`[${SUITE}:unreachable] outcome=${outcome}`);
    expect(outcome).toBe("unreachable");
  });
});
