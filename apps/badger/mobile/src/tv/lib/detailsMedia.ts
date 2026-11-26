/**
 * What a TV title page shows about its video (UX-TV-06, UX-TV-07), from the library's `MediaDetails`. Pure: no React, no
 * native modules, so it is unit tested in `detailsMedia.test.ts`.
 *
 * Model (Chris 2026-10-28): one video per movie and per episode, in several qualities. The original (`isSource`) comes
 * first, then the smaller copies made from it. A movie's named cuts (INGS-EDIT-01) show as version chips beside its
 * qualities. A show never has qualities of its own: each episode has its own.
 */
import type { MediaDetails, MediaEpisode, MediaFile, MediaFormat, MediaRow, MediaTrailer, MediaType } from "@space/shared/libraryTypes";
import { isOcrTwin } from "@space/shared/subtitleTwins";
import { formatLocalizedStorage, formatRating as formatRatingIn, formatStarRating as formatStarRatingIn } from "@space/shared/format";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import { selectFileTracks } from "../../lib/downloads/planner";
import { episodeFileKey } from "../../lib/playback/episodeSelection";

export type TvDetailsTab = "episodes" | "cast" | "versions" | "similar";

/**
 * The tabs of a title page, in order (UX-TV-06): a movie Cast & crew, Versions, More like this; a show Episodes, Cast &
 * crew, More like this. Cast & crew is left out when the library knows nobody and More like this when no other title
 * shares a genre, so no tab opens on an empty panel.
 */
export const tvDetailsTabs = (type: MediaType, hasCast: boolean, hasSimilar: boolean): TvDetailsTab[] => {
  const tabs: TvDetailsTab[] = type === "tv" ? ["episodes", "cast", "similar"] : ["cast", "versions", "similar"];
  return tabs.filter((tab) => (tab === "cast" ? hasCast : tab === "similar" ? hasSimilar : true));
};

export type TvVersionChip = { key: string; label: string; /** The version Play starts, drawn amber. */ playing: boolean };

/**
 * The version chips above a movie's title (UX-TV-06): its qualities, highest first, the one Play starts marked, then the
 * named cuts it holds (INGS-EDIT-01). A show has none: its qualities are per episode (UX-TV-07).
 */
export const tvVersionChips = (details: Pick<MediaDetails, "type" | "editions">, block: MediaTracksBlock | null): TvVersionChip[] => {
  if (details.type !== "movie") return [];
  const chips: TvVersionChip[] = (block?.qualities ?? []).map((chip, index) => ({
    key: `quality-${chip.label}`,
    label: chip.label,
    playing: index === 0,
  }));
  for (const edition of details.editions ?? []) {
    const name = edition.name.trim();
    if (edition.season !== null || name.length === 0 || chips.some((chip) => chip.label === name)) continue;
    chips.push({ key: `edition-${edition.id}`, label: name, playing: false });
  }
  return chips;
};

/** Most titles the More like this tab lists (one row on the TV). */
export const TV_SIMILAR_LIMIT = 12;

/**
 * More like this (UX-TV-40): the other titles of the same kind in the library that share a genre with this one, the most
 * shared genres first, then the best rated, then the newest added. Built from the library alone: nothing is fetched.
 */
export const similarTitles = (
  details: Pick<MediaDetails, "id" | "type" | "genres">,
  media: readonly MediaRow[],
  limit = TV_SIMILAR_LIMIT,
): MediaRow[] => {
  const genres = new Set(details.genres);
  if (genres.size === 0) return [];
  return media
    .flatMap((row) => {
      if (row.id === details.id || row.type !== details.type) return [];
      const shared = row.genres.filter((genre) => genres.has(genre)).length;
      return shared > 0 ? [{ row, shared }] : [];
    })
    .sort(
      (a, b) =>
        b.shared - a.shared || (b.row.rating ?? 0) - (a.row.rating ?? 0) || b.row.addedAt.localeCompare(a.row.addedAt) || a.row.id.localeCompare(b.row.id),
    )
    .slice(0, limit)
    .map(({ row }) => row);
};

export type MediaQualityChip = { label: string; original: boolean };

