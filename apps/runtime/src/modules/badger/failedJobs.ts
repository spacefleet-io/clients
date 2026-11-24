/**
 * Failed Badger imports: which ONE action each offers, running it, and the
 * processed copies kept for them (UX-JOBS-03, INGS-KEEP-01, INGS-RESUME-01).
 *
 * A failed source or format job keeps its processed copy in
 * `<transcode base>/<userId>/<jobId>`. The action is decided from what is
 * still on disk when the Jobs panel asks, never from the error text alone:
 *
 *   1. the storage plan is full          → `upgrade_plan`
 *   2. this computer's disk is full      → `free_space` (only while it still is)
 *   3. the same video was imported since → `already_in_library`
 *   4. the processed copy is kept        → `upload_again` (only the upload runs)
 *   5. the original file is there, same  → `process_again`
 *   6. the original file is in the trash → `remove_only`
 *   7. the original file moved / changed → `find_file`
 *
 * "Same video" = same size and same SHA-256 over its first, middle and last
 * MiB, recorded at submit (`payload.sourceFingerprint`). A retry re-checks
 * before it runs and refuses with the action that fits now.
 *
 * Kept copies live 14 days after the failure, or until the job is removed.
 * While the disk holding them has less than {@link KEPT_COPIES_MIN_FREE_BYTES}
 * free, the oldest go first. A removed copy flips its job to `process_again`;
 * `payload.keptCopyRemoved` records why, and the on-disk absence is the state
 * itself, so both survive a restart.
 */
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join as joinPath } from "node:path";
import { loadJobStateSync } from "@space/content-core";
import type {
  FailedJobAction,
  FailedJobAvailability,
  FailedJobReason,
  RuntimeJobsAvailabilityResult,
  RuntimeJobsRetryPayload,
  RuntimeJobsRetryResult,
} from "@space/runtime-contracts/runtime/jobs";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { EngineV2 } from "../../core/jobs/engineV2";
import { defaultFreeBytesAt } from "./export";
import { getBadgerStepDeps } from "./steps/deps";
import { dirSizeBytes, resolveJobDir, resolveTranscodeRoot } from "./steps/deps-adapter";

/** Chris 2026-11-24 (chat): processed copies of failed uploads are kept 14 days. */
export const KEPT_COPIES_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Below this much free space on the transcode disk, kept copies are removed oldest first. */
export const KEPT_COPIES_MIN_FREE_BYTES = 10 * 1024 ** 3;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SAMPLE_BYTES = 1024 * 1024;

/** What a source file looked like at submit; compared to tell "same video" from "another file". */
export type SourceFingerprint = { size: number; mtimeMs: number; sampleSha256: string };

/** The storage API's "account full" refusals, by code or by the i18n key the runtime maps them to. */
const QUOTA_MARKERS = [
  "upload_quota_exceeded",
  "lab.errors.uploadQuotaExceeded",
  "storage_quota_blocked",
  "lab.errors.storageQuotaBlocked",
];
const DISK_FULL_PATTERN = /ENOSPC|no space left on device|disk is full/i;

/**
 * Size, mtime and a hash of the first, middle and last MiB of `path`; null
 * when it cannot be read. Hashing samples keeps it fast on 50 GB files while
 * still telling two encodes of the same length apart.
 */
export const fingerprintSourceFile = async (path: string): Promise<SourceFingerprint | null> => {
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return null;
    handle = await fs.open(path, "r");
    const hash = createHash("sha256");
    const offsets = [0, Math.max(0, Math.floor(stat.size / 2) - SAMPLE_BYTES / 2), Math.max(0, stat.size - SAMPLE_BYTES)];
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    for (const offset of offsets) {
      const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, offset);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sampleSha256: hash.digest("hex") };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

const readFingerprint = (value: unknown): SourceFingerprint | null => {
  const fp = value as Partial<SourceFingerprint> | null | undefined;
  return fp && typeof fp.size === "number" && typeof fp.sampleSha256 === "string"
    ? { size: fp.size, mtimeMs: typeof fp.mtimeMs === "number" ? fp.mtimeMs : 0, sampleSha256: fp.sampleSha256 }
    : null;
};

/**
 * Bytes of the job's kept processed copy, or null when there is none: the
 * job dir must hold a `job_state.json` whose every output finished encoding.
 */
export const readKeptCopyBytes = async (userId: string, jobId: string): Promise<number | null> => {
  const dir = resolveJobDir(userId, jobId);
  const state = loadJobStateSync<{ outputs?: Array<{ encodingComplete?: boolean }> }>(joinPath(dir, "job_state.json"));
  const outputs = Array.isArray(state?.outputs) ? state.outputs : [];
  if (outputs.length === 0 || !outputs.every((o) => o.encodingComplete === true)) return null;
  return dirSizeBytes(dir);
};

