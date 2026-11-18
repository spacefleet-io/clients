import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACKED_SMALL_FILE_THRESHOLD_BYTES,
  buildContentManifestRef,
  planContentIngest,
  resolveChunkingMode,
  uploadEncryptedContentBytes,
  uploadEncryptedContentObject,
} from "../src";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// On assertion failure in an upload test, dump the computed upload descriptor so
// the size/checksum/key mismatch is diagnosable straight from CI logs.
const dumpUploadSnapshot = (label: string, uploaded: unknown): void => {
  try {
    console.error(`=== [content-core-index:${label}] snapshot ===`);
    console.error(`uploaded descriptor:\n${JSON.stringify(uploaded, null, 2)}`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("content-core", () => {
  it("prefers packed_small_file for small sources in auto mode", () => {
    expect(
      resolveChunkingMode({
        source: { sizeBytes: DEFAULT_PACKED_SMALL_FILE_THRESHOLD_BYTES },
      })
    ).toBe("packed_small_file");
  });

  it("prefers chunked for large sources in auto mode", () => {
    expect(
      resolveChunkingMode({
        source: { sizeBytes: DEFAULT_PACKED_SMALL_FILE_THRESHOLD_BYTES + 1 },
      })
    ).toBe("chunked");
  });

  it("honors explicit chunking preference", () => {
    expect(
      resolveChunkingMode({
        source: { sizeBytes: 1 },
        preferredMode: "chunked",
      })
    ).toBe("chunked");
    expect(
      resolveChunkingMode({
        source: { sizeBytes: Number.MAX_SAFE_INTEGER },
        preferredMode: "packed_small_file",
      })
    ).toBe("packed_small_file");
  });

  it("plans ingest using shared chunking policy", () => {
    console.info(
      "[content-core-index:plan-ingest] planning 12-byte parrot source (expect packed_small_file)",
    );
    const plan = planContentIngest({
      source: {
        sourceId: "src-1",
        localPath: "/tmp/video.mp4",
        sizeBytes: 12,
        mimeType: "video/mp4",
        modifiedAt: null,
      },
      objectNamespace: "parrot/user-1",
      ownerApp: "parrot",
      derivePreviews: true,
    });
    console.info(
      `[content-core-index:plan-ingest] result chunkingMode=${plan.chunkingMode} ownerApp=${plan.ownerApp} namespace=${plan.objectNamespace}`,
    );
    try {
      expect(plan).toMatchObject({
        sourceId: "src-1",
        ownerApp: "parrot",
        objectNamespace: "parrot/user-1",
        chunkingMode: "packed_small_file",
        derivePreviews: true,
      });
    } catch (err) {
      dumpUploadSnapshot("plan-ingest", plan);
      throw err;
    }
  });

  it("builds a manifest ref with shared defaults", () => {
    console.info(
      "[content-core-index:manifest-ref] building chunked manifest ref (100 plaintext / 140 encrypted bytes)",
    );
    const ref = buildContentManifestRef({
      manifestId: "manifest-1",
      chunkingMode: "chunked",
      totalPlaintextBytes: 100,
      totalEncryptedBytes: 140,
    });
    try {
      expect(ref).toEqual({
        manifestId: "manifest-1",
        encryptionMode: "aes_gcm_v1",
        chunkingMode: "chunked",
        totalPlaintextBytes: 100,
        totalEncryptedBytes: 140,
      });
    } catch (err) {
      dumpUploadSnapshot("manifest-ref", ref);
      throw err;
    }
  });

  it("@bugfix @regression-proof uploads encrypted content objects through one shared content-core primitive", async () => {
    const root = mkdtempSync(join(tmpdir(), "content-core-upload-"));
    const inputPath = join(root, "input.bin");
    console.info(
      `[content-core-index:upload-object] writing 'payload' to ${inputPath}`,
    );
    await fs.writeFile(inputPath, Buffer.from("payload"));

    try {
      const uploadObject = async (_token: string, objectKey: string, payload: Uint8Array) => {
        expect(Buffer.from(payload)).toEqual(Buffer.from("payload"));
        return `persisted-${objectKey}`;
      };

      const uploaded = await uploadEncryptedContentObject(
        {
          encryptObject: (bytes) => bytes,
          uploadObject,
        },
        "token",
        inputPath
      );

      console.info(
        `[content-core-index:upload-object] result sizeBytes=${uploaded.sizeBytes} checksumLen=${uploaded.checksum.length} key=${uploaded.key}`,
      );
      try {
        expect(uploaded.sizeBytes).toBe(7);
        expect(uploaded.checksum).toHaveLength(64);
        expect(uploaded.key).toMatch(/^persisted-/);
      } catch (err) {
        dumpUploadSnapshot("upload-object", uploaded);
        throw err;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uploads already-read plaintext bytes through the same shared content-core upload primitive", async () => {
    console.info(
      "[content-core-index:upload-bytes] uploading in-memory 'bytes-payload' (13 bytes)",
    );
    const uploaded = await uploadEncryptedContentBytes(
      {
        encryptObject: (bytes) => bytes,
        uploadObject: async (_token, objectKey, payload) => {
          expect(Buffer.from(payload)).toEqual(Buffer.from("bytes-payload"));
          return `persisted-${objectKey}`;
        },
      },
      "token",
      {
        plaintext: Buffer.from("bytes-payload"),
        logicalRef: "/tmp/from-memory.bin",
      }
    );

    console.info(
      `[content-core-index:upload-bytes] result sizeBytes=${uploaded.sizeBytes} checksumLen=${uploaded.checksum.length} key=${uploaded.key}`,
    );
    try {
      expect(uploaded.sizeBytes).toBe(13);
      expect(uploaded.key).toMatch(/^persisted-/);
      expect(uploaded.checksum).toHaveLength(64);
    } catch (err) {
      dumpUploadSnapshot("upload-bytes", uploaded);
      throw err;
    }
  });
});
