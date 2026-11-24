// PLAY-SKIP-03/05 (Chris 2026-11-23/24): what the player does with sf.lua's "Was it right?" line and Change times
// panel. "Yes" reports the skipped times as right; Save stores the user's times on this episode or, for "This season",
// on every episode of the season where the same intro (or credits) was found, keeps the season's fix for episodes
// imported later, and reports the change. Reports go through `queueSkipContribution` (@space/metadata-client), which
// sends them later and anonymously (META-SKIP-05/06); nothing here talks to the network.
import type { MediaDetails, MediaSkipMarkerType } from "@space/shared/libraryTypes";
import {
  planSkipFix,
  preselectSkipFixScope,
  readSkipFixPayload,
  readSkipMatchPayload,
  SKIP_FIX_ANALYSIS_KIND,
  SKIP_MATCH_ANALYSIS_KIND,
  SKIP_SOURCE_CHAPTERS,
  SKIP_SOURCE_DETECTED,
  SKIP_SOURCE_USER,
  type SkipFixEpisode,
  type SkipKind,
  type SkipMatchPayload,
} from "@space/shared/skipMarkers";
import {
  LUA_OUTBOUND_CHANNELS,
  skipEditArgsSchema,
  type MpvExternalMessage,
  type SkipEditAnswer,
} from "@space/mpv-protocol";
import type { SkipContribution } from "@space/metadata-client";

export type SkipEditMessage =
  | { action: "verdict"; kind: SkipKind; startSeconds: number; endSeconds: number; durationSeconds: number }
  | { action: "preselect"; kind: SkipKind; startSeconds: number; endSeconds: number }
  | {
      action: "save";
      kind: SkipKind;
      startSeconds: number;
      endSeconds: number;
      scope: "season" | "episode";
      durationSeconds: number;
    };

/** sf.lua's `sf-skip-edit` message, or null for any other message (or a malformed one). */
export const parseSkipEditMessage = (message: MpvExternalMessage): SkipEditMessage | null => {
  if (message.type !== "script_message" || message.name !== LUA_OUTBOUND_CHANNELS.SKIP_EDIT) return null;
  const args = skipEditArgsSchema.safeParse(message.args);
  if (!args.success) return null;
  const [, k, startSeconds, endSeconds] = args.data;
  if (endSeconds <= startSeconds) return null;
  if (args.data[0] === "verdict") return { action: "verdict", kind: k, startSeconds, endSeconds, durationSeconds: args.data[4] };
  if (args.data[0] === "save") {
    return { action: "save", kind: k, startSeconds, endSeconds, scope: args.data[4], durationSeconds: args.data[5] };
  }
  return { action: "preselect", kind: k, startSeconds, endSeconds };
};

type SkipAnalysisRow = { episodeId: string | null; payload: unknown };

export type SkipEditDeps = {
  media: MediaDetails;
  episodeId: string;
  listSkipAnalysis: (mediaId: string, kind?: string) => Promise<SkipAnalysisRow[]>;
  upsertSkipAnalysis: (mediaId: string, episodeId: string | null, kind: string, payload: Record<string, unknown>) => Promise<void>;
  replaceSkipMarkers: (
    mediaId: string,
    episodeId: string | null,
    markers: Array<{ type: MediaSkipMarkerType; startSeconds: number; endSeconds: number; source: string; confidence?: number | null }>
  ) => Promise<void>;
  queueSkipContribution: (contribution: SkipContribution) => void;
  log: (message: string, data?: Record<string, unknown>) => void;
};

