import { listStorageObjects } from "@/api";

export type DummyChunk = {
  key: string;
  size: number;
  startSeconds: number;
};

export type DummyChunkMap = {
  initKey: string;
  initSize: number;
  durationSeconds: number;
  totalSize: number;
  chunks: DummyChunk[];
};

export type DummyVideo = {
  quality: string;
  codec: "h264" | "hevc";
  codecString?: string | null;
  width: number;
  height: number;
  bitrateKbps: number | null;
  sizeMb: number;
  chunkMap: DummyChunkMap;
  chapters: Array<{ title: string; startSeconds: number }>;
};

export type DummyAudio = {
  language: string;
  label: string;
  codec: string;
  codecString?: string | null;
  bitrateKbps: number | null;
  isDefault?: boolean;
  chunkMap: DummyChunkMap;
};

export type DummySubtitle = {
  language: string;
  label: string;
  format: "srt" | "sup";
  objectKey: string;
  isDefault?: boolean;
};

export type DummyManifest = {
  version: string;
  createdAt: string;
  videos: DummyVideo[];
  audio: DummyAudio[];
  subtitles: DummySubtitle[];
};

type DummyBridge = {
  getDummyManifest?: () => Promise<unknown>;
};

const getBridge = (): DummyBridge | null => {
  if (typeof window === "undefined") return null;
  return (window as typeof window & { sf?: DummyBridge }).sf ?? null;
};

export const loadDummyManifest = async (): Promise<DummyManifest> => {
  const bridge = getBridge();
  if (!bridge?.getDummyManifest) {
    throw new Error("DUMMY_MANIFEST_MISSING");
  }
  const manifest = (await bridge.getDummyManifest()) as DummyManifest & {
    audios?: DummyAudio[];
    videos?: Array<{ map?: DummyChunkMap; chunkMap?: DummyChunkMap } & DummyVideo>;
  };
  if (!manifest.audio && manifest.audios) {
    manifest.audio = manifest.audios;
  }
  const normalizeChunkMap = (map?: DummyChunkMap) => {
    if (!map) return map;
    map.chunks = map.chunks.map((chunk: DummyChunk & { sizeBytes?: number }) => ({
      key: chunk.key,
      size: chunk.size ?? chunk.sizeBytes ?? 0,
      startSeconds: chunk.startSeconds,
    }));
    return map;
  };
  manifest.videos = (manifest.videos ?? []).map((video) => ({
    ...video,
    chunkMap: normalizeChunkMap(video.chunkMap ?? (video as { map?: DummyChunkMap }).map) ?? video.chunkMap,
  }));
  manifest.audio = (manifest.audio ?? []).map((track) => ({
    ...track,
    chunkMap: normalizeChunkMap(track.chunkMap) ?? track.chunkMap,
  }));
  return manifest as DummyManifest;
};

const collectDummyKeys = (manifest: DummyManifest | (DummyManifest & { audios?: DummyAudio[] })) => {
  const keys = new Set<string>();
  const audioTracks = manifest.audio ?? (manifest as { audios?: DummyAudio[] }).audios ?? [];
  manifest.videos.forEach((video) => {
    keys.add(video.chunkMap.initKey);
    video.chunkMap.chunks.forEach((chunk) => keys.add(chunk.key));
  });
  audioTracks.forEach((track) => {
    keys.add(track.chunkMap.initKey);
    track.chunkMap.chunks.forEach((chunk) => keys.add(chunk.key));
  });
  manifest.subtitles.forEach((track) => {
    keys.add(track.objectKey);
  });
  return Array.from(keys);
};

export const ensureDummyObjectsAvailable = async (token: string, manifest: DummyManifest) => {
  const keys = collectDummyKeys(manifest);
  const { keys: storedKeys } = await listStorageObjects(token);
  const existing = new Set(storedKeys);
  const missing = keys.filter((key) => !existing.has(key));
  if (missing.length > 0) {
    throw new Error("DUMMY_BUCKET_MISSING");
  }
};
