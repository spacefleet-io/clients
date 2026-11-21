/**
 * Module-scoped dependency registry for the Phase 2 offline-download step.
 *
 * Mirrors the pattern in `apps/runtime/src/modules/badger/steps/deps.ts`
 * (a narrow seam the runtime wires once at boot, tests inject mocks via the
 * same setter) but kept separate so the offline pipeline has no upward dep on
 * the ingest pipeline's deps interface.
 *
 * Production wiring lives in `apps/runtime/src/modules/index.ts` next to
 * `setEngineV2ForBadgerIngest` — same lifecycle, same HMR resilience via
 * `globalThis`-keyed slot.
 */

import { promises as fs, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { decryptMediaObject } from "@space/media-crypto";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import type { OfflineTrafficSource } from "./offlineTrafficGate";
import { createAuthWaiter } from "./steps/authWait";

/** Room kept free on the disk beyond a download's own size (OFFL-SAFE-02), the same margin as the uploads. */
export const FREE_DISK_SAFETY_MARGIN_BYTES = 100 * 1024 * 1024;

/**
 * Free bytes on the disk holding `dir` (OFFL-SAFE-02). `statfs` needs an existing directory, so a dir not created yet
 * is measured at its nearest existing parent. 0 when nothing can be measured.
 */
export const freeDiskBytesAt = async (dir: string): Promise<number> => {
  let candidate = dir;
  for (;;) {
    try {
      await fs.access(candidate);
      break;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  try {
    const stat = statfsSync(candidate);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Number.isFinite(free) && free > 0 ? free : 0;
  } catch (err) {
    console.warn(`[badger.offline] statfs failed for ${candidate}:`, err instanceof Error ? err.message : err);
    return 0;
  }
};

/**
 * Dependency surface for the offline-download step handler + the five
 * `badger.offline.*` command handlers. Designed to be small enough that a
 * unit test can hand-roll a stub in a few lines.
 */
export interface BadgerOfflineDeps {
  /**
   * The backend token and the library key of the active session, from the runtime's memory (RT-SEC-05: neither is
   * ever written to a job payload or to disk). A job resumed at boot runs before the desktop re-attaches the
   * session, so this waits (bounded, abortable, logged) for the push; `null` once the wait expires.
   */
  awaitCredentials(wait: {
    jobId: string;
    signal: AbortSignal;
  }): Promise<{ token: string; libraryKeyBase64: string } | null>;
  /**
   * Download a single encrypted chunk from the storage gateway. `onTraffic` hears the report of the silo serving the
   * object (session open, every ack).
   */
  downloadObject(
    token: string,
    objectKey: string,
    options?: { onTraffic?: (traffic: StorageTraffic) => void }
  ): Promise<Uint8Array>;
  /**
   * The traffic reads: `refresh` is the per-silo poll (STOR-BW-09), while the object's silo is saturated the download
   * step holds between objects; `current` is the merged "any silo high" snapshot (STOR-BW-01), while it is high the
   * download step is slowed, never stopped. Omitted = never holds nor slows (tests).
   */
  traffic?: OfflineTrafficSource;
  /**
   * Symmetric to `encryptMediaObject` (used during ingest). Defaults to
   * the canonical `decryptMediaObject` from `@space/media-crypto`; tests can
   * inject a passthrough to avoid wiring real AES-GCM around fixture data.
   */
  decrypt(encrypted: Uint8Array, libraryKeyBase64: string): Buffer;
  /**
   * Returns the absolute path of the per-library offline dir, e.g.
   * `<userData>/offline/<libraryId>/`. The desktop main resolves
   * `app.getPath("userData")` and exposes the root via env var; the runtime
   * mirrors the same env so tests can override.
   */
  resolveOfflineDir(libraryId: string): string;
  /** Optional ffmpeg binary override; falls back to PATH lookup. */
  resolveFfmpegPath?(): string | undefined;
  /**
   * Free bytes on the disk holding `dir` (OFFL-SAFE-02). The step checks it before fetching anything. Omitted = the
   * real `statfs` of `dir` (or its nearest existing parent); tests inject a number.
   */
  freeDiskBytes?(dir: string): Promise<number>;
  /**
   * Record the saved title in `media_local_downloads` once every piece and the item manifest are in place.
   * `schemaVersion` 2 = sealed pieces (OFFL-FILE-03); a row for the same file is replaced.
   */
  registerLocalDownload(input: {
    id: string;
    fileId: string;
    mediaId: string;
    quality: string;
    formatId: string;
    container: string;
    localPath: string;
    totalBytes: number;
    downloadedAt: string;
    runtimeJobId: string | null;
    schemaVersion?: number;
  }): Promise<{ inserted: number }>;
}

// ---------------------------------------------------------------------------
// Hot-reload-safe registry. Same `globalThis`-keyed pattern documented in
// `apps/runtime/src/modules/badger/steps/deps.ts`. A re-evaluation of THIS
// file via `bun --hot` re-imports type definitions but keeps the slot value
// alive — production wiring stays valid across reloads.
// ---------------------------------------------------------------------------

const GLOBAL_SLOT = Symbol.for("@space/runtime/badger-offline/deps-registry/v1");

interface GlobalRegistrySlot {
  configured: BadgerOfflineDeps | null;
}

const getGlobalSlot = (): GlobalRegistrySlot => {
  const g = globalThis as unknown as Record<symbol, GlobalRegistrySlot | undefined>;
  let slot = g[GLOBAL_SLOT];
  if (!slot) {
    slot = { configured: null };
    g[GLOBAL_SLOT] = slot;
  }
  return slot;
};

export const configureBadgerOfflineDeps = (deps: BadgerOfflineDeps): void => {
  getGlobalSlot().configured = deps;
};

export const getBadgerOfflineDeps = (): BadgerOfflineDeps => {
  const slot = getGlobalSlot();
  if (slot.configured) return slot.configured;
  // Mirror the deps.ts loud-failure pattern — surface where the dispatch
  // came from so the gap is diagnosable from the runtime log alone.
  const stack = new Error().stack ?? "(no stack)";
  console.error(
    `[badger.offline] BADGER_OFFLINE_DEPS_NOT_CONFIGURED — getBadgerOfflineDeps() called before configureBadgerOfflineDeps(). Stack: ${stack}`
  );
  throw new Error(
    "BADGER_OFFLINE_DEPS_NOT_CONFIGURED — call configureBadgerOfflineDeps() before submitting offline jobs"
  );
};

/** Test-only: clears the registered deps. Production never calls this. */
export const __resetBadgerOfflineDeps = (): void => {
  getGlobalSlot().configured = null;
};

/**
 * Production {@link BadgerOfflineDeps.awaitCredentials}: reads the active session's token and library key from the
 * runtime's memory through `resolve*`, waiting (bounded, same budget as the other resumed steps) for the desktop to
 * push them when the job was resumed at boot.
 */
export const createOfflineAwaitCredentials = (source: {
  resolveToken(): string | null;
  resolveLibraryKey(): string | null;
  authWaitMs?: number;
  authPollMs?: number;
}): BadgerOfflineDeps["awaitCredentials"] => {
  const { waitForReady } = createAuthWaiter({ authWaitMs: source.authWaitMs, authPollMs: source.authPollMs });
  return async ({ jobId, signal }) => {
    const wait = { stage: "offline-download", userId: "active", jobId, signal };
    const token = await waitForReady("backend token", () => source.resolveToken() ?? "", wait);
    if (!token) return null;
    const libraryKeyBase64 = await waitForReady("library key", () => source.resolveLibraryKey() ?? "", wait);
    if (!libraryKeyBase64) return null;
    return { token, libraryKeyBase64 };
  };
};

/**
 * Offline downloads are exports of the user's own files: their tunnel sessions
 * open with purpose `export`, the only purpose an unpaid account may still use
 * (playback and uploads answer 402 `subscription_unpaid`) — #145 step 5.
 */
export const createOfflineDownloadObject =
  (bridge: {
    downloadObject(
      token: string,
      objectKey: string,
      options: { purpose: "export"; hints?: { onTraffic?: (traffic: StorageTraffic) => void } }
    ): Promise<Uint8Array>;
  }): BadgerOfflineDeps["downloadObject"] =>
  (token, objectKey, options) =>
    bridge.downloadObject(token, objectKey, {
      purpose: "export",
      ...(options?.onTraffic ? { hints: { onTraffic: options.onTraffic } } : {}),
    });

/**
 * Convenience: a sane decrypt default for production. Re-exported so the
 * wiring site in `apps/runtime/src/modules/index.ts` doesn't have to import
 * `@space/media-crypto` directly — keeps the wiring file's import surface
 * narrow.
 */
export const offlineDefaultDecrypt = decryptMediaObject;
