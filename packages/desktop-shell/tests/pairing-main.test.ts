/**
 * ACCT-PAIR-01 / PRIV-KEY-05: the new-device side of pairing in the main process, against a fake API that
 * behaves like the pairing contract (the real approver seals the library key with `sealLibraryKey`).
 */
import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, normalizeShortCode, sealLibraryKey } from "@space/pairing-crypto";
import { createDesktopPairingClient, pairingRefusalOf, PairingHttpError, resolveDeviceName } from "../src/pairing/main";
import { pairingModeOf } from "../src/pairing/types";
import type { SpaceAppId } from "@space/shared/appScope";

const log = (message: string, extra?: Record<string, unknown>) => console.info(`[pairing-main.test] ${message}`, extra ?? "");

const LIBRARY_KEY = bytesToBase64(new Uint8Array(32).map((_, i) => i + 1));
const USER = { id: "u1", email: "kodi-test@spacefleet.test" };

type Created = { deviceType: string; deviceName: string; publicKey: string };

const makeFakeApi = () => {
  const state = {
    created: null as Created | null,
    createdPath: null as string | null,
    posts: 0,
    headers: null as Record<string, string> | null,
    pollResponses: [] as Array<{ status: number; body: unknown }>,
    polls: 0,
    lastWait: null as string | null,
  };
  // The SDK calls fetch with one Request.
  const fetchImpl = (async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && (path === "/pairing/requests" || path === "/pairing/key-requests")) {
      state.posts += 1;
      state.createdPath = path;
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
    state.polls += 1;
    state.lastWait = new URL(request.url).searchParams.get("wait");
    const next = state.pollResponses.shift() ?? { status: 200, body: { status: "pending" } };
    return Response.json(next.body, { status: next.status });
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
};

const makeClient = (
  api: ReturnType<typeof makeFakeApi>,
  appId: SpaceAppId = "badger",
  sessionToken?: () => string | null,
) =>
  createDesktopPairingClient({
    getApiBaseUrl: () => "http://api.test",
    appId,
    fetchImpl: api.fetchImpl,
    hostname: () => "chris-pc.local",
    platform: "linux",
    log,
    sessionToken,
  });

describe("pairing client (new device)", () => {
  it("@req ACCT-PAIR-01 asks for a code as a desktop with its own public key and the computer's name", async () => {
    const api = makeFakeApi();
    const started = await makeClient(api).start();

    expect(api.state.created?.deviceType).toBe("desktop");
    expect(api.state.created?.deviceName).toBe("Linux (chris-pc)");
    expect(api.state.headers?.["x-space-app"]).toBe("badger");
    expect(base64ToBytes(api.state.created?.publicKey ?? "")).toHaveLength(32);
    expect(started.shortCode).toBe("ABCD-EFGH");
    expect(normalizeShortCode(started.shortCode)).toBe("ABCDEFGH");
    expect(started.qrSvg).toContain("<svg");
    expect(started.deviceName).toBe("Linux (chris-pc)");
  });

  it("@req ACCT-PAIR-05 tells the API that Parrot is the app asking, so the phone can name it", async () => {
    const api = makeFakeApi();
    await makeClient(api, "parrot").start();
    expect(api.state.headers?.["x-space-app"]).toBe("parrot");
    expect(api.state.created?.deviceType).toBe("desktop");
  });

  it("@req ACCT-PAIR-01 keeps waiting while the phone has not approved", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    expect(await client.poll(started.requestId)).toEqual({ status: "pending" });
    console.info("[pairing-main] poll wait param", api.state.lastWait);
    // OPS-LIMIT-02: long-poll keeps the desktop far under 20 polls per minute.
    expect(api.state.lastWait).toBe("25");
  });

  it("@req ACCT-PAIR-01 @req PRIV-KEY-05 opens the sealed library key with its own private key and hands over the session", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    api.state.pollResponses.push({
      status: 200,
      body: {
        status: "approved",
        token: "session-token",
        user: USER,
        clientType: "badger-desktop",
        sealedKey: sealLibraryKey({
          devicePublicKey: api.state.created?.publicKey ?? "",
          requestId: started.requestId,
          libraryKey: LIBRARY_KEY,
        }),
      },
    });

    const result = await client.poll(started.requestId);

    expect(result).toEqual({ status: "approved", token: "session-token", user: USER, libraryKey: LIBRARY_KEY });
  });

  it("@req ACCT-PAIR-01 returns the approved result again when asked twice, because the API only delivers it once", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    api.state.pollResponses.push({
      status: 200,
      body: {
        status: "approved",
        token: "session-token",
        user: USER,
        sealedKey: sealLibraryKey({
          devicePublicKey: api.state.created?.publicKey ?? "",
          requestId: started.requestId,
          libraryKey: LIBRARY_KEY,
        }),
      },
    });
    const first = await client.poll(started.requestId);
    const second = await client.poll(started.requestId);
    expect(second).toEqual(first);
    expect(api.state.polls).toBe(1);
  });

  it("@req PRIV-KEY-05 reports an unreadable key when the phone sealed it to a different device", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    // Sealed to a throwaway key that is not the one this client generated.
    const strangerKey = sealLibraryKey({
      devicePublicKey: bytesToBase64(new Uint8Array(32).fill(9)),
      requestId: started.requestId,
      libraryKey: LIBRARY_KEY,
    });
    api.state.pollResponses.push({
      status: 200,
      body: { status: "approved", token: "session-token", user: USER, sealedKey: strangerKey },
    });
    expect(await client.poll(started.requestId)).toEqual({ status: "key_unreadable" });
  });

  it.each([
    ["denied", { status: 200, body: { status: "denied" } }, "denied"],
    ["expired", { status: 200, body: { status: "expired" } }, "expired"],
    ["consumed with no stored result", { status: 200, body: { status: "consumed" } }, "expired"],
    ["unknown request", { status: 404, body: { error: "pairing_not_found" } }, "expired"],
    ["gone request", { status: 410, body: { error: "pairing_expired" } }, "expired"],
  ])("@req ACCT-PAIR-01 treats a %s request as ended", async (_label, response, expected) => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    api.state.pollResponses.push(response);
    expect(await client.poll(started.requestId)).toEqual({ status: expected });
  });

  it("@req ACCT-PAIR-01 forgets the request after cancel", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    client.cancel();
    expect(await client.poll(started.requestId)).toEqual({ status: "expired" });
    expect(api.state.polls).toBe(0);
  });

  it("@req ACCT-PAIR-01 keeps the newest code when an older start finishes after it (React StrictMode double start)", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let posts = 0;
    const fetchImpl = (async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/pairing/requests") {
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
    const client = createDesktopPairingClient({
      getApiBaseUrl: () => "http://api.test",
      appId: "badger",
      fetchImpl,
      hostname: () => "pc",
      platform: "linux",
      log,
    });

    const slow = client.start();
    client.cancel();
    const fast = await client.start();
    releaseFirst();
    await slow;

    expect(await client.poll(fast.requestId)).toEqual({ status: "pending" });
    expect(await client.poll("req-1")).toEqual({ status: "expired" });
  });

  it("@req ACCT-PAIR-01 does not revive a request whose start was cancelled while in flight", async () => {
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchImpl = (async () => {
      await gate;
      return Response.json({
        requestId: "req-1",
        pollSecret: "secret-1",
        shortCode: "ABCD-EFGH",
        qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }) as unknown as typeof fetch;
    const client = createDesktopPairingClient({
      getApiBaseUrl: () => "http://api.test",
      appId: "badger",
      fetchImpl,
      hostname: () => "pc",
      platform: "linux",
      log,
    });
    const pending = client.start();
    client.cancel();
    releaseFirst();
    await pending;
    expect(await client.poll("req-1")).toEqual({ status: "expired" });
  });

  it("@req ACCT-PAIR-05 names the computer by its system and hostname, without the .local suffix", () => {
    expect(resolveDeviceName("Studio-Mac.local", "macos")).toBe("macOS (Studio-Mac)");
    expect(resolveDeviceName("chris-pc", "linux")).toBe("Linux (chris-pc)");
    expect(resolveDeviceName("DESKTOP-1", "windows")).toBe("Windows (DESKTOP-1)");
    expect(resolveDeviceName("  ", "linux")).toBe("Linux");
  });

  it("@req ACCT-PAIR-01 maps errors to a short failure the window can explain", () => {
    expect(pairingRefusalOf(new PairingHttpError(429, "slow down"))).toEqual({ error: "rate_limited", retryAfterMinutes: 15 });
    expect(pairingRefusalOf(new PairingHttpError(500, "boom"))).toEqual({ error: "failed" });
    expect(pairingRefusalOf(new TypeError("fetch failed"))).toEqual({ error: "unreachable" });
  });

  it("@req ACCT-AUTH-11 a 429 carries the API's wait, in whole minutes, to the window", async () => {
    const api = makeFakeApi();
    const client = makeClient(api);
    const started = await client.start();
    api.state.pollResponses.push({ status: 429, body: { error: "rate_limited", retryAfterSeconds: 125 } });
    const error = await client.poll(started.requestId).catch((err: unknown) => err);
    console.info("[pairing-main:429] poll refused", { error: String(error), refusal: pairingRefusalOf(error) });
    expect(error).toBeInstanceOf(PairingHttpError);
    expect((error as PairingHttpError).retryAfterSeconds).toBe(125);
    expect(pairingRefusalOf(error)).toEqual({ error: "rate_limited", retryAfterMinutes: 3 });
  });
});