/** Each episode's file length: the longest format of the file holding that season and episode. */
const episodeDurations = (media: MediaDetails): Map<string, number> => {
  const byFile = new Map<string, number>();
  for (const format of media.formats) {
    if (typeof format.durationSeconds !== "number" || !(format.durationSeconds > 0)) continue;
    byFile.set(format.fileId, Math.max(byFile.get(format.fileId) ?? 0, format.durationSeconds));
  }
  const out = new Map<string, number>();
  for (const episode of media.episodes) {
    for (const file of media.files) {
      if (file.season !== episode.seasonNumber || file.episode !== episode.episodeNumber) continue;
      const duration = byFile.get(file.id);
      if (duration) out.set(episode.id, Math.max(out.get(episode.id) ?? 0, duration));
    }
  }
  return out;
};

/** Every episode of the show with the matched shared audio of `kind` and the times it uses now. */
export const skipFixEpisodes = (media: MediaDetails, kindOf: SkipKind, matchRows: SkipAnalysisRow[]): SkipFixEpisode[] => {
  const matches = new Map<string, SkipMatchPayload | null>();
  for (const row of matchRows) if (row.episodeId) matches.set(row.episodeId, readSkipMatchPayload(row.payload));
  const durations = episodeDurations(media);
  return media.episodes.map((episode) => {
    const marker = media.skipMarkers.find((entry) => entry.episodeId === episode.id && entry.type === kindOf);
    return {
      episodeId: episode.id,
      season: episode.seasonNumber,
      match: matches.get(episode.id)?.[kindOf] ?? null,
      current: marker ? { startSeconds: marker.startSeconds, endSeconds: marker.endSeconds } : null,
      durationSeconds: durations.get(episode.id) ?? null,
    };
  });
};

/** The report for the metadata service, or null when the media has no catalog id or the times are outside its bounds. */
export const skipContributionFor = (
  media: MediaDetails,
  episodeId: string,
  edit: { kind: SkipKind; startSeconds: number; endSeconds: number; durationSeconds: number },
  verdict: SkipContribution["verdict"]
): SkipContribution | null => {
  const episode = media.episodes.find((entry) => entry.id === episodeId);
  if (media.catalogId == null || !episode) return null;
  const durationMs = Math.round(edit.durationSeconds * 1000);
  const startMs = Math.round(edit.startSeconds * 1000);
  const endMs = Math.min(durationMs, Math.round(edit.endSeconds * 1000));
  return {
    id: media.catalogId,
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
    durationMs,
    kind: edit.kind,
    startMs,
    endMs,
    verdict,
  };
};

/**
 * Whether the episode's times of `kind` were found on this device (detection or the file's chapters): only those are
 * reported (META-SKIP-05). A change to the metadata service's times (shared or users' agreed) stays in each user's vault (Chris 2026-11-24).
 */
export const skipTimesReportable = (media: MediaDetails, episodeId: string, kind: SkipKind): boolean => {
  const marker = media.skipMarkers.find((entry) => entry.episodeId === episodeId && entry.type === kind);
  return marker?.source === SKIP_SOURCE_DETECTED || marker?.source === SKIP_SOURCE_CHAPTERS;
};

/** The scope "Use these times for" starts on (PLAY-SKIP-05). */
export const preselectSkipEdit = async (
  message: Extract<SkipEditMessage, { action: "preselect" }>,
  deps: SkipEditDeps
): Promise<SkipEditAnswer> => {
  const rows = await deps.listSkipAnalysis(deps.media.id, SKIP_MATCH_ANALYSIS_KIND);
  const episodes = skipFixEpisodes(deps.media, message.kind, rows);
  const target = episodes.find((episode) => episode.episodeId === deps.episodeId);
  const result = target
    ? preselectSkipFixScope(target, { startSeconds: message.startSeconds, endSeconds: message.endSeconds }, episodes)
    : "episode";
  deps.log("preselect", { kind: message.kind, start: message.startSeconds, end: message.endSeconds, scope: result, matched: target?.match != null });
  return { kind: "preselect", scope: result };
};

