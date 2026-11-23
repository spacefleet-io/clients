import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64ToBytes, commitmentFingerprint, commitmentOpens, generateDeviceKeyPair, newPairingNonce, pairingCheckCode, sealLibraryKey } from "@space/pairing-crypto";
import { loadIntegrationConfig } from "../src/config";
import { encryptLibraryEnvelope, parseLibraryKey, verifyKeyProbe } from "../src/mediaCrypto";
import { PairingFlow, type PairingResult } from "../src/pairing";
import { IntegrationRuntime } from "../src/runtime";
import { handleIntegrationRequest, type IntegrationDeps, type IntegrationStatus } from "../src/server";

const libraryKey = crypto.randomBytes(32);
const libraryKeyBase64 = libraryKey.toString("base64");

/** In-memory stand-in for the api's pairing routes, protocol 2 (PRIV-PAIR-01): `approverNonce` set = an app connected. */
const fakePairingApi = () => {
  const state = {
    requestId: "11111111-2222-4333-8444-555555555555",
    pollSecret: "secret",
    publicKey: "",
    commitment: "",
    approverNonce: null as string | null,
    requesterNonce: null as string | null,
    reveals: 0,
    approved: false,
    deviceName: "",
    deviceType: "",
    polls: 0,
    lastWait: null as string | null,
    /** A lying server: keeps the first reveal's number, answers 500, then shows this approver number from now on. */
    swapNonceOnFirstReveal: null as string | null,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/pairing/requests" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { publicKey: string; deviceName: string; deviceType: string; commitment: string };
      state.publicKey = body.publicKey;
      state.commitment = body.commitment;
      state.deviceName = body.deviceName;
      state.deviceType = body.deviceType;
      return json({
        requestId: state.requestId,
        pollSecret: state.pollSecret,
        // An API from before Chris 2026-11-18 sent the dash; the sidecar still hands on the plain 8 characters.
        shortCode: "ABCD-EFGH",
        qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }, 201);
    }
    if (url.pathname === `/pairing/requests/${state.requestId}/reveal` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { pollSecret: string; requesterNonce: string };
      state.reveals += 1;
      if (body.pollSecret !== state.pollSecret) return json({ error: "pairing_not_found" }, 404);
      if (!state.approverNonce) return json({ error: "pairing_check_pending" }, 409);
      if (!commitmentOpens(state.commitment, state.publicKey, body.requesterNonce)) return json({ error: "pairing_commitment_mismatch" }, 400);
      state.requesterNonce = body.requesterNonce;
      if (state.swapNonceOnFirstReveal && state.reveals === 1) {
        state.approverNonce = state.swapNonceOnFirstReveal;
        return json({ error: "internal" }, 500);
      }
      return json({ ok: true });
    }
    if (url.pathname === `/pairing/requests/${state.requestId}`) {
      state.polls += 1;
      state.lastWait = url.searchParams.get("wait");
      if (url.searchParams.get("pollSecret") !== state.pollSecret) return json({ error: "forbidden" }, 403);
      if (!state.approved) {
        const showNonce = state.approverNonce && (!state.requesterNonce || state.swapNonceOnFirstReveal);
        return json(showNonce ? { status: "pending", approverNonce: state.approverNonce } : { status: "pending" });
      }
      const sealed = sealLibraryKey({ devicePublicKey: state.publicKey, requestId: state.requestId, libraryKey: new Uint8Array(libraryKey) });
      return json({ status: "approved", token: "device-token", user: { id: "u1", email: "me@example.com" }, sealedKey: sealed, clientType: "badger-jellyfin" });
    }
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;
  return { state, fetchImpl };
};

