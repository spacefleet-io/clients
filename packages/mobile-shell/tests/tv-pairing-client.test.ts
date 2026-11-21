/**
 * @test-id TV-PAIR-CLIENT-001
 * @level unit
 * @why The TV is the NEW device in a pairing: it asks the API for a code, long-polls and opens the sealed library
 *   key with its own private key. A wrong device type, a missing `wait`, or a key opened to the wrong request would
 *   leave the TV unable to sign in or signed in with an unusable key. Runs against a fake API that follows the
 *   pairing contract; the approver side uses the real `sealLibraryKey`.
 */
import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, normalizeShortCode, sealLibraryKey } from "@space/pairing-crypto";
import { PairingHttpError, TV_POLL_WAIT_SECONDS, createTvPairingClient, resolveTvDeviceName } from "../src/tv/pairingClient";

const LIBRARY_KEY = bytesToBase64(new Uint8Array(32).map((_, i) => i + 1));
const USER = { id: "u1", email: "tv-test@spacefleet.test" };

type Created = { deviceType: string; deviceName: string; publicKey: string };

type FakeApiState = {
  created: Created | null;
  headers: Record<string, string> | null;
  pollUrls: string[];
  pollResponses: Array<{ status: number; body: unknown }>;
};
type FakeApi = { state: FakeApiState; fetchImpl: typeof fetch };