describe("pairing client, key mode (the key screen of a signed-in computer)", () => {
  const approveKey = (api: ReturnType<typeof makeFakeApi>, requestId: string) =>
    api.state.pollResponses.push({
      status: 200,
      body: {
        status: "key_approved",
        user: USER,
        sealedKey: sealLibraryKey({ devicePublicKey: api.state.created?.publicKey ?? "", requestId, libraryKey: LIBRARY_KEY }),
      },
    });

  it("@req ACCT-PAIR-01 asks for the key only, with this computer's session, and hands that same session back", async () => {
    const api = makeFakeApi();
    const client = makeClient(api, "parrot", () => "own-session");
    const started = await client.start({ mode: "key" });
    console.info("[pairing-main:key-1] created", { path: api.state.createdPath, auth: api.state.headers?.authorization, app: api.state.headers?.["x-space-app"] });
    expect(api.state.createdPath).toBe("/pairing/key-requests");
    expect(api.state.headers?.authorization).toBe("Bearer own-session");
    expect(api.state.headers?.["x-space-app"]).toBe("parrot");
    expect(api.state.created?.deviceName).toBe("Linux (chris-pc)");
    expect(started.qrSvg).toContain("<svg");

    approveKey(api, started.requestId);
    const result = await client.poll(started.requestId);
    console.info("[pairing-main:key-1] poll", result);
    expect(result).toEqual({ status: "approved", token: "own-session", user: USER, libraryKey: LIBRARY_KEY });
  });

  it("@req ACCT-PAIR-01 refuses key mode without a session, before calling the API", async () => {
    const api = makeFakeApi();
    const signedOut = makeClient(api, "badger", () => null);
    const error = await signedOut.start({ mode: "key" }).catch((err: unknown) => err);
    console.info("[pairing-main:key-2] signed out", { error: String(error) });
    expect(error).toBeInstanceOf(PairingHttpError);
    expect(pairingRefusalOf(error)).toEqual({ error: "failed" });

    const noProvider = makeClient(api);
    await expect(noProvider.start({ mode: "key" })).rejects.toBeInstanceOf(PairingHttpError);
    expect(api.state.posts).toBe(0);
  });

  it("@req ACCT-PAIR-01 a sign-in start after a key start asks for a sign-in and polls the sign-in request", async () => {
    const api = makeFakeApi();
    const client = makeClient(api, "badger", () => "own-session");
    await client.start({ mode: "key" });
    expect(api.state.createdPath).toBe("/pairing/key-requests");
    const signIn = await client.start();
    console.info("[pairing-main:key-3] second start", { path: api.state.createdPath, auth: api.state.headers?.authorization ?? null });
    expect(api.state.createdPath).toBe("/pairing/requests");
    expect(api.state.headers?.authorization).toBeUndefined();
    api.state.pollResponses.push({
      status: 200,
      body: {
        status: "approved",
        token: "new-session",
        user: USER,
        sealedKey: sealLibraryKey({ devicePublicKey: api.state.created?.publicKey ?? "", requestId: signIn.requestId, libraryKey: LIBRARY_KEY }),
      },
    });
    // The sign-in core answers: the token is the new session the approval created, not this computer's old one.
    expect(await client.poll(signIn.requestId)).toEqual({ status: "approved", token: "new-session", user: USER, libraryKey: LIBRARY_KEY });
  });

  it("@req ACCT-PAIR-01 reads the start IPC's argument: only { mode: 'key' } is key mode", () => {
    expect(pairingModeOf({ mode: "key" })).toBe("key");
    expect(pairingModeOf({ mode: "sign_in" })).toBe("sign_in");
    expect(pairingModeOf(undefined)).toBe("sign_in");
    expect(pairingModeOf("key")).toBe("sign_in");
    expect(pairingModeOf(null)).toBe("sign_in");
  });
});
