import { useEffect, useRef, useState } from "react";
import type { MediaRow } from "@/lib/libraryDb";
import type { LabJob } from "@/lib/labJobs";
import { pickMostActiveJob } from "@/lib/runtimeIngestJobs";
import { formatUploadSpeedLabel } from "@/lib/uploadSpeed";

// ---------------------------------------------------------------------------
// useStableStageLabel — minimum-dwell stabilizer for status/stage labels
// ---------------------------------------------------------------------------
//
// Phase 4 (we-ve-done-quite-a-immutable-dahl.md): on fast uploads (small
// file, fast network), the runtime emits stageCode transitions
// `extracting → uploading → committing → done` in <100ms total. Without a
// minimum dwell, the user sees "Uploading" flash for a single frame before
// flipping to "Done" — perceived as the upload "skipped". This hook plays
// the full transition sequence at human-readable speed by FIFO-queuing
// every distinct intermediate state and dwelling each one for at least
// `minDwellMs` before showing the next.
//
// Behaviour:
//   - First emit: mirror the raw input immediately, record `lastEmitAt`.
//   - Terminal state arrives: clear the queue and emit immediately. The
//     outcome (`done`/`failed`/`cancelled`) must NEVER be held behind a
//     pending non-terminal display.
//   - Non-terminal change inside the dwell window: append to the FIFO
//     queue (coalescing with the queue tail so identical adjacent labels
//     are not re-shown). The pending drain timer flushes the head, then
//     schedules another timer if the queue is non-empty — playing every
//     distinct intermediate label in turn, each visible for at least
//     `minDwellMs`.
//   - Non-terminal change after the dwell elapsed and queue is empty:
//     emit immediately.
//   - `skipDwell` states (a job waiting in line, #2499) take no part in
//     the dwell: arriving at one clears the queue and emits at once, and
//     the change that leaves one emits at once too. Their text depends on
//     live props (the place in line), so a held copy would read stale.
//
// The hook owns its state per-instance, so two LabStatusBadge mounts on
// the same job (e.g. row + group header) each get an independent drain
// timeline. That's the correct semantics: each visible label has its own
// minimum lifetime.

export type UseStableStageLabelOptions<T> = {
  /** Minimum visible time for any non-terminal value, in ms. */
  minDwellMs: number;
  /** Predicate returning true for "must-emit-now" states (`done`, `failed`). */
  isTerminal?: (state: T) => boolean;
  /** Predicate for states shown immediately on entry AND exit, never held. */
  skipDwell?: (state: T) => boolean;
  /** Equality predicate for the stabilizer; defaults to `Object.is`. */
  equals?: (a: T, b: T) => boolean;
};

