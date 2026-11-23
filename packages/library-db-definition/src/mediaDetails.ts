/**
 * One title's `MediaDetails` read from the library tables, for every SQLite driver: the phone runs the queries over
 * its three split files (async, fanned out), the web player over one sql.js database (sync). The SQL and the row →
 * `MediaDetails` mapping live here once; each client only says how to run one query.
 *
 * `mediaDetailsQueries` lists the reads, `assembleMediaDetails` maps their rows, `readMediaDetails` /
 * `readMediaDetailsSync` do both. `collectMediaStorageKeys` lists the storage objects a title (or one of its
 * episode files) owns, for a delete (LIB-OPS-02); `collectMediaKeysInUse` adds its artwork, for the leftover
 * clean-up (STOR-PLACE-08).
 */
import type {
  AudioTrack,
  MediaCastMember,
  MediaChapter,
  MediaDetails,
  MediaEpisode,
  MediaFile,
  MediaFormat,
  MediaSeason,
  MediaSkipMarker,
  MediaTrailer,
  SubtitleTrack,
} from "@space/shared/libraryTypes";
import { parsePreviewSheets, previewSheetKeys } from "@space/shared/previewSheets";
import { CATALOG_ID_SOURCES_SQL } from "./legacyFormat";
import type { LibraryDbGroup } from "./manifest";

type Row = Record<string, unknown>;

export type MediaDetailsQueryName =
  | "item"
  | "catalogId"
  | "genres"
  | "cast"
  | "crew"
  | "seasons"
  | "episodes"
  | "trailers"
  | "files"
  | "desiredFormats"
  | "skipMarkers"
  | "formats"
  | "formatChunks"
  | "audioTracks"
  | "audioChunks"
  | "subtitles"
  | "chapters"
  | "editions"
  | "fileEditions"
  | "fileSizes";

/** Reads of tables or columns a library from an older layout may not have yet; they read as no rows there. */
const OPTIONAL_QUERIES: ReadonlySet<MediaDetailsQueryName> = new Set(["crew", "editions", "fileEditions", "fileSizes"]);

export type MediaDetailsQuery = {
  name: MediaDetailsQueryName;
  /** The split file the table lives in (core / metadata / playback); a combined database ignores it. */
  group: LibraryDbGroup;
  sql: string;
  params: unknown[];
};

export type MediaDetailsRows = Partial<Record<MediaDetailsQueryName, Row[]>>;