const makeFakeApi = (): FakeApi => {
  const state: FakeApiState = {
    created: null,
    headers: null,
    pollUrls: [],
    pollResponses: [],
  };
  // The SDK calls fetch with one Request.
  const fetchImpl = (async (request: Request) => {
    const url = request.url;
    if (request.method === "POST" && new URL(url).pathname === "/pairing/requests") {
      state.created = (await request.json()) as Created;
      state.headers = Object.fromEntries(request.headers);
      return Response.json({
        requestId: "req-1",
        pollSecret: "secret-1",
        shortCode: "ABCD-EFGH",
        qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
    state.pollUrls.push(url);
    const next = state.pollResponses.shift() ?? { status: 200, body: { status: "pending" } };
    return Response.json(next.body, { status: next.status });
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
};

const makeClient = (api: FakeApi, deviceName = "Chromecast with Google TV") =>
  createTvPairingClient({ appId: "badger", getApiBaseUrl: () => "http://api.test", deviceName: () => deviceName, fetchImpl: api.fetchImpl });

const approvedBody = (api: FakeApi, requestId: string) => ({
  status: "approved",
  token: "session-token",
  user: USER,
  clientType: "badger-mobile",
  sealedKey: sealLibraryKey({ devicePublicKey: api.state.created?.publicKey ?? "", requestId, libraryKey: LIBRARY_KEY }),
});

describe("TV pairing client (new device)", () => {
  it("asks for a code as a TV with its own public key and the TV's name", async () => {
    console.info("[tv-pairing-client:phase] start");
    const api = makeFakeApi();
    const started = await makeClient(api).start();
    console.info("[tv-pairing-client:state]", { created: api.state.created, headers: api.state.headers, started });

    expect(api.state.created?.deviceType).toBe("tv");
    expect(api.state.created?.deviceName).toBe("Chromecast with Google TV");
    expect(base64ToBytes(api.state.created?.publicKey ?? "")).toHaveLength(32);
    expect(api.state.headers?.["x-space-app"]).toBe("badger");
    expect(started.shortCode).toBe("ABCD-EFGH");
    expect(normalizeShortCode(started.shortCode)).toBe("ABCDEFGH");
    expect(started.qrPayload).toBe("https://spacefleet.io/pair/badger?code=ABCDEFGH");
  });

  it("long-polls with its secret and asks the API to hold the poll open", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    expect(await client.poll(started.requestId)).toEqual({ status: "pending" });
    const url = new URL(api.state.pollUrls[0] ?? "");
    console.info("[tv-pairing-client:state]", { pollUrl: url.toString() });
    expect(url.pathname).toBe("/pairing/requests/req-1");
    expect(url.searchParams.get("pollSecret")).toBe("secret-1");
    expect(url.searchParams.get("wait")).toBe(String(TV_POLL_WAIT_SECONDS));
    expect(TV_POLL_WAIT_SECONDS).toBeLessThanOrEqual(25);
  });

  it("opens the sealed library key with its own private key", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    api.state.pollResponses.push({ status: 200, body: { status: "pending" } });
    api.state.pollResponses.push({ status: 200, body: approvedBody(api, started.requestId) });

    expect(await client.poll(started.requestId)).toEqual({ status: "pending" });
    const result = await client.poll(started.requestId);
    console.info("[tv-pairing-client:state]", { result: { ...result, token: "<token>" } });
    expect(result).toEqual({ status: "approved", token: "session-token", user: USER, libraryKey: LIBRARY_KEY });
  });

  it("returns the approved result again when asked twice (the API delivers it once)", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    api.state.pollResponses.push({ status: 200, body: approvedBody(api, started.requestId) });
    const first = await client.poll(started.requestId);
    const second = await client.poll(started.requestId);
    expect(second).toEqual(first);
    expect(api.state.pollUrls).toHaveLength(1);
  });

  it("reports an unreadable key when the approver sealed it to a different device", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    const stranger = sealLibraryKey({
      devicePublicKey: bytesToBase64(new Uint8Array(32).fill(9)),
      requestId: started.requestId,
      libraryKey: LIBRARY_KEY,
    });
    api.state.pollResponses.push({ status: 200, body: { status: "approved", token: "t", user: USER, sealedKey: stranger } });
    expect(await client.poll(started.requestId)).toEqual({ status: "key_unreadable" });
  });

  it.each([
    ["denied", { status: 200, body: { status: "denied" } }, "denied"],
    ["expired", { status: 200, body: { status: "expired" } }, "expired"],
    ["consumed with no stored result", { status: 200, body: { status: "consumed" } }, "expired"],
    ["unknown request (404)", { status: 404, body: { error: "pairing_not_found" } }, "expired"],
    ["gone request (410)", { status: 410, body: { error: "pairing_expired" } }, "expired"],
  ])("treats a %s request as ended", async (_label, response, expected) => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    api.state.pollResponses.push(response);
    expect(await client.poll(started.requestId)).toEqual({ status: expected });
  });

  it("surfaces a rate limit from the API as an HTTP error with its status", async () => {
    const fetchImpl = (async () => Response.json({ error: "rate_limited" }, { status: 429 })) as unknown as typeof fetch;
    const client = createTvPairingClient({ appId: "badger", getApiBaseUrl: () => "http://api.test", deviceName: () => "TV", fetchImpl });
    const error = await client.start().then(
      () => null,
      (caught: unknown) => caught,
    );
    console.info("[tv-pairing-client:state]", { error: error instanceof Error ? error.message : error });
    expect(error).toBeInstanceOf(PairingHttpError);
    expect((error as PairingHttpError).status).toBe(429);
  });

  it("forgets the request after cancel without calling the API again", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    client.cancel();
    expect(await client.poll(started.requestId)).toEqual({ status: "expired" });
    expect(api.state.pollUrls).toHaveLength(0);
  });

  it("keeps the newest code when an older start finishes after it (React StrictMode double start)", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let posts = 0;
    const fetchImpl = (async (request: Request) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/pairing/requests") {
        posts += 1;
        const n = posts;
        if (n === 1) await firstGate;
        return Response.json({
          requestId: `req-${n}`,
          pollSecret: `secret-${n}`,
          shortCode: "ABCD-EFGH",
          qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      return Response.json({ status: "pending" });
    }) as unknown as typeof fetch;
    const client = createTvPairingClient({ getApiBaseUrl: () => "http://api.test", deviceName: () => "TV", fetchImpl });

    const slow = client.start();
    client.cancel();
    const fast = await client.start();
    releaseFirst();
    await slow;

    expect(await client.poll(fast.requestId)).toEqual({ status: "pending" });
    expect(await client.poll("req-1")).toEqual({ status: "expired" });
  });
});

describe("TV device name", () => {
  it.each([
    ["Android TV model with its maker", { manufacturer: "Sony", model: "BRAVIA 4K", isTVOS: false }, "Sony BRAVIA 4K"],
    ["a model that already carries the maker", { manufacturer: "Amazon", model: "Amazon AFTMM", isTVOS: false }, "Amazon AFTMM"],
    ["the brand when there is no manufacturer", { brand: "google", model: "Chromecast", isTVOS: false }, "google Chromecast"],
    ["a maker with no model", { manufacturer: "Xiaomi", model: "", isTVOS: false }, "Xiaomi"],
    ["nothing known on Android", { isTVOS: false }, "Android TV"],
    ["Apple TV, whatever the constants say", { manufacturer: "Apple", model: "AppleTV14,1", isTVOS: true }, "Apple TV"],
  ])("names %s", (_label, info, expected) => {
    expect(resolveTvDeviceName(info)).toBe(expected);
  });
});