/** Where the desktop's trash puts a deleted file of that name (Linux, macOS); Windows has no plain path. */
const trashPathsFor = (filename: string): string[] => {
  const name = basename(filename);
  if (process.platform === "darwin") return [joinPath(homedir(), ".Trash", name)];
  if (process.platform === "linux") {
    const dataHome = process.env.XDG_DATA_HOME?.trim() || joinPath(homedir(), ".local", "share");
    return [joinPath(dataHome, "Trash", "files", name)];
  }
  return [];
};

const failedAtMs = (job: IngestJobRecord): number => Date.parse(job.finishedAt ?? job.updatedAt);

const userIdOf = (job: IngestJobRecord): string | null =>
  typeof job.payload.userId === "string" && job.payload.userId.length > 0 ? job.payload.userId : null;

export type BadgerFailedJobsDeps = {
  engine: EngineV2;
  /** Free bytes on the volume of a path; statfs by default. */
  freeBytesAt?: (dir: string) => number;
  /** Paths a deleted file would be found at in the trash; the desktop trash by default. */
  trashPathsFor?: (filename: string) => string[];
  now?: () => number;
};

export type BadgerFailedJobs = {
  availability(jobIds: string[]): Promise<RuntimeJobsAvailabilityResult>;
  retry(input: RuntimeJobsRetryPayload): Promise<RuntimeJobsRetryResult>;
  /** Remove kept copies past 14 days, of removed jobs, and the oldest while the disk is low. */
  sweepKeptCopies(trigger: string): Promise<{ removed: number; freedBytes: number }>;
  /** Boot sweep, then hourly. Returns the stop function. */
  startSweeper(): () => void;
};

