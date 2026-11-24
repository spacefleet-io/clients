import { findMediaLanguage } from "./media-languages";
import type { MediaPreviewSheets } from "./previewSheets";

export type MediaType = "movie" | "tv";

export type MediaRow = {
  id: string;
  type: MediaType;
  /** The metadata service's id of the title; null when the title has none. */
  catalogId: number | null;
  title: string;
  originalTitle: string | null;
  originalLanguage: string | null;
  overview: string | null;
  year: string | null;
  rating: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  genres: number[];
  addedAt: string;
  updatedAt: string;
  hasFiles: boolean;
  progressPct: number;
  lastWatchedAt: string | null;
  totalEpisodes: number | null;
  episodeCount: number;
  /**
   * Roll-up of the user's offline-availability for this media on THIS device.
   * - "none"    — nothing saved locally for this media
   * - "partial" — some but not all playable items saved (TV-only state)
   * - "full"    — every playable item saved (movie OR all episodes)
   *
   * Driven by `badger.offline.list_local` data, rolled up by the renderer's
   * `collectOfflineLocalCounts` helper. Optional at the type boundary so
   * snapshots that pre-date Phase 3 deserialize cleanly; consumers treat
   * `undefined` as `"none"`.
   *
   * Local-only per the offline-mode plan — no remote sync, since
   * downloaded-ness is per-device.
   */
  offlineState?: "none" | "partial" | "full";
};

export type MediaCastMember = {
  id: string;
  personId: string;
  catalogId: number | null;
  name: string;
  role: string | null;
  profilePath: string | null;
};

export type MediaCastDraft = {
  personId?: string | null;
  catalogId?: number | null;
  name: string;
  role?: string | null;
  profilePath?: string | null;
};

/** One crew credit kept in the library (LIB-CREW-01): only the jobs the detail page and the Director filter use. */
export type MediaCrewMember = {
  id: string;
  personId: string;
  catalogId: number | null;
  name: string;
  job: string;
  profilePath: string | null;
};

export type MediaCrewDraft = {
  catalogId?: number | null;
  name: string;
  job: string | null;
  profilePath?: string | null;
};

export type MediaTrailer = {
  provider: "youtube";
  key: string;
  name: string | null;
  language: string;
};

export type MediaSeason = {
  id: string;
  seasonNumber: number;
  name: string;
  overview: string | null;
  posterPath: string | null;
  episodeCount: number;
  airDate: string | null;
};

export type MediaSeasonDraft = {
  id: string;
  name: string;
  overview: string | null;
  posterPath: string | null;
  episodeCount: number | null;
  airDate: string | null;
};

export type MediaEpisode = {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string | null;
  stillPath: string | null;
  airDate: string | null;
};

export type MediaEpisodeDraft = {
  id: string;
  name: string;
  overview: string | null;
  stillPath: string | null;
  airDate: string | null;
};

/** What `refreshShowEpisodes` changed in one show (LIB-SHOW-01). */
export type ShowEpisodeRefreshResult = {
  changed: boolean;
  addedSeasons: number;
  updatedSeasons: number;
  addedEpisodes: number;
  updatedEpisodes: number;
  /**
   * LIB-SHOW-02 / LIB-SHOW-04: stored episodes the metadata service provably no longer lists; nothing is changed. One without a
   * file is offered for removal; one with a file carries `move`, the change suggested for it.
   */
  notListed: ShowEpisodeNotListed[];
};

/** An episode slot of a show in the library. */
export type ShowEpisodeSlot = { id: string; seasonNumber: number; episodeNumber: number; title: string };

/**
 * LIB-SHOW-04: what the dialog suggests for a delisted episode that has a file. `move`: the service's new list points to
 * one likely new place (`target`). `merged`: the service merged this part and the other `partIds` into `into`; one episode
 * cannot hold two halves, so each part gets the keep-or-pick-by-hand choice. `none`: no likely place; keep it or
 * pick its episode by hand.
 */
