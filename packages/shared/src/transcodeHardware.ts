/**
 * Whether a computer is strong enough to make extra copies automatically (INGS-FALLBK-01, PAR-FMT-02).
 *
 * One rule for every SpaceFleet desktop app: Badger decides from it whether a computer makes its video copies
 * ("This computer makes copies"), Parrot whether a computer makes the light copy of a song over 90 minutes
 * (Chris 2026-11-11: "on badger no video gets auto transcoding when the hardware is weak, on parrot all songs get
 * autotranscoding, but above 90min they only get it automatically if the hardware allows it").
 *
 * Pure and dependency-free: the hardware facts are measured by the app (`probeHostCapacity` in
 * `@space/desktop-platform` for cores and memory, Badger's ffmpeg probe for a hardware video encoder).
 */

export type TranscodeHardware = {
  /** `os.cpus()[0].model`, trimmed; null when the OS does not report one. */
  cpuModel?: string | null;
  /** Logical cores usable by this process (affinity-aware). */
  cores: number;
  /** Memory in GiB usable by this process (cgroup-aware). */
  ramGB: number;
  /** Hardware video encoder name as Badger's `detectEncoder` reports it, or "none" (Parrot has none to probe). */
  hwEncoder: string;
};

/** Without a hardware encoder, both floors must hold for the computer to count as strong. */
export const FALLBACK_COPY_MIN_CORES = 8;
export const FALLBACK_COPY_MIN_RAM_GB = 12;

export const hasHardwareEncoder = (hw: Pick<TranscodeHardware, "hwEncoder">): boolean =>
  hw.hwEncoder !== "none" && hw.hwEncoder !== "cpu" && hw.hwEncoder.trim() !== "";

/**
 * Why the rule decides what it does:
 *  - "hw-encoder": a working hardware H.264 encoder barely loads the CPU → on.
 *  - "strong-cpu": ≥ 8 logical cores AND ≥ 12 GB → the CPU encode fits beside playback → on.
 *  - "weak":       neither → the extra copy would slow this computer down → off.
 */
export type FallbackCopyReason = "hw-encoder" | "strong-cpu" | "weak";

export const fallbackCopyReason = (hw: TranscodeHardware): FallbackCopyReason => {
  if (hasHardwareEncoder(hw)) return "hw-encoder";
  if (hw.cores >= FALLBACK_COPY_MIN_CORES && hw.ramGB >= FALLBACK_COPY_MIN_RAM_GB) return "strong-cpu";
  return "weak";
};

export const decideFallbackCopy = (hw: TranscodeHardware): boolean => fallbackCopyReason(hw) !== "weak";

/**
 * Per-computer "uploads while a video (Badger) or a song (Parrot, PAR-UP-15) plays" (#25, Chris 2026-10-13): what
 * this computer's hardware recommends. Preparing an upload (cutting, encrypting, hashing) costs CPU next to playback.
 *  - full:     uploads keep their normal speed while playing.
 *  - throttle: uploads continue slowly (2 pieces at a time, with a rest between).
 *  - pause:    nothing new starts while playing; the pieces in flight finish.
 */
export type UploadsDuringPlayback = "full" | "throttle" | "pause";

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
