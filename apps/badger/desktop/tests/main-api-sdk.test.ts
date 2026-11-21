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

import { ApiError, deleteStorageObjects, listStorageObjects } from "../src/main/api";

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
  it("builds a GET as an SDK Request with the path, the bearer and the badger app header", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { objects: [] }));

    await listStorageObjects("desktop-token");

    const request = sentRequest();
    console.info("[main-api-sdk] GET", request.method, request.url);
    expect(request).toBeInstanceOf(Request);
    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://localhost:3000/storage/objects");
    expect(request.headers.get("authorization")).toBe("Bearer desktop-token");
    expect(request.headers.get("x-space-app")).toBe("badger");
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

    const error: unknown = await deleteStorageObjects("desktop-token", ["k1"]).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error("expected ApiError");
    expect(error.status).toBe(409);
    expect(error.message).toBe("version_conflict");
    expect(error.payload).toEqual({ error: "version_conflict", version: 5 });
  });
});
