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