export type MediaTracksBlock = {
  fileId: string;
  /** The original quality ("2160p HDR"), its format ("HEVC · Dolby Vision") and size ("18.4 GB"); null without formats. */
  original: { quality: string; format: string; size: string | null } | null;
  /** Every quality to play: the original first, then the copies, highest first. One chip per quality. */
  qualities: readonly MediaQualityChip[];
  audio: readonly string[];
  subtitles: readonly string[];
  /** Length of the video, from its formats; null when none knows it. */
  durationSeconds: number | null;
};

const CODEC_LABELS: Record<string, string> = {
  h264: "H.264",
  avc: "H.264",
  avc1: "H.264",
  hevc: "HEVC",
  h265: "HEVC",
  hvc1: "HEVC",
  av1: "AV1",
  vp9: "VP9",
};

/** Dolby Vision is the only HDR the format rows reveal (`dvh1` / `dvhe` codec strings). */
const isDolbyVision = (format: Pick<MediaFormat, "codecString">): boolean => /^dv(h1|he|a1|av)/i.test(format.codecString ?? "");

/** "2160p", or "2160p HDR" for an HDR picture. */
export const qualityLabel = (format: Pick<MediaFormat, "quality" | "codecString">): string => {
  const quality = format.quality.trim();
  return isDolbyVision(format) && !/hdr/i.test(quality) ? `${quality} HDR` : quality;
};

/** "HEVC", "H.264", "HEVC · Dolby Vision". */
export const codecLabel = (format: Pick<MediaFormat, "codec" | "codecString">): string => {
  const codec = CODEC_LABELS[format.codec.trim().toLowerCase()] ?? format.codec.toUpperCase();
  return isDolbyVision(format) ? `${codec} · Dolby Vision` : codec;
};

/** "18,4 Go" in French, "18,4 GB" in German, "850 MB"; null for an unknown or empty size. Number and unit follow the UI language (STOR-UNIT-02). */
export const formatSizeMb = (sizeMb: number | null | undefined): string | null => {
  if (typeof sizeMb !== "number" || !Number.isFinite(sizeMb) || sizeMb <= 0) return null;
  return formatLocalizedStorage(sizeMb * 1024 ** 2, getCurrentLanguage(), { minUnit: "MB", maxUnit: "GB" });
};

/** The shared rating formats (`@space/shared/format`) in the UI language: "7,4" and "★ 7,4" in German. */
export const formatRating = (rating: number): string => formatRatingIn(rating, getCurrentLanguage());
export const formatStarRating = (rating: number): string => formatStarRatingIn(rating, getCurrentLanguage());

/** Lines of a quality label ("2160p" → 2160), 0 when it has none. */
const qualityHeight = (quality: string): number => {
  const match = /(\d{3,4})/.exec(quality);
  return match ? Number(match[1]) : 0;
};

const unique = (labels: readonly string[]): string[] => Array.from(new Set(labels.filter((label) => label.length > 0)));

/** The qualities, audio and subtitles of one video file (a movie's, or one episode's). */
export const mediaBlockForFile = (details: MediaDetails, fileId: string, episodeId: string | null): MediaTracksBlock => {
  const formats = details.formats.filter((format) => format.fileId === fileId);
  const source = formats.find((format) => format.isSource === true) ?? null;
  const copies = formats
    .filter((format) => format !== source)
    .sort((a, b) => qualityHeight(b.quality) - qualityHeight(a.quality));
  const ordered = source ? [source, ...copies] : copies;
  const head = ordered[0] ?? null;
  const qualities: MediaQualityChip[] = [];
  for (const format of ordered) {
    const label = qualityLabel(format);
    if (qualities.some((chip) => chip.label === label)) continue;
    qualities.push({ label, original: format === source });
  }
  // Same scoping as the player (episode-scoped tracks win, then file-scoped, then unscoped).
  const { audioTracks, subtitleTracks } = selectFileTracks(details, fileId, episodeId);
  const durations = formats.map((format) => format.durationSeconds ?? 0).filter((seconds) => seconds > 0);
  return {
    fileId,
    original: head ? { quality: qualityLabel(head), format: codecLabel(head), size: formatSizeMb(head.sizeMb) } : null,
    qualities,
    audio: unique(audioTracks.map((track) => track.label || track.language)),
    // An OCR twin (PLAY-TRACK-05) is the text copy of a picture track the player loads in its place: never listed.
    subtitles: unique(subtitleTracks.filter((track) => !isOcrTwin(track)).map((track) => track.label || track.language)),
    durationSeconds: durations.length > 0 ? Math.max(...durations) : null,
  };
};

