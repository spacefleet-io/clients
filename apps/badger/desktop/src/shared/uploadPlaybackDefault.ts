/**
 * Per-computer "uploads while a video plays" (#25, Chris 2026-10-13).
 *
 * Preparing an upload (cutting it into pieces, encrypting, hashing) costs CPU on
 * the computer doing the ingest. Measured on a 4-core i5 without a GPU, that work
 * is about a quarter of the runtime's CPU and uses up a 2-core budget, so the
 * video starts dropping frames while an upload starts. The choice belongs to the
 * MACHINE, like the 360p fallback copy (transcodeDefault.ts): on the first start the app
 * detects the hardware once, recommends a value and asks once
 * (the "First setup" flow, renderer/components/FirstSetup.tsx); Settings → Transcoding changes it later.
 *
 *  - full:     uploads keep their normal speed while a video plays.
 *  - throttle: uploads continue slowly (2 pieces at a time, with a rest between).
 *  - pause:    nothing new starts while a video plays; the pieces already in
 *              flight finish and uploads resume when the video stops.
 *
 * Pure, dependency-free helpers shared by main (decision, enforcement) and
 * renderer (dialog, Settings).
 */
import type { TranscodeHardware } from "@space/shared/transcodeHardware";

export type UploadsDuringPlayback = "full" | "throttle" | "pause";

export const UPLOADS_DURING_PLAYBACK_VALUES: readonly UploadsDuringPlayback[] = ["full", "throttle", "pause"];

export const isUploadsDuringPlayback = (value: unknown): value is UploadsDuringPlayback =>
  value === "full" || value === "throttle" || value === "pause";

/**
 * Thresholds, on LOGICAL cores (affinity-aware) and usable RAM (cgroup-aware) —
 * the same numbers the 480p rule uses. A hardware video encoder is deliberately
 * NOT considered: uploads hash and encrypt on the CPU whatever the GPU does.
 *
 *  - full: ≥ 8 cores AND ≥ 12 GB. Same floor as the 480p "strong CPU" case: the
 *    upload work fits next to playback.
 *  - pause: ≤ 2 cores OR < 6 GB. Nothing is left over for uploads (an "8 GB"
 *    computer reports ~7.7 GB usable, so 6 GB only catches 4 GB-class machines).
 *  - throttle: everything in between — includes the reference box of issue #25
 *    (4-core i5, 8-16 GB, no GPU), where playback was dropping frames.
 */
export const UPLOADS_FULL_MIN_CORES = 8;
export const UPLOADS_FULL_MIN_RAM_GB = 12;
export const UPLOADS_PAUSE_MAX_CORES = 2;
export const UPLOADS_PAUSE_BELOW_RAM_GB = 6;

/** Plain-language bucket for the dialog text: strong → full, modest → throttle, weak → pause. */
export type UploadsDuringPlaybackReason = "strong" | "modest" | "weak";

export const uploadsDuringPlaybackReason = (hw: Pick<TranscodeHardware, "cores" | "ramGB">): UploadsDuringPlaybackReason => {
  if (hw.cores <= UPLOADS_PAUSE_MAX_CORES || hw.ramGB < UPLOADS_PAUSE_BELOW_RAM_GB) return "weak";
  if (hw.cores >= UPLOADS_FULL_MIN_CORES && hw.ramGB >= UPLOADS_FULL_MIN_RAM_GB) return "strong";
  return "modest";
};

const MODE_FOR_REASON: Record<UploadsDuringPlaybackReason, UploadsDuringPlayback> = {
  strong: "full",
  modest: "throttle",
  weak: "pause",
};

export const decideUploadsDuringPlayback = (hw: Pick<TranscodeHardware, "cores" | "ramGB">): UploadsDuringPlayback =>
  MODE_FOR_REASON[uploadsDuringPlaybackReason(hw)];

export const formatUploadsDefaultLog = (hw: TranscodeHardware, mode: UploadsDuringPlayback, note: string): string =>
  `[uploads-playback-default] cores=${hw.cores} ramGB=${Math.round(hw.ramGB * 10) / 10} -> uploadsDuringPlayback=${mode} (${note})`;

/**
 * How the user (or a test harness) settled this computer's value. "dismissed" is
 * only read back from a file an older build wrote (closing its dialog); nothing
 * writes it any more.
 */
export type UploadsDuringPlaybackAnswer = "accepted" | "chosen" | "dismissed" | "settings" | "forced";

/** What the first-setup flow sends: agree with the recommendation, or pick another value. */
export type UploadsFirstRunAnswer = { kind: "accepted" } | { kind: "chosen"; mode: UploadsDuringPlayback };

/** Device-local record, as stored in `<userData>/device-settings.json` and sent over IPC. */
export type DeviceUploadsDuringPlaybackSettings = {
  /** Effective value on this computer. Until answered, the recommendation. */
  mode: UploadsDuringPlayback;
  /** True once the first-run question was answered (or settled in Settings) — never ask again. */
  answered: boolean;
  answer: UploadsDuringPlaybackAnswer | null;
  recommendation: {
    mode: UploadsDuringPlayback;
    /** null when the verdict was forced by SF_UPLOADS_DURING_PLAYBACK (no detection ran). */
    reason: UploadsDuringPlaybackReason | null;
    hardware: TranscodeHardware | null;
    detectedAt: string;
  };
  updatedAt: string;
};

/** Value a first-setup answer stores. */
export const uploadsDuringPlaybackForAnswer = (
  recommended: UploadsDuringPlayback,
  answer: UploadsFirstRunAnswer,
): UploadsDuringPlayback => (answer.kind === "chosen" ? answer.mode : recommended);