const nowMs = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export const useStableStageLabel = <T>(
  rawState: T,
  options: UseStableStageLabelOptions<T>,
): T => {
  const { minDwellMs, isTerminal, skipDwell, equals } = options;
  const eq = equals ?? ((a: T, b: T): boolean => Object.is(a, b));
  const [displayed, setDisplayed] = useState<T>(rawState);
  const lastEmitAtRef = useRef<number>(nowMs());
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // FIFO queue of pending non-terminal transitions waiting for the dwell
  // drain. We coalesce on push (drop if equal to the tail or to the
  // current displayed value) so identical adjacent labels never burn a
  // second dwell window.
  const queueRef = useRef<T[]>([]);
  // Latest displayed value so the drain callback can compare against it
  // without depending on a stale `displayed` closure.
  const displayedRef = useRef<T>(rawState);
  displayedRef.current = displayed;
  // Lock to the *current* predicate funcs so callbacks see the freshest
  // references (callers commonly pass arrow funcs that re-create each
  // render — we don't want stale closures).
  const isTerminalRef = useRef(isTerminal);
  isTerminalRef.current = isTerminal;
  const skipDwellRef = useRef(skipDwell);
  skipDwellRef.current = skipDwell;
  const eqRef = useRef(eq);
  eqRef.current = eq;
  const minDwellMsRef = useRef(minDwellMs);
  minDwellMsRef.current = minDwellMs;

  // Drain the head of the queue when the dwell window elapses, then
  // either schedule the next drain (queue non-empty) or settle.
  const scheduleNextDrain = (waitMs: number): void => {
    if (pendingTimerRef.current !== null) return;
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      const next = queueRef.current.shift();
      if (next === undefined) return;
      lastEmitAtRef.current = nowMs();
      setDisplayed(next);
      // displayedRef is updated synchronously below this commit, but
      // inside the setTimeout we need the next-loop's view; the queue
      // pop has already advanced. If more states are queued, schedule
      // another drain `minDwellMs` from now.
      if (queueRef.current.length > 0) {
        scheduleNextDrain(minDwellMsRef.current);
      }
    }, Math.max(0, waitMs));
  };

  useEffect(() => {
    // No change vs. what's already shown — nothing to do.
    if (eqRef.current(displayed, rawState)) return;

    // Terminal and skip-dwell states bypass the dwell window AND clear any
    // pending queue: the outcome supersedes intermediate animation, and a
    // place in line must show the moment the job joins the line. Leaving a
    // skip-dwell state is immediate too (entering it emptied the queue).
    const skipDwellNow =
      skipDwellRef.current?.(rawState) === true ||
      skipDwellRef.current?.(displayed) === true;
    if (isTerminalRef.current?.(rawState) || skipDwellNow) {
      queueRef.current = [];
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      lastEmitAtRef.current = nowMs();
      setDisplayed(rawState);
      return;
    }

    const queue = queueRef.current;
    const tail = queue.length > 0 ? queue[queue.length - 1] : undefined;
    // Coalesce against the tail of the queue (or current displayed when
    // queue is empty) so a redundant repeat of the same value doesn't
    // schedule another dwell window for itself.
    const referenceForCoalesce = tail !== undefined ? tail : displayed;
    if (eqRef.current(referenceForCoalesce, rawState)) return;

    // If a drain is already in flight, the new state joins the queue
    // and waits its turn — every distinct transition gets its own dwell.
    if (pendingTimerRef.current !== null) {
      queue.push(rawState);
      return;
    }

    // No drain in flight. Decide based on whether the dwell window for
    // the currently-displayed value has elapsed.
    const sinceLast = nowMs() - lastEmitAtRef.current;
    if (sinceLast >= minDwellMsRef.current) {
      // Window already elapsed — emit this transition immediately.
      lastEmitAtRef.current = nowMs();
      setDisplayed(rawState);
      return;
    }

    // Inside the window. Queue this transition and schedule a single
    // drain to flush it once the window expires.
    queue.push(rawState);
    scheduleNextDrain(minDwellMsRef.current - sinceLast);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: scheduleNextDrain is stable, predicates are ref-locked
  }, [rawState, displayed]);

  // Cleanup on unmount: drop any pending timer so it doesn't fire after
  // the consumer has gone away.
  useEffect(() => {
    return () => {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      queueRef.current = [];
    };
  }, []);

  return displayed;
};

const recentlyDeletedMediaIds = new Set<string>();

/** Mark a media ID as recently deleted so ghost items are suppressed until the runtime confirms removal. */
export const markMediaDeleted = (mediaId: string) => {
  recentlyDeletedMediaIds.add(mediaId);
};

/** Prune stale entries from the recently-deleted set once no jobs reference them. */
export const pruneDeletedMediaIds = (jobs: LabJob[]) => {
  if (!recentlyDeletedMediaIds.size) return;
  const referenced = new Set<string>();
  for (const job of jobs) {
    if (job.matchedMediaId) referenced.add(job.matchedMediaId);
    if (job.manualSelectedId) referenced.add(job.manualSelectedId);
    if (job.pendingKey) referenced.add(job.pendingKey);
  }
  for (const id of recentlyDeletedMediaIds) {
    if (!referenced.has(id)) recentlyDeletedMediaIds.delete(id);
  }
};

export type GhostLibraryItem = {
  id: string;
  title: string;
  year?: string | null;
  posterPath?: string | null;
  type?: "movie" | "tv";
  progress: number;
  statusLabel: string;
};

const normalizeIdentityPart = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

const getIdentityKey = (input: {
  title?: string | null;
  year?: string | null;
  type?: "movie" | "tv" | null;
}) => {
  const title = normalizeIdentityPart(input.title);
  const type = input.type ?? null;
  if (!title || !type) return null;
  return `${type}:${title}:${normalizeIdentityPart(input.year)}`;
};