/** Every read of one title. Without `chunks`, the segment rows are left out (formats and audio keep `chunks: []`). */
export const mediaDetailsQueries = (mediaId: string, options: { chunks?: boolean } = {}): MediaDetailsQuery[] => {
  const q = (name: MediaDetailsQueryName, group: LibraryDbGroup, sql: string): MediaDetailsQuery => ({
    name,
    group,
    sql,
    params: [mediaId],
  });
  const queries = [
    q("item", "core", "SELECT * FROM media_items WHERE id = ? LIMIT 1;"),
    q(
      "catalogId",
      "core",
      `SELECT external_id FROM media_external_ids WHERE media_id = ? AND source IN (${CATALOG_ID_SOURCES_SQL}) LIMIT 1;`
    ),
    q("genres", "core", "SELECT genre_id FROM media_genres WHERE media_id = ?;"),
    q(
      "cast",
      "metadata",
      `SELECT media_roles.id, media_roles.person_id, media_roles.role, media_roles.order_index,
        people.name, people.profile_path,
        (SELECT external_id FROM people_external_ids WHERE person_id = media_roles.person_id AND source IN (${CATALOG_ID_SOURCES_SQL}) LIMIT 1) as external_id
      FROM media_roles
      JOIN people ON people.id = media_roles.person_id
      WHERE media_roles.media_id = ?
      ORDER BY media_roles.order_index ASC;`
    ),
    q(
      "crew",
      "metadata",
      `SELECT media_crew.id, media_crew.person_id, media_crew.job, people.name, people.profile_path,
        (SELECT external_id FROM people_external_ids WHERE person_id = media_crew.person_id AND source IN (${CATALOG_ID_SOURCES_SQL}) LIMIT 1) as external_id
      FROM media_crew
      JOIN people ON people.id = media_crew.person_id
      WHERE media_crew.media_id = ?
      ORDER BY media_crew.order_index ASC;`
    ),
    q(
      "seasons",
      "metadata",
      `SELECT id, season_number as seasonNumber, title as name, overview, poster_path as posterPath,
        episode_count as episodeCount, air_date as airDate
      FROM media_seasons WHERE media_id = ? ORDER BY season_number ASC;`
    ),
    q(
      "episodes",
      "metadata",
      `SELECT id, season_number as seasonNumber, episode_number as episodeNumber, title as name,
        overview, still_path as stillPath, air_date as airDate
      FROM media_episodes WHERE media_id = ? ORDER BY season_number ASC, episode_number ASC;`
    ),
    q("trailers", "metadata", "SELECT id, provider, key, name, language FROM media_trailers WHERE media_id = ?;"),
    q("files", "metadata", "SELECT id, filename, season, episode FROM media_files WHERE media_id = ?;"),
    // LIB-EDIT-01. Separate from `files` so a library from before editions (no such columns) still reads its files.
    q("fileEditions", "metadata", "SELECT id, edition_id, content_sha256 FROM media_files WHERE media_id = ?;"),
    // STOR-USE-02. Separate too, so a library from before the column still reads its files and editions.
    q("fileSizes", "metadata", "SELECT id, original_size_bytes FROM media_files WHERE media_id = ?;"),
    q(
      "editions",
      "metadata",
      `SELECT id, season, episode, name, name_user_set, duration_seconds, created_at FROM media_editions
      WHERE media_id = ? ORDER BY created_at ASC, id ASC;`
    ),
    q(
      "desiredFormats",
      "metadata",
      "SELECT file_id, quality, codec, bitrate_kbps FROM media_file_desired_formats WHERE media_id = ?;"
    ),
    q(
      "skipMarkers",
      "metadata",
      `SELECT id, episode_id, type, start_seconds, end_seconds, source, confidence, created_at, updated_at
      FROM media_skip_markers WHERE media_id = ? ORDER BY start_seconds ASC, type ASC;`
    ),
    q("formats", "playback", "SELECT * FROM media_formats WHERE media_id = ?;"),
    q("audioTracks", "playback", "SELECT * FROM media_audio_tracks WHERE media_id = ?;"),
    q(
      "subtitles",
      "playback",
      `SELECT id, media_id as mediaId, file_id as fileId, episode_id as episodeId, language, label,
        object_key as objectKey, format, is_default as isDefault, source, derived_from_subtitle_id as derivedFromSubtitleId,
        created_at as createdAt
      FROM media_subtitles WHERE media_id = ?;`
    ),
    q(
      "chapters",
      "playback",
      `SELECT id, format_id as formatId, title, start_seconds as startSeconds
      FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?)
      ORDER BY start_seconds ASC;`
    ),
  ];
  if (options.chunks === false) return queries;
  return [
    ...queries,
    q(
      "formatChunks",
      "playback",
      "SELECT * FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?) ORDER BY order_index ASC;"
    ),
    q(
      "audioChunks",
      "playback",
      "SELECT * FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?) ORDER BY order_index ASC;"
    ),
  ];
};

const strOrNull = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
const numOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));

type Chunk = { key: string; sizeBytes: number | null; startSeconds: number | null };

const groupChunks = (rows: Row[] | undefined, ownerColumn: string) => {
  const byOwner = new Map<string, Chunk[]>();
  for (const row of rows ?? []) {
    const owner = String(row[ownerColumn]);
    const list = byOwner.get(owner) ?? [];
    list.push({ key: String(row.chunk_key), sizeBytes: numOrNull(row.size_bytes), startSeconds: numOrNull(row.start_seconds) });
    byOwner.set(owner, list);
  }
  return byOwner;
};

