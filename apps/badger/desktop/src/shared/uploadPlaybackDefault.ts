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
 * Pure, dependency-free helpers shared by main (enforcement) and renderer (dialog,
 * Settings). The hardware decision itself is `decideUploadsDuringPlayback` in
 * `@space/shared/transcodeHardware`, which Parrot applies to its imports too (PAR-UP-15).
 */
import type { TranscodeHardware, UploadsDuringPlaybackReason } from "@space/shared/transcodeHardware";

export type UploadsDuringPlayback = "full" | "throttle" | "pause";

export const UPLOADS_DURING_PLAYBACK_VALUES: readonly UploadsDuringPlayback[] = ["full", "throttle", "pause"];

export const isUploadsDuringPlayback = (value: unknown): value is UploadsDuringPlayback =>
  value === "full" || value === "throttle" || value === "pause";

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
