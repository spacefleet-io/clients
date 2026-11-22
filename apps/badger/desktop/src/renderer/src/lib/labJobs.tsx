/**
 * Lab jobs renderer entry point — V2 native.
 *
 * The renderer fully consumes runtime ingest jobs (V2). The legacy
 * `window.sf.labQueue.*` IPC path has been removed; this file now
 * exposes only the V2-driven view hooks plus a thin provider that
 * surfaces window-processing state and dependent shape (`activeJobs`,
 * `completedJobs`, `pendingFileIds`) on top of `useRuntimeIngestJobs()`.
 *
 * Plan reference: video-ingestion-is-buggy-effervescent-teapot.md Round 3.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useAppBusyMark } from "@space/ui/app-busy-mark";
import { useLibraryData } from "@/lib/libraryContext";
import {
  useRuntimeIngestActions,
  useRuntimeIngestJobs,
  ingestJobsToLabJobs,
  type RuntimeIngestError,
} from "@/lib/runtimeIngestJobs";
import type { LabJob } from "../../../shared/labQueueShared";
import type { LabJobGroup } from "@/components/labQueueGroups";
import { hasProcessingLabJobs, splitLabJobsByCompletion } from "@/lib/labJobsState";

// Re-exports preserved so existing consumers keep working.
export type { JobStatus, LabJob, LabQueueAction, QueuePreset } from "../../../shared/labQueueShared";
export {
  buildStorageOutputs,
  estimateBitrateKbps,
  estimateFromFile,
  estimateFromSourceFormat,
  estimateSizeMb,
  formatJobOutputLabel,
  getAvailableFormats,
  guessQualityLabel,
  qualityRank,
} from "../../../shared/labQueueShared";

export type LabJobsContextValue = {
  jobs: LabJob[];
  activeJobs: LabJob[];
  activeGroups: LabJobGroup[];
  completedJobs: LabJob[];
  pendingFileIds: Set<string>;
  runtimeError: RuntimeIngestError | null;
  /**
   * Per-media-id map of the most recent succeeded ingest job's
   * `libraryVersionAtDone` and the wall-clock time the succeeded event
   * landed. Consulted by the play-button gate to keep playback disabled
   * while the renderer's last-seen library snapshot version is strictly
   * behind the version stamped on the `runtime.jobs.succeeded` event AND
   * the stabilization timeout has not elapsed. Entries are absent when
   * no succeeded job for that media has carried the field (older
   * runtime, replayed event, or commit step that didn't write the
   * library DB).
   */
  libraryVersionAtDoneByMediaId: Map<
    string,
    { version: number; doneAt: number | undefined }
  >;
};

type LabJobsActionsValue = {
  cancelJob: (id: string) => void;
  dismissJob: (id: string) => void;
  retryJob: (id: string) => void;
  /**
   * Combined cancel-or-dismiss helper kept for parity with V1 callsites.
   * Active jobs are cancelled (the row remains as `cancelled`); terminal
   * jobs are dismissed (the row disappears).
   */
  cancelOrDismissJob: (id: string, isActive: boolean) => void;
  clearCompleted: () => void;
};

const LabJobsDataContext = createContext<LabJobsContextValue | null>(null);
const LabJobsActionsContext = createContext<LabJobsActionsValue | null>(null);

