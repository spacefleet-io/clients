/**
 * OFFL-MIGR-01: titles an older Badger desktop saved offline as one plain file (`media_local_downloads`
 * schema_version 1, a .mkv / .mp4 inside the app's offline dir) are re-saved as sealed pieces (OFFL-FILE-03) at the
 * same file and quality, and their old file is deleted. The user's selection is kept: the v1 row stays until the
 * re-save replaces it in one write (upsert on file_id).
 *
 * Runs once the library DB is open with the network up (an offline start leaves the rows for the next online open:
 * agent reading, a re-save cannot download anything then). For each v1 row with no save already in flight for its
 * file (idempotent across opens):
 *   - space for the pieces (OFFL-SAFE-02, running total over the rows): submit the re-save; the step deletes the old
 *     file once the pieces are recorded;
 *   - not enough space: delete the old file first (only from inside the offline dir, never a user folder), then
 *     submit. When even that is short, the step refuses with the not-enough-space message and the row waits for the
 *     next open; a partial re-save never counts (OFFL-SAFE-01);
 *   - the library no longer holds the file: nothing can replace it, so the old file and its row go.
 */

import { promises as fs } from "node:fs";
import { isPathUnderDir } from "@space/library-db-runtime/offlinePieceStore";
import type { IngestJobStatus } from "@space/runtime-jobs";
import { FREE_DISK_SAFETY_MARGIN_BYTES, freeDiskBytesAt } from "./offlineDownloadDeps";
import { buildOfflineResaveJob, type BadgerOfflineHandlerDeps } from "./offlineDownload";

const TERMINAL: ReadonlySet<IngestJobStatus> = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

export interface OfflineMigrationResult {
  legacyRows: number;
  submitted: number;
  inFlight: number;
  removedFirstForSpace: number;
  dropped: number;
  errors: number;
}

export const migrateLegacyOfflineFiles = async (
  deps: BadgerOfflineHandlerDeps & { freeDiskBytes?(dir: string): Promise<number> }
): Promise<OfflineMigrationResult> => {
  const result: OfflineMigrationResult = {
    legacyRows: 0,
    submitted: 0,
    inFlight: 0,
    removedFirstForSpace: 0,
    dropped: 0,
    errors: 0,
  };
  if (!deps.libraryDb.isOpen()) return result;
  const legacy = (await deps.libraryDb.listLocalDownloads(undefined)).filter((row) => row.schemaVersion < 2);
  result.legacyRows = legacy.length;
  if (legacy.length === 0) return result;

  const inFlightFileIds = new Set<string>();
  for (const job of (await deps.engine.list()).jobs) {
    if (job.kind !== "download" || TERMINAL.has(job.status)) continue;
    const fileId = job.payload.fileId;
    if (typeof fileId === "string") inFlightFileIds.add(fileId);
  }
  const offlineRoot = deps.resolveOfflineDir(deps.resolveLibraryId?.() ?? "default");
  let freeBytes = await (deps.freeDiskBytes ?? freeDiskBytesAt)(offlineRoot);
  let committedBytes = 0;
  console.info("[badger.offline.migrate] start", {
    legacyRows: legacy.length,
    inFlight: inFlightFileIds.size,
    freeBytes,
    offlineRoot,
  });

  const removeLegacyFile = async (path: string): Promise<number> => {
    if (!isPathUnderDir(offlineRoot, path)) {
      console.warn(`[badger.offline.migrate] ${path} is outside the offline dir ${offlineRoot}; left alone`);
      return 0;
    }
    const size = await fs.stat(path).then((s) => s.size, () => 0);
    await fs.rm(path, { force: true });
    return size;
  };

  for (const row of legacy) {
    if (inFlightFileIds.has(row.fileId)) {
      result.inFlight += 1;
      console.info(`[badger.offline.migrate] fileId=${row.fileId} re-save already in flight`);
      continue;
    }
    try {
      const resave = await buildOfflineResaveJob(deps, row);
      if (!resave) {
        await removeLegacyFile(row.localPath);
        await deps.libraryDb.dropLocalDownloads({ type: "file", fileId: row.fileId });
        result.dropped += 1;
        console.warn(`[badger.offline.migrate] fileId=${row.fileId} no longer in the library; old file and row dropped`);
        continue;
      }
      const { job, requiredBytes } = resave;
      if (freeBytes - committedBytes < requiredBytes + FREE_DISK_SAFETY_MARGIN_BYTES) {
        const freed = await removeLegacyFile(row.localPath);
        freeBytes += freed;
        result.removedFirstForSpace += 1;
        console.info(
          `[badger.offline.migrate] fileId=${row.fileId} short of space (required=${requiredBytes} free=${freeBytes - freed} committed=${committedBytes}); old file removed first, freed=${freed}`
        );
      }
      committedBytes += requiredBytes;
      await deps.engine.submit(job);
      result.submitted += 1;
      console.info(
        `[badger.offline.migrate] fileId=${row.fileId} re-save submitted job=${job.jobId} quality=${row.quality} requiredBytes=${requiredBytes}`
      );
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[badger.offline.migrate] fileId=${row.fileId} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  console.info("[badger.offline.migrate] result", result);
  return result;
};
