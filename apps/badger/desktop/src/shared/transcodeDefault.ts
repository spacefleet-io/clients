/**
 * Per-computer "fallback 360p copy" (#25, Chris 2026-10-09, reworked 2026-10-13).
 *
 * A fallback copy is ONE smaller 360p version of each video, used when the
 * connection or the computer cannot play the original. Making it costs CPU on
 * the computer doing the ingest, so the choice belongs to the MACHINE, not the
 * account: on the first start of a computer the app detects its hardware once,
 * recommends on/off, and asks the user once (the "First setup" flow,
 * renderer/components/FirstSetup.tsx). The answer
 * is stored device-locally (Electron userData, main/deviceSettings.ts); it is
 * the ONLY thing that decides whether the automatic ladder is [360p] or []; the
 * account-level ladder (`transcodeOutputs`) keeps every other quality.
 *
 * The hardware rule itself (strong or weak computer) is shared with Parrot: `@space/shared/transcodeHardware`.
 * Pure, dependency-free helpers shared by main (decision, ingest enforcement)
 * and renderer (dialog, Settings, ingest preview).
 */
import type { FallbackCopyReason, TranscodeHardware } from "@space/shared/transcodeHardware";
import { defaultCodecForQuality, type CodecPreset, type QualityPreset } from "./quality";

export const formatTranscodeDefaultLog = (hw: TranscodeHardware, fallbackCopy: boolean, note: string): string =>
  `[transcode-default] cores=${hw.cores} ramGB=${Math.round(hw.ramGB * 10) / 10} hwEncoder=${hw.hwEncoder} -> fallbackCopy=${
    fallbackCopy ? "on" : "off"
  } (${note})`;

/**
 * How the user (or a test harness) settled this computer's value. "dismissed" is
 * only read back from a file an older build wrote (closing its dialog); nothing
 * writes it any more.
 */
export type FallbackCopyAnswer = "accepted" | "overridden" | "dismissed" | "settings" | "forced";

/** Device-local record, as stored in `<userData>/device-settings.json` and sent over IPC. */
export type DeviceTranscodeSettings = {
  /** Effective value on this computer. Until answered, the recommendation. */
  fallbackCopy: boolean;
  /** True once the first-run question was answered (or settled in Settings) — never ask again. */
  answered: boolean;
  answer: FallbackCopyAnswer | null;
  recommendation: {
    fallbackCopy: boolean;
    /** null when the verdict was forced by SF_TRANSCODE_FALLBACK_COPY (no detection ran). */
    reason: FallbackCopyReason | null;
    hardware: TranscodeHardware | null;
    detectedAt: string;
  };
  updatedAt: string;
};

/** Value a first-setup answer stores: agree with the recommendation, or the opposite. */
export const fallbackCopyForAnswer = (recommended: boolean, answer: "accepted" | "overridden"): boolean =>
  answer === "overridden" ? !recommended : recommended;

/**
 * Shape the AUTOMATIC ingest ladder for this computer (INGS-FALLBK-01, ACCT-SQUAD-03): "This computer makes copies"
 * is a device setting that overrides the account's further qualities. On: the account's further qualities plus the
 * one small 360p copy (an account-level 360p entry is folded into it, and a stale 480p an older build listed is
 * ignored). Off: no automatic copy at all, so only the original is stored.
 */
export const applyFallbackCopyToFormats = <Q extends string>(formats: readonly Q[], fallbackCopy: boolean): Q[] => {
  if (!fallbackCopy) return [];
  return [...formats.filter((q) => q !== "360p" && q !== "480p"), "360p" as Q];
};

export const applyFallbackCopyToOutputs = <T extends { quality: QualityPreset; codec: CodecPreset }>(
  outputs: readonly T[],
  fallbackCopy: boolean,
): Array<T | { quality: QualityPreset; codec: CodecPreset }> => {
  if (!fallbackCopy) return [];
  const rest = outputs.filter((o) => o.quality !== "360p" && o.quality !== "480p");
  return [...rest, { quality: "360p", codec: defaultCodecForQuality("360p") }];
};
