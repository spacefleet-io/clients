/**
 * @test-id PARROT-DESKTOP-JOBS-INTERRUPTED-001
 * @level unit (main's import jobs list: the error a stopped import records, and the list read back at start)
 * @why UX-JOBS-01: an import still running when Parrot closed shows as failed, with the line saying to import the
 *   folder again. Closing Parrot mid-upload aborted the import and closed the light-copy encoder window, so the import
 *   saved "the encoder window closed" as its error and the card said "Import failed: the encoder window closed".
 */
import { describe, expect, it } from "vitest";
import { importStopError, restoreImportJobs, type StoredImportJob } from "../src/main/importJobs";
import { IMPORT_INTERRUPTED, type ParrotImportStatus } from "../src/shared/ipc";

const SUITE = "[parrot-import-interrupted]";

const status = (patch: Partial<ParrotImportStatus>): ParrotImportStatus => ({
  running: false,
  phase: "done",
  total: 6,
  done: 0,
  imported: 0,
  skipped: 0,
  failed: 0,
  bytesDone: 0,
  bytesTotal: 0,
  published: 0,
  currentFile: null,
  error: null,
  ...patch,
});

const stored = (id: string, patch: Partial<ParrotImportStatus>, finishedAt: number | null = null): StoredImportJob => ({
  id,
  userId: "u1",
  sources: [`/home/me/Music/${id}`],
  startedAt: 1,
  finishedAt,
  failures: [],
  status: status(patch),
});

// @req UX-JOBS-01[parrot]
describe("an import cut short by Parrot closing", () => {
  it("[@bugfix][@regression-proof] records the interrupted error, whatever the import ended on", () => {
    const cases = [new Error("the encoder window closed"), new DOMException("This operation was aborted", "AbortError"), "boom"];
    for (const error of cases) {
      const recorded = importStopError(error, true);
      console.info(`${SUITE} closing, ${String(error)} -> ${recorded}`);
      expect(recorded).toBe(IMPORT_INTERRUPTED);
    }
  });

  it("keeps the import's own error when Parrot is not closing", () => {
    expect(importStopError(new Error("the server said no"), false)).toBe("the server said no");
    expect(importStopError("boom", false)).toBe("boom");
  });

  it("reads back a job still running as failed and interrupted, drops a scan waiting for review, keeps ended jobs", () => {
    const failedOnClose = stored("Closed Album", { phase: "failed", imported: 1, error: IMPORT_INTERRUPTED }, 5);
    const restored = restoreImportJobs(
      [
        stored("Running Album", { running: true, phase: "uploading", imported: 2, currentFile: "/home/me/Music/Running Album/03.flac" }),
        stored("Review Album", { phase: "review" }),
        failedOnClose,
        stored("Done Album", { phase: "done", imported: 6 }, 4),
      ],
      99
    );
    console.info(`${SUITE} restored=${JSON.stringify(restored.map((job) => [job.id, job.status.phase, job.status.error]))}`);
    expect(restored.map((job) => job.id)).toEqual(["Running Album", "Closed Album", "Done Album"]);
    expect(restored[0]).toMatchObject({ finishedAt: 99, status: { running: false, phase: "failed", currentFile: null, error: IMPORT_INTERRUPTED, imported: 2 } });
    expect(restored[1]).toBe(failedOnClose);
    expect(restoreImportJobs({ not: "a list" }, 99)).toEqual([]);
  });
});
