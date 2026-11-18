import type { ContentChunkingMode, ContentEncryptionMode, ContentManifestRef } from "./models";

export type BuildContentManifestRefArgs = {
  manifestId: string;
  chunkingMode: ContentChunkingMode;
  totalPlaintextBytes: number;
  totalEncryptedBytes: number;
  encryptionMode?: ContentEncryptionMode;
};

export const buildContentManifestRef = ({
  manifestId,
  chunkingMode,
  totalPlaintextBytes,
  totalEncryptedBytes,
  encryptionMode = "aes_gcm_v1",
}: BuildContentManifestRefArgs): ContentManifestRef => ({
  manifestId,
  encryptionMode,
  chunkingMode,
  totalPlaintextBytes,
  totalEncryptedBytes,
});
