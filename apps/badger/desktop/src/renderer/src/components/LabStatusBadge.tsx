import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DesktopJobStatusPill, type DesktopJobTone } from "@space/desktop-shell/components";
import type { JobStatus } from "@/lib/labJobs";
import { useStableStageLabel } from "@/lib/libraryGhosts";

// Phase 4: minimum-dwell window for visible status transitions (ms). Below
// this floor, fast uploads flash "Uploading" too briefly for the eye to
// register. 600ms keeps the active label readable without delaying the
// terminal "Done" state — terminal transitions bypass the dwell.
const STAGE_LABEL_DWELL_MS = 600;

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "done",
  "failed",
  "cancelled",
]);

type BadgeState = { status: JobStatus; stageLabel: string | undefined };

const tupleEquals = (a: BadgeState, b: BadgeState): boolean =>
  a.status === b.status && a.stageLabel === b.stageLabel;

export const LabStatusBadge = memo(
  ({
    status,
    error,
    stageLabel,
    queuePosition,
  }: {
    status: JobStatus;
    error?: string;
    stageLabel?: string;
    /** Place in the runtime's queue while waiting (#2499): "Waiting · #3 in line". */
    queuePosition?: number;
  }) => {
    const { t } = useTranslation();
    // Stabilize the (status, stageLabel) tuple so a fast
    // queued→uploading→done burst visibly dwells on each non-terminal
    // phase before the renderer collapses to "Done". Terminal states
    // (done/failed/cancelled) bypass the dwell so the user sees the
    // outcome the moment it's known.
    const rawState = useMemo<BadgeState>(
      () => ({ status, stageLabel }),
      [status, stageLabel],
    );
    const stable = useStableStageLabel<BadgeState>(rawState, {
      minDwellMs: STAGE_LABEL_DWELL_MS,
      isTerminal: (s) => TERMINAL_STATUSES.has(s.status),
      // A waiting badge reads its live place in line ("#3 in line"); a
      // held copy of it beside a running row's % bar read as a bare
      // "Waiting" for 1–2 s at every hand-off (#2499 hand try).
      skipDwell: (s) => s.status === "waiting",
      equals: tupleEquals,
    });
    const displayStatus: JobStatus =
      stable.status === "done" && error ? "failed" : stable.status;
    const stageLabelStable = stable.stageLabel;
    const tones: Record<JobStatus, DesktopJobTone> = {
      waiting: "neutral",
      identifying: "blue",
      needs_match: "amber",
      ready: "emerald",
      transcoding: "purple",
      uploading: "cyan",
      done: "emerald",
      failed: "destructive",
      cancelled: "neutral",
    };
    const labels: Record<JobStatus, string> = {
      waiting: t("lab.status.waiting"),
      identifying: t("lab.status.identifying"),
      needs_match: t("lab.status.needsMatch"),
      ready: t("lab.status.ready"),
      transcoding: t("lab.status.transcoding"),
      uploading: t("lab.status.uploading"),
      done: t("lab.status.done"),
      failed: t("lab.status.failed"),
      cancelled: t("lab.status.cancelled", "Cancelled"),
    };
    // For active phases, prefer the runtime-emitted stageLabel ("Extracting",
    // "Uploading", "Transcoding 360p") over the coarse status word — it
    // matches the row-level text and reflects the actual phase. Fall back
    // when stageLabel is missing or just echoes the status name.
    const isLivePhase = displayStatus === "uploading" || displayStatus === "transcoding";
    const trimmedStage = stageLabelStable?.trim();
    const echoesStatus =
      !!trimmedStage && trimmedStage.toLowerCase() === displayStatus.toLowerCase();
    const text =
      isLivePhase && trimmedStage && !echoesStatus
        ? trimmedStage
        : displayStatus === "waiting" && queuePosition !== undefined
          ? t("lab.status.waitingInLine", { position: queuePosition })
          : labels[displayStatus];
    return <DesktopJobStatusPill tone={tones[displayStatus]}>{text}</DesktopJobStatusPill>;
  },
);
