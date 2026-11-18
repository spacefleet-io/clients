import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadEncryptedObjectFile } from "../src/storageTransport";

// On assertion failure, dump enough of the upload result + mock call args to
// diagnose offline (per "Tests log generously"). try/catch so a dump failure
// can't mask the real assertion.
const dumpUploaderSnapshot = (
  label: string,
  ctx: {
    uploaded?: unknown;
    uploadObject?: { mock?: { calls: unknown[] } };
    sessionManager?: {
      getCompletedParts?: { mock?: { calls: unknown[] } };
      recordPart?: { mock?: { calls: unknown[] } };
    };
  },
) => {
  try {
    console.error(`=== [encrypted-uploader:${label}] snapshot ===`);
    console.error(`uploaded result:\n${JSON.stringify(ctx.uploaded, null, 2)}`);
    if (ctx.uploadObject?.mock) {
      console.error(
        `uploadObject callCount=${ctx.uploadObject.mock.calls.length} calls=${JSON.stringify(ctx.uploadObject.mock.calls, null, 2)}`,
      );
    }
    if (ctx.sessionManager) {
      console.error(
        `sessionManager.getCompletedParts callCount=${ctx.sessionManager.getCompletedParts?.mock?.calls.length ?? "n/a"} calls=${JSON.stringify(ctx.sessionManager.getCompletedParts?.mock?.calls, null, 2)}`,
      );
      console.error(
        `sessionManager.recordPart callCount=${ctx.sessionManager.recordPart?.mock?.calls.length ?? "n/a"} calls=${JSON.stringify(ctx.sessionManager.recordPart?.mock?.calls, null, 2)}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("encrypted uploader", () => {
  const roots: string[] = [];

  afterEach(() => {
    console.info(`[encrypted-uploader:teardown] cleaning ${roots.length} temp root(s)`);
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const createTempFile = async (name: string, content: string) => {
    const root = mkdtempSync(join(tmpdir(), "sf-encrypted-uploader-"));
    roots.push(root);
    const inputPath = join(root, name);
    await fs.writeFile(inputPath, Buffer.from(content));
    console.info(
      `[encrypted-uploader:setup] wrote temp file name=${name} bytes=${Buffer.byteLength(content)} path=${inputPath}`,
    );
    return inputPath;
  };

  it("@bugfix @regression-proof uploads encrypted files through the single high-level upload contract", async () => {
    const inputPath = await createTempFile("input.bin", "payload");
    const uploadObject = vi.fn(async (_token: string, objectKey: string, payload: Uint8Array) => {
      expect(Buffer.from(payload)).toEqual(Buffer.from("payload"));
      return `persisted-${objectKey}`;
    });

    console.info(`[encrypted-uploader:upload] invoking uploadEncryptedObjectFile path=${inputPath}`);
    const uploaded = await uploadEncryptedObjectFile(
      {
        encryptObject: (bytes) => bytes,
        uploadObject,
      },
      "token",
      inputPath
    );
    console.info(
      `[encrypted-uploader:upload] result sizeBytes=${uploaded.sizeBytes} checksumLen=${uploaded.checksum.length} uploadObjectCalls=${uploadObject.mock.calls.length}`,
    );

    try {
      expect(uploaded.sizeBytes).toBe(7);
      expect(uploaded.checksum).toHaveLength(64);
      expect(uploadObject).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpUploaderSnapshot("single-contract-upload", { uploaded, uploadObject });
      throw err;
    }
  });

  it("@bugfix @regression-proof reuses resumable upload metadata instead of re-uploading the same file", async () => {
    const inputPath = await createTempFile("resume.bin", "resume-payload");
    const uploadObject = vi.fn();
    const sessionManager = {
      getCompletedParts: vi.fn(async () => [
        {
          partNumber: 0,
          etag: "persisted-existing",
          sizeBytes: 14,
          checksum: "abc123",
          path: inputPath,
        },
      ]),
      recordPart: vi.fn(async () => undefined),
    };

    console.info(
      `[encrypted-uploader:resume] invoking uploadEncryptedObjectFile outputId=output-1 (expect ledger reuse, no re-upload)`,
    );
    const uploaded = await uploadEncryptedObjectFile(
      {
        encryptObject: (bytes) => bytes,
        uploadObject,
      },
      "token",
      inputPath,
      {
        outputId: "output-1",
        sessionManager,
      }
    );
    console.info(
      `[encrypted-uploader:resume] result=${JSON.stringify(uploaded)} uploadObjectCalls=${uploadObject.mock.calls.length} recordPartCalls=${sessionManager.recordPart.mock.calls.length}`,
    );

    try {
      expect(uploaded).toEqual({
        key: "persisted-existing",
        sizeBytes: 14,
        checksum: "abc123",
      });
      expect(sessionManager.getCompletedParts).toHaveBeenCalledWith("output-1");
      expect(uploadObject).not.toHaveBeenCalled();
      expect(sessionManager.recordPart).not.toHaveBeenCalled();
    } catch (err) {
      dumpUploaderSnapshot("resume-reuse-ledger", { uploaded, uploadObject, sessionManager });
      throw err;
    }
  });

  it("records uploaded files into the resumable upload ledger", async () => {
    const inputPath = await createTempFile("record.bin", "record");
    const sessionManager = {
      getCompletedParts: vi.fn(async () => []),
      recordPart: vi.fn(async () => undefined),
    };

    console.info(`[encrypted-uploader:record] invoking uploadEncryptedObjectFile outputId=output-2`);
    const uploaded = await uploadEncryptedObjectFile(
      {
        encryptObject: (bytes) => bytes,
        uploadObject: vi.fn(async (_token: string, objectKey: string) => `persisted-${objectKey}`),
      },
      "token",
      inputPath,
      {
        outputId: "output-2",
        sessionManager,
      }
    );
    console.info(
      `[encrypted-uploader:record] result key=${uploaded.key} recordPartCalls=${sessionManager.recordPart.mock.calls.length}`,
    );

    try {
      expect(uploaded.key).toMatch(/^persisted-/);
      expect(sessionManager.recordPart).toHaveBeenCalledWith(
        "output-2",
        expect.objectContaining({
          partNumber: 0,
          etag: uploaded.key,
          sizeBytes: 6,
          path: inputPath,
        })
      );
    } catch (err) {
      dumpUploaderSnapshot("record-into-ledger", { uploaded, sessionManager });
      throw err;
    }
  });
});
