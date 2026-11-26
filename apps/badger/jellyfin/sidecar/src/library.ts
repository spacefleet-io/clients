import {
  isSidecarSubtitleFileId,
  type AudioTrack,
  type MediaDetails,
  type MediaFormat,
  type MediaRow,
  type MediaSkipMarker,
  type SubtitleTrack,
} from "@space/shared/libraryTypes";
import { languagesMatch, type TrackPrefs } from "@space/shared/trackPrefs";
import { isOcrTwin } from "@space/shared/subtitleTwins";
import { parseProfileSettings, PROFILE_SETTINGS_KEY } from "@space/shared/profileSettings";
import { parseTitleVariants, profileTitleLanguage, shownTitleArt, titleVariantsKey } from "@space/shared/titleLanguage";
import { readEpisodeResumeSetting, readMediaProgress, readTrackPrefs } from "./profile";
import { keptTexts } from "./localizedTexts";
import { OVERVIEW_FALLBACK_LANGUAGE } from "@space/metadata-client";
import { isWatchedProgress } from "./progress";
import {
  resolutionForQuality,
  segmentsFromChunks,
  type HlsAudioVariant,
  type HlsUnit,
  type HlsVideoVariant,
} from "./hls";

/** Catalog genre ids (movie + tv) -> names, so .nfo files carry readable genres. */
const CATALOG_GENRES: Record<number, string> = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Science Fiction",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
  10759: "Action & Adventure",
  10762: "Kids",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk",
  10768: "War & Politics",
};

export type PlayableUnit = {
  mediaId: string;
  episodeId: string | null;
  fileId: string | null;
  durationSeconds: number | null;
  formats: MediaFormat[];
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  skipMarkers: MediaSkipMarker[];
};

/** Playable unit: movie -> first file; episode -> file matching season/episode. Tracks are scoped by file/episode. */
export const resolvePlayableUnit = (details: MediaDetails, episodeId: string | null): PlayableUnit | null => {
  let fileId: string | null = null;
  if (episodeId) {
    const episode = details.episodes.find((entry) => entry.id === episodeId);
    if (!episode) return null;
    const file = details.files.find((entry) => entry.season === episode.seasonNumber && entry.episode === episode.episodeNumber);
    fileId = file?.id ?? null;
    if (!fileId) return null;
  } else {
    fileId = details.files[0]?.id ?? null;
  }
  const inScope = <T extends { fileId: string | null; episodeId?: string | null }>(track: T) => {
    if (fileId && track.fileId === fileId) return true;
    if (episodeId && track.episodeId === episodeId) return true;
    // A sidecar subtitle names its import candidate, not a library file: it belongs to the title (PLAY-SUBGET-24).
    return (!track.fileId || isSidecarSubtitleFileId(track.fileId)) && !(track.episodeId ?? null);
  };
  const formats = details.formats.filter((format) => (fileId ? format.fileId === fileId : true));
  if (formats.length === 0) return null;
  const durations = formats.map((format) => format.durationSeconds ?? 0).filter((value) => value > 0);
  return {
    mediaId: details.id,
    episodeId,
    fileId,
    durationSeconds: durations.length > 0 ? Math.max(...durations) : null,
    formats,
    audioTracks: details.audioTracks.filter(inScope),
    // OCR twins (PLAY-TRACK-05) only stand in for picture tracks on the Android TV; Jellyfin gets the picture track.
    subtitleTracks: details.subtitleTracks.filter((track) => inScope(track) && !isOcrTwin(track)),
    skipMarkers: details.skipMarkers.filter((marker) => (episodeId ? marker.episodeId === episodeId : !marker.episodeId)),
  };
};

/**
 * Stable per-unit quality keys for URLs / file names: the quality label, with the codec appended when two
 * formats of one unit share a label (and the format id as last resort).
 */
export const qualityKeys = (formats: readonly MediaFormat[]): Array<{ key: string; format: MediaFormat }> => {
  const counts = new Map<string, number>();
  formats.forEach((format) => counts.set(format.quality, (counts.get(format.quality) ?? 0) + 1));
  const used = new Set<string>();
  return formats.map((format) => {
    let key = (counts.get(format.quality) ?? 0) > 1 ? `${format.quality}-${format.codec}` : format.quality;
    if (used.has(key)) key = `${key}-${format.id.slice(0, 8)}`;
    used.add(key);
    return { key, format };
  });
};

