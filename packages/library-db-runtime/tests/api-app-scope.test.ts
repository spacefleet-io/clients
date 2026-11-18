import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  deleteStorageObjects,
  downloadStorageObjectViaTunnel,
  getLibraryDb,
  getLibraryMeta,
  getLibraryOps,
  listStorageObjects,
} from "../src/api";

const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(new Response("{}", { status: 200 })),
);
globalThis.fetch = fetchMock as unknown as typeof fetch;

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** The `x-space-app` header of recorded fetch call `index`, whether it went through the SDK or raw fetch. */
const appHeaderAt = (index: number) => {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch call ${index} was not recorded`);
  const [input, init] = call;
  if (input instanceof Request) return input.headers.get("x-space-app");
  return new Headers(init?.headers).get("x-space-app");
};

afterEach(() => {
  fetchMock.mockReset();
});

describe("library api app scope", () => {
  const calls: Array<[string, (appId?: "badger" | "parrot") => Promise<unknown>, unknown]> = [
    ["getLibraryMeta", (appId) => getLibraryMeta("token", appId), { exists: false, version: 0 }],
    ["getLibraryDb", (appId) => getLibraryDb("token", appId), { exists: false }],
    ["getLibraryOps", (appId) => getLibraryOps("token", 0, appId), { version: 0, snapshotVersion: 0, tooOld: false, ops: [] }],
    ["listStorageObjects", (appId) => listStorageObjects("token", appId), { keys: [] }],
    ["deleteStorageObjects", (appId) => deleteStorageObjects("token", ["library/parrot/x"], appId), { deleted: 1 }],
  ];

  for (const [name, call, body] of calls) {
    it(`${name} sends x-space-app: parrot when asked for the parrot library`, async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(body));
      await call("parrot");
      expect(appHeaderAt(0)).toBe("parrot");
    });

    it(`${name} keeps Badger's scope by default`, async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(body));
      await call();
      expect(appHeaderAt(0)).toBe("badger");
    });
  }

  it("routes storage tunnel traffic under the requested app, one client per app", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{"error":"forbidden"}', { status: 403 })));
    const download = (appId?: "parrot") =>
      downloadStorageObjectViaTunnel(
        "token",
        "library/chunks/abc",
        { clientType: "test", downloadId: "d1", purpose: "library" },
        appId,
      ).catch(() => undefined);

    await download("parrot");
    const parrotCalls = fetchMock.mock.calls.length;
    await download();

    expect(parrotCalls).toBeGreaterThanOrEqual(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(parrotCalls);
    for (let i = 0; i < parrotCalls; i += 1) expect(appHeaderAt(i)).toBe("parrot");
    for (let i = parrotCalls; i < fetchMock.mock.calls.length; i += 1) expect(appHeaderAt(i)).toBe("badger");
  });
});