/**
 * A movie's video. The player plays `files[0]`, so a movie with several files (a leftover until editions exist) shows the
 * first one, and says so in the log.
 */
export const movieMediaBlock = (details: MediaDetails): MediaTracksBlock | null => {
  const file = details.files[0] ?? null;
  if (!file) return null;
  if (details.files.length > 1) {
    console.info(
      "tv.details.movieFiles",
      JSON.stringify({ mediaId: details.id, files: details.files.length, shown: file.id, note: "first file only, as the player" }),
    );
  }
  return mediaBlockForFile(details, file.id, null);
};

/** The file of one episode (matched on season and episode number, as the player does). */
export const episodeFile = (details: MediaDetails, episode: Pick<MediaEpisode, "seasonNumber" | "episodeNumber">): MediaFile | null =>
  details.files.find((file) => file.season === episode.seasonNumber && file.episode === episode.episodeNumber) ?? null;

/** Every episode's video, keyed by episode id; an episode without a file has none. */
export const episodeMediaBlocks = (details: MediaDetails | null): ReadonlyMap<string, MediaTracksBlock> => {
  const blocks = new Map<string, MediaTracksBlock>();
  if (!details || details.type !== "tv") return blocks;
  const files = new Map<string, MediaFile>();
  for (const file of details.files) {
    if (typeof file.season === "number" && typeof file.episode === "number") files.set(episodeFileKey(file.season, file.episode), file);
  }
  for (const episode of details.episodes) {
    const file = files.get(episodeFileKey(episode.seasonNumber, episode.episodeNumber));
    if (file) blocks.set(episode.id, mediaBlockForFile(details, file.id, episode.id));
  }
  return blocks;
};

/** An episode row's qualities: "1080p · 720p". */
export const qualitiesLine = (block: Pick<MediaTracksBlock, "qualities">): string => block.qualities.map((chip) => chip.label).join(" · ");

export type TrailerLink = { key: string; appUrl: string };

/**
 * The first YouTube trailer and the tvOS YouTube app's link to it; null when the title has none (UX-TV-06).
 * `youtube://watch/<id>` is the tvOS app's form; Apple TV has no browser, so there is no web fallback. Android TV plays
 * the trailer embedded, and Android's `vnd.youtube:` form crashed the YouTube app on an Android TV box.
 */
export const youtubeTrailer = (trailers: readonly MediaTrailer[] | null | undefined): TrailerLink | null => {
  const trailer = (trailers ?? []).find((item) => item.provider === "youtube" && item.key.trim().length > 0);
  if (!trailer) return null;
  return { key: trailer.key.trim(), appUrl: `youtube://watch/${encodeURIComponent(trailer.key.trim())}` };
};

/** Whole minutes left at this progress (0-100) of this length; null when the length is unknown. */
export const minutesLeft = (progressPct: number, durationSeconds: number | null): number | null => {
  if (durationSeconds === null || durationSeconds <= 0) return null;
  const pct = Math.max(0, Math.min(100, progressPct));
  return Math.max(1, Math.round((durationSeconds * (100 - pct)) / 100 / 60));
};

/** Hours and minutes of a length, for "2 h 9 min" / "52 min"; null when unknown. */
export const runtimeParts = (durationSeconds: number | null): { hours: number; minutes: number } | null => {
  if (durationSeconds === null || durationSeconds <= 0) return null;
  const total = Math.max(1, Math.round(durationSeconds / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
};

/** First letters of the first and last words of a name ("Ian McKellen" → "IM"). */
export const initials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]![0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]![0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
};