describe("pairing flow (new-device side)", () => {
  it("@req ACCT-PAIR-01[badger-jellyfin] @req PRIV-KEY-05[badger-jellyfin] requests a code, polls, and opens the sealed library key with the device's own private key", async () => {
    const api = fakePairingApi();
    const results: PairingResult[] = [];
    const flow = new PairingFlow({
      log: () => undefined,
      deviceType: "jellyfin",
      fetchImpl: api.fetchImpl,
      pollIntervalMs: 10,
      onApproved: async (result) => {
        results.push(result);
        return "approved";
      },
    });

    const started = await flow.start({ apiUrl: "http://api.test/", deviceName: "Chris Jellyfin" });
    // @bugfix @regression-proof Chris 2026-11-18: no dash in the code the Jellyfin page shows.
    expect(started.shortCode).toBe("ABCDEFGH");
    expect(started.qrPayload).toBe(`https://spacefleet.io/pair/badger?code=ABCDEFGH#c=${commitmentFingerprint(api.state.commitment)}`);
    expect(started.checkCode).toBeNull();
    expect(api.state.deviceType).toBe("jellyfin");
    expect(api.state.deviceName).toBe("Chris Jellyfin");
    expect(base64ToBytes(api.state.publicKey)).toHaveLength(32);

    await vi.waitFor(() => expect(api.state.polls).toBeGreaterThanOrEqual(2));
    console.info("[integration-pairing] poll wait param", api.state.lastWait);
    // OPS-LIMIT-02: long-poll keeps the sidecar far under 20 polls per minute.
    expect(api.state.lastWait).toBe("25");
    expect(flow.snapshot()?.state).toBe("pending");
    expect(results).toHaveLength(0);

    api.state.approved = true;
    await vi.waitFor(() => expect(flow.snapshot()?.state).toBe("approved"));
    expect(results[0]?.token).toBe("device-token");
    expect(results[0]?.libraryKeyBase64).toBe(libraryKeyBase64);
    expect(results[0]?.apiUrl).toBe("http://api.test");
  });

  it("@req PRIV-KEY-05[badger-jellyfin] a sealed key made for another device is refused", async () => {
    const api = fakePairingApi();
    const flow = new PairingFlow({ log: () => undefined, deviceType: "jellyfin", fetchImpl: api.fetchImpl, pollIntervalMs: 10, onApproved: async () => "approved" });
    await flow.start({ apiUrl: "http://api.test", deviceName: "x" });
    api.state.publicKey = generateDeviceKeyPair().publicKey;
    api.state.approved = true;
    await vi.waitFor(() => expect(flow.snapshot()?.state).toBe("failed"));
    flow.cancel();
  });

  it("reports an expired code", async () => {
    const api = fakePairingApi();
    let now = Date.now();
    const flow = new PairingFlow({ log: () => undefined, deviceType: "jellyfin", fetchImpl: api.fetchImpl, pollIntervalMs: 10, now: () => now, onApproved: async () => "approved" });
    await flow.start({ apiUrl: "http://api.test", deviceName: "x" });
    now += 400_000;
    expect(flow.snapshot()?.state).toBe("expired");
    flow.cancel();
  });

  /**
   * @test-id JELLYFIN-PAIR-CHECK-001
   * @req PRIV-PAIR-01 PRIV-PAIR-04
   * @why Chris 2026-11-23 ("yes that'd be better"): the Jellyfin page is a receiving device; it must send a commitment,
   *   reveal its number only once an approving app connected, and show the six digits that app shows.
   */
  it("@req PRIV-PAIR-01[badger-jellyfin] @req PRIV-PAIR-04[badger-jellyfin] commits, reveals once an app connected, and shows the same check code", async () => {
    const api = fakePairingApi();
    const flow = new PairingFlow({ log: () => undefined, deviceType: "jellyfin", fetchImpl: api.fetchImpl, pollIntervalMs: 10, onApproved: async () => "approved" });
    await flow.start({ apiUrl: "http://api.test", deviceName: "x" });
    expect(base64ToBytes(api.state.commitment)).toHaveLength(32);
    await vi.waitFor(() => expect(api.state.polls).toBeGreaterThanOrEqual(2));
    console.info("[jellyfin-pair-check] phase: no app yet", { reveals: api.state.reveals });
    expect(api.state.reveals).toBe(0);
    expect(flow.snapshot()?.checkCode).toBeNull();

    api.state.approverNonce = newPairingNonce();
    await vi.waitFor(() => expect(flow.snapshot()?.checkCode).toMatch(/^\d{6}$/));
    // The approving app computes its code from what it read: the same digits.
    const theirs = pairingCheckCode({ publicKey: api.state.publicKey, commitment: api.state.commitment, approverNonce: api.state.approverNonce, requesterNonce: api.state.requesterNonce! });
    console.info("[jellyfin-pair-check] phase: revealed", { reveals: api.state.reveals, same: theirs === flow.snapshot()?.checkCode });
    expect(flow.snapshot()?.checkCode).toBe(theirs);
    const polls = api.state.polls;
    await vi.waitFor(() => expect(api.state.polls).toBeGreaterThan(polls + 1));
    expect(api.state.reveals).toBe(1);

    api.state.approved = true;
    await vi.waitFor(() => expect(flow.snapshot()?.state).toBe("approved"));
  });

  /**
   * Found by the sf-pair-v2 TLA+ model: a server that keeps the reveal but answers 500, then shows another approver
   * number, knows this service's number by then and could grind its new number until the code matches one it controls on
   * the approving app. The code must stay the one built from the first number.
   */
  it("@req PRIV-PAIR-01[badger-jellyfin] a failed reveal does not let the server swap the approver number", async () => {
    const api = fakePairingApi();
    const logs: string[] = [];
    const flow = new PairingFlow({ log: (message) => logs.push(message), deviceType: "jellyfin", fetchImpl: api.fetchImpl, pollIntervalMs: 10, onApproved: async () => "approved" });
    await flow.start({ apiUrl: "http://api.test", deviceName: "x" });
    const first = newPairingNonce();
    const swapped = newPairingNonce();
    api.state.swapNonceOnFirstReveal = swapped;
    api.state.approverNonce = first;
    await vi.waitFor(() => expect(flow.snapshot()?.checkCode).toMatch(/^\d{6}$/));
    const codeFor = (approverNonce: string) =>
      pairingCheckCode({ publicKey: api.state.publicKey, commitment: api.state.commitment, approverNonce, requesterNonce: api.state.requesterNonce! });
    console.info("[jellyfin-pair-check] lying server", { reveals: api.state.reveals, shown: flow.snapshot()?.checkCode, first: codeFor(first), swapped: codeFor(swapped), logs });
    expect(api.state.reveals).toBe(2);
    expect(flow.snapshot()?.checkCode).toBe(codeFor(first));
    expect(flow.snapshot()?.checkCode).not.toBe(codeFor(swapped));
    expect(logs).toContain("pairing approver number changed; ignored, the first one stays");
    flow.cancel();
  });
});

