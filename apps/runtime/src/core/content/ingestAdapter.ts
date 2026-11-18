import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  buildContentManifestRef,
  encryptContentObject,
  planContentIngest,
  uploadEncryptedContentBytes,
  type ContentIngestPlan,
  type ContentIngestResult,
  type ContentPreviewRef,
} from "@space/content-core";
import type { StorageObjectCounting } from "@space/shared/storageCounting";

export type RuntimeContentUploadResult = {
  objectKey: string;
  sizeBytes: number;
};

export type RuntimeContentIngestArgs = {
  plan: ContentIngestPlan;
  contentKeyBase64: string;
  uploadObject: (args: {
    objectKey: string;
    payload: Uint8Array;
    objectNamespace: string;
    logicalRef: string;
    contentType: string;
    /** How the object counts toward the allowance (STOR-USE-02). */
    counting?: StorageObjectCounting;
  }) => Promise<RuntimeContentUploadResult>;
  derivePreviews?: (args: {
    plaintext: Buffer;
    source: ContentIngestPlan["source"];
    contentKeyBase64: string;
    uploadObject: RuntimeContentIngestArgs["uploadObject"];
    objectNamespace: string;
  }) => Promise<ContentPreviewRef[]>;
  contentIdFactory?: () => string;
  objectKeyFactory?: () => string;
};

const checksumBytes = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");

export const ingestLocalFileToContent = async (args: RuntimeContentIngestArgs): Promise<ContentIngestResult> => {
  const ingestPlan = planContentIngest(args.plan);
  const plaintext = await readFile(args.plan.source.localPath);
  const contentId = args.contentIdFactory?.() ?? crypto.randomUUID();
  const uploaded = await uploadEncryptedContentBytes(
    {
      encryptObject: (bytes) => encryptContentObject(bytes, args.contentKeyBase64),
      uploadObject: async (_token, objectKey, payload, options) => {
        const uploaded = await args.uploadObject({
          objectKey: args.objectKeyFactory?.() ?? objectKey,
          payload,
          objectNamespace: options?.objectNamespace ?? args.plan.objectNamespace,
          logicalRef: options?.logicalRef ?? args.plan.source.localPath,
          contentType: options?.contentType ?? "application/octet-stream",
          counting: options?.counting,
        });
        return uploaded.objectKey;
      },
    },
    "runtime-content",
    {
      plaintext,
      logicalRef: args.plan.source.localPath,
      objectNamespace: args.plan.objectNamespace,
      contentType: "application/octet-stream",
      // STOR-USE-02: the file is stored as one object, counted at the size the user's computer showed.
      counting: { role: "source", declaredBytes: plaintext.byteLength },
    }
  );
  let previewRefs: ContentPreviewRef[] = [];
  if (ingestPlan.derivePreviews && args.derivePreviews) {
    try {
      previewRefs = await args.derivePreviews({
        plaintext,
        source: args.plan.source,
        contentKeyBase64: args.contentKeyBase64,
        uploadObject: args.uploadObject,
        objectNamespace: args.plan.objectNamespace,
      });
    } catch {
      // Preview derivation is best-effort; a failure must not block the ingest.
    }
  }

  return {
    contentId,
    manifest: buildContentManifestRef({
      manifestId: contentId,
      chunkingMode: ingestPlan.chunkingMode,
      totalPlaintextBytes: plaintext.byteLength,
      totalEncryptedBytes: uploaded.sizeBytes,
    }),
        objects: [
          {
            objectKey: uploaded.key,
            sizeBytes: uploaded.sizeBytes,
            sha256: uploaded.checksum,
          },
        ],
        previewRefs,
  };
};
