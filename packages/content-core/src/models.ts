import type { SpaceAppId } from "@space/shared/appScope";

export type ContentEncryptionMode = "aes_gcm_v1";
export type ContentChunkingMode = "chunked" | "packed_small_file";
export type ContentChunkingPreference = ContentChunkingMode | "auto";
export type ContentPreviewKind = "image_thumb" | "video_poster" | "audio_cover";
export type ContentPreviewSize = "small" | "large";

export type ContentObjectRef = {
  objectKey: string;
  sizeBytes: number;
  sha256: string;
};

export type ContentChunkRef = ContentObjectRef & {
  index: number;
  logicalOffset: number;
};

export type ContentManifestRef = {
  manifestId: string;
  encryptionMode: ContentEncryptionMode;
  chunkingMode: ContentChunkingMode;
  totalPlaintextBytes: number;
  totalEncryptedBytes: number;
};

export type LocalContentSource = {
  sourceId: string;
  localPath: string;
  sizeBytes: number;
  mimeType: string | null;
  modifiedAt: string | null;
};

export type ContentPreviewRef = {
  kind: ContentPreviewKind;
  size: ContentPreviewSize;
  objectKey: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
};

export type ContentIngestPlan = {
  source: LocalContentSource;
  objectNamespace: string;
  ownerApp: SpaceAppId;
  derivePreviews: boolean;
  preferredChunkingMode?: ContentChunkingPreference;
};

export type ContentIngestResult = {
  contentId: string;
  manifest: ContentManifestRef;
  objects: ContentObjectRef[];
  previewRefs: ContentPreviewRef[];
};

export type ContentReadRequest = {
  contentId: string;
  offset: number;
  length: number;
};

export type ContentReadResult = {
  data: Uint8Array;
  bytesRead: number;
  eof: boolean;
};

export type ContentStreamTicket = {
  streamId: string;
  contentId: string;
  totalBytes: number;
};

export type ContentPreviewRequest = {
  contentId: string;
  kind: ContentPreviewKind;
  size: ContentPreviewSize;
};

export type ContentPreviewResult = {
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
};
