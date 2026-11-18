/**
 * Quality selection state: Auto vs pinned (Force / a manual pick), what the decoder proved undecodable, and the
 * decode-bound fallbacks (a non-H.264 original, HEVC / AV1 / VP9 ..., -> H.264 at the same resolution; H.264 one rung
 * down). All sticky for the file.
 */
import { needsH264Fallback, oneStepDown, qualityRank, sortVariantsBestToWorst, type Variant } from "./ladder";
import type { AbrDecision } from "./network";
import { decodableBy, planStart, type DecoderPolicy, type DecoderVerdicts, type QualitySetting } from "./start";

export type QualityMode = "auto" | "manual";

export type QualityState = {
  /** "manual" = pinned (Settings "Force this quality" or a rung picked in the player): no automatic switching at all. */
  mode: QualityMode;
  currentId: string | null;
  /** Variants proven undecodable here for this file (sticky for the session of the file). */
  bannedIds: string[];
  /** Decode-bound H.264: Auto may not climb above this rank again (null = no decode ceiling). */
  decodeCeilingRank?: number | null;
  lastSwitchAtMs: number | null;
  /** Why the last switch happened (diagnostics / UI toast). */
  lastReason: "start" | "manual" | "abr-downshift" | "abr-upshift" | "hevc-fallback" | "decode-fallback" | null;
};

export const createQualityState = (
  variants: Variant[],
  setting: QualitySetting,
  caps: DecoderVerdicts | null = null,
  policy: DecoderPolicy = "hardware-first",
): QualityState => {
  const start = planStart(variants, setting, caps, policy);
  const state: QualityState = {
    mode: setting.force ? "manual" : "auto",
    currentId: start.variant?.id ?? null,
    bannedIds: [],
    decodeCeilingRank: null,
    lastSwitchAtMs: null,
    lastReason: "start",
  };
  if (start.reason !== "decoder-limit" || !start.variant) return state;
  // The device said it cannot decode the Settings rung (by `policy`): Auto never climbs into what it reported undecodable.
  // (Only when something is decodable at all: banning every version would leave Auto nowhere to go.)
  const decodable = decodableBy(caps, policy);
  const undecodable = new Set(variants.filter((v) => !decodable(v.id)).map((v) => v.id));
  const anyDecodable = variants.some((v) => !undecodable.has(v.id));
  return {
    ...state,
    decodeCeilingRank: qualityRank(start.variant.quality),
    bannedIds: anyDecodable ? variants.filter((v) => undecodable.has(v.id)).map((v) => v.id) : [],
  };
};

/** User picked a rung (or "auto" = null): manual pins the rung, auto hands control back to ABR. */
export const selectQuality = (state: QualityState, pickedId: string | "auto", nowMs: number): QualityState =>
  pickedId === "auto"
    ? { ...state, mode: "auto", lastReason: "manual" }
    : { ...state, mode: "manual", currentId: pickedId, lastSwitchAtMs: nowMs, lastReason: "manual" };

/** Network moves only change the current rung: nothing is blacklisted, the link can recover. */
export const applyAbrDecision = (state: QualityState, decision: AbrDecision, nowMs: number): QualityState => {
  if (state.mode !== "auto" || decision.action === "hold") return state;
  return {
    ...state,
    currentId: decision.targetId,
    lastSwitchAtMs: nowMs,
    lastReason: decision.action === "downshift" ? "abr-downshift" : "abr-upshift",
  };
};

/**
 * A non-H.264 version (HEVC, or an AV1 / VP9 / MPEG-2 ... original) is decode-bound: pick the best H.264 variant not above
 * the current rung (the same resolution when it exists, else the best lower one) and ban every non-H.264 variant for the
 * rest of the file. (Named for HEVC, the common case; AV1 and VP9 originals take the same path, #303.)
 * With no H.264 copy at this resolution or below, the next lighter rung is the step (the codec is not banned then: the
 * device decodes it, just not that heavy) and Auto is capped at it. Null when nothing lighter exists either.
 */
export const planHevcFallback = (
  variants: Variant[],
  state: QualityState,
  nowMs: number,
): { state: QualityState; target: Variant } | null => {
  const current = variants.find((v) => v.id === state.currentId);
  const h264 = sortVariantsBestToWorst(variants.filter((v) => !needsH264Fallback(v.codec)));
  const currentRank = current ? qualityRank(current.quality) : 0;
  const target = h264.find((v) => qualityRank(v.quality) >= currentRank);
  // Never "fall back" to a heavier (higher resolution) rung: no H.264 at this resolution or below -> next lighter rung.
  if (!target) return planLighterRung(variants, state, nowMs);
  const bannedIds = Array.from(new Set([...state.bannedIds, ...variants.filter((v) => needsH264Fallback(v.codec)).map((v) => v.id)]));
  return {
    target,
    state: { ...state, currentId: target.id, bannedIds, lastSwitchAtMs: nowMs, lastReason: "hevc-fallback" },
  };
};

/**
 * H.264 is decode-bound (no non-H.264 version to ban): step to the best lower non-banned rung, and cap Auto at it for the
 * file so a recovered network cannot climb back into the rung the device cannot decode. Null when nothing lower exists.
 */
export const planH264DecodeFallback = (
  variants: Variant[],
  state: QualityState,
  nowMs: number,
): { state: QualityState; target: Variant } | null =>
  planLighterRung(variants.filter((v) => !needsH264Fallback(v.codec)), state, nowMs, variants);

/** One rung lighter among `candidates` (ids resolved against `all`), capped for the file. Null when nothing lighter exists. */
const planLighterRung = (
  candidates: Variant[],
  state: QualityState,
  nowMs: number,
  all: Variant[] = candidates,
): { state: QualityState; target: Variant } | null => {
  const current = all.find((v) => v.id === state.currentId);
  if (!current) return null;
  const banned = new Set(state.bannedIds);
  const target = oneStepDown(candidates, current, banned);
  if (!target) return null;
  return {
    target,
    state: {
      ...state,
      currentId: target.id,
      decodeCeilingRank: qualityRank(target.quality),
      lastSwitchAtMs: nowMs,
      lastReason: "decode-fallback",
    },
  };
};

/** Decode-bound fallback for whatever is playing: non-H.264 -> H.264 (same resolution first), H.264 -> next lower rung. */
export const planDecodeFallback = (
  variants: Variant[],
  state: QualityState,
  nowMs: number,
): { state: QualityState; target: Variant } | null => {
  const current = variants.find((v) => v.id === state.currentId);
  if (!current) return null;
  return needsH264Fallback(current.codec) ? planHevcFallback(variants, state, nowMs) : planH264DecodeFallback(variants, state, nowMs);
};