/** The title's `MediaDetails` from the rows of `mediaDetailsQueries`; null when `media_items` has no such title. */
export const assembleMediaDetails = (mediaId: string, rows: MediaDetailsRows): MediaDetails | null => {
  const base = rows.item?.[0];
  if (!base) return null;
  const catalogId = Number(rows.catalogId?.[0]?.external_id);
  const cast: MediaCastMember[] = (rows.cast ?? []).map((row) => ({
    id: String(row.id),
    personId: String(row.person_id),
    catalogId: row.external_id ? Number(row.external_id) : null,
    name: String(row.name),
    role: row.role ? String(row.role) : null,
    profilePath: row.profile_path ? String(row.profile_path) : null,
  }));
  const desiredByFile = new Map<string, { quality: string; codec: string; bitrateKbps?: number | null }[]>();
  for (const row of rows.desiredFormats ?? []) {
    const list = desiredByFile.get(String(row.file_id)) ?? [];
    list.push({ quality: String(row.quality), codec: String(row.codec), bitrateKbps: numOrNull(row.bitrate_kbps) });
    desiredByFile.set(String(row.file_id), list);
  }
  const editionByFile = new Map<string, Row>();
  for (const row of rows.fileEditions ?? []) editionByFile.set(String(row.id), row);
  const sizeByFile = new Map<string, unknown>();
  for (const row of rows.fileSizes ?? []) sizeByFile.set(String(row.id), row.original_size_bytes);
  const files: MediaFile[] = (rows.files ?? []).map((row) => {
    const edition = editionByFile.get(String(row.id));
    return {
      id: String(row.id),
      filename: String(row.filename),
      season: numOrNull(row.season),
      episode: numOrNull(row.episode),
      desiredFormats: desiredByFile.get(String(row.id)) ?? [],
      // LIB-EDIT-01: absent on a library from before editions (the file is its unit's unnamed edition).
      ...(edition ? { editionId: strOrNull(edition.edition_id), contentSha256: strOrNull(edition.content_sha256) } : {}),
      ...(sizeByFile.has(String(row.id)) ? { originalSizeBytes: numOrNull(sizeByFile.get(String(row.id))) } : {}),
    };
  });
  const skipMarkers: MediaSkipMarker[] = (rows.skipMarkers ?? []).map((row) => ({
    id: String(row.id),
    mediaId,
    episodeId: strOrNull(row.episode_id),
    type: row.type === "credits" ? "credits" : "intro",
    startSeconds: Number(row.start_seconds),
    endSeconds: Number(row.end_seconds),
    source: String(row.source),
    confidence: numOrNull(row.confidence),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
  const formatChunks = groupChunks(rows.formatChunks, "format_id");
  const formats: MediaFormat[] = (rows.formats ?? []).map((row) => {
    // Seek-bar previews (MPV-PREV-01), on the source format only. Left out when absent or malformed, never `null`: a
    // `media.upsert` of this title then keeps the stored record (ops.ts `keepPreviews`) instead of erasing it.
    const previewSheets = parsePreviewSheets(strOrNull(row.preview_sheets));
    return {
      id: String(row.id),
      mediaId: String(row.media_id),
      fileId: String(row.file_id),
      quality: String(row.quality),
      codec: String(row.codec),
      codecString: strOrNull(row.codec_string),
      bitrateKbps: numOrNull(row.bitrate_kbps),
      sizeMb: Number(row.size_mb),
      initKey: strOrNull(row.init_key),
      initSize: numOrNull(row.init_size),
      durationSeconds: numOrNull(row.duration_seconds),
      totalSize: numOrNull(row.total_size),
      chunks: formatChunks.get(String(row.id)) ?? [],
      ...(previewSheets ? { previewSheets } : {}),
    };
  });
  const audioChunks = groupChunks(rows.audioChunks, "track_id");
  const audioTracks: AudioTrack[] = (rows.audioTracks ?? []).map((row) => ({
    id: String(row.id),
    mediaId: String(row.media_id),
    fileId: strOrNull(row.file_id),
    episodeId: strOrNull(row.episode_id),
    language: String(row.language),
    label: String(row.label),
    isDefault: Number(row.is_default) === 1,
    source: String(row.source),
    codec: strOrNull(row.codec),
    codecString: strOrNull(row.codec_string),
    initKey: strOrNull(row.init_key),
    initSize: numOrNull(row.init_size),
    durationSeconds: numOrNull(row.duration_seconds),
    totalSize: numOrNull(row.total_size),
    chunks: audioChunks.get(String(row.id)) ?? [],
  }));
  const subtitles = (rows.subtitles ?? []) as unknown as SubtitleTrack[];
  const episodes = (rows.episodes ?? []) as unknown as MediaEpisode[];
  const rating = base.rating;
  const progressPct = Number(base.progress_pct);
  const totalEpisodes = Number(base.total_episodes);
  return {
    id: String(base.id),
    type: base.type === "tv" ? "tv" : "movie",
    catalogId: Number.isFinite(catalogId) && catalogId > 0 ? catalogId : null,
    title: String(base.title),
    originalTitle: base.original_title ? String(base.original_title) : null,
    originalLanguage: base.original_language ? String(base.original_language) : null,
    overview: base.overview ? String(base.overview) : null,
    year: base.year ? String(base.year) : null,
    rating: typeof rating === "number" ? rating : rating ? Number(rating) : null,
    posterPath: base.poster_path ? String(base.poster_path) : null,
    backdropPath: base.backdrop_path ? String(base.backdrop_path) : null,
    genres: (rows.genres ?? []).map((row) => Number(row.genre_id)),
    addedAt: String(base.added_at),
    updatedAt: String(base.updated_at),
    hasFiles: Number(base.has_files) === 1,
    progressPct: Number.isFinite(progressPct) ? progressPct : 0,
    lastWatchedAt: base.last_watched_at ? String(base.last_watched_at) : null,
    totalEpisodes: Number.isFinite(totalEpisodes) ? totalEpisodes : null,
    episodeCount: episodes.length,
    cast,
    crew: (rows.crew ?? []).map((row) => ({
      id: String(row.id),
      personId: String(row.person_id),
      catalogId: row.external_id ? Number(row.external_id) : null,
      name: String(row.name),
      job: String(row.job),
      profilePath: row.profile_path ? String(row.profile_path) : null,
    })),
    seasons: (rows.seasons ?? []) as unknown as MediaSeason[],
    episodes,
    trailers: (rows.trailers ?? []) as unknown as MediaTrailer[],
    editions: (rows.editions ?? []).map((row) => ({
      id: String(row.id),
      season: numOrNull(row.season),
      episode: numOrNull(row.episode),
      name: String(row.name ?? ""),
      nameUserSet: Number(row.name_user_set) === 1,
      durationSeconds: numOrNull(row.duration_seconds),
      createdAt: String(row.created_at),
    })),
    files,
    formats,
    audioTracks,
    playlistIds: [],
    subtitleTracks: subtitles,
    subtitles,
    chapters: (rows.chapters ?? []) as unknown as MediaChapter[],
    skipMarkers,
    hasLocalFiles: files.length > 0,
  };
};

/** Async drivers (the phone): every query runs at once. `run` may time or route each one by its `name` / `group`. */
export const readMediaDetails = async (
  run: (query: MediaDetailsQuery) => Promise<Row[]>,
  mediaId: string,
  options: { chunks?: boolean } = {}
): Promise<MediaDetails | null> => {
  const queries = mediaDetailsQueries(mediaId, options);
  const results = await Promise.all(
    queries.map((query) => (OPTIONAL_QUERIES.has(query.name) ? run(query).catch(() => []) : run(query)))
  );
  const rows: MediaDetailsRows = {};
  queries.forEach((query, index) => {
    rows[query.name] = results[index];
  });
  return assembleMediaDetails(mediaId, rows);
};

/** LIB-CREW-01, LIB-EDIT-01: a database from before `media_crew` or editions has no such table or column. */
const rowsOrEmpty = (read: () => Row[]): Row[] => {
  try {
    return read();
  } catch {
    return [];
  }
};

/** Sync drivers (sql.js in the web player). */
export const readMediaDetailsSync = (
  run: (query: MediaDetailsQuery) => Row[],
  mediaId: string,
  options: { chunks?: boolean } = {}
): MediaDetails | null => {
  const rows: MediaDetailsRows = {};
  for (const query of mediaDetailsQueries(mediaId, options)) {
    rows[query.name] = OPTIONAL_QUERIES.has(query.name) ? rowsOrEmpty(() => run(query)) : run(query);
    // No title: the other reads would only come back empty.
    if (query.name === "item" && !rows.item?.length) return null;
  }
  return assembleMediaDetails(mediaId, rows);
};

/**
 * Every storage object a title owns (format init + segments + preview sheets, audio init + segments, subtitle
 * objects), deduplicated. With `file`, only what belongs to that file (one episode's file, plus the audio and
 * subtitles tied to `episodeId`).
 */
export const collectMediaStorageKeys = (
  details: Pick<MediaDetails, "formats" | "audioTracks" | "subtitleTracks">,
  file?: { fileId: string; episodeId: string | null }
): string[] => {
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (typeof value === "string" && value.length > 0) seen.add(value);
  };
  const owns = (track: { fileId?: string | null; episodeId?: string | null }) =>
    !file || track.fileId === file.fileId || (file.episodeId !== null && track.episodeId === file.episodeId);
  for (const format of details.formats ?? []) {
    if (file && format.fileId !== file.fileId) continue;
    add(format.initKey);
    for (const chunk of format.chunks ?? []) add(chunk.key);
    for (const key of previewSheetKeys(format.previewSheets)) add(key);
  }
  for (const track of details.audioTracks ?? []) {
    if (!owns(track)) continue;
    add(track.initKey);
    for (const chunk of track.chunks ?? []) add(chunk.key);
  }
  for (const subtitle of details.subtitleTracks ?? []) {
    if (owns(subtitle)) add(subtitle.objectKey);
  }
  return [...seen];
};

/**
 * The storage key an artwork field points at, or null when it is not a stored piece. The library holds a copied
 * image (META-ART-01) as `asset:<content type>::<key>` (older rows: the bare key); a catalog path (`/abc.jpg`), a URL
 * or an empty value is not in the user's storage.
 */
export const artworkStorageKey = (value: string | null | undefined): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  let key = value;
  if (value.startsWith("asset:")) {
    const split = value.indexOf("::");
    if (split < 0) return null;
    key = value.slice(split + 2);
  }
  if (key.length === 0 || key.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(key)) return null;
  return key;
};

/**
 * STOR-PLACE-08: every storage piece a title in the library uses, for the leftover clean-up (STOR-PLACE-06): what
 * `collectMediaStorageKeys` lists (video and audio pieces, seek-bar previews, subtitles) plus its artwork (poster,
 * backdrop, season posters, episode stills, cast and crew photos). Deduplicated. A delete keeps using
 * `collectMediaStorageKeys`: a person's photo is shared by every title they appear in.
 */
export const collectMediaKeysInUse = (
  details: Pick<MediaDetails, "formats" | "audioTracks" | "subtitleTracks" | "posterPath" | "backdropPath"> &
    Partial<Pick<MediaDetails, "cast" | "crew" | "seasons" | "episodes">>
): string[] => {
  const keys = new Set(collectMediaStorageKeys(details));
  const addArtwork = (value: string | null | undefined) => {
    const key = artworkStorageKey(value);
    if (key) keys.add(key);
  };
  addArtwork(details.posterPath);
  addArtwork(details.backdropPath);
  for (const member of details.cast ?? []) addArtwork(member.profilePath);
  for (const member of details.crew ?? []) addArtwork(member.profilePath);
  for (const season of details.seasons ?? []) addArtwork(season.posterPath);
  for (const episode of details.episodes ?? []) addArtwork(episode.stillPath);
  return [...keys];
};