const qualityRank = (format: MediaFormat) => {
  const resolution = resolutionForQuality(format.quality)?.height ?? 0;
  return resolution * 1_000_000 + (format.bitrateKbps ?? 0);
};

/** Highest quality first; the source (original) format wins ties. INTG-QUAL-01: original = default version. */
export const sortFormatsBestFirst = (formats: readonly MediaFormat[]) =>
  [...formats].sort((a, b) => {
    if (Boolean(a.isSource) !== Boolean(b.isSource)) return a.isSource ? -1 : 1;
    return qualityRank(b) - qualityRank(a);
  });

export const buildHlsUnit = (unit: PlayableUnit, qualityKey: string | null, preferredLanguage?: string | null): HlsUnit | null => {
  const keyed = qualityKeys(unit.formats);
  const selected = qualityKey && qualityKey !== "auto" ? keyed.filter((entry) => entry.key === qualityKey) : keyed;
  if (selected.length === 0) return null;
  const videos: HlsVideoVariant[] = selected
    .filter(({ format }) => format.initKey && format.chunks.length > 0)
    .map(({ format }) => {
      const resolution = resolutionForQuality(format.quality);
      return {
        id: format.id,
        quality: format.quality,
        bitrateKbps: format.bitrateKbps,
        width: resolution?.width ?? null,
        height: resolution?.height ?? null,
        track: {
          initKey: format.initKey as string,
          codecString: format.codecString ?? null,
          segments: segmentsFromChunks(format.chunks, format.durationSeconds),
        },
      };
    });
  if (videos.length === 0) return null;
  const audio: HlsAudioVariant[] = unit.audioTracks
    .filter((track) => track.initKey && track.chunks.length > 0)
    .map((track) => ({
      id: track.id,
      language: track.language,
      label: track.label,
      isDefault:
        preferredLanguage && track.language
          ? languagesMatch(track.language, preferredLanguage)
          : track.isDefault,
      track: {
        initKey: track.initKey as string,
        codecString: track.codecString ?? null,
        segments: segmentsFromChunks(track.chunks, track.durationSeconds),
      },
    }));
  // Several tracks may match the preferred language; keep one DEFAULT.
  const firstDefault = audio.findIndex((entry) => entry.isDefault);
  audio.forEach((entry, index) => {
    entry.isDefault = firstDefault >= 0 ? index === firstDefault : index === 0;
  });
  return { videos, audio };
};

// --- Library listing JSON -------------------------------------------------

export type IntegrationVersion = {
  qualityKey: string;
  formatId: string;
  quality: string;
  codec: string;
  bitrateKbps: number | null;
  width: number | null;
  height: number | null;
  isSource: boolean;
  sizeMb: number;
  isDefault: boolean;
  masterPath: string;
};

export type IntegrationResume = {
  progressPct: number;
  positionSeconds: number | null;
  durationSeconds: number | null;
  updatedAt: string | null;
  watched: boolean;
};

export type IntegrationSubtitle = {
  id: string;
  language: string;
  label: string;
  format: string | null;
  isDefault: boolean;
  path: string;
};

export type IntegrationAudio = { id: string; language: string; label: string; isDefault: boolean };

export type IntegrationUnit = {
  durationSeconds: number | null;
  versions: IntegrationVersion[];
  audioTracks: IntegrationAudio[];
  subtitleTracks: IntegrationSubtitle[];
  skipMarkers: Array<{ type: "intro" | "credits"; startSeconds: number; endSeconds: number }>;
  resume: IntegrationResume | null;
};

export type IntegrationMovie = {
  id: string;
  type: "movie";
  title: string;
  originalTitle: string | null;
  originalLanguage: string | null;
  year: number | null;
  overview: string | null;
  genres: string[];
  addedAt: string;
  posterPath: string | null;
  backdropPath: string | null;
  preferredAudioLanguage: string | null;
  cast: Array<{ name: string; role: string | null }>;
} & IntegrationUnit;

export type IntegrationEpisode = {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  /** The stored episode name: file names are made of it, so a language change renames nothing. */
  title: string;
  /** The episode name in Jellyfin's interface language (LIB-LANG-01), null when none is kept. */
  shownTitle: string | null;
  overview: string | null;
  airDate: string | null;
  stillPath: string | null;
} & IntegrationUnit;

export type IntegrationSeason = {
  seasonNumber: number;
  name: string;
  overview: string | null;
  posterPath: string | null;
  episodes: IntegrationEpisode[];
};

