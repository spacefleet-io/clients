/**
 * "Download file" (OFFL-FILE-01): `exportTitleFiles` picks a folder, then submits the title (or one episode's files)
 * with the flat layout, and turns the runtime's answer into a toast. The real `exportIpc` runs, so a payload or result
 * that drifts from the contract fails here; only the preload bridge `window.sf.exportFiles` is faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { rendererLogger: { child: () => log, ...log } };
});

import { exportOutcomeToast, exportTitleFiles } from "../src/renderer/src/lib/exportFlow";

const SUITE = "export-flow";
const t = ((key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key)) as unknown as TFunction;

let bridge: { pickFolder: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn>; estimate: ReturnType<typeof vi.fn> };

const install = (folder: string | null, submitResult: unknown) => {
  bridge = { pickFolder: vi.fn(async () => folder), submit: vi.fn(async () => submitResult), estimate: vi.fn() };
  (globalThis as unknown as { window: { sf: { exportFiles: typeof bridge } } }).window = { sf: { exportFiles: bridge } };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exportTitleFiles (Download file, OFFL-FILE-01)", () => {
  it("exports a movie flat into the picked folder at the chosen container", async () => {
    install("/home/me/Videos", { submitted: [{ mediaId: "m1", fileId: "f1", jobId: "j1" }], skipped: [] });
    const outcome = await exportTitleFiles({ t, locale: "en", mediaId: "m1", container: "mkv" });
    console.log(`[${SUITE}] phase=movie submit=${JSON.stringify(bridge.submit.mock.calls)} outcome=${JSON.stringify(outcome)}`);
    expect(bridge.submit).toHaveBeenCalledWith({ mediaIds: ["m1"], destDir: "/home/me/Videos", container: "mkv", layout: "flat" });
    expect(outcome).toEqual({ kind: "submitted", count: 1, skipped: 0, destDir: "/home/me/Videos" });
    expect(exportOutcomeToast(t, outcome)).toBe('library.export.submittedToast {"count":1,"folder":"/home/me/Videos"}');
  });

  it("narrows a show to one episode's files", async () => {
    install("D:\\Exports", { submitted: [{ mediaId: "show", fileId: "ep-file", jobId: "j9" }], skipped: [] });
    await exportTitleFiles({ t, locale: "en", mediaId: "show", fileIds: ["ep-file"], container: "mp4" });
    console.log(`[${SUITE}] phase=episode submit=${JSON.stringify(bridge.submit.mock.calls)}`);
    expect(bridge.submit).toHaveBeenCalledWith({
      mediaIds: ["show"],
      fileIds: ["ep-file"],
      destDir: "D:\\Exports",
      container: "mp4",
      layout: "flat",
    });
  });

  it("cancels quietly when the folder dialog is closed", async () => {
    install(null, {});
    const outcome = await exportTitleFiles({ t, locale: "en", mediaId: "m1", container: "mkv" });
    console.log(`[${SUITE}] phase=cancel outcome=${JSON.stringify(outcome)}`);
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(bridge.submit).not.toHaveBeenCalled();
    expect(exportOutcomeToast(t, outcome)).toBeNull();
  });

  it("turns the runtime's refusals into user-facing reasons", async () => {
    install("/x", { errorCode: "insufficient_disk_space", requiredBytes: 5_000_000_000, freeBytes: 1_000_000_000 });
    const disk = await exportTitleFiles({ t, locale: "en", mediaId: "m1", container: "mkv" });
    console.log(`[${SUITE}] phase=disk outcome=${JSON.stringify(disk)}`);
    expect(disk.kind).toBe("failed");
    expect(exportOutcomeToast(t, disk)).toMatch(/^library\.export\.errors\.insufficient_disk_space \{"required":"[^"]+","free":"[^"]+"\}$/);

    install("/x", { errorCode: "not_authenticated" });
    const auth = await exportTitleFiles({ t, locale: "en", mediaId: "m1", container: "mkv" });
    expect(exportOutcomeToast(t, auth)).toBe("library.export.errors.not_authenticated");

    install("/x", { __runtimeJobsError: true, status: 0, errorCode: "dest_not_picked", message: "nope" });
    const notPicked = await exportTitleFiles({ t, locale: "en", mediaId: "m1", container: "mkv" });
    expect(exportOutcomeToast(t, notPicked)).toBe("library.export.errors.dest_not_picked");

    install("/x", { surprise: true });
    const drift = await exportTitleFiles({ t, locale: "en", mediaId: "m1", container: "mkv" });
    console.log(`[${SUITE}] phase=drift outcome=${JSON.stringify(drift)}`);
    expect(drift.kind).toBe("failed");
    expect(exportOutcomeToast(t, drift)).toContain("library.export.errors.generic");
  });
});
