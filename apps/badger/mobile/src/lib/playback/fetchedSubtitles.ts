import type { SubtitleTrack } from "@space/mobile-mpv-playback";
import type { FetchedSubtitleTrack } from "../subtitleFetchStore";
import { resolveSubtitleFormat } from "./ingestMetadata";

/**
 * A subtitle "Get more subtitles…" just stored, as a row of the playing session's subtitle menu (PLAY-SUBGET-02): the
 * same mapping the session applies to the library's tracks (`buildIngestMetadata`), so the pick loads it as a sidecar
 * through the playback proxy like any other subtitle of the title.
 */
export const fetchedSubtitleToPlayerTrack = (track: FetchedSubtitleTrack): SubtitleTrack => ({
  id: track.id,
  language: track.language,
  label: track.label,
  isDefault: false,
  format: resolveSubtitleFormat(track.format, track.objectKey),
  encrypted: false,
  url: track.objectKey,
  ...(track.source ? { source: track.source } : {}),
});

/**
 * Subtitles "Try another version" put in place of the session's own during this playback (PLAY-SUBGET-07): the
 * session's track id → the track now standing in its row.
 */
export type ReplacedSubtitles = Readonly<Record<string, SubtitleTrack>>;

/**
 * The menu's subtitles during one playback: the session's (each replaced one in its own row), then the ones fetched
 * since it started, in fetch order. A fetched track the session already lists (same id) is not listed twice.
 */
export const withFetchedSubtitles = (
  base: readonly SubtitleTrack[],
  fetched: readonly SubtitleTrack[],
  replaced: ReplacedSubtitles = {},
): SubtitleTrack[] => {
  const rows = Object.keys(replaced).length === 0 ? (base as SubtitleTrack[]) : base.map((track) => replaced[track.id] ?? track);
  if (fetched.length === 0) return rows;
  const ids = new Set(rows.map((track) => track.id));
  return [...rows, ...fetched.filter((track) => !ids.has(track.id))];
};

/**
 * "Try another version" replaced `oldId` with `next` (PLAY-SUBGET-07): the new track takes the old one's row, so the
 * menu keeps one track of that name and the subtitle on stays at the same index. The old track may be one fetched in
 * this playback, a session track, or one an earlier replacement already put in a session track's row.
 */
export const replacePlayerSubtitle = (
  state: { fetched: readonly SubtitleTrack[]; replaced: ReplacedSubtitles },
  oldId: string,
  next: SubtitleTrack,
): { fetched: SubtitleTrack[]; replaced: Record<string, SubtitleTrack> } => {
  if (state.fetched.some((track) => track.id === oldId)) {
    return { fetched: state.fetched.map((track) => (track.id === oldId ? next : track)), replaced: { ...state.replaced } };
  }
  const baseId = Object.keys(state.replaced).find((id) => state.replaced[id]?.id === oldId) ?? oldId;
  return { fetched: [...state.fetched], replaced: { ...state.replaced, [baseId]: next } };
};
