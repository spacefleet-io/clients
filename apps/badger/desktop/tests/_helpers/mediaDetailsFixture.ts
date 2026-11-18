import type {
  AudioTrack,
  MediaDetails,
  MediaEpisode,
  MediaFile,
  MediaFormat,
  MediaSkipMarker,
  MediaType,
  SubtitleTrack,
} from "../../src/shared/libraryTypes";

/**
 * Builds a complete `MediaDetails` from the handful of fields the processing
 * helpers actually read. Every field the tests do not care about gets a neutral
 * default, so fixtures stay fully typed (no casts) when `MediaDetails` grows.
 */

export type FixtureFile = Pick<MediaFile, "id" | "season" | "episode">;

export type FixtureFormat = Pick<MediaFormat, "id" | "fileId" | "quality" | "initKey"> & {
  chunks: string[];
  durationSeconds?: number;
};

export type FixtureEpisode = Pick<MediaEpisode, "id" | "seasonNumber" | "episodeNumber">;

export type FixtureAudioTrack = Pick<AudioTrack, "id" | "episodeId" | "language" | "label" | "initKey"> & {
  chunks: string[];
};

export type FixtureSubtitleTrack = Pick<SubtitleTrack, "id" | "episodeId" | "language" | "label">;

export type MediaDetailsFixtureInput = {
  id: string;
  type: MediaType;
  title: string;
  files: FixtureFile[];
  formats: FixtureFormat[];
  episodes: FixtureEpisode[];
  audioTracks: FixtureAudioTrack[];
  subtitleTracks: FixtureSubtitleTrack[];
  skipMarkers?: MediaSkipMarker[];
};

const toChunks = (keys: string[]): MediaFormat["chunks"] =>
  keys.map((key) => ({ key, sizeBytes: null, startSeconds: null }));

export const buildMediaDetailsFixture = (input: MediaDetailsFixtureInput): MediaDetails => ({
  id: input.id,
  type: input.type,
  tmdbId: null,
  externalIds: null,
  title: input.title,
  originalTitle: null,
  originalLanguage: null,
  overview: null,
  year: null,
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  hasFiles: input.files.length > 0,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: null,
  episodeCount: input.episodes.length,
  cast: [],
  playlistIds: [],
  seasons: [],
  episodes: input.episodes.map((episode) => ({
    ...episode,
    name: `Episode ${episode.episodeNumber}`,
    overview: null,
    stillPath: null,
    airDate: null,
  })),
  trailers: [],
  files: input.files.map((file) => ({
    ...file,
    filename: `${file.id}.mkv`,
    desiredFormats: [],
  })),
  formats: input.formats.map((format) => ({
    id: format.id,
    mediaId: input.id,
    fileId: format.fileId,
    quality: format.quality,
    codec: "h264",
    bitrateKbps: null,
    sizeMb: 0,
    initKey: format.initKey,
    initSize: null,
    durationSeconds: format.durationSeconds ?? null,
    totalSize: null,
    chunks: toChunks(format.chunks),
  })),
  audioTracks: input.audioTracks.map((track) => ({
    id: track.id,
    mediaId: input.id,
    fileId: null,
    episodeId: track.episodeId,
    language: track.language,
    label: track.label,
    isDefault: false,
    source: "fixture",
    codec: null,
    initKey: track.initKey,
    initSize: null,
    durationSeconds: null,
    totalSize: null,
    chunks: toChunks(track.chunks),
  })),
  subtitleTracks: input.subtitleTracks.map((track) => ({
    id: track.id,
    mediaId: input.id,
    fileId: null,
    episodeId: track.episodeId,
    language: track.language,
    label: track.label,
    objectKey: null,
    format: null,
    isDefault: false,
    source: "fixture",
    createdAt: "2026-01-01T00:00:00Z",
  })),
  subtitles: [],
  chapters: [],
  skipMarkers: input.skipMarkers ?? [],
  hasLocalFiles: input.files.length > 0,
});
