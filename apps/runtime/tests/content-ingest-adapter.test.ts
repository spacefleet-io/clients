import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ingestLocalFileToContent } from "../src/core/content/ingestAdapter";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps tmp paths + ingest result + upload mock calls
// on assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpIngestAdapterSnapshot = (
  label: string,
  ctx: {
    root?: string;
    localPath?: string;
    result?: unknown;
    uploadCalls?: unknown[][];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [ingest-adapter:${label}] snapshot ===`);
    if (ctx.root) console.error(`root=${ctx.root}`);
    if (ctx.localPath) console.error(`localPath=${ctx.localPath}`);
    if (ctx.result !== undefined) {
      console.error(`result=\n${JSON.stringify(ctx.result, null, 2)}`);
    }
    if (ctx.uploadCalls) {
      console.error(`uploadCalls(${ctx.uploadCalls.length})=\n${JSON.stringify(ctx.uploadCalls, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime content ingest adapter", () => {
  it("@bugfix @regression-proof ingests a real local file into a shared content result via runtime-owned byte reads", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "spacefleet-content-core-"));
    console.info(`[ingest-adapter:real-file-encrypted] root=${root}`);
    try {
      const localPath = joinPath(root, "clip.mp4");
      writeFileSync(localPath, Buffer.from("real-file-bytes"));
      const uploadObject = vi.fn(async ({ objectKey, payload }: { objectKey: string; payload: Uint8Array }) => ({
        objectKey: `shards/dev/${objectKey}`,
        sizeBytes: payload.byteLength,
      }));

      const result = await ingestLocalFileToContent({
        plan: {
          source: {
            sourceId: "src-1",
            localPath,
            sizeBytes: Buffer.byteLength("real-file-bytes"),
            mimeType: "video/mp4",
            modifiedAt: null,
          },
          objectNamespace: "library",
          ownerApp: "parrot",
          derivePreviews: false,
          preferredChunkingMode: "packed_small_file",
        },
        contentKeyBase64: Buffer.alloc(32, 9).toString("base64"),
        uploadObject,
        contentIdFactory: () => "content-1",
        objectKeyFactory: () => "object-1",
      });
      console.info(`[ingest-adapter:real-file-encrypted] contentId=${result.contentId} objects.length=${result.objects.length} uploadCalls=${uploadObject.mock.calls.length}`);

      try {
        expect(uploadObject).toHaveBeenCalledTimes(1);
        const uploadedPayload = uploadObject.mock.calls[0]?.[0]?.payload as Uint8Array;
        expect(Buffer.from(uploadedPayload)).not.toEqual(Buffer.from("real-file-bytes"));
        expect(result).toMatchObject({
          contentId: "content-1",
          manifest: {
            manifestId: "content-1",
            chunkingMode: "packed_small_file",
            totalPlaintextBytes: Buffer.byteLength("real-file-bytes"),
          },
          objects: [
            {
              objectKey: "shards/dev/object-1",
            },
          ],
          previewRefs: [],
        });
        expect(result.objects[0]?.sizeBytes).toBeGreaterThan(Buffer.byteLength("real-file-bytes"));
      } catch (err) {
        dumpIngestAdapterSnapshot("real-file-encrypted-failure", {
          root,
          localPath,
          result,
          uploadCalls: uploadObject.mock.calls.map((c) => c as unknown[]),
        });
        throw err;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes shared preview refs when preview derivation is provided", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "spacefleet-content-core-preview-"));
    console.info(`[ingest-adapter:preview-refs-included] root=${root}`);
    try {
      const localPath = joinPath(root, "photo.jpg");
      writeFileSync(localPath, Buffer.from("image-bytes"));
      const uploadObject = vi.fn(async ({ objectKey, payload }: { objectKey: string; payload: Uint8Array }) => ({
        objectKey: `shards/dev/${objectKey}`,
        sizeBytes: payload.byteLength,
      }));

      const result = await ingestLocalFileToContent({
        plan: {
          source: {
            sourceId: "src-preview",
            localPath,
            sizeBytes: Buffer.byteLength("image-bytes"),
            mimeType: "image/jpeg",
            modifiedAt: null,
          },
          objectNamespace: "parrot",
          ownerApp: "parrot",
          derivePreviews: true,
          preferredChunkingMode: "packed_small_file",
        },
        contentKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        uploadObject,
        derivePreviews: async () => [
          {
            kind: "image_thumb",
            size: "small",
            objectKey: "shards/dev/preview-small",
            mimeType: "image/jpeg",
            sizeBytes: 24,
          },
        ],
      });
      console.info(`[ingest-adapter:preview-refs-included] previewRefs.length=${result.previewRefs.length}`);

      try {
        expect(result.previewRefs).toEqual([
          {
            kind: "image_thumb",
            size: "small",
            objectKey: "shards/dev/preview-small",
            mimeType: "image/jpeg",
            sizeBytes: 24,
          },
        ]);
      } catch (err) {
        dumpIngestAdapterSnapshot("preview-refs-included-failure", {
          root,
          localPath,
          result,
          uploadCalls: uploadObject.mock.calls.map((c) => c as unknown[]),
        });
        throw err;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("@bugfix @regression-proof completes the ingest even when preview derivation throws", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "spacefleet-content-core-preview-fail-"));
    console.info(`[ingest-adapter:preview-throws-tolerated] root=${root}; derivePreviews will throw`);
    try {
      const localPath = joinPath(root, "photo.png");
      writeFileSync(localPath, Buffer.from("png-bytes"));
      const uploadObject = vi.fn(async ({ objectKey, payload }: { objectKey: string; payload: Uint8Array }) => ({
        objectKey: `shards/dev/${objectKey}`,
        sizeBytes: payload.byteLength,
      }));

      const result = await ingestLocalFileToContent({
        plan: {
          source: {
            sourceId: "src-preview-fail",
            localPath,
            sizeBytes: Buffer.byteLength("png-bytes"),
            mimeType: "image/png",
            modifiedAt: null,
          },
          objectNamespace: "parrot",
          ownerApp: "parrot",
          derivePreviews: true,
          preferredChunkingMode: "packed_small_file",
        },
        contentKeyBase64: Buffer.alloc(32, 3).toString("base64"),
        uploadObject,
        derivePreviews: async () => {
          throw new Error("decoder not found");
        },
        contentIdFactory: () => "content-fail-preview",
        objectKeyFactory: () => "object-fail-preview",
      });
      console.info(`[ingest-adapter:preview-throws-tolerated] contentId=${result.contentId} previewRefs.length=${result.previewRefs.length} uploadCalls=${uploadObject.mock.calls.length}`);

      try {
        expect(result.contentId).toBe("content-fail-preview");
        expect(result.previewRefs).toEqual([]);
        expect(uploadObject).toHaveBeenCalledTimes(1);
      } catch (err) {
        dumpIngestAdapterSnapshot("preview-throws-tolerated-failure", {
          root,
          localPath,
          result,
          uploadCalls: uploadObject.mock.calls.map((c) => c as unknown[]),
        });
        throw err;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
