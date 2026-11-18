import type { EncoderPolicy, HardwareEncoder } from "./types";

/**
 * Pick the hardware H.264 encoder a machine should try, from what ffmpeg
 * advertises and the GPU vendor. Advertised is not usable: the caller must
 * still probe the pick with a test encode.
 *
 * The algorithm is OS-independent; the OS decides only the DATA: which
 * encoders exist (`policy.order`, also the fallback order) and which GPU
 * vendor each belongs to (`policy.vendors`).
 *
 *  1. the first encoder (policy order) that is advertised AND whose vendor
 *     list matches `gpuVendor`;
 *  2. else the first advertised encoder of the OS (policy order);
 *  3. else null (software).
 */
export const pickHardwareEncoder = (
  policy: EncoderPolicy,
  advertised: readonly string[],
  gpuVendor: string
): HardwareEncoder | null => {
  const has = (encoder: HardwareEncoder) => advertised.includes(encoder);
  const vendor = gpuVendor.toLowerCase();
  if (vendor) {
    for (const encoder of policy.order) {
      if (!has(encoder)) continue;
      if ((policy.vendors[encoder] ?? []).some((needle) => vendor.includes(needle))) return encoder;
    }
  }
  return policy.order.find(has) ?? null;
};

/** `h264_vaapi` names in an ffmpeg `-encoders` listing -> hardware encoder ids (policy order). */
export const advertisedHardwareEncoders = (policy: EncoderPolicy, encoderNames: readonly string[]): HardwareEncoder[] =>
  policy.order.filter((encoder) => encoderNames.includes(`h264_${encoder}`));

/** Map a free-form adapter / vendor string (`NVIDIA GeForce`, `Advanced Micro Devices`) to `amd`|`intel`|`nvidia`|``. */
export const normalizeGpuVendor = (text: string): string => {
  const lower = text.toLowerCase();
  if (lower.includes("radeon") || lower.includes("amd") || lower.includes("advanced micro devices")) return "amd";
  if (lower.includes("nvidia") || lower.includes("geforce")) return "nvidia";
  if (lower.includes("intel")) return "intel";
  if (lower.includes("apple")) return "apple";
  return "";
};