describe("library key probe (same check as typing the key by hand)", () => {
  it("@req PRIV-KEY-05[badger-jellyfin] accepts the right key and refuses a wrong one", () => {
    const probe = encryptLibraryEnvelope(parseLibraryKey(libraryKeyBase64), crypto.randomBytes(32)).toString("base64");
    expect(verifyKeyProbe(libraryKeyBase64, probe)).toBe(true);
    expect(verifyKeyProbe(crypto.randomBytes(32).toString("base64"), probe)).toBe(false);
    expect(verifyKeyProbe("not-a-key", probe)).toBe(false);
  });
});

const status = (overrides: Partial<IntegrationStatus> = {}): IntegrationStatus => ({
  state: "ok", signedIn: true, email: null, userId: null, accessState: "paid", paidUntil: null, wipeAt: null, libraryVersion: 1, mediaCount: 0,
  lastSyncAt: null, lastError: null, apiUrl: "http://api", version: "0", pairing: null, signedOutReason: null, keyRejected: false, profile: null, profiles: null, profileNeeded: null,
  updateRequired: null, ...overrides,
});

const deps = (overrides: Partial<IntegrationDeps> = {}): IntegrationDeps => ({
  getStatus: () => status(),
  isLibraryReady: () => true,
  isStarting: () => false,
  getLibrary: () => ({ version: 1, generatedAt: "now", movies: [], shows: [] }) as never,
  getDetails: () => ({ id: "show", type: "tv" }) as never,
  objectStore: { get: async () => Buffer.alloc(0), registerSequence: () => undefined, prefetch: () => undefined },
  loadImage: async () => ({ bytes: new Uint8Array(), contentType: "image/png" }),
  recordProgress: async () => undefined,
  getTrackPrefs: () => ({ audioLanguage: null, subtitle: null, updatedAt: null }),
  setTrackPrefs: async () => ({ audioLanguage: null, subtitle: null, updatedAt: null }),
  deleteMedia: async () => ({ deletedKeys: 0, reclaimedBytes: 0 }),
  deleteEpisode: async () => ({ deletedKeys: 0, reclaimedBytes: 0, deletedFile: true }),
  startPairing: async () => {
    throw new Error("unused");
  },
  cancelPairing: () => undefined,
  currentVersion: () => 1,
  waitForChange: async (since) => since,
  login: async () => status(),
  signOut: async () => undefined,
  chooseProfile: async () => status(),
  listProfiles: async () => ({ profile: null, profiles: [], required: false }),
  streams: { start: async () => ({ status: "play", takeover: false }), poll: () => ({ status: "idle" }), stop: async () => {} },
  log: () => undefined,
  ...overrides,
});

