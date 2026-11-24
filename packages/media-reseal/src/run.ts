/**
 * The device side of a reseal run (STOR-RESEAL-01/02): page through the objects the server says still wait, open
 * each with the old media library key, upload the copy sealed with the new key next to it (STOR-RESEAL-03), and mark
 * the ones the old key cannot open as kept (STOR-RESEAL-05). The server holds the run, so a stopped run resumes on
 * any device from what is still pending. I/O is injected: `resealIoForRun` binds the API, tests bind fakes.
 */
import {
  downloadStorageObjectViaTunnel,
  getMediaResealRun,
  listMediaResealCopies,
  markMediaResealKept,
  uploadStorageObjectViaTunnel,
  type MediaResealCopies,
  type MediaResealProgress,
} from "@space/shared/api";
import { placementOfKey, resealCopyKey } from "./copyKey";
import { resealObject, type ResealKeys } from "./sealing";

/** The API's page limit for pending objects, copies and kept marks. */
export const RESEAL_PAGE_MAX = 500;

export type ResealPending = MediaResealProgress["pending"][number];

export type ResealUpload = {
  /** The old object this copy takes over. */
  of: string;
  objectNamespace: string | null;
  contentType: string | null;
  placementId: string | null;
};

export type ResealIo = {
  pending(after: string | null, limit: number): Promise<MediaResealProgress>;
  download(key: string): Promise<Uint8Array>;
  upload(copyKey: string, sealed: Uint8Array, copy: ResealUpload): Promise<void>;
  markKept(keys: string[]): Promise<void>;
  copies(after: string | null, limit: number): Promise<MediaResealCopies>;
};

/** Binds a run's I/O to the API and the storage tunnel. Downloads use the `export` purpose (allowed when unpaid). */
export const resealIoForRun = (token: string, runId: string): ResealIo => ({
  pending: (after, limit) => getMediaResealRun(token, runId, { after, limit }),
  download: (key) => downloadStorageObjectViaTunnel(token, key, { purpose: "export" }),
  upload: async (copyKey, sealed, copy) => {
    await uploadStorageObjectViaTunnel(token, copyKey, sealed, {
      reseal: { runId, of: copy.of },
      ...(copy.objectNamespace ? { objectNamespace: copy.objectNamespace } : {}),
      ...(copy.contentType ? { contentType: copy.contentType } : {}),
      ...(copy.placementId ? { placementId: copy.placementId } : {}),
    });
  },
  markKept: async (keys) => {
    await markMediaResealKept(token, runId, keys);
  },
  copies: (after, limit) => listMediaResealCopies(token, runId, { after, limit }),
});

/**
 * Where the run is. The transfer counts both the download and the upload of every file (ACCT-KEYCHG-09): a copy is
 * as large as its old object, so the total is twice the bytes still pending when the run started here.
 */
export type ResealRunProgress = {
  totalFiles: number;
  doneFiles: number;
  keptFiles: number;
  transferBytes: number;
  transferredBytes: number;
};

export type ResealRunResult = { copied: number; kept: number; stopped: boolean };

export type ResealRunOptions = {
  onProgress?: (progress: ResealRunProgress) => void;
  /** Checked between objects: a stopped run is resumed later from what the server still lists. */
  signal?: AbortSignal;
  /** The copy's fresh last part; tests pin it. */
  uuid?: () => string;
  /**
   * Awaited before each object (ACCT-KEYCHG-05: a phone on mobile data waits here for Wi-Fi). It resolves when the next
   * object may go, or once `signal` aborts; it never rejects for the abort.
   */
  beforeFile?: (signal: AbortSignal) => Promise<void>;
};

const errorCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("error" in error && typeof error.error === "string") return error.error;
  return null;
};

/** A copy name another object already holds (409 `reseal_target_taken`): a new name is drawn once. */
const isTargetTaken = (error: unknown) =>
  errorCode(error) === "reseal_target_taken" || (error instanceof Error && error.message.includes("reseal_target_taken"));

export const runMediaReseal = async (io: ResealIo, keys: ResealKeys, options: ResealRunOptions = {}): Promise<ResealRunResult> => {
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const first = await io.pending(null, RESEAL_PAGE_MAX);
  const progress: ResealRunProgress = {
    totalFiles: first.totalFiles,
    // The server's done count already holds the kept ones.
    doneFiles: first.doneFiles,
    keptFiles: first.keptFiles,
    transferBytes: first.pendingBytes * 2,
    transferredBytes: 0,
  };
  const report = () => options.onProgress?.({ ...progress });
  report();

  let copied = 0;
  let kept: string[] = [];
  let keptTotal = 0;
  // A kept file is counted only once the server holds its mark, so "See the N files" lists every file the count
  // names (ACCT-KEYCHG-07). Marks are batched until the next copy, the page's end or 500 keys.
  const flushKept = async () => {
    while (kept.length > 0) {
      const batch = kept.slice(0, RESEAL_PAGE_MAX);
      await io.markKept(batch);
      kept = kept.slice(batch.length);
      progress.keptFiles += batch.length;
      report();
    }
  };

  const resealOne = async (entry: ResealPending) => {
    const stored = await io.download(entry.key);
    progress.transferredBytes += entry.sizeBytes;
    report();
    const outcome = await resealObject(keys, stored);
    if (outcome.kind === "unreadable") {
      kept.push(entry.key);
      keptTotal += 1;
      progress.doneFiles += 1;
      progress.transferredBytes += entry.sizeBytes;
      if (kept.length >= RESEAL_PAGE_MAX) await flushKept();
      report();
      return;
    }
    await flushKept();
    const copy: ResealUpload = {
      of: entry.key,
      objectNamespace: entry.objectNamespace,
      contentType: entry.contentType,
      placementId: placementOfKey(entry.key),
    };
    try {
      await io.upload(resealCopyKey(entry.key, uuid()), outcome.sealed, copy);
    } catch (error) {
      if (!isTargetTaken(error)) throw error;
      await io.upload(resealCopyKey(entry.key, uuid()), outcome.sealed, copy);
    }
    copied += 1;
    progress.doneFiles += 1;
    progress.transferredBytes += entry.sizeBytes;
    report();
  };

  let page = first;
  for (;;) {
    for (const entry of page.pending) {
      if (options.beforeFile && !options.signal?.aborted) await options.beforeFile(options.signal ?? new AbortController().signal);
      if (options.signal?.aborted) {
        await flushKept();
        return { copied, kept: keptTotal, stopped: true };
      }
      await resealOne(entry);
    }
    await flushKept();
    if (!page.nextAfter) break;
    page = await io.pending(page.nextAfter, RESEAL_PAGE_MAX);
  }
  return { copied, kept: keptTotal, stopped: false };
};

/**
 * Every copy of the run as `old key → copy key`, for rewriting the library's references before the switch
 * (STOR-RESEAL-01). Kept objects have no copy and keep their key.
 */
export const collectResealCopies = async (io: Pick<ResealIo, "copies">): Promise<Map<string, string>> => {
  const copies = new Map<string, string>();
  let after: string | null = null;
  for (;;) {
    const page = await io.copies(after, RESEAL_PAGE_MAX);
    for (const copy of page.copies) {
      if (!copy.kept && copy.newKey) copies.set(copy.oldKey, copy.newKey);
    }
    if (!page.nextAfter) return copies;
    after = page.nextAfter;
  }
};