/** Stores a save (PLAY-SKIP-05) or reports a "Yes" (PLAY-SKIP-03). */
export const applySkipEdit = async (
  message: Exclude<SkipEditMessage, { action: "preselect" }>,
  deps: SkipEditDeps
): Promise<SkipEditAnswer> => {
  const { media, episodeId } = deps;
  if (message.action === "verdict") {
    const contribution = skipTimesReportable(media, episodeId, message.kind) ? skipContributionFor(media, episodeId, message, "confirmed") : null;
    deps.log("verdict: confirmed", { kind: message.kind, start: message.startSeconds, end: message.endSeconds, queued: contribution !== null });
    if (contribution) deps.queueSkipContribution(contribution);
    return { kind: "saved", scope: "episode" };
  }
  // Read before the writes below turn these times into the user's own.
  const reportable = skipTimesReportable(media, episodeId, message.kind);
  const fix = { startSeconds: message.startSeconds, endSeconds: Math.min(message.endSeconds, message.durationSeconds || message.endSeconds) };
  const matchRows = await deps.listSkipAnalysis(media.id, SKIP_MATCH_ANALYSIS_KIND);
  const episodes = skipFixEpisodes(media, message.kind, matchRows);
  const target = episodes.find((episode) => episode.episodeId === episodeId) ?? {
    episodeId,
    season: media.episodes.find((entry) => entry.id === episodeId)?.seasonNumber ?? 0,
    match: null,
    current: null,
  };
  const fixRows = await deps.listSkipAnalysis(media.id, SKIP_FIX_ANALYSIS_KIND);
  const fixes = readSkipFixPayload(fixRows.find((row) => row.episodeId === null)?.payload);
  const episodeOnly = new Set(
    Object.entries(fixes.episodeOnly)
      .filter(([, kinds]) => kinds[message.kind] === true)
      .map(([id]) => id)
  );
  const plan = planSkipFix({ target, fix, scope: message.scope, episodes, episodeOnly });
  deps.log("save: plan", {
    kind: message.kind,
    scope: message.scope,
    start: fix.startSeconds,
    end: fix.endSeconds,
    matched: target.match !== null,
    writes: plan.writes.length,
    seasonOffsets: plan.seasonOffsets,
  });
  for (const write of plan.writes) {
    // The other kind keeps its times; the edited kind becomes the user's, which nothing else replaces (PLAY-SKIP-08).
    const kept = media.skipMarkers
      .filter((marker) => marker.episodeId === write.episodeId && marker.type !== message.kind)
      .map((marker) => ({
        type: marker.type,
        startSeconds: marker.startSeconds,
        endSeconds: marker.endSeconds,
        source: marker.source,
        confidence: marker.confidence,
      }));
    await deps.replaceSkipMarkers(media.id, write.episodeId, [
      ...kept,
      { type: message.kind, startSeconds: write.startSeconds, endSeconds: write.endSeconds, source: SKIP_SOURCE_USER, confidence: null },
    ]);
  }
  const seasonKey = String(target.season);
  if (message.scope === "season" && plan.seasonOffsets) {
    fixes.seasons[seasonKey] = { ...fixes.seasons[seasonKey], [message.kind]: plan.seasonOffsets };
    const only = fixes.episodeOnly[episodeId];
    if (only?.[message.kind]) {
      const { [message.kind]: _dropped, ...rest } = only;
      fixes.episodeOnly[episodeId] = rest;
    }
  } else if (message.scope === "episode") {
    fixes.episodeOnly[episodeId] = { ...fixes.episodeOnly[episodeId], [message.kind]: true };
  }
  await deps.upsertSkipAnalysis(media.id, null, SKIP_FIX_ANALYSIS_KIND, fixes);
  const contribution = reportable
    ? skipContributionFor(media, episodeId, { ...fix, kind: message.kind, durationSeconds: message.durationSeconds }, "changed")
    : null;
  if (contribution) deps.queueSkipContribution(contribution);
  deps.log("save: stored", { kind: message.kind, scope: message.scope, episodes: plan.writes.map((write) => write.episodeId), queued: contribution !== null });
  return { kind: "saved", scope: message.scope };
};
