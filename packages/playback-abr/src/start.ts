import { qualityRank, sortVariantsBestToWorst, type QualityPreset, type Variant } from "./ladder";

/**
 * The device's answer about which versions it can decode, per version id. Mobile's `DecoderCaps` satisfies this.
 * `software` absent = the device did not say: only the hardware answer counts for that version.
 */
export type DecoderVerdicts = { probes: ReadonlyArray<{ id: string; hardware: boolean; software?: boolean }> };

/**
 * Which decoders count when choosing the start version (PLAY-QUAL-06):
 *  - `hardware-first` (phone): only the hardware decoder counts; software decode only when no version is hardware-decodable;
 *  - `any` (computer, TV): hardware and software decoders both count.
 */
export type DecoderPolicy = "hardware-first" | "any";

/** Whether `policy` lets the device play a version from its verdicts. A version the device did not report on is unknown: eligible. */
export const decodableBy = (caps: DecoderVerdicts | null, policy: DecoderPolicy): ((id: string) => boolean) => {
  const answers = new Map((caps?.probes ?? []).map((probe) => [probe.id, probe]));
  return (id) => {
    const answer = answers.get(id);
    if (!answer) return true;
    return answer.hardware || (policy === "any" && answer.software === true);
  };
};

/** The two Settings: default quality (start rung + Auto ceiling) and "Force this quality". */
export type QualitySetting = { quality: QualityPreset; force: boolean };

export type StartReason =
  /** The Settings rung (or the best below it), no decoder information involved. */
  | "settings"
  /** The Settings rung is more than the hardware reports it can decode: started on the best version it can. */
  | "decoder-limit"
  /** Force this quality: the forced rung, whatever the decoder says. */
  | "forced";

export type StartPlan = {
  variant: Variant | null;
  /** What would start without decoder caps. */
  baseline: Variant | null;
  reason: StartReason;
  /** Force only: the device reported it cannot decode the forced version (by the decoder policy; played anyway, logged). */
  forcedUndecodable: boolean;
};

/**
 * Start decision. Candidates are the versions at or below the Settings quality (best first); when the Settings quality is
 * below every version, the lightest one above it. With caps the first candidate the device can decode starts (`policy`:
 * hardware only on a phone, hardware or software on a computer or TV; at one resolution a hardware-decodable copy wins);
 * when none can, the lightest. A version the device did not report on is unknown, so it stays eligible. Under Force the
 * rung is the Settings quality whatever the device says (only the codec at that resolution may follow the decoder).
 */
export const planStart = (
  variants: Variant[],
  setting: QualitySetting,
  caps: DecoderVerdicts | null = null,
  policy: DecoderPolicy = "hardware-first",
): StartPlan => {
  if (variants.length === 0) return { variant: null, baseline: null, reason: setting.force ? "forced" : "settings", forcedUndecodable: false };
  const sorted = sortVariantsBestToWorst(variants);
  const targetRank = qualityRank(setting.quality);
  const atOrBelow = sorted.filter((v) => qualityRank(v.quality) >= targetRank);
  const ordered = atOrBelow.length > 0 ? atOrBelow : [...sorted].reverse();
  // Same pick as always: the Settings rung exactly, else the best below it, else the lightest above it.
  const baseline = ordered[0]!;
  const answers = new Set((caps?.probes ?? []).map((probe) => probe.id));
  const decodable = decodableBy(caps, policy);
  const hardwareOk = decodableBy(caps, "hardware-first");
  // The best decodable version; at that resolution, a copy the hardware decodes beats one only software decodes.
  const pick = (list: Variant[]): Variant | undefined => {
    const first = list.find((v) => decodable(v.id));
    if (!first) return undefined;
    return list.find((v) => qualityRank(v.quality) === qualityRank(first.quality) && hardwareOk(v.id)) ?? first;
  };
  const known = answers.size > 0 && variants.some((v) => answers.has(v.id));
  if (setting.force) {
    const sameRung = ordered.filter((v) => qualityRank(v.quality) === qualityRank(baseline.quality));
    const variant = (known ? pick(sameRung) : undefined) ?? baseline;
    return { variant, baseline, reason: "forced", forcedUndecodable: known && !decodable(variant.id) };
  }
  if (!known) return { variant: baseline, baseline, reason: "settings", forcedUndecodable: false };
  const variant = pick(ordered) ?? (atOrBelow.length > 0 ? ordered[ordered.length - 1]! : ordered[0]!);
  return { variant, baseline, reason: variant.id === baseline.id ? "settings" : "decoder-limit", forcedUndecodable: false };
};

/** Variant to start playback with (Auto): see `planStart`. */
export const pickStartVariant = (variants: Variant[], preference: QualityPreset, caps: DecoderVerdicts | null = null): Variant | null =>
  planStart(variants, { quality: preference, force: false }, caps).variant;