describe("sidecar routes", () => {
  it("@req INTG-DEL-01[badger-jellyfin] DELETE media/<id>/<episodeId> deletes one episode, DELETE media/<id> the whole title", async () => {
    const deleteEpisode = vi.fn(async () => ({ deletedKeys: 4, reclaimedBytes: 9, deletedFile: true }));
    const deleteMedia = vi.fn(async () => ({ deletedKeys: 1, reclaimedBytes: 1 }));
    const handlers = deps({ deleteEpisode, deleteMedia });
    const one = await handleIntegrationRequest(new Request("http://127.0.0.1:8790/integration/v1/media/show/ep2", { method: "DELETE" }), handlers);
    expect(one.status).toBe(200);
    expect(deleteEpisode).toHaveBeenCalledWith("show", "ep2");
    expect(deleteMedia).not.toHaveBeenCalled();
    await handleIntegrationRequest(new Request("http://127.0.0.1:8790/integration/v1/media/show", { method: "DELETE" }), handlers);
    expect(deleteMedia).toHaveBeenCalledWith("show");
  });

  it("@req ACCT-PAIR-01[badger-jellyfin] pairing/start returns the code and pairing/status reports it", async () => {
    const pairing = { state: "pending", requestId: "r", shortCode: "ABCDEFGH", qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH", checkCode: null, expiresAt: "2030-01-01T00:00:00Z", deviceName: "Jf", error: null } as const;
    const startPairing = vi.fn(async () => pairing);
    const handlers = deps({ startPairing, getStatus: () => status({ state: "needs_login", signedIn: false, pairing }), isLibraryReady: () => false });
    const start = await handleIntegrationRequest(new Request("http://127.0.0.1:8790/integration/v1/pairing/start", { method: "POST", body: JSON.stringify({ deviceName: "Jf" }) }), handlers);
    expect(start.status).toBe(200);
    expect(startPairing).toHaveBeenCalledWith({ deviceName: "Jf", apiUrl: null });
    expect(((await start.json()) as { shortCode: string }).shortCode).toBe("ABCDEFGH");
    const polled = await handleIntegrationRequest(new Request("http://127.0.0.1:8790/integration/v1/pairing/status"), handlers);
    expect(((await polled.json()) as { pairing: { shortCode: string } }).pairing.shortCode).toBe("ABCDEFGH");
  });
});

describe("sign-out (ACCT-DEV-01, PRIV-KEY-05)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("@req ACCT-DEV-01[badger-jellyfin] @req PRIV-KEY-05[badger-jellyfin] a revoked device (api 401) wipes the key file and state and reports signed_out, which survives a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-intg-signout-"));
    dirs.push(dir);
    const keyFile = path.join(dir, "library.key");
    const stateDir = path.join(dir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(keyFile, `${libraryKeyBase64}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, "auth.json"), JSON.stringify({ token: "t", email: "a@b.c", userId: "u", apiUrl: "http://api.test" }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      return new Response(JSON.stringify({ exists: false }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const config = loadIntegrationConfig({ HEADLESS_STATE_DIR: stateDir, HEADLESS_LIBRARY_KEY_FILE: keyFile, HEADLESS_API_URL: "http://api.test", HEADLESS_DEV_TICKET_KEY: "1" });
      const runtime = new IntegrationRuntime(config, () => undefined);
      await runtime.start();
      // a library open failure with a 401 triggers /auth/me, which answers 401: private refreshAccess is what the 60 s timer runs
      await (runtime as unknown as { refreshAccess(): Promise<void> }).refreshAccess();
      await runtime.stop();
      expect(fs.existsSync(keyFile)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "auth.json"))).toBe(false);
      expect(runtime.status().state).toBe("signed_out");
      expect(runtime.status().signedOutReason).toBe("api_401");

      const restarted = new IntegrationRuntime(config, () => undefined);
      await restarted.start();
      await restarted.stop();
      expect(restarted.status().state).toBe("signed_out");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
