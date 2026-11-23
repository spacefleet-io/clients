import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  ApiError,
  deleteStorageObjects,
  getLibraryDb,
  getLibraryMeta,
  getLibraryOps,
  listStorageObjects,
  onAppUpdateRefusal,
  putLibraryDb,
  putLibraryDbBinary,
  putLibraryOp,
} from "../src/api";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import { OP_STREAM_VERSION } from "@space/library-db-definition/ops";

const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(new Response("{}", { status: 200 })),
);
globalThis.fetch = fetchMock as unknown as typeof fetch;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The SDK calls `fetch(Request)` with a single Request argument. */
const sdkRequestAt = (index: number): Request => {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch call ${index} was not recorded`);
  const [input, init] = call;
  if (!(input instanceof Request)) throw new Error(`fetch call ${index} did not pass a Request`);
  if (init !== undefined) throw new Error(`fetch call ${index} passed a second argument`);
  return input;
};

/** The raw-fetch fallback (octet-stream snapshot) still calls `fetch(url, init)`. */
const rawCallAt = (index: number): { url: string; init: RequestInit } => {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch call ${index} was not recorded`);
  const [input, init] = call;
  if (typeof input !== "string") throw new Error(`fetch call ${index} did not use a string url`);
  if (!init) throw new Error(`fetch call ${index} had no request init`);
  return { url: input, init };
};

afterEach(() => {
  fetchMock.mockReset();
  delete process.env.SF_API_BASE_URL;
});

