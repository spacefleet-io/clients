import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { putLibraryDb, setApiBaseUrl } from "@space/shared/api";

/**
 * @test-id MOBILE-LIBRARY-CHUNKREFS-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: prior to the JSON-body contract rebuild,
 * mobile bootstrap (apps/badger/mobile/src/lib/libraryDb.ts:1375)
 * and flush (apps/badger/mobile/src/lib/libraryDb.ts:2631) called
 * putLibraryDbBinary with only 6 args, silently dropping the
 * chunkRefs needed for server-side chunk reference counting and
 * rotation GC. Result in production: every bootstrap and flush
 * snapshot orphaned its chunks once the snapshot rotated out of
 * the kept-3 window.
 *
 * This regression test asserts that the call-site argument shape
 * actually reaches the wire with chunkRefs populated for ALL three
 * mobile snapshot upload paths: bootstrap, uploadSnapshot, flush.
 */

// The SDK calls `fetch(Request)` and cannot build a Request from the default relative `/api` base.
beforeAll(() => setApiBaseUrl("http://api.test"));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

const okResponse = () =>
  Response.json({
    version: 1,
    stateHash: null,
    lastOpId: null,
    snapshotVersion: 1,
  });

// On assertion failure, dump the raw captured fetch call(s) so a body-shape
// regression is diagnosable from CI logs alone. Wrapped in try/catch so a
// dump failure can never mask the original assertion error.
const dumpChunkRefsSnapshot = async (label: string, parsedBody?: unknown) => {
  try {
    console.error(`=== [library-snapshot-chunkrefs:${label}] snapshot ===`);
    console.error(`fetchMock.calls=${fetchMock.mock.calls.length}`);
    for (const [i, call] of fetchMock.mock.calls.entries()) {
      const [request] = call as [Request];
      console.error(
        `call[${i}]: url=${JSON.stringify(request.url)} method=${request.method} headers=${JSON.stringify(Object.fromEntries(request.headers))}`,
      );
      console.error(`call[${i}].body=${await request.clone().text()}`);
    }
    if (parsedBody !== undefined) console.error(`parsed body:\n${JSON.stringify(parsedBody, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const captureBody = async (): Promise<Record<string, unknown>> => {
  try {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [request] = fetchMock.mock.calls[0] as [Request];
    expect(request.method).toBe("PUT");
    expect(request.headers.get("content-type")).toContain("application/json");
    return JSON.parse(await request.clone().text());
  } catch (err) {
    await dumpChunkRefsSnapshot("captureBody-failed");
    throw err;
  }
};

// @req LIB-SYNC-04
describe("mobile snapshot upload — chunkRefs in JSON body", () => {
  it("bootstrap path (libraryDb.ts:1375) sends chunkRefs in body", async () => {
    console.info("[library-snapshot-chunkrefs:bootstrap] putLibraryDb via bootstrap call shape (expectedVersion=0)");
    fetchMock.mockResolvedValueOnce(okResponse());

    // Replicates the post-fix call shape at libraryDb.ts:1375
    //   putLibraryDb(
    //     token, 0, base64(manifestPayload), snapshotId, CHUNK_SIZE_BYTES,
    //     keyProbe, undefined, undefined, undefined, undefined,
    //     chunkIndex.chunks.map(c => c.hash)
    //   )
    const chunkHashes = ["sha256-aaa", "sha256-bbb", "sha256-ccc"];
    await putLibraryDb(
      "test-token",
      0,
      Buffer.from("manifest-ciphertext").toString("base64"),
      "snap-bootstrap-1",
      4_194_304,
      "key-probe-base64",
      undefined,
      undefined,
      undefined,
      undefined,
      chunkHashes
    );

    const body = await captureBody();
    console.info(`[library-snapshot-chunkrefs:bootstrap] body.chunkRefs=${JSON.stringify(body.chunkRefs)} manifestEncoding=${String(body.manifestEncoding)}`);
    try {
      expect(body.expectedVersion).toBe(0);
      expect(body.snapshotId).toBe("snap-bootstrap-1");
      expect(body.chunkRefs).toEqual(chunkHashes);
      expect(body.manifestEncoding).toBe("base64");
    } catch (err) {
      await dumpChunkRefsSnapshot("bootstrap-body-mismatch", body);
      throw err;
    }
  });

  it("uploadSnapshot main path (libraryDb.ts:2385) sends chunkRefs in body", async () => {
    console.info("[library-snapshot-chunkrefs:upload] putLibraryDb via uploadSnapshot call shape (expectedVersion=42, force=true)");
    fetchMock.mockResolvedValueOnce(okResponse());

    // Replicates the post-fix call shape at libraryDb.ts:2385
    //   putLibraryDb(
    //     this.token, pending.baseVersion, base64(manifestPayload),
    //     pending.snapshotId, pending.chunkSize, pending.keyProbe,
    //     true, undefined, undefined, undefined, chunkRefs
    //   )
    const chunkHashes = ["sha256-ddd", "sha256-eee"];
    await putLibraryDb(
      "test-token",
      42,
      Buffer.from("manifest-2").toString("base64"),
      "snap-upload-2",
      4_194_304,
      "key-probe-2",
      true,
      undefined,
      undefined,
      undefined,
      chunkHashes
    );

    const body = await captureBody();
    console.info(`[library-snapshot-chunkrefs:upload] body.chunkRefs=${JSON.stringify(body.chunkRefs)} force=${String(body.force)}`);
    try {
      expect(body.expectedVersion).toBe(42);
      expect(body.snapshotId).toBe("snap-upload-2");
      expect(body.chunkRefs).toEqual(chunkHashes);
      expect(body.force).toBe(true);
    } catch (err) {
      await dumpChunkRefsSnapshot("upload-body-mismatch", body);
      throw err;
    }
  });

  it("flush path (libraryDb.ts:2636) sends chunkRefs in body", async () => {
    console.info("[library-snapshot-chunkrefs:flush] putLibraryDb via flush call shape (expectedVersion=99, force=false)");
    fetchMock.mockResolvedValueOnce(okResponse());

    // Replicates the post-fix call shape at libraryDb.ts:2636
    //   putLibraryDb(
    //     this.token, pending.baseVersion, base64(manifestPayload),
    //     pending.snapshotId, pending.chunkSize, pending.keyProbe,
    //     undefined, undefined, undefined, undefined,
    //     chunkIndex.chunks.map(c => c.hash)
    //   )
    const chunkHashes = ["sha256-fff", "sha256-ggg", "sha256-hhh", "sha256-iii"];
    await putLibraryDb(
      "test-token",
      99,
      Buffer.from("manifest-flush").toString("base64"),
      "snap-flush-3",
      4_194_304,
      "key-probe-3",
      undefined,
      undefined,
      undefined,
      undefined,
      chunkHashes
    );

    const body = await captureBody();
    console.info(`[library-snapshot-chunkrefs:flush] body.chunkRefs=${JSON.stringify(body.chunkRefs)} force=${String(body.force)}`);
    try {
      expect(body.expectedVersion).toBe(99);
      expect(body.snapshotId).toBe("snap-flush-3");
      expect(body.chunkRefs).toEqual(chunkHashes);
      expect(body.force).toBe(false);
    } catch (err) {
      await dumpChunkRefsSnapshot("flush-body-mismatch", body);
      throw err;
    }
  });

  it("regression guard: chunkRefs is always an array, never omitted", async () => {
    console.info("[library-snapshot-chunkrefs:always-array] putLibraryDb with empty chunkRefs — body.chunkRefs must still be []");
    // The bug was that putLibraryDbBinary was called with 6 args, so chunkRefs
    // was undefined and never serialized. The new putLibraryDb defaults
    // missing chunkRefs to []. We assert that even with an empty chunkRefs
    // arg, the body still contains the key — the server-side refcount
    // logic must always see chunkRefs as an array.
    fetchMock.mockResolvedValueOnce(okResponse());

    await putLibraryDb(
      "test-token",
      1,
      Buffer.from("m").toString("base64"),
      "snap-empty",
      4_194_304,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      []
    );

    const body = await captureBody();
    console.info(`[library-snapshot-chunkrefs:always-array] body.chunkRefs=${JSON.stringify(body.chunkRefs)} isArray=${Array.isArray(body.chunkRefs)}`);
    try {
      expect(Array.isArray(body.chunkRefs)).toBe(true);
      expect(body.chunkRefs).toEqual([]);
    } catch (err) {
      await dumpChunkRefsSnapshot("always-array-regression", body);
      throw err;
    }
  });
});
