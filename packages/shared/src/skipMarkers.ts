/**
 * Skip times shared by every client that writes or plays them (META-SKIP-04, PLAY-SKIP-*): where a marker came from,
 * which one wins when several exist for one episode, and how a user's change of the times carries to the other
 * episodes of the season.
 *
 * A detected intro is the shared audio two episodes have in common (`rawStart`..`rawEnd`), padded. A user's change is
 * kept as offsets from that shared audio, so "This season" moves every episode where the same audio was found by the
 * same amount, wherever the intro sits in each one (Chris 2026-11-23/24, chat, skip UX, via Main).
 */

import { z } from "zod";

export type SkipKind = "intro" | "credits";

/** The user set the times (player "Change … times", "Intro ends here", "Credits start here"). */
export const SKIP_SOURCE_USER = "user";
/** Found by shared-audio detection on the desktop (META-SKIP-04). */
export const SKIP_SOURCE_DETECTED = "detected";
/** Read from the file's chapters ("Credits", "Opening", …). */
export const SKIP_SOURCE_CHAPTERS = "chapters";

/** `media_skip_analysis.kind` of an episode's detection result (the matched shared audio, per kind). */
export const SKIP_MATCH_ANALYSIS_KIND = "skip-match-v1";
/** `media_skip_analysis.kind` of a show's season-wide fixes (one row per show, episodeId null). */
export const SKIP_FIX_ANALYSIS_KIND = "skip-fix-v1";

/** A fix more than this many seconds away from the other matched episodes preselects "Only this episode". */
export const SKIP_FIX_EPISODE_ONLY_SECONDS = 10;

export type SkipSpan = { startSeconds: number; endSeconds: number };
export type SkipMatchSpan = { rawStart: number; rawEnd: number };

export type SkipMatchPayload = {
  version: 1;
  intro: SkipMatchSpan | null;
  credits: SkipMatchSpan | null;
};

export type SkipFixOffsets = { startOffset: number; endOffset: number };

export type SkipFixPayload = {
  version: 1;
  /** Season number → kind → offsets from the matched shared audio. */
  seasons: Record<string, Partial<Record<SkipKind, SkipFixOffsets>>>;
  /** Episodes whose times were set for that episode only; a season fix leaves them alone. */
  episodeOnly: Record<string, Partial<Record<SkipKind, true>>>;
};

export const emptySkipFixPayload = (): SkipFixPayload => ({ version: 1, seasons: {}, episodeOnly: {} });

const SpanSchema = z.object({ rawStart: z.number().finite(), rawEnd: z.number().finite() });
const OffsetsSchema = z.object({ startOffset: z.number().finite(), endOffset: z.number().finite() });
const SkipMatchPayloadSchema = z.object({
  version: z.literal(1),
  intro: SpanSchema.nullable().catch(null),
  credits: SpanSchema.nullable().catch(null),
});
const SkipFixPayloadSchema = z.object({
  version: z.literal(1),
  seasons: z.record(z.string(), z.object({ intro: OffsetsSchema.optional(), credits: OffsetsSchema.optional() })),
  episodeOnly: z.record(z.string(), z.object({ intro: z.literal(true).optional(), credits: z.literal(true).optional() })),
});