export type EpisodeMoveSuggestion =
  | { kind: "move"; target: ShowEpisodeSlot }
  | { kind: "merged"; into: ShowEpisodeSlot; partIds: string[] }
  | { kind: "none" };

export type ShowEpisodeNotListed = ShowEpisodeSlot & {
  /** Present only for an episode that has a file (LIB-SHOW-04); such an episode is never offered for removal. */
  move?: EpisodeMoveSuggestion;
};

/** What `removeEpisodesNotInCatalog` did (LIB-SHOW-02). */
export type DelistedEpisodeRemovalResult = { removed: number; keptWithFile: number };

/** What `moveEpisodeToSlot` did (LIB-SHOW-04); `reason` says why nothing moved. */
export type EpisodeMoveResult =
  | { moved: true; files: number }
  | { moved: false; reason: "not-found" | "same-episode" | "no-file" | "target-has-file" };

export type MediaFile = {
  id: string;
  filename: string;
  season: number | null;
  episode: number | null;
  desiredFormats: { quality: string; codec: string; bitrateKbps?: number | null }[];
  /**
   * Edition this file belongs to (LIB-EDIT-01). Absent in an op from a client that predates editions: the file then
   * belongs to its unit's unnamed edition, `defaultEditionId` (`@space/shared/mediaEditions`).
   */
  editionId?: string | null;
  /** SHA-256 of the file's content, hex (INGS-EDIT-05); null for files stored before editions. */
  contentSha256?: string | null;
  /**
   * The size the user's computer showed for the file, bytes (`fs.stat`, STOR-USE-02): what it counts in the storage
   * allowance. Backfilled from the source copy for files stored before it was recorded; absent in an op from an older client.
   */
  originalSizeBytes?: number | null;
};

/** One `media_editions` row (LIB-EDIT-01): a cut of a film, or of one episode (`season`/`episode` set). */
export type MediaEditionRow = {
  id: string;
  season: number | null;
  episode: number | null;
  /** Empty for the unnamed edition every film or episode starts with. */
  name: string;
  nameUserSet: boolean;
  /** The edition's length, seconds; null when not recorded (editions made by the LIB-EDIT-02 upgrade). */
  durationSeconds: number | null;
  createdAt: string;
};

export type MediaFormat = {
  id: string;
  mediaId: string;
  fileId: string;
  quality: string;
  codec: string;
  codecString?: string | null;
  bitrateKbps: number | null;
  sizeMb: number;
  initKey: string | null;
  initSize: number | null;
  durationSeconds: number | null;
  totalSize: number | null;
  chunks: Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>;
  // True for the source-extracted format (highest available resolution). All
  // other formats — fallback transcodes from ingest, post-ingest re-transcode
  // outputs — are non-source. The post-ingest delete flow gates removals on
  // this flag: deleting the only source row would orphan the media item.
  //
  // Optional at the type boundary so older v1 op-stream payloads (which
  // omitted this field) deserialise cleanly. Consumers MUST treat `undefined`
  // as `false` — the canonical projection is `format.isSource === true`. The
  // local SQLite column DEFAULT is 0, so the runtime always returns a real
  // boolean from `getMediaDetails` / `listMediaFormats`; only stale op-stream
  // payloads and pre-bump test fixtures hit the undefined path.
  isSource?: boolean;
  /** Seek-bar preview sheets (MPV-PREV-01); only the source format carries them, absent/null = none. */
  previewSheets?: MediaPreviewSheets | null;
};

export type AudioTrack = {
  id: string;
  mediaId: string;
  fileId: string | null;
  episodeId: string | null;
  language: string;
  label: string;
  isDefault: boolean;
  source: string;
  codec: string | null;
  codecString?: string | null;
  initKey: string | null;
  initSize: number | null;
  durationSeconds: number | null;
  totalSize: number | null;
  chunks: Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>;
};