export const buildGhostLibraryItems = (
  jobs: LabJob[],
  media: MediaRow[],
  t: (key: string, options?: Record<string, unknown>) => string,
  excludeMediaIds?: Set<string>
): GhostLibraryItem[] => {
  const mediaIds = new Set(media.map((item) => item.id));
  const existingIdentityKeys = new Set(
    media
      .map((item) =>
        getIdentityKey({
          title: item.title,
          year: item.year ?? null,
          type: item.type,
        })
      )
      .filter((value): value is string => Boolean(value))
  );
  const groups = new Map<string, LabJob[]>();
  const suppressed = recentlyDeletedMediaIds.size || excludeMediaIds?.size
    ? new Set([...recentlyDeletedMediaIds, ...(excludeMediaIds ?? [])])
    : null;

  jobs.forEach((job) => {
    if (job.status === "failed") return;
    if (job.matchedMediaId && mediaIds.has(job.matchedMediaId)) return;
    if (suppressed?.size) {
      if (job.matchedMediaId && suppressed.has(job.matchedMediaId)) return;
      if (job.manualSelectedId && suppressed.has(job.manualSelectedId)) return;
      if (job.pendingKey && suppressed.has(job.pendingKey)) return;
    }
    const inferredType =
      job.matchedTo?.type ??
      (job.detectedSeason || job.detectedEpisode || job.pendingDetails?.episodes?.length ? "tv" : "movie");
    const identityKey = getIdentityKey({
      title: job.matchedTo?.title ?? job.detectedTitle ?? null,
      year: job.matchedTo?.year ?? job.detectedYear ?? null,
      type: inferredType,
    });
    if (identityKey && existingIdentityKeys.has(identityKey)) return;
    const key = job.groupId ?? job.id;
    const list = groups.get(key) ?? [];
    list.push(job);
    groups.set(key, list);
  });

  const entries: GhostLibraryItem[] = [];
  groups.forEach((groupJobs, key) => {
    const display = groupJobs.find((job) => job.matchedTo) ?? groupJobs[0];
    const matched = display?.matchedTo;
    const fallbackTitle = display?.detectedTitle ?? display?.filename;
    if (!matched && !fallbackTitle) return;
    const hasUploading = groupJobs.some((job) => job.status === "uploading");
    const hasTranscoding = groupJobs.some((job) => job.status === "transcoding");
    const hasNeedsInput = groupJobs.some((job) => job.status === "needs_match");
    const progress = Math.round(
      groupJobs.reduce((sum, job) => sum + (Number.isFinite(job.progress) ? job.progress : 0), 0) / groupJobs.length
    );
    const uploadSpeedValues = groupJobs
      .map((job) => (Number.isFinite(job.uploadSpeedMbps) ? Number(job.uploadSpeedMbps) : null))
      .filter((value): value is number => value !== null && value > 0);
    const avgUploadSpeed =
      uploadSpeedValues.length > 0
        ? uploadSpeedValues.reduce((sum, value) => sum + value, 0) / uploadSpeedValues.length
        : undefined;
    const speedLabel = formatUploadSpeedLabel(t, avgUploadSpeed, "library.processing.uploadSpeed");
    const liveStageLabel = pickMostActiveJob(groupJobs)?.stageLabel;
    const fallbackStatusLabel = hasUploading
      ? t("library.processing.uploading")
      : hasTranscoding
        ? t("library.processing.preparing")
        : hasNeedsInput
          ? t("ingestion.ui.needsInput")
          : t("library.processing.queued");
    // hasNeedsInput is a pre-flight UI state, not a runtime stage — keep its
    // localized fallback even when a live stageLabel is present on a sibling
    // job, so the user sees "needs input" until they resolve the match.
    const statusLabel = hasNeedsInput
      ? fallbackStatusLabel
      : liveStageLabel ?? fallbackStatusLabel;
    entries.push({
      id: key,
      title: matched?.title ?? fallbackTitle ?? "Pending",
      year: matched?.year,
      posterPath: matched?.posterPath,
      type:
        matched?.type ??
        (display.detectedSeason || display.detectedEpisode || display.pendingDetails?.episodes?.length ? "tv" : "movie"),
      progress,
      statusLabel: speedLabel ? `${statusLabel} · ${speedLabel}` : statusLabel,
    });
  });

  return entries;
};