export const LabJobsProvider = ({ children }: { children: ReactNode; defer?: boolean }) => {
  // Mount the runtime ingest stream once at the provider level so every
  // consumer sees the same live job set without each mounting a separate
  // stream.
  const { media } = useLibraryData();
  const { jobs: rawRecords, groups, runtimeError } = useRuntimeIngestJobs({ media });
  const { cancelJob, dismissJob, retryJob } = useRuntimeIngestActions();
  const lastWindowProcessingStateRef = useRef<boolean | null>(null);

  // The renderer view shape (LabJob) is derived from V2 records joined
  // with media metadata. Re-derive whenever raw records OR media change
  // so jobs that arrived before media settled still pick up
  // matchedTo/posterPath/title once media loads.
  const jobs = useMemo(() => ingestJobsToLabJobs(rawRecords, media), [rawRecords, media]);
  const { activeJobs, completedJobs } = useMemo(() => splitLabJobsByCompletion(jobs), [jobs]);
  // UX-HOME-05 diagnostics: failed jobs are left out of `activeJobs` (no Home overlay). Log their ids and
  // media ids once per change so a stuck-looking title can be traced to its failed job. No titles or paths.
  const failedJobsKey = useMemo(
    () =>
      jobs
        .filter((job) => job.status === "failed")
        .map((job) => `${job.id}@${job.matchedMediaId ?? "unmatched"}`)
        .sort()
        .join(","),
    [jobs],
  );
  useEffect(() => {
    if (!failedJobsKey) return;
    const failed = failedJobsKey.split(",");
    console.info("[lab-jobs] failed jobs kept off the active set", { count: failed.length, jobs: failed });
  }, [failedJobsKey]);
  // A group is active iff one of its jobs can still make progress (queued,
  // running, interrupted awaiting requeue). The group's display status is a
  // label (failed wins over finished jobs, else the first job's status), so
  // filtering on it counted a failed-source group as active forever and hid a
  // group whose finished source is listed before its still-queued quality.
  const activeGroups = useMemo(() => groups.filter((g) => hasProcessingLabJobs(g.jobs)), [groups]);

  const pendingFileIds = useMemo(() => {
    const ids = new Set<string>();
    jobs.forEach((job) => {
      if (!job.fileId) return;
      if (job.status !== "done" && job.status !== "cancelled") ids.add(job.fileId);
    });
    return ids;
  }, [jobs]);

  // Reduce raw IngestJobRecords down to a per-media map of the highest
  // observed `libraryVersionAtDone` plus the wall-clock time the
  // succeeded event landed (`libraryVersionDoneAt`). The play-button
  // gate uses this to hold playback closed until the renderer's
  // library snapshot version catches up to the runtime's post-commit
  // version OR the stabilization window elapses (whichever comes
  // first). Closes the residual jobs-SSE / library-SSE race after
  // Phase 2's snapshot coalescing without locking users out
  // indefinitely on a stalled library SSE.
  const libraryVersionAtDoneByMediaId = useMemo(() => {
    const map = new Map<string, { version: number; doneAt: number | undefined }>();
    for (const rec of rawRecords) {
      const v = rec.libraryVersionAtDone;
      if (typeof v !== "number") continue;
      const mediaId = rec.mediaId;
      if (!mediaId) continue;
      const prev = map.get(mediaId);
      if (prev == null || v > prev.version) {
        map.set(mediaId, { version: v, doneAt: rec.libraryVersionDoneAt });
      }
    }
    return map;
  }, [rawRecords]);

  // While a job can still run, the star sky's shooting stars stop (UX-SKY-01):
  // every animated sky frame costs compositing, which on the low-end profile
  // costs the frames ingest progress needs (#2461).
  useAppBusyMark(hasProcessingLabJobs(jobs));

  useEffect(() => {
    const hasProcessing = hasProcessingLabJobs(jobs);
    if (lastWindowProcessingStateRef.current === hasProcessing) return;
    lastWindowProcessingStateRef.current = hasProcessing;
    window.sf?.setWindowProcessingState?.(hasProcessing);
  }, [jobs]);

  useEffect(() => {
    return () => {
      window.sf?.setWindowProcessingState?.(false);
      lastWindowProcessingStateRef.current = null;
    };
  }, []);

  const cancelJobAction = useCallback(
    (id: string) => {
      void cancelJob(id).catch(() => undefined);
    },
    [cancelJob],
  );
  const dismissJobAction = useCallback(
    (id: string) => {
      void dismissJob(id).catch(() => undefined);
    },
    [dismissJob],
  );
  const retryJobAction = useCallback(
    (id: string) => {
      void retryJob(id).catch(() => undefined);
    },
    [retryJob],
  );
  const cancelOrDismissJob = useCallback(
    (id: string, isActive: boolean) => {
      if (isActive) cancelJobAction(id);
      else dismissJobAction(id);
    },
    [cancelJobAction, dismissJobAction],
  );
  const clearCompleted = useCallback(() => {
    completedJobs.forEach((job) => {
      void dismissJob(job.id).catch(() => undefined);
    });
  }, [completedJobs, dismissJob]);

  const dataValue = useMemo<LabJobsContextValue>(
    () => ({
      jobs,
      activeJobs,
      activeGroups,
      completedJobs,
      pendingFileIds,
      runtimeError,
      libraryVersionAtDoneByMediaId,
    }),
    [
      jobs,
      activeJobs,
      activeGroups,
      completedJobs,
      pendingFileIds,
      runtimeError,
      libraryVersionAtDoneByMediaId,
    ],
  );

  const actionsValue = useMemo<LabJobsActionsValue>(
    () => ({
      cancelJob: cancelJobAction,
      dismissJob: dismissJobAction,
      retryJob: retryJobAction,
      cancelOrDismissJob,
      clearCompleted,
    }),
    [cancelJobAction, dismissJobAction, retryJobAction, cancelOrDismissJob, clearCompleted],
  );

  return (
    <LabJobsActionsContext.Provider value={actionsValue}>
      <LabJobsDataContext.Provider value={dataValue}>{children}</LabJobsDataContext.Provider>
    </LabJobsActionsContext.Provider>
  );
};

export const useLabJobsData = () => {
  const ctx = useContext(LabJobsDataContext);
  if (!ctx) {
    throw new Error("useLabJobsData must be used within LabJobsProvider");
  }
  return ctx;
};

export const useLabJobsActions = () => {
  const ctx = useContext(LabJobsActionsContext);
  if (!ctx) {
    throw new Error("useLabJobsActions must be used within LabJobsProvider");
  }
  return ctx;
};

export const shouldShowJobForMedia = (job: LabJob, mediaId?: string | null) => {
  if (!mediaId) return true;
  return job.matchedMediaId === mediaId || job.manualSelectedId === mediaId || job.pendingKey === mediaId;
};