export type IntegrationShow = Omit<IntegrationMovie, "type" | keyof IntegrationUnit> & {
  type: "tv";
  seasons: IntegrationSeason[];
};

export type IntegrationLibrary = {
  version: number;
  generatedAt: string;
  movies: IntegrationMovie[];
  shows: IntegrationShow[];
};

export type LibraryReader = {
  getVersion(): number;
  listMedia(): MediaRow[];
  getMediaDetails(mediaId: string): MediaDetails | null;
  getSetting(key: string): { value: string | null; updatedAt?: string | null } | null | undefined;
};

const parseYear = (value: string | null) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

export const mediaPathBase = (mediaId: string, episodeId: string | null) =>
  `/integration/v1/media/${encodeURIComponent(mediaId)}${episodeId ? `/${encodeURIComponent(episodeId)}` : ""}`;

const buildUnit = (details: MediaDetails, unit: PlayableUnit, resume: IntegrationResume | null): IntegrationUnit => {
  const keyed = qualityKeys(sortFormatsBestFirst(unit.formats));
  const base = mediaPathBase(details.id, unit.episodeId);
  const credits = unit.skipMarkers.find((marker) => marker.type === "credits");
  return {
    durationSeconds: unit.durationSeconds,
    versions: keyed.map(({ key, format }, index) => {
      const resolution = resolutionForQuality(format.quality);
      return {
        qualityKey: key,
        formatId: format.id,
        quality: format.quality,
        codec: format.codec,
        bitrateKbps: format.bitrateKbps,
        width: resolution?.width ?? null,
        height: resolution?.height ?? null,
        isSource: Boolean(format.isSource),
        sizeMb: format.sizeMb,
        isDefault: index === 0,
        masterPath: `${base}/${encodeURIComponent(key)}/master.m3u8`,
      };
    }),
    audioTracks: unit.audioTracks.map((track) => ({
      id: track.id,
      language: track.language,
      label: track.label,
      isDefault: track.isDefault,
    })),
    subtitleTracks: unit.subtitleTracks
      .filter((track) => track.objectKey)
      .map((track) => ({
        id: track.id,
        language: track.language,
        label: track.label,
        format: track.format,
        isDefault: track.isDefault,
        path: `/integration/v1/subtitles/${encodeURIComponent(details.id)}/${encodeURIComponent(track.id)}.${subtitleExtension(track.format)}`,
      })),
    skipMarkers: unit.skipMarkers.map((marker) => ({
      type: marker.type,
      startSeconds: marker.startSeconds,
      endSeconds: marker.endSeconds,
    })),
    resume: resume
      ? {
          ...resume,
          watched: isWatchedProgress({
            progressPct: resume.progressPct,
            positionSeconds: resume.positionSeconds,
            creditsStartSeconds: credits?.startSeconds ?? null,
          }),
        }
      : null,
  };
};

export const subtitleExtension = (format: string | null | undefined) => {
  const value = (format ?? "").toLowerCase();
  if (value === "srt" || value === "vtt" || value === "ass" || value === "ssa") return value;
  if (value === "sup") return "sup";
  return value || "bin";
};

const parseEpisodeResume = (raw: string | null | undefined, fallbackUpdatedAt: string | null): IntegrationResume | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      progressPct?: number;
      updatedAt?: string;
      positionSeconds?: number;
      durationSeconds?: number;
    };
    const pct = Number(parsed.progressPct);
    if (!Number.isFinite(pct)) return null;
    return {
      progressPct: Math.max(0, Math.min(100, pct)),
      positionSeconds: Number.isFinite(parsed.positionSeconds) ? (parsed.positionSeconds as number) : null,
      durationSeconds: Number.isFinite(parsed.durationSeconds) ? (parsed.durationSeconds as number) : null,
      updatedAt: parsed.updatedAt ?? fallbackUpdatedAt,
      watched: false,
    };
  } catch {
    return null;
  }
};

/** Movie resume of the profile (main: the row; others: their `media_progress_v1` key, absent = not started). */
const movieResume = (reader: LibraryReader, prefix: string, row: MediaRow, durationSeconds: number | null): IntegrationResume | null => {
  const progress = readMediaProgress(reader, prefix, row);
  if (!(progress.progressPct > 0)) return null;
  return {
    progressPct: progress.progressPct,
    positionSeconds: durationSeconds ? (progress.progressPct / 100) * durationSeconds : null,
    durationSeconds,
    updatedAt: progress.lastWatchedAt,
    watched: false,
  };
};