describe("runtime api client", () => {
  it("sends SDK requests to the configured API base URL with the badger scope", async () => {
    process.env.SF_API_BASE_URL = "https://api.dev.spacebadger.io";
    fetchMock.mockResolvedValueOnce(jsonResponse({ keys: ["a", "b"] }));

    const result = await listStorageObjects("token");

    expect(result).toEqual({ keys: ["a", "b"] });
    const request = sdkRequestAt(0);
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://api.dev.spacebadger.io/storage/objects");
    expect(request.headers.get("authorization")).toBe("Bearer token");
    expect(request.headers.get("x-space-app")).toBe("badger");
  });

  it("throws ApiError for non-2xx responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    const error: unknown = await getLibraryMeta("token").catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error("expected ApiError");
    expect(error.status).toBe(401);
    expect(error.message).toBe("unauthorized");
    expect(error.payload.error).toBe("unauthorized");
  });

  it("falls back to request_failed when the error body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));

    const error: unknown = await getLibraryMeta("token").catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error("expected ApiError");
    expect(error.status).toBe(502);
    expect(error.message).toBe("request_failed");
  });

  it("sends no Authorization header without a token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ keys: [] }));

    await listStorageObjects("");

    expect(sdkRequestAt(0).headers.has("authorization")).toBe(false);
  });

  it("uploads ops as binary payload with lineage headers", async () => {
    process.env.SF_API_BASE_URL = "https://api.dev.spacebadger.io";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ version: 2, snapshotVersion: 1, stateHash: "s2", lastOpId: "op2" }),
    );

    const payload = new Uint8Array([7, 8, 9]);
    await putLibraryOp("token", 1, "op1", payload, { prevStateHash: "s1", nextStateHash: "s2" }, OP_STREAM_VERSION);

    const request = sdkRequestAt(0);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.dev.spacebadger.io/library/db/ops");
    expect(request.headers.get("content-type")).toBe("application/octet-stream");
    expect(request.headers.get("authorization")).toBe("Bearer token");
    expect(request.headers.get("x-space-app")).toBe("badger");
    expect(request.headers.get("x-library-base-version")).toBe("1");
    expect(request.headers.get("x-library-op-id")).toBe("op1");
    expect(request.headers.get("x-library-storage-format-version")).toBe(String(STORAGE_FORMAT_VERSION));
    expect(request.headers.get("x-library-op-stream-version")).toBe(String(OP_STREAM_VERSION));
    expect(request.headers.get("x-library-prev-state-hash")).toBe("s1");
    expect(request.headers.get("x-library-next-state-hash")).toBe("s2");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(payload);
  });

  it("scopes an op upload to the given app and omits absent lineage headers", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ version: 2, snapshotVersion: 1, stateHash: "s2", lastOpId: "op2" }),
    );

    await putLibraryOp("token", 1, "op1", new Uint8Array([1]), undefined, OP_STREAM_VERSION, "parrot");

    const request = sdkRequestAt(0);
    expect(request.headers.get("x-space-app")).toBe("parrot");
    expect(request.headers.has("x-library-prev-state-hash")).toBe(false);
    expect(request.headers.has("x-library-next-state-hash")).toBe(false);
  });

  it("fetches library metadata and preserves snapshot/ops fields", async () => {
    process.env.SF_API_BASE_URL = "https://api.dev.spacebadger.io";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        exists: true,
        bootstrapRequired: false,
        syncUnavailable: false,
        version: 14,
        snapshotVersion: 11,
        hash: "hash-14",
        stateHash: "state-14",
        lastOpId: "op-14",
        consistency: "ok",
        updatedAt: "2026-02-15T10:00:00.000Z",
        keyProbe: "probe",
        keyProbeUpdatedAt: "2026-02-15T10:00:00.000Z",
        blobEncoding: "binary",
        snapshotId: "snapshot-11",
        manifestKey: "library/manifests/snapshot-11",
        chunkSize: 4194304,
        snapshotHistory: [{ snapshotId: "snapshot-11", manifestKey: "library/manifests/snapshot-11", createdAt: "2026-02-15T10:00:00.000Z" }],
        opsHistory: [{ opId: "op-14", version: 14, createdAt: "2026-02-15T10:00:01.000Z", size: 512, objectKey: "library/ops/op-14" }],
        storageFormatVersion: 1,
        opStreamVersion: 1,
      }),
    );

    const meta = await getLibraryMeta("token-1");

    expect(meta.version).toBe(14);
    expect(meta.snapshotVersion).toBe(11);
    expect(meta.snapshotHistory).toHaveLength(1);
    expect(meta.opsHistory).toHaveLength(1);
    const request = sdkRequestAt(0);
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://api.dev.spacebadger.io/library/db/meta");
    expect(request.headers.get("authorization")).toBe("Bearer token-1");
    expect(request.headers.get("x-space-app")).toBe("badger");
  });

  it("requests ops since the expected version and includes auth header", async () => {
    process.env.SF_API_BASE_URL = "https://api.dev.spacebadger.io";
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: 15, snapshotVersion: 11, tooOld: false, ops: [] }));

    const result = await getLibraryOps("token-2", 11);

    expect(result.tooOld).toBe(false);
    const request = sdkRequestAt(0);
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://api.dev.spacebadger.io/library/db/ops?since=11");
    expect(request.headers.get("authorization")).toBe("Bearer token-2");
    expect(request.headers.get("x-space-app")).toBe("badger");
  });

  // @req LIB-FMT-09[runtime]
  it("publishes a snapshot as the JSON contract with the declared format versions", async () => {
    process.env.SF_API_BASE_URL = "https://api.dev.spacebadger.io";
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: 21, stateHash: "state-21", lastOpId: "op-21" }));

    // The op-stream version is the caller's (here an app at 7), never a constant of this transport (LIB-FMT-09).
    const result = await putLibraryDb("token-5", 20, "bWFuaWZlc3Q=", "snapshot-21", 4194304, "probe", true, "state-20", "op-20", "badger", ["c1", "c2"], { client: "desktop", refsVersion: 1 }, 7, "checked-probe");

    expect(result.version).toBe(21);
    const request = sdkRequestAt(0);
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://api.dev.spacebadger.io/library/db");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("authorization")).toBe("Bearer token-5");
    expect(request.headers.get("x-space-app")).toBe("badger");
    const body = (await request.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      expectedVersion: 20,
      manifest: "bWFuaWZlc3Q=",
      manifestEncoding: "base64",
      snapshotId: "snapshot-21",
      chunkSize: 4194304,
      chunkRefs: ["c1", "c2"],
      chunkRefsSource: { client: "desktop", refsVersion: 1 },
      keyProbe: "probe",
      force: true,
      stateHash: "state-20",
      lastOpId: "op-20",
    });
    expect(typeof body.storageFormatVersion).toBe("number");
    expect(body.opStreamVersion).toBe(7);
    expect(body.checkedKeyProbe).toBe("checked-probe");
  });

  it("uploads encrypted snapshot manifest bytes with binary headers", async () => {
    process.env.SF_API_BASE_URL = "https://api.dev.spacebadger.io";
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: 21, stateHash: "state-21", lastOpId: "op-21" }));

    await putLibraryDbBinary("token-3", 20, new Uint8Array([1, 2, 3]), "snapshot-21", 4194304, "probe", false, "state-20", "op-20");

    const { url, init: options } = rawCallAt(0);
    expect(url).toBe("https://api.dev.spacebadger.io/library/db");
    expect(options.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/octet-stream",
        Authorization: "Bearer token-3",
        "x-space-app": "badger",
        "x-library-version": "20",
        "x-library-snapshot-id": "snapshot-21",
        "x-library-chunk-size": "4194304",
        "x-library-key-probe": "probe",
        "x-library-state-hash": "state-20",
        "x-library-last-op-id": "op-20",
      }),
    );
    expect(options.body).toBeInstanceOf(Uint8Array);
  });

  it("raises ApiError from the raw octet-stream upload too", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "version_conflict", version: 22 }, 409));

    const error: unknown = await putLibraryDbBinary("token", 20, new Uint8Array([1]), "snapshot", 1).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error("expected ApiError");
    expect(error.status).toBe(409);
    expect(error.payload).toEqual({ error: "version_conflict", version: 22 });
  });

  it("fetches current snapshot metadata with binary blob encoding", async () => {
    process.env.SF_API_BASE_URL = "https://api.dev.spacebadger.io";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        exists: true,
        version: 33,
        snapshotVersion: 31,
        hash: "hash-33",
        downloadUrl: "https://storage.dev/snapshot",
        manifestKey: "library/manifests/snapshot-31",
        updatedAt: "2026-02-15T11:00:00.000Z",
        blobEncoding: "binary",
        snapshotId: "snapshot-31",
        chunkSize: 4194304,
        storageFormatVersion: 1,
        opStreamVersion: 1,
      }),
    );

    const db = await getLibraryDb("token-4");

    expect(db.exists).toBe(true);
    expect(db.blobEncoding).toBe("binary");
    expect(db.snapshotVersion).toBe(31);
    expect(sdkRequestAt(0).url).toBe("https://api.dev.spacebadger.io/library/db");
  });

  it("deletes storage objects by key", async () => {
    process.env.SF_API_BASE_URL = "https://api.dev.spacebadger.io";
    fetchMock.mockResolvedValueOnce(jsonResponse({ deleted: 2, reclaimedBytes: 10 }));

    const result = await deleteStorageObjects("token-6", ["k1", "k2"]);

    expect(result).toEqual({ deleted: 2, reclaimedBytes: 10 });
    const request = sdkRequestAt(0);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.dev.spacebadger.io/storage/delete");
    expect(await request.json()).toEqual({ keys: ["k1", "k2"] });
  });

  /**
   * @test-id LIB-V4-RUNTIME-002
   * @why The runtime has no screen: it hands "please update" refusals to the desktop app over IPC. A switched
   *   account's 426 for an op stream this build reads is not one (the library converts and retries, LIB-FMT-13), so
   *   forwarding it would lock a current app behind the update gate.
   */
  it("@req LIB-FMT-13 passes on app-update refusals but not an op-stream switch this build reads", async () => {
    const seen: Array<{ status: number; reason: unknown }> = [];
    const stop = onAppUpdateRefusal((refusal) => seen.push({ status: refusal.status, reason: refusal.payload.reason }));
    try {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "app_update_required", reason: "library_op_stream", opStreamVersion: 4, minVersion: "" }, 426)
      );
      await getLibraryMeta("token").catch(() => undefined);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "app_update_required", reason: "library_op_stream", opStreamVersion: 5, minVersion: "" }, 426)
      );
      await getLibraryMeta("token").catch(() => undefined);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "app_update_required", app: "badger", platform: "desktop", version: "1.0.0", minVersion: "9.0.0" }, 426)
      );
      await getLibraryMeta("token").catch(() => undefined);
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
      await getLibraryMeta("token").catch(() => undefined);
    } finally {
      stop();
    }
    console.info(`[LIB-V4-RUNTIME-002] seen ${JSON.stringify(seen)}`);
    expect(seen).toEqual([
      { status: 426, reason: "library_op_stream" },
      { status: 426, reason: undefined },
    ]);
  });
});
