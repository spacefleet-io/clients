import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@space/shared/storageTunnel", () => ({
  createUserStorageTunnelClient: () => ({}),
}));

vi.mock("../src/main/apiHost", () => ({
  getApiBaseUrl: () => "http://localhost:3000",
}));

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));

import { ApiError, deleteStorageObjects, getLibraryMeta, putLibraryOp } from "../src/main/api";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

/** The SDK calls `fetch(Request)`: one Request argument, nothing else. */
const sentRequest = (index = 0): Request => {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch call ${index} was not recorded`);
  expect(call).toHaveLength(1);
  return call[0];
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop main-process API calls go through the SDK", () => {
  /** @req DEV-API-02[badger-desktop] */
  it("builds the library metadata call as an SDK Request with the path, the bearer and the badger app header", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { exists: true, version: 3 }));

    const meta = await getLibraryMeta("desktop-token");

    expect(meta).toMatchObject({ exists: true, version: 3 });
    const request = sentRequest();
    expect(request).toBeInstanceOf(Request);
    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://localhost:3000/library/db/meta");
    expect(request.headers.get("authorization")).toBe("Bearer desktop-token");
    expect(request.headers.get("x-space-app")).toBe("badger");
  });

  /** @req DEV-API-02[badger-desktop] */
  it("sends an op as the SDK's octet-stream Request with the x-library-* headers", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { version: 2, snapshotVersion: 1, stateHash: "s2", lastOpId: "op1" }),
    );
    const payload = new Uint8Array([7, 8, 9]);

    const result = await putLibraryOp("desktop-token", 1, "op1", payload, { prevStateHash: "s1", nextStateHash: "s2" });

    expect(result.version).toBe(2);
    const request = sentRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost:3000/library/db/ops");
    expect(request.headers.get("content-type")).toBe("application/octet-stream");
    expect(request.headers.get("authorization")).toBe("Bearer desktop-token");
    expect(request.headers.get("x-space-app")).toBe("badger");
    expect(request.headers.get("x-library-base-version")).toBe("1");
    expect(request.headers.get("x-library-op-id")).toBe("op1");
    expect(request.headers.get("x-library-prev-state-hash")).toBe("s1");
    expect(request.headers.get("x-library-next-state-hash")).toBe("s2");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(payload);
  });

  /** @req DEV-API-02[badger-desktop] */
  it("posts a JSON body for storage deletes", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { deleted: 2 }));

    await expect(deleteStorageObjects("desktop-token", ["k1", "k2"])).resolves.toEqual({ deleted: 2 });

    const request = sentRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost:3000/storage/delete");
    expect(request.headers.get("x-space-app")).toBe("badger");
    expect(await request.json()).toEqual({ keys: ["k1", "k2"] });
  });

  /** @req DEV-API-02[badger-desktop] */
  it("turns a non-2xx answer into ApiError(status, payload)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "version_conflict", version: 5 }));

    const error: unknown = await putLibraryOp("desktop-token", 1, "op1", new Uint8Array([1])).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error("expected ApiError");
    expect(error.status).toBe(409);
    expect(error.message).toBe("version_conflict");
    expect(error.payload).toEqual({ error: "version_conflict", version: 5 });
  });
});