/** An episode's stored detection result; null when it is not a version-1 payload. */
export const readSkipMatchPayload = (value: unknown): SkipMatchPayload | null => {
  const parsed = SkipMatchPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The stored season fixes; an empty set for anything that is not a version-1 payload (the row is local to the desktop). */
export const readSkipFixPayload = (value: unknown): SkipFixPayload => {
  const parsed = SkipFixPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : emptySkipFixPayload();
};

/**
 * Higher wins (Chris 2026-11-24): the user's own times, then the metadata service's (its shared times, else users'
 * agreed times, META-SKIP-07), then this device's detection or the file's chapters.
 */
export const skipSourceRank = (source: string): number => {
  if (source === SKIP_SOURCE_USER) return 3;
  if (source === SKIP_SOURCE_DETECTED || source === SKIP_SOURCE_CHAPTERS) return 1;
  return 2;
};

export type SkipMarkerWrite = SkipSpan & { type: SkipKind; source: string; confidence?: number | null };

/**
 * One marker per kind for an episode: `incoming` replaces an existing marker of its kind unless the existing one
 * ranks higher (`skipSourceRank`). A user's times are never replaced by detection or by the metadata service.
 */
export const mergeSkipMarkersByPriority = <T extends SkipMarkerWrite>(existing: T[], incoming: T[]): T[] => {
  const byType = new Map<SkipKind, T>();
  for (const marker of existing) {
    const held = byType.get(marker.type);
    if (!held || skipSourceRank(marker.source) > skipSourceRank(held.source)) byType.set(marker.type, marker);
  }
  for (const marker of incoming) {
    const held = byType.get(marker.type);
    if (!held || skipSourceRank(marker.source) >= skipSourceRank(held.source)) byType.set(marker.type, marker);
  }
  return [...byType.values()].sort((a, b) => a.startSeconds - b.startSeconds);
};

export type SkipFixEpisode = {
  episodeId: string;
  season: number;
  /** The matched shared audio of this kind; null when detection found none for this episode. */
  match: SkipMatchSpan | null;
  /** The times in use now for this kind (any source); null when there are none. */
  current: SkipSpan | null;
  durationSeconds?: number | null;
};

type Anchor = { start: number; end: number };

/**
 * What a fix is measured from. With a match on the fixed episode, the shared audio (so the fix follows the intro to
 * wherever it sits in each other episode); without one, the times the other episodes use now.
 */
const anchorOf = (episode: SkipFixEpisode, byMatch: boolean): Anchor | null => {
  if (byMatch) return episode.match ? { start: episode.match.rawStart, end: episode.match.rawEnd } : null;
  return episode.current ? { start: episode.current.startSeconds, end: episode.current.endSeconds } : null;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The fix as offsets from the fixed episode's anchor; null when the episode has none (it applies to itself only). */
export const skipFixOffsets = (target: SkipFixEpisode, fix: SkipSpan): SkipFixOffsets | null => {
  const anchor = anchorOf(target, target.match !== null);
  if (!anchor) return null;
  return { startOffset: fix.startSeconds - anchor.start, endOffset: fix.endSeconds - anchor.end };
};

/**
 * The scope the save step preselects: "This season", unless the fix lands more than
 * {@link SKIP_FIX_EPISODE_ONLY_SECONDS} away from where the other matched episodes of the season have it (then the
 * fix is probably about this episode alone), or nothing else in the season can follow it.
 */
export const preselectSkipFixScope = (
  target: SkipFixEpisode,
  fix: SkipSpan,
  episodes: SkipFixEpisode[]
): "season" | "episode" => {
  const offsets = skipFixOffsets(target, fix);
  if (!offsets) return "episode";
  const byMatch = target.match !== null;
  const others = episodes.filter(
    (episode) => episode.episodeId !== target.episodeId && episode.season === target.season && anchorOf(episode, byMatch)
  );
  const placed = others.filter((episode) => episode.current);
  if (placed.length === 0) return others.length > 0 ? "season" : "episode";
  const startOffsets = placed.map((episode) => episode.current!.startSeconds - anchorOf(episode, byMatch)!.start);
  const endOffsets = placed.map((episode) => episode.current!.endSeconds - anchorOf(episode, byMatch)!.end);
  const far =
    Math.abs(offsets.startOffset - median(startOffsets)) > SKIP_FIX_EPISODE_ONLY_SECONDS ||
    Math.abs(offsets.endOffset - median(endOffsets)) > SKIP_FIX_EPISODE_ONLY_SECONDS;
  return far ? "episode" : "season";
};

/** Times placed at `anchor` + `offsets`, kept inside the episode; null when nothing of at least 1 s is left. */
export const placeSkipFix = (
  anchor: SkipMatchSpan,
  offsets: SkipFixOffsets,
  durationSeconds?: number | null
): SkipSpan | null => {
  const limit = durationSeconds && durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY;
  const startSeconds = Math.max(0, anchor.rawStart + offsets.startOffset);
  const endSeconds = Math.min(limit, anchor.rawEnd + offsets.endOffset);
  if (endSeconds - startSeconds < 1) return null;
  return { startSeconds: round3(startSeconds), endSeconds: round3(endSeconds) };
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export type SkipFixPlan = {
  /** New user times per episode (always includes the fixed episode). */
  writes: Array<{ episodeId: string } & SkipSpan>;
  /** The season-wide offsets to keep for episodes added later; null for "Only this episode" or without an anchor. */
  seasonOffsets: SkipFixOffsets | null;
};

/**
 * Where a saved fix goes. "Only this episode" writes that episode. "This season" also moves every other episode of
 * the season that has the same anchor (the matched shared audio, or current times when the fixed episode has no
 * match), except episodes whose times were set for that episode only.
 */
export const planSkipFix = (args: {
  target: SkipFixEpisode;
  fix: SkipSpan;
  scope: "season" | "episode";
  episodes: SkipFixEpisode[];
  episodeOnly?: ReadonlySet<string>;
}): SkipFixPlan => {
  const { target, fix, scope, episodes } = args;
  const writes: SkipFixPlan["writes"] = [
    { episodeId: target.episodeId, startSeconds: round3(fix.startSeconds), endSeconds: round3(fix.endSeconds) },
  ];
  const offsets = scope === "season" ? skipFixOffsets(target, fix) : null;
  if (!offsets) return { writes, seasonOffsets: null };
  const byMatch = target.match !== null;
  for (const episode of episodes) {
    if (episode.episodeId === target.episodeId || episode.season !== target.season) continue;
    if (args.episodeOnly?.has(episode.episodeId)) continue;
    const anchor = anchorOf(episode, byMatch);
    if (!anchor) continue;
    const placed = placeSkipFix({ rawStart: anchor.start, rawEnd: anchor.end }, offsets, episode.durationSeconds);
    if (placed) writes.push({ episodeId: episode.episodeId, ...placed });
  }
  return { writes, seasonOffsets: byMatch ? offsets : null };
};