export const createBadgerFailedJobs = (deps: BadgerFailedJobsDeps): BadgerFailedJobs => {
  const { engine } = deps;
  const freeBytesAt = deps.freeBytesAt ?? defaultFreeBytesAt;
  const trashPaths = deps.trashPathsFor ?? trashPathsFor;
  const now = deps.now ?? Date.now;

  /** The source file path and its submit-time fingerprint (a format job reads its source job's). */
  const sourceOf = async (job: IngestJobRecord): Promise<{ filename: string | null; fingerprint: SourceFingerprint | null }> => {
    const filename = typeof job.payload.filename === "string" && job.payload.filename ? job.payload.filename : null;
    let fingerprint = readFingerprint(job.payload.sourceFingerprint);
    if (!fingerprint && job.kind === "format" && job.parentJobIds[0]) {
      fingerprint = readFingerprint((await engine.get(job.parentJobIds[0]))?.job.payload.sourceFingerprint);
    }
    return { filename, fingerprint };
  };

  /** A later import of the same video (same media, or same file; same quality for a format job) succeeded. */
  const reimported = async (job: IngestJobRecord): Promise<boolean> => {
    const { jobs } = await engine.list({ app: "badger", status: ["succeeded"], kind: [job.kind], includeDismissed: true });
    return jobs.some(
      (other) =>
        other.jobId !== job.jobId &&
        other.createdAt > job.createdAt &&
        (job.kind !== "format" || other.variant === job.variant) &&
        ((job.mediaId && other.mediaId === job.mediaId) ||
          (job.payload.filename && other.payload.filename === job.payload.filename))
    );
  };

  /** The action the source file allows when no processed copy is kept. */
  const decideFromSource = async (
    job: IngestJobRecord
  ): Promise<{ action: FailedJobAction; reason: FailedJobReason }> => {
    const { filename, fingerprint } = await sourceOf(job);
    if (!filename) return { action: "remove_only", reason: "no_source_path" };
    const current = await fingerprintSourceFile(filename);
    if (current) {
      if (fingerprint && (current.size !== fingerprint.size || current.sampleSha256 !== fingerprint.sampleSha256)) {
        return { action: "find_file", reason: "source_changed" };
      }
      const removed = (job.payload.keptCopyRemoved as { why?: string } | undefined)?.why;
      if (removed === "low_disk") return { action: "process_again", reason: "kept_removed_low_disk" };
      if (removed === "expired") return { action: "process_again", reason: "kept_removed_expired" };
      return { action: "process_again", reason: "source_unchanged" };
    }
    if (trashPaths(filename).some((p) => existsSync(p))) return { action: "remove_only", reason: "source_deleted" };
    return { action: "find_file", reason: "source_missing" };
  };

  const decide = async (job: IngestJobRecord): Promise<FailedJobAvailability> => {
    const base = { jobId: job.jobId, nextAction: null, keptBytes: null, keptUntil: null };
    const userId = userIdOf(job);
    if (job.app !== "badger" || (job.kind !== "source" && job.kind !== "format") || !userId) {
      return { ...base, action: "remove_only", reason: "not_retryable" };
    }
    if (job.status === "cancelled" && job.errorCode === "parent-cancelled") {
      return { ...base, action: "remove_only", reason: "parent_failed" };
    }
    if (job.status !== "failed") return { ...base, action: "remove_only", reason: "not_retryable" };
    const keptBytes = await readKeptCopyBytes(userId, job.jobId);
    const kept = keptBytes === null
      ? base
      : { ...base, keptBytes, keptUntil: new Date(failedAtMs(job) + KEPT_COPIES_MAX_AGE_MS).toISOString() };
    const message = `${job.errorCode ?? ""} ${job.errorMessage ?? ""}`;
    if (await reimported(job)) return { ...kept, action: "already_in_library", reason: "reimported" };
    const next = keptBytes !== null
      ? { action: "upload_again" as const, reason: "kept_outputs" as const }
      : await decideFromSource(job);
    if (QUOTA_MARKERS.some((marker) => message.includes(marker))) {
      return { ...kept, action: "upgrade_plan", reason: "upload_quota", nextAction: next.action };
    }
    if (DISK_FULL_PATTERN.test(message) && freeBytesAt(resolveTranscodeRoot()) < KEPT_COPIES_MIN_FREE_BYTES) {
      return { ...kept, action: "free_space", reason: "disk_full", nextAction: next.action };
    }
    return { ...kept, ...next };
  };

  const availability: BadgerFailedJobs["availability"] = async (jobIds) => {
    const jobs: FailedJobAvailability[] = [];
    for (const jobId of jobIds) {
      const found = await engine.get(jobId);
      if (!found) continue;
      jobs.push(await decide(found.job));
    }
    const keptBytesTotal = jobs.reduce((sum, j) => sum + (j.keptBytes ?? 0), 0);
    console.info(
      JSON.stringify({
        event: "badger.failed_jobs.availability",
        asked: jobIds.length,
        answered: jobs.map((j) => ({ jobId: j.jobId, action: j.action, reason: j.reason, keptBytes: j.keptBytes })),
        keptBytesTotal,
      })
    );
    return { jobs, keptBytesTotal };
  };

  const removeKeptCopy = async (job: IngestJobRecord, why: "low_disk" | "expired") => {
    const userId = userIdOf(job);
    if (!userId) return;
    await getBadgerStepDeps().removeJobDir?.({ userId, jobId: job.jobId, reason: `failed-job-kept-copy-${why}` });
    await engine.updateJobPayload(job.jobId, { keptCopyRemoved: { why, at: new Date(now()).toISOString() } });
  };

  const retry: BadgerFailedJobs["retry"] = async ({ jobId, mode, path }) => {
    const found = await engine.get(jobId);
    if (!found) return { retried: false, reason: "not_retryable" };
    const job = found.job;
    const current = await decide(job);
    const userId = userIdOf(job);
    const wanted =
      mode ?? (current.action === "upload_again" ? "upload" : current.action === "process_again" ? "process" : null);
    const refuse = (decision: { action: FailedJobAction; reason: FailedJobReason }): RuntimeJobsRetryResult => {
      console.info(
        JSON.stringify({ event: "badger.failed_jobs.retry_refused", jobId, mode: wanted, action: decision.action, reason: decision.reason })
      );
      return { retried: false, action: decision.action, reason: decision.reason };
    };
    if (!userId || current.reason === "not_retryable" || current.reason === "parent_failed" || !wanted) return refuse(current);

    let steps: "unfinished" | "all";
    let payloadPatch: Record<string, unknown> = { keptCopyRemoved: null };
    if (wanted === "upload") {
      if (current.keptBytes === null) return refuse(await decideFromSource(job));
      steps = "unfinished";
    } else if (wanted === "process") {
      const fromSource = await decideFromSource(job);
      if (fromSource.action !== "process_again") return refuse(fromSource);
      steps = "all";
    } else {
      if (!path) return refuse({ action: "find_file", reason: "source_missing" });
      const picked = await fingerprintSourceFile(path);
      const { fingerprint } = await sourceOf(job);
      if (!picked || (fingerprint && (picked.size !== fingerprint.size || picked.sampleSha256 !== fingerprint.sampleSha256))) {
        return refuse({ action: "find_file", reason: "picked_mismatch" });
      }
      steps = "all";
      payloadPatch = { ...payloadPatch, filename: path, sourceFingerprint: fingerprint ?? picked };
      // The children re-queued with this job read the file from their own payload.
      for (const child of (await engine.list({ app: "badger", includeDismissed: true })).jobs) {
        if (child.parentJobIds.includes(jobId) && child.errorCode === "parent-cancelled") {
          await engine.updateJobPayload(child.jobId, { filename: path });
        }
      }
    }
    if (steps === "all") {
      // A stale or partial processed copy must not be mistaken for the new one.
      await getBadgerStepDeps().removeJobDir?.({ userId, jobId, reason: `failed-job-${wanted}-again` });
    }
    const result = await engine.retry(jobId, { steps, payloadPatch });
    console.info(
      JSON.stringify({
        event: "badger.failed_jobs.retry",
        jobId,
        kind: job.kind,
        mode: wanted,
        steps,
        retried: result.retried,
        refusal: result.reason ?? null,
        keptBytes: current.keptBytes,
      })
    );
    if (!result.retried) return { retried: false, action: "already_in_library", reason: "reimported" };
    return { retried: true, newJobId: jobId };
  };

  const sweepKeptCopies: BadgerFailedJobs["sweepKeptCopies"] = async (trigger) => {
    const { jobs } = await engine.list({ app: "badger", status: ["failed"], kind: ["source", "format"], includeDismissed: true });
    const kept: Array<{ job: IngestJobRecord; bytes: number }> = [];
    let removed = 0;
    let freedBytes = 0;
    for (const job of jobs) {
      const userId = userIdOf(job);
      if (!userId) continue;
      const bytes = await readKeptCopyBytes(userId, job.jobId);
      if (bytes === null) continue;
      if (job.dismissedAt || now() - failedAtMs(job) > KEPT_COPIES_MAX_AGE_MS) {
        await removeKeptCopy(job, "expired");
        removed += 1;
        freedBytes += bytes;
        continue;
      }
      kept.push({ job, bytes });
    }
    kept.sort((a, b) => failedAtMs(a.job) - failedAtMs(b.job));
    let free = freeBytesAt(resolveTranscodeRoot());
    while (free < KEPT_COPIES_MIN_FREE_BYTES && kept.length > 0) {
      const oldest = kept.shift()!;
      await removeKeptCopy(oldest.job, "low_disk");
      removed += 1;
      freedBytes += oldest.bytes;
      free = freeBytesAt(resolveTranscodeRoot());
    }
    console.info(
      JSON.stringify({
        event: "badger.failed_jobs.kept_copies_sweep",
        trigger,
        failedJobs: jobs.length,
        removed,
        freedBytes,
        stillKept: kept.length,
        stillKeptBytes: kept.reduce((sum, k) => sum + k.bytes, 0),
        freeBytes: free,
      })
    );
    return { removed, freedBytes };
  };

  const startSweeper: BadgerFailedJobs["startSweeper"] = () => {
    const run = (trigger: string) =>
      void sweepKeptCopies(trigger).catch((err: unknown) => {
        console.warn("[badger.failed_jobs] kept copies sweep failed", {
          trigger,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    run("boot");
    const timer = setInterval(() => run("hourly"), SWEEP_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return { availability, retry, sweepKeptCopies, startSweeper };
};

/**
 * Removing a failed import from the Jobs panel drops its kept copy, and the
 * pieces it had uploaded unless its commit ever started (UX-JOBS-03).
 */
export const registerFailedJobDismissCleanup = (engine: EngineV2): void => {
  engine.subscribe((event) => {
    if (event.event !== "runtime.jobs.dismissed") return;
    const jobId = event.jobId;
    void (async () => {
      const found = await engine.get(jobId);
      const job = found?.job;
      if (!job || job.app !== "badger" || job.status !== "failed") return;
      if (job.kind !== "source" && job.kind !== "format") return;
      const userId = userIdOf(job);
      if (!userId) return;
      const deps = getBadgerStepDeps();
      const commitStarted = Boolean(found.steps.find((s) => s.kind === "commit")?.startedAt);
      console.info("[badger.failed_jobs] removed failed job; dropping its kept copy", { jobId, kind: job.kind, commitStarted });
      if (deps.discardJobOutputs) {
        await deps.discardJobOutputs({ userId, jobId, reason: "failed-job-removed", mediaId: job.mediaId, commitStarted });
      } else {
        await deps.removeJobDir?.({ userId, jobId, reason: "failed-job-removed" });
      }
    })().catch((err: unknown) => {
      console.warn("[badger.failed_jobs] removed failed job cleanup failed", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
};
