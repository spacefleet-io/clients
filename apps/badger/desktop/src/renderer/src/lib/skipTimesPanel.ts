// PLAY-SKIP-09 (Chris 2026-11-23/24, chat, skip UX, via Main): changing an episode's intro or credits times from the
// show page, without playing it. The panel works like the player's (two handles for the intro, one for the credits,
// −1 s / +1 s, arrow keys, Esc / Enter, then "This season" / "Only this episode"); the handle pictures are the
// episode's stored seek-bar preview pictures (one every 5 s), so nothing is downloaded and the video is not opened.
import type { MediaDetails, MediaSkipMarker } from "@space/shared/libraryTypes";
import { locatePreviewPicture, type MediaPreviewSheets } from "@space/shared/previewSheets";
import type { SkipKind } from "@space/shared/skipMarkers";

/** The longest the bar shows: the intro sits in the first quarter (at most 10 min), the credits in the last 10 min. */
export const SKIP_PANEL_SPAN_SECONDS = 600;
/** Where a new credits start goes: 5 min before the end. */
export const SKIP_PANEL_NEW_CREDITS_BEFORE_END_SECONDS = 300;

export type SkipPanelHandles = { startSeconds: number; endSeconds: number };
export type SkipPanelHandle = "start" | "end";

/** The part of the episode the bar shows. */
export const skipPanelRange = (kind: SkipKind, durationSeconds: number): { from: number; to: number } =>
  kind === "intro"
    ? { from: 0, to: Math.min(durationSeconds / 4, SKIP_PANEL_SPAN_SECONDS) }
    : { from: Math.max(0, durationSeconds - SKIP_PANEL_SPAN_SECONDS), to: durationSeconds };

/**
 * Where the handles start: the episode's times, else both at the start of the episode (intro) or the credits 5 min
 * before the end. Credits have one time; they run to the end.
 */
export const initialSkipHandles = (kind: SkipKind, marker: MediaSkipMarker | null, durationSeconds: number): SkipPanelHandles => {
  const range = skipPanelRange(kind, durationSeconds);
  if (kind === "credits") {
    const start = marker ? marker.startSeconds : durationSeconds - SKIP_PANEL_NEW_CREDITS_BEFORE_END_SECONDS;
    return { startSeconds: clamp(start, range.from, range.to), endSeconds: durationSeconds };
  }
  if (!marker) return { startSeconds: 0, endSeconds: 0 };
  return { startSeconds: clamp(marker.startSeconds, range.from, range.to), endSeconds: clamp(marker.endSeconds, range.from, range.to) };
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Moves one handle to `seconds`, kept on the bar; the intro's start never passes its end, nor the end its start. */
export const moveSkipHandle = (
  kind: SkipKind,
  handles: SkipPanelHandles,
  handle: SkipPanelHandle,
  seconds: number,
  durationSeconds: number
): SkipPanelHandles => {
  const range = skipPanelRange(kind, durationSeconds);
  if (kind === "credits") return { startSeconds: clamp(seconds, range.from, range.to), endSeconds: durationSeconds };
  if (handle === "start") return { ...handles, startSeconds: clamp(seconds, range.from, handles.endSeconds) };
  return { ...handles, endSeconds: clamp(seconds, handles.startSeconds, range.to) };
};

/** Whether Save can store the times: something to skip, inside the episode. */
export const skipHandlesSavable = (handles: SkipPanelHandles, durationSeconds: number): boolean =>
  handles.endSeconds > handles.startSeconds && handles.startSeconds >= 0 && handles.endSeconds <= durationSeconds;

/** "1:44", or "1:02:03" past the hour; whole seconds, rounded down. */
export const formatSkipClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

/** An episode's file: the file holding its season and episode. */
const episodeFileIds = (media: MediaDetails, episodeId: string): string[] => {
  const episode = media.episodes.find((entry) => entry.id === episodeId);
  if (!episode) return [];
  return media.files.filter((file) => file.season === episode.seasonNumber && file.episode === episode.episodeNumber).map((file) => file.id);
};

/** The episode's length: the longest format of its file. Null when no format records one. */
export const episodeDurationSeconds = (media: MediaDetails, episodeId: string): number | null => {
  const fileIds = new Set(episodeFileIds(media, episodeId));
  let longest = 0;
  for (const format of media.formats) {
    if (fileIds.has(format.fileId) && typeof format.durationSeconds === "number") longest = Math.max(longest, format.durationSeconds);
  }
  return longest > 0 ? longest : null;
};

/** The episode's seek-bar preview record (its source format's), null when it has none. */
export const episodePreviewSheets = (media: MediaDetails, episodeId: string): MediaPreviewSheets | null => {
  const fileIds = new Set(episodeFileIds(media, episodeId));
  return media.formats.find((format) => fileIds.has(format.fileId) && format.isSource === true)?.previewSheets ?? null;
};

/** The episode's source format id: the video the skip-detection catch-up works on (MPV-PREV-07). Null when none. */
export const episodeSourceFormatId = (media: MediaDetails, episodeId: string): string | null => {
  const fileIds = new Set(episodeFileIds(media, episodeId));
  return media.formats.find((format) => fileIds.has(format.fileId) && format.isSource === true)?.id ?? null;
};

/**
 * The title's videos the catch-up left out (PLAY-SKIP-09): the failed and cancelled ones, removed from the Jobs
 * history or not, until "Try again".
 */
export const leftOutFormatIds = (
  status: { failed: ReadonlyArray<{ formatId: string; mediaId: string }>; cancelled: ReadonlyArray<{ formatId: string; mediaId: string }> } | null,
  mediaId: string,
): Set<string> =>
  new Set(status ? [...status.failed, ...status.cancelled].filter((video) => video.mediaId === mediaId).map((video) => video.formatId) : []);

/** What the panel draws for a moment: which sheet object and where the picture sits in it. Null when there is none. */
export type SkipPanelPicture = { objectKey: string; x: number; y: number; width: number; height: number };

export const skipPanelPicture = (previews: MediaPreviewSheets | null, seconds: number): SkipPanelPicture | null => {
  const location = locatePreviewPicture(previews, seconds);
  if (!location) return null;
  return { objectKey: location.sheet.objectKey, x: location.x, y: location.y, width: location.width, height: location.height };
};
