import type {
  AudioTrack,
  IngestJob,
  IngestJobEvent,
  MediaChapter,
  MediaDetails,
  MediaFormat,
  SubtitleTrack,
} from "./libraryTypes";

export type LibraryOpBase = {
  id: string;
  type: string;
  createdAt: string;
};

export type PlaylistCreateOp = LibraryOpBase & {
  type: "playlist.create";
  payload: {
    id: string;
    name: string;
    slug: string | null;
    isSystem: boolean;
    createdAt: string;
  };
};

export type PlaylistDeleteOp = LibraryOpBase & {
  type: "playlist.delete";
  payload: {
    id: string;
  };
};

export type PlaylistItemAddOp = LibraryOpBase & {
  type: "playlist.item.add";
  payload: {
    id: string;
    playlistId: string;
    mediaId: string;
    addedAt: string;
  };
};

export type PlaylistItemRemoveOp = LibraryOpBase & {
  type: "playlist.item.remove";
  payload: {
    playlistId: string;
    mediaId: string;
  };
};

export type MediaUpsertOp = LibraryOpBase & {
  type: "media.upsert";
  payload: {
    details: MediaDetails;
  };
};

export type MediaDeleteOp = LibraryOpBase & {
  type: "media.delete";
  payload: {
    mediaId: string;
  };
};

export type MediaProgressOp = LibraryOpBase & {
  type: "media.progress";
  payload: {
    mediaId: string;
    progressPct: number;
    lastWatchedAt: string | null;
    updatedAt: string;
  };
};

export type SettingSetOp = LibraryOpBase & {
  type: "setting.set";
  payload: {
    key: string;
    value: string;
    updatedAt: string;
  };
};

export type IngestJobUpsertOp = LibraryOpBase & {
  type: "ingest.job.upsert";
  payload: {
    job: IngestJob;
  };
};

export type IngestJobDeleteOp = LibraryOpBase & {
  type: "ingest.job.delete";
  payload: {
    jobId: string;
  };
};

export type IngestJobEventAddOp = LibraryOpBase & {
  type: "ingest.job.event.add";
  payload: {
    event: IngestJobEvent;
  };
};

export type IngestJobHistoryClearOp = LibraryOpBase & {
  type: "ingest.job.history.clear";
  payload: {
    mediaId: string;
  };
};

export type LibraryOp =
  | PlaylistCreateOp
  | PlaylistDeleteOp
  | PlaylistItemAddOp
  | PlaylistItemRemoveOp
  | MediaUpsertOp
  | MediaDeleteOp
  | MediaProgressOp
  | SettingSetOp
  | IngestJobUpsertOp
  | IngestJobDeleteOp
  | IngestJobEventAddOp
  | IngestJobHistoryClearOp;

// --- Op stream 4 (LIB-FMT-11) ---------------------------------------------------------------------------------------
// Codec and byte layout: `@space/library-db-definition/chunkLists` and `test-vectors/chunk-lists.json`.

/** One format's or audio track's packed chunk list inside an op-stream-4 op; byte fields are standard padded base64. */
export type PackedChunkListJson = {
  placementId: string;
  /** 0 = key texts joined by `\n`, 1 = 16 raw UUID bytes per chunk, 2 = 16-byte seed. */
  keyMode: 0 | 1 | 2;
  keyData: string;
  count: number;
  sizes: string;
  starts: string | null;
};

/** A format in op stream 4: no `chunks`, one packed `chunkList`. */
export type PlaybackFormatV4 = Omit<MediaFormat, "chunks"> & { chunkList: PackedChunkListJson };

/** An audio track in op stream 4: no `chunks`, one packed `chunkList`. */
export type PlaybackAudioTrackV4 = Omit<AudioTrack, "chunks"> & { chunkList: PackedChunkListJson };

/**
 * A title's details in op stream 4: core and metadata only. The playback keys (`formats`, `audioTracks`, `subtitles`,
 * `subtitleTracks`, `chapters`) are absent; a `media.upsert` carrying any of them is the old (v3) shape.
 */
export type MediaDetailsV4 = Omit<MediaDetails, "formats" | "audioTracks" | "subtitles" | "subtitleTracks" | "chapters">;

export type MediaUpsertV4Op = LibraryOpBase & {
  type: "media.upsert";
  payload: {
    details: MediaDetailsV4;
  };
};

/**
 * One file's whole playback; replaces that file's previous playback rows (formats with their chunk lists and
 * chapters, audio tracks with their chunk lists, subtitles). `fileId: null` is the title's rows that name no file
 * (`file_id IS NULL`: tracks scoped to the title or only to an episode). `updatedAt` is this file's playback clock
 * (LIB-SYNC-08): an older set never replaces a newer one. Every row's `fileId` (and every chapter's format) belongs
 * to this file.
 */
export type MediaFilePlaybackSetOp = LibraryOpBase & {
  type: "media.file.playback.set";
  payload: {
    mediaId: string;
    fileId: string | null;
    updatedAt: string;
    formats: PlaybackFormatV4[];
    audioTracks: PlaybackAudioTrackV4[];
    subtitles: SubtitleTrack[];
    chapters: MediaChapter[];
  };
};

/** Removes one file's playback rows (as `media.file.playback.set` with nothing in it, without a clock). */
export type MediaFilePlaybackDeleteOp = LibraryOpBase & {
  type: "media.file.playback.delete";
  payload: {
    mediaId: string;
    fileId: string | null;
  };
};

/**
 * Removes one episode of a show and only its rows: the episode, its files (with their editions' episode slot,
 * desired formats, playback and offline copies), its skip markers and its episode-scoped tracks. `fileIds` are named
 * by the writer because each group is its own SQLite file and a playback statement cannot read `media_files`.
 */
export type MediaEpisodeDeleteOp = LibraryOpBase & {
  type: "media.episode.delete";
  payload: {
    mediaId: string;
    episodeId: string | null;
    seasonNumber: number;
    episodeNumber: number;
    fileIds: string[];
  };
};

/** The ops op stream 4 adds (LIB-FMT-11). Joins `LibraryOp` with their builders (vault v4 plan §1.1). */
export type LibraryOpV4Addition = MediaFilePlaybackSetOp | MediaFilePlaybackDeleteOp | MediaEpisodeDeleteOp;
