import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** How an album was released; drives grouping in the library (PAR-LIB-01). */
export const ALBUM_KINDS = ["studio", "compilation", "live", "remix", "interview", "bootleg", "other"] as const;
export type AlbumKind = (typeof ALBUM_KINDS)[number];

/** Plaintext size of one audio chunk object: an original file is cut into 1 MiB pieces. */
export const TRACK_FILE_CHUNK_SIZE_BYTES = 1024 * 1024;

export const artists = sqliteTable("artists", {
  id: text("id").primaryKey(),
  /** The artist's id in the metadata, opaque. */
  musicId: text("music_id"),
  name: text("name").notNull(),
  sortName: text("sort_name").notNull(),
  /** The artist's photo copied into the vault (PAR-META-15, PAR-COPY-01), large and small copies as an album's cover. */
  pictureObjectKey: text("picture_object_key"),
  pictureThumbObjectKey: text("picture_thumb_object_key"),
  /** Who took a Commons photo and under which licence; all null for a photo needing no credit. */
  pictureAuthor: text("picture_author"),
  pictureLicence: text("picture_licence"),
  pictureLicenceUrl: text("picture_licence_url"),
  /** When the photo was last asked for (ms), so an artist with none is not asked again at every launch. */
  pictureTriedAt: integer("picture_tried_at"),
});

export const albums = sqliteTable(
  "albums",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    albumArtistId: text("album_artist_id").notNull(),
    year: integer("year"),
    kind: text("kind", { enum: ALBUM_KINDS }).notNull().default("studio"),
    /** The album's id in the metadata (across its editions) and the edition the songs came from, both opaque. */
    musicId: text("music_id"),
    musicEditionId: text("music_edition_id"),
    coverObjectKey: text("cover_object_key"),
    createdAt: integer("created_at").notNull(),
    coverThumbObjectKey: text("cover_thumb_object_key"),
    genre: text("genre"),
    /** 1 once the user set or emptied the year in the edit dialog: imports leave it alone (PAR-META-17). */
    yearEdited: integer("year_edited", { mode: "boolean" }).notNull().default(false),
    genreEdited: integer("genre_edited", { mode: "boolean" }).notNull().default(false),
    /** 1 once the user edited the album by hand: a new music copy no longer refreshes it (PAR-COPY-01). */
    edited: integer("edited", { mode: "boolean" }).notNull().default(false),
    /** The album's full tracklist from the metadata as JSON `ParrotListedTrack[]`; null when unknown (PAR-LIB-05). */
    tracklist: text("tracklist"),
  },
  (table) => [index("albums_album_artist_id_idx").on(table.albumArtistId)]
);

export const tracks = sqliteTable(
  "tracks",
  {
    id: text("id").primaryKey(),
    albumId: text("album_id").notNull(),
    disc: integer("disc").notNull().default(1),
    number: integer("number"),
    title: text("title").notNull(),
    artistId: text("artist_id").notNull(),
    durationMs: integer("duration_ms"),
    /** The song's id in the metadata, opaque. */
    musicId: text("music_id"),
    /** The song's own release year; the album's year applies when null. */
    year: integer("year"),
    genre: text("genre"),
    /** 1 once the user set or emptied the song's year in the edit dialog: imports leave it alone (PAR-META-17). */
    yearEdited: integer("year_edited", { mode: "boolean" }).notNull().default(false),
    genreEdited: integer("genre_edited", { mode: "boolean" }).notNull().default(false),
    /** Even volume (PAR-PLAY-03): the song's ReplayGain 2.0 gain to −18 LUFS in dB and its sample peak (linear), measured once. */
    gainDb: real("gain_db"),
    peak: real("peak"),
    /** The file's own ReplayGain album tag, when it has one. */
    albumGainDb: real("album_gain_db"),
    albumPeak: real("album_peak"),
    /** 1 when the user kept the song as is at import, matched to nothing, so it can be identified later (PAR-UP-05). */
    unidentified: integer("unidentified", { mode: "boolean" }),
  },
  (table) => [
    index("tracks_album_id_idx").on(table.albumId),
    index("tracks_artist_id_idx").on(table.artistId),
  ]
);

export const trackFiles = sqliteTable(
  "track_files",
  {
    id: text("id").primaryKey(),
    trackId: text("track_id").notNull(),
    codec: text("codec").notNull(),
    container: text("container").notNull(),
    mime: text("mime").notNull(),
    lossless: integer("lossless", { mode: "boolean" }).notNull(),
    bitrateKbps: integer("bitrate_kbps"),
    sampleRate: integer("sample_rate"),
    sizeBytes: integer("size_bytes").notNull(),
    lightCopy: integer("light_copy", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    headerBytes: integer("header_bytes"),
    sourceSizeBytes: integer("source_size_bytes"),
    tagsObjectKey: text("tags_object_key"),
  },
  (table) => [index("track_files_track_id_idx").on(table.trackId)]
);

export const trackFileChunks = sqliteTable(
  "track_file_chunks",
  {
    trackFileId: text("track_file_id").notNull(),
    idx: integer("idx").notNull(),
    objectKey: text("object_key").notNull(),
    plainOffset: integer("plain_offset").notNull(),
    plainSize: integer("plain_size").notNull(),
  },
  (table) => [primaryKey({ columns: [table.trackFileId, table.idx] })]
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** The user's own playlists (PAR-PL-01). */
export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** A playlist's songs in order; a song may appear more than once, so the position is the key. */
export const playlistTracks = sqliteTable(
  "playlist_tracks",
  {
    playlistId: text("playlist_id").notNull(),
    position: integer("position").notNull(),
    trackId: text("track_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.playlistId, table.position] }), index("playlist_tracks_track_id_idx").on(table.trackId)]
);

/** A song's lyrics copied into the vault (PAR-COPY-01): from a lookup, never re-read from the file's tags. */
export const lyrics = sqliteTable("lyrics", {
  trackId: text("track_id").primaryKey(),
  plain: text("plain"),
  synced: text("synced"),
  source: text("source"),
  fetchedAt: integer("fetched_at"),
});

export const parrotTables = { artists, albums, tracks, trackFiles, trackFileChunks, settings, playlists, playlistTracks, lyrics } as const;