const commonFields = (row: MediaRow, details: MediaDetails, prefs: TrackPrefs | null) => ({
  id: row.id,
  title: row.title,
  originalTitle: row.originalTitle,
  originalLanguage: row.originalLanguage,
  year: parseYear(row.year),
  overview: row.overview,
  genres: (row.genres ?? []).map((id) => CATALOG_GENRES[id]).filter((name): name is string => Boolean(name)),
  addedAt: row.addedAt,
  posterPath: row.posterPath,
  backdropPath: row.backdropPath,
  preferredAudioLanguage: prefs?.audioLanguage ?? null,
  cast: details.cast.slice(0, 12).map((member) => ({ name: member.name, role: member.role })),
});

/**
 * The library as the chosen profile (INTG-PROF-01) sees it: `prefix` "" = main profile, `p:<id>:` otherwise. Synopses
 * and episode texts are the kept texts of `language` (LIB-LANG-01), English filling what it lacks, the stored text
 * where none is kept; building reads rows only and never asks a lookup. With the profile's "Original version"
 * (ACCT-PROF-03) a title shows the original set of its `title_variants_v1` row, its pictures once copied.
 */
export const buildIntegrationLibrary = (reader: LibraryReader, prefix: string, language = OVERVIEW_FALLBACK_LANGUAGE): IntegrationLibrary => {
  const movies: IntegrationMovie[] = [];
  const shows: IntegrationShow[] = [];
  const titleLanguage = profileTitleLanguage(parseProfileSettings(reader.getSetting(`${prefix}${PROFILE_SETTINGS_KEY}`)?.value));
  for (const stored of reader.listMedia()) {
    const row =
      titleLanguage === "original" ? shownTitleArt(stored, parseTitleVariants(reader.getSetting(titleVariantsKey(stored.id))?.value), titleLanguage) : stored;
    const details = reader.getMediaDetails(row.id);
    if (!details) continue;
    const texts = row.catalogId && (row.type === "movie" || row.type === "tv") ? keptTexts(reader, row.type, row.catalogId, language) : null;
    const overview = texts?.overview ?? row.overview;
    if (row.type === "movie") {
      const unit = resolvePlayableUnit(details, null);
      if (!unit) continue;
      movies.push({
        ...commonFields(row, details, readTrackPrefs(reader, prefix, row.id)),
        overview,
        type: "movie",
        ...buildUnit(details, unit, movieResume(reader, prefix, row, unit.durationSeconds)),
      });
      continue;
    }
    const seasons = new Map<number, IntegrationSeason>();
    for (const episode of details.episodes) {
      const unit = resolvePlayableUnit(details, episode.id);
      if (!unit) continue;
      const setting = readEpisodeResumeSetting(reader, prefix, episode.id);
      const resume = parseEpisodeResume(setting?.value, setting?.updatedAt ?? null);
      const season =
        seasons.get(episode.seasonNumber) ??
        (() => {
          const meta = details.seasons.find((entry) => entry.seasonNumber === episode.seasonNumber);
          const created: IntegrationSeason = {
            seasonNumber: episode.seasonNumber,
            name: meta?.name ?? `Season ${episode.seasonNumber}`,
            overview: meta?.overview ?? null,
            posterPath: meta?.posterPath ?? null,
            episodes: [],
          };
          seasons.set(episode.seasonNumber, created);
          return created;
        })();
      const kept = texts?.episode(episode.seasonNumber, episode.episodeNumber);
      season.episodes.push({
        id: episode.id,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        title: episode.name,
        shownTitle: kept?.name ?? null,
        overview: kept?.overview ?? episode.overview,
        airDate: episode.airDate,
        stillPath: episode.stillPath,
        ...buildUnit(details, unit, resume),
      });
    }
    if (seasons.size === 0) continue;
    const ordered = [...seasons.values()].sort((a, b) => a.seasonNumber - b.seasonNumber);
    ordered.forEach((season) => season.episodes.sort((a, b) => a.episodeNumber - b.episodeNumber));
    shows.push({ ...commonFields(row, details, readTrackPrefs(reader, prefix, row.id)), overview, type: "tv", seasons: ordered });
  }
  return { version: reader.getVersion(), generatedAt: new Date().toISOString(), movies, shows };
};
