import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageTunnelError, createUserStorageTunnelClient } from "../src/storageTunnel";

/**
 * STOR-BW-11: every playback session names the profile it plays for, the main profile's real id included on a single-profile
 * account. The shared client sends it in every tunnel mode (direct, waterfall), refuses to open a playback session
 * without one before any request (a missing profile is a client bug, never guessed), and asks the traffic report of that profile.
 * Export, library and upload sessions need none; no app is exempted.
 */

const SUITE = "storage-tunnel-playback-profile";
const API = "http://api.test:3000";
const GATEWAY = "http://gw-1:3010";
const MAIN_PROFILE = "0b6f3c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
const KID_PROFILE = "9e8f7a6b-5c4d-4e3f-8a1b-2c3d4e5f6a7b";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  console.info(`[${SUITE}:teardown] resetting fetch mock (calls=${fetchMock.mock.calls.length})`);
  fetchMock.mockReset();
});

type Call = { url: string; body: Record<string, unknown> | null };

const calls = (): Call[] =>
  fetchMock.mock.calls.map(([url, init]) => {
    const raw = (init as RequestInit | undefined)?.body;
    return { url: String(url), body: typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null };
  });

const sessionCalls = () => calls().filter((c) => c.url.endsWith("/storage/tunnel/session"));

const dump = (label: string) => console.info(`[${SUITE}:${label}] fetch calls:\n${JSON.stringify(calls(), null, 2)}`);

const payload = new Uint8Array([9, 8, 7]);
const checksum = `sha256:${createHash("sha256").update(payload).digest("hex")}`;

/** Minimal API + gateway over the HTTP fallback. A playback session without `profileId` gets the server's 400, as it would for real. */
const installBackend = () => {
  let seq = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url === `${API}/storage/placement`) {
      return Response.json({
        policy: {
          policy: "rendezvous-v1",
          epoch: 1,
          seed: "s",
          replicaCount: 1,
          shards: [{ id: "gw-1", gatewayUrl: GATEWAY, weight: 1, status: "active" }],
        },
      });
    }
    if (url.endsWith("/storage/tunnel/session")) {
      if ((body.purpose ?? "playback") === "playback" && !body.profileId) {
        return Response.json({ error: "profile_required" }, { status: 400 });
      }
      seq += 1;
      return Response.json({ sessionId: `sess-${seq}`, protocolVersion: 1, createdAt: 1, expiresAt: 2 });
    }
    if (url.includes("/storage/traffic")) {
      return Response.json({ traffic: { state: "normal", saturated: false } });
    }
    if (url.endsWith("/storage/tunnel/frame")) {
      const frame = (body.frame ?? {}) as Record<string, unknown>;
      const kind = String(frame.kind ?? "");
      if (kind === "session.start" || kind === "session.end") return Response.json({ frame: { kind: "session.ack" } });
      if (kind === "download.open") {
        return Response.json({
          frame: { kind: "download.data", downloadId: frame.downloadId, seq: 0, checksum, ciphertext: Array.from(payload) },
        });
      }
      return Response.json({ frame: { kind: "download.complete", downloadId: frame.downloadId } });
    }
    return new Response(JSON.stringify({ error: "unexpected", url }), { status: 500 });
  });
};

const newClient = (overrides: Partial<Parameters<typeof createUserStorageTunnelClient>[0]> = {}) =>
  createUserStorageTunnelClient({
    getApiBaseUrl: () => API,
    fetchImpl: fetchMock as unknown as typeof fetch,
    preferWebSocket: false,
    ...overrides,
  });

describe("a playback session names its profile @req STOR-BW-11[api]", () => {
  it.each(["direct", "waterfall"] as const)(
    "sends the client's profile on every playback session (%s), the main profile's id on a single-profile account",
    async (tunnelMode) => {
      installBackend();
      const client = newClient({ tunnelMode, getProfileId: () => MAIN_PROFILE });
      await client.createSession("token-1", "library/chunks/abc");
      await client.downloadObject("token-1", "library/chunks/abc", { downloadId: "d1" });
      dump(`client-profile-${tunnelMode}`);
      expect(sessionCalls().map((c) => c.body?.profileId)).toEqual([MAIN_PROFILE, MAIN_PROFILE]);
    }
  );

  it("a per-call profile wins over the client's (one client serving several profiles)", async () => {
    installBackend();
    const client = newClient({ tunnelMode: "direct", getProfileId: () => MAIN_PROFILE });
    await client.createSession("token-1", "library/chunks/abc", { profileId: KID_PROFILE });
    await client.downloadObjectToSink("token-1", "library/chunks/abc", () => undefined, { downloadId: "d2", profileId: KID_PROFILE });
    dump("per-call");
    expect(sessionCalls().map((c) => c.body?.profileId)).toEqual([KID_PROFILE, KID_PROFILE]);
  });

  it.each(["direct", "waterfall"] as const)(
    "refuses a playback session without a profile before any request (%s): profile_required, never guessed",
    async (tunnelMode) => {
      installBackend();
      const client = newClient({ tunnelMode, getProfileId: () => null });
      const error = await client.createSession("token-1", "library/chunks/abc").catch((caught: unknown) => caught);
      dump(`missing-${tunnelMode}`);
      expect(error).toBeInstanceOf(StorageTunnelError);
      expect((error as StorageTunnelError).code).toBe("profile_required");
      expect((error as StorageTunnelError).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(newClient({ tunnelMode }).downloadObject("token-1", "library/chunks/abc")).rejects.toMatchObject({
        code: "profile_required",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("sends no profile with export and library sessions", async () => {
    installBackend();
    const client = newClient({ tunnelMode: "direct", getProfileId: () => MAIN_PROFILE });
    await client.createSession("token-1", "library/chunks/abc", { purpose: "export" });
    await client.createSession("token-1", "library/chunks/abc", { purpose: "library" });
    dump("no-profile-purposes");
    expect(sessionCalls().map((c) => c.body?.profileId ?? null)).toEqual([null, null]);
  });

  it("refuses a Parrot playback without a profile like any other client @req STOR-BW-11[api]", async () => {
    installBackend();
    const parrot = newClient({ tunnelMode: "direct", getAppId: () => "parrot", getProfileId: () => null });
    const error = await parrot.createSession("token-1", "library/chunks/abc").catch((caught: unknown) => caught);
    dump("parrot-missing");
    expect(error).toBeInstanceOf(StorageTunnelError);
    expect(error).toMatchObject({ status: 400, code: "profile_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the traffic report of the playing profile from the silo's gateway (never the API)", async () => {
    installBackend();
    await newClient({ tunnelMode: "direct", getProfileId: () => KID_PROFILE }).refreshTraffic("token-1", "library/chunks/abc");
    dump("traffic");
    const trafficUrls = calls()
      .map((c) => c.url)
      .filter((url) => url.includes("/storage/traffic"));
    expect(trafficUrls).toEqual([`${GATEWAY}/storage/traffic?profileId=${KID_PROFILE}`]);
    expect(trafficUrls.some((url) => url.startsWith(API))).toBe(false);
  });
});
