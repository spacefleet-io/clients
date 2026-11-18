import type { QualityPreset } from "@/lib/config";
import { QUALITY_ORDER } from "@/lib/config";

export type ChunkMap = {
  init: { key: string; size: number } | null;
  durationSeconds: number | null;
  totalSize: number | null;
  chunks: Array<{ key: string; size: number; startSeconds: number | null }>;
};

export type HlsSegment = {
  key: string;
  durationSeconds: number;
  startSeconds: number | null;
};

export type HlsTrack = {
  initKey: string;
  codecString: string | null;
  segments: HlsSegment[];
};

type PlaybackFormatLike = {
  initKey: string | null;
  initSize: number | null;
  chunks: Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>;
  durationSeconds: number | null;
  totalSize: number | null;
};

export const orderPlaybackFormats = (a: string, b: string) =>
  QUALITY_ORDER.indexOf(a as QualityPreset) - QUALITY_ORDER.indexOf(b as QualityPreset);

export const buildChunkMapFromFormat = (format: PlaybackFormatLike): ChunkMap | null => {
  if (!format.initKey || !format.chunks?.length) return null;
  return {
    init: { key: format.initKey, size: format.initSize ?? 0 },
    durationSeconds: format.durationSeconds ?? null,
    totalSize: format.totalSize ?? null,
    chunks: format.chunks.map((chunk) => ({
      key: chunk.key,
      size: chunk.sizeBytes ?? 0,
      startSeconds: chunk.startSeconds ?? null,
    })),
  };
};

export const buildHlsTrackFromChunkMap = (map: ChunkMap, codecString: string | null): HlsTrack => {
  if (!map.init?.key) {
    throw new Error("playback_hls_init_missing");
  }
  const fallbackDuration =
    map.durationSeconds && map.chunks.length > 0
      ? map.durationSeconds / map.chunks.length
      : 0;
  const segments = map.chunks.map((chunk, index) => {
    const nextStart = map.chunks[index + 1]?.startSeconds ?? null;
    const start = chunk.startSeconds ?? null;
    const duration =
      start !== null && nextStart !== null
        ? Math.max(0.001, nextStart - start)
        : start !== null && map.durationSeconds
          ? Math.max(0.001, map.durationSeconds - start)
          : Math.max(0.001, fallbackDuration);
    return { key: chunk.key, durationSeconds: duration, startSeconds: start };
  });
  return { initKey: map.init.key, codecString, segments };
};