export type SubtitleTrack = {
  id: string;
  mediaId: string;
  fileId: string | null;
  episodeId: string | null;
  language: string;
  label: string;
  objectKey: string | null;
  format: string | null;
  isDefault: boolean;
  source: string;
  /**
   * Set on an OCR twin (`source: "ocr"`, SRT text recognised from a picture track): the id of the picture
   * (PGS / VobSub / DVB) row it was made from. Clients never list a twin as its own track; the Android TV
   * loads it in place of its picture row under direct rendering (PLAY-TRACK-05). Null/absent on every other row.
   */
  derivedFromSubtitleId?: string | null;
  createdAt: string;
};

const SIDECAR_SUBTITLE_FILE_ID_PREFIX = "external-subtitle:";

/**
 * `media_subtitles.file_id` of a subtitle file the user added beside a video at import (a sidecar `.srt`,
 * INGS-SUBS-01): it names the import candidate, never a library file, so it never equals the playing file's id.
 */
export const sidecarSubtitleFileId = (candidateId: string) => `${SIDECAR_SUBTITLE_FILE_ID_PREFIX}${candidateId}`;

export const isSidecarSubtitleFileId = (fileId: string | null | undefined): boolean =>
  fileId?.startsWith(SIDECAR_SUBTITLE_FILE_ID_PREFIX) ?? false;

/**
 * Whether an audio or subtitle track plays with the library file `fileId` (of episode `episodeId`, null for a film):
 * an episode's tracks by their episode, then the file's own tracks; unscoped tracks and sidecar subtitles (scoped to
 * no library file) belong to every file of the title, so the player lists them (PLAY-SUBGET-24).
 */
export const trackBelongsToPlayingFile = (
  track: { fileId?: string | null; episodeId?: string | null },
  fileId: string,
  episodeId: string | null
): boolean => {
  if (episodeId && track.episodeId) return track.episodeId === episodeId;
  if (track.fileId && !isSidecarSubtitleFileId(track.fileId)) return track.fileId === fileId;
  return true;
};

/**
 * Stored `media_subtitles.format` values of a picture subtitle (PGS `.sup`; VobSub / DVB kept in a
 * Matroska wrapper), lower-cased. These rows get an OCR text twin (PLAY-TRACK-05).
 */
export const PICTURE_SUBTITLE_FORMATS: ReadonlyArray<string> = [
  "sup",
  "pgs",
  "hdmv_pgs_subtitle",
  "mkv",
  "matroska",
  "vobsub",
  "dvd_subtitle",
  "dvb_subtitle",
];

/** The PGS ones among PICTURE_SUBTITLE_FORMATS: the OCR reads them as a `.sup` file, the others as Matroska. */
export const PGS_SUBTITLE_FORMATS: Record<string, true> = { sup: true, pgs: true, hdmv_pgs_subtitle: true };

const UPLOADED_SUBTITLE_FORMATS: ReadonlyArray<string> = ["srt", "vtt", "ass", "ssa", "sub", "txt"];

/** `media_subtitles.format` of a subtitle file the user adds (INGS-SUBS-01): its lower-cased extension, null when unknown. */
export const subtitleFormatFromName = (name: string): string | null => {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext && UPLOADED_SUBTITLE_FORMATS.includes(ext) ? ext : null;
};

const SUBTITLE_LANGUAGE_ALIASES: Record<string, string> = {
  english: "en",
  eng: "en",
  french: "fr",
  fra: "fr",
  fre: "fr",
  fran: "fr",
  spanish: "es",
  esp: "es",
  spa: "es",
  german: "de",
  deu: "de",
  ger: "de",
  italian: "it",
  ita: "it",
  japanese: "ja",
  jpn: "ja",
  korean: "ko",
  kor: "ko",
  portuguese: "pt",
  por: "pt",
  dutch: "nl",
  nld: "nl",
};

/**
 * The language of a subtitle file the user adds (INGS-SUBS-01), read from its name (`Movie.fr.srt`, `movie_french.srt`):
 * the first name word that is a known alias or a two-letter media language code; `und` when none is.
 */
export const subtitleLanguageFromName = (name: string): string => {
  const tokens = name.replace(/\.[^/.]+$/, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    const mapped = SUBTITLE_LANGUAGE_ALIASES[token];
    if (mapped) return mapped;
    if (token.length === 2 && findMediaLanguage(token)) return token;
  }
  return "und";
};

/** A picture subtitle row the OCR catch-up pass still has to turn into a text twin (PLAY-TRACK-05). */
export type SubtitleOcrCandidate = {
  id: string;
  mediaId: string;
  fileId: string | null;
  episodeId: string | null;
  language: string;
  label: string;
  objectKey: string;
  /** Lower-cased stored format, one of PICTURE_SUBTITLE_FORMATS. */
  format: string;
  /** Earlier attempts that produced no twin (0 when never tried). */
  attempts: number;
};

/** A video the seek-bar preview catch-up pass (MPV-PREV-03) still owes its sheets: its source format and file. */
export type PreviewSheetCandidate = {
  formatId: string;
  mediaId: string;
  fileId: string;
  /** The file's season and episode (null for a movie); the runtime matches its own imports on them. */
  season: number | null;
  episode: number | null;
  /** When the file joined the library; the pass goes newest first. */
  addedAt: string;
  durationSeconds: number | null;
  initKey: string | null;
};

/** Outcome of storing an OCR twin: `created: false` when the picture row is gone or already has a twin. */
export type AddOcrSubtitleTwinResult =
  | { created: true; reason: null; id: string }
  | { created: false; reason: "picture_missing"; id: null }
  | { created: false; reason: "twin_exists"; id: string };

export type MediaChapter = {
  id: string;
  formatId: string;
  title: string;
  startSeconds: number;
};

export type MediaSkipMarkerType = "intro" | "credits";

export type MediaSkipMarker = {
  id: string;
  mediaId: string;
  episodeId: string | null;
  type: MediaSkipMarkerType;
  startSeconds: number;
  endSeconds: number;
  source: string;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaDetails = MediaRow & {
  /** Director and writers (LIB-CREW-01). Absent where a reader does not load crew (an op from a client that predates crew). */
  crew?: MediaCrewMember[];
  /**
   * Editions (cuts) of the title's films or episodes (LIB-EDIT-01), one `media_editions` row each. Absent in an op
   * from a client that predates editions; such a reader treats every file as its unit's unnamed edition.
   */
  editions?: MediaEditionRow[];
  cast: MediaCastMember[];
  playlistIds: string[];
  seasons: MediaSeason[];
  episodes: MediaEpisode[];
  trailers: MediaTrailer[];
  files: MediaFile[];
  formats: MediaFormat[];
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  // Backward-compatible alias used by some callers.
  subtitles: SubtitleTrack[];
  chapters: MediaChapter[];
  skipMarkers: MediaSkipMarker[];
  hasLocalFiles: boolean;
};

export type PlaylistRow = {
  id: string;
  name: string;
  slug: string | null;
  isSystem: boolean;
  createdAt: string;
};

export type LibrarySnapshot = {
  media: MediaRow[];
  playlists: PlaylistRow[];
  playlistItems?: Record<string, string[]>;
  mediaDetails?: MediaDetails[];
  ingestJobs?: IngestJob[];
  settings?: Record<string, { value: string; updatedAt: string }>;
  version?: number;
};

export type IngestJobKind =
  | "source_upload"
  | "transcode"
  | "audio"
  | "subtitles"
  | "finalize";

export type IngestJobStatus =
  | "queued"
  | "processing"
  | "uploading"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export type IngestJob = {
  id: string;
  mediaId: string;
  fileId: string | null;
  workerPeerId: string;
  ownerClientId: string | null;
  kind: IngestJobKind;
  status: IngestJobStatus;
  progressPct: number;
  errorCode: string | null;
  errorMessage: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type IngestJobEventLevel = "info" | "warning" | "error" | "success";

export type IngestJobEvent = {
  id: string;
  jobId: string;
  level: IngestJobEventLevel;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
};
