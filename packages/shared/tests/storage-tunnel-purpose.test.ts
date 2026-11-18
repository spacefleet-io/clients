import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserStorageTunnelClient, StorageTunnelError } from "../src/storageTunnel";
import { isSubscriptionUnpaidError, readSubscriptionUnpaidWipeAt } from "../src/subscriptionUnpaid";

/**
 * Tunnel session `purpose` (#145 unpaid access): the API/gateway refuse
 * `playback` and `upload` sessions with 402 `subscription_unpaid` once the paid
 * period ended, but allow `export` (offline downloads, exports to standard
 * files). The client MUST therefore say why each session opens.
 */

const SUITE = "storage-tunnel-purpose";
const API = "http://api.test:3000";
const GATEWAY = "http://gw-1:3010";
const WIPE_AT = "2026-12-12T00:00:00.000Z";
/** STOR-BW-11: every Badger client carries the active profile; playback sessions require it. */
const PROFILE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

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

/** Minimal API + gateway over the HTTP fallback (no WebSocket). `unpaid` refuses playback/upload with 402. */
const installBackend = (options: { unpaid?: boolean } = {}) => {
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
      if (options.unpaid && body.purpose !== "export") {
        return Response.json({ error: "subscription_unpaid", wipeAt: WIPE_AT }, { status: 402 });
      }
      seq += 1;
      return Response.json({ sessionId: `sess-${seq}`, protocolVersion: 1, createdAt: 1, expiresAt: 2 });
    }
    if (url.endsWith("/storage/tunnel/frame")) {
      const frame = (body.frame ?? {}) as Record<string, unknown>;
      const kind = String(frame.kind ?? "");
      if (kind === "session.start" || kind === "session.end") return Response.json({ frame: { kind: "session.ack" } });
      if (kind === "upload.open") return Response.json({ frame: { kind: "upload.progress", uploadId: frame.uploadId } });
      if (kind === "upload.data") {
        return Response.json({ frame: { kind: "upload.ack", uploadId: frame.uploadId, seq: frame.seq } });
      }
      if (kind === "upload.close") return Response.json({ frame: { kind: "upload.complete", uploadId: frame.uploadId } });
      if (kind === "download.open") {
        return Response.json({
          frame: {
            kind: "download.data",
            downloadId: frame.downloadId,
            seq: 0,
            checksum,
            ciphertext: Array.from(payload),
          },
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
    getProfileId: () => PROFILE_ID,
    fetchImpl: fetchMock as unknown as typeof fetch,
    preferWebSocket: false,
    ...overrides,
  });

describe("storage tunnel session purpose", () => {
  it("defaults to playback for plain sessions and downloads", async () => {
    installBackend();
    const client = newClient({ tunnelMode: "direct" });
    console.info(`[${SUITE}:default] createSession + downloadObject without a purpose`);
    await client.createSession("token-1", "library/chunks/abc");
    await client.downloadObject("token-1", "library/chunks/abc", { downloadId: "d1" });
    dump("default");
    expect(sessionCalls().map((c) => c.body?.purpose)).toEqual(["playback", "playback"]);
    expect(sessionCalls().map((c) => c.body?.profileId)).toEqual([PROFILE_ID, PROFILE_ID]);
  });

  it("sends purpose export on offline-download/export sessions", async () => {
    installBackend();
    const client = newClient({ tunnelMode: "direct" });
    console.info(`[${SUITE}:export] downloadObject with purpose export`);
    const bytes = await client.downloadObject("token-1", "library/chunks/abc", { downloadId: "d1", purpose: "export" });
    dump("export");
    expect(Array.from(bytes)).toEqual(Array.from(payload));
    expect(sessionCalls()).toHaveLength(1);
    expect(sessionCalls()[0].body).toMatchObject({ purpose: "export" });
    // `intent: "upload"` is reserved for uploads.
    expect(sessionCalls()[0].body).not.toHaveProperty("intent");
  });

  it("carries purpose export through downloadObjectToSink", async () => {
    installBackend();
    const client = newClient({ tunnelMode: "direct" });
    const chunks: number[] = [];
    await client.downloadObjectToSink("token-1", "library/chunks/abc", (chunk) => void chunks.push(...chunk), {
      downloadId: "d2",
      purpose: "export",
    });
    dump("sink-export");
    expect(chunks).toEqual(Array.from(payload));
    expect(sessionCalls()[0].body?.purpose).toBe("export");
  });

  it("marks every upload session as purpose upload", async () => {
    installBackend();
    const client = newClient({ tunnelMode: "direct" });
    await client.uploadObject("token-1", "library/chunks/abc", new Uint8Array([1, 2]), { uploadId: "u1" });
    dump("upload");
    expect(sessionCalls()).toHaveLength(1);
    expect(sessionCalls()[0].url).toBe(`${GATEWAY}/storage/tunnel/session`);
    expect(sessionCalls()[0].body).toMatchObject({ purpose: "upload" });
  });

  it("sends the purpose to the gateway in direct mode", async () => {
    installBackend();
    const client = newClient({ tunnelMode: "direct" });
    await client.uploadObject("token-1", "library/chunks/abc", new Uint8Array([1, 2]), { uploadId: "u1" });
    await client.downloadObject("token-1", "library/chunks/abc", { downloadId: "d1", purpose: "export" });
    dump("direct");
    const sessions = sessionCalls();
    expect(sessions.map((c) => c.url)).toEqual([`${GATEWAY}/storage/tunnel/session`, `${GATEWAY}/storage/tunnel/session`]);
    expect(sessions.map((c) => c.body?.purpose)).toEqual(["upload", "export"]);
  });

  it("surfaces a 402 subscription_unpaid on playback and upload but lets export through", async () => {
    installBackend({ unpaid: true });
    const client = newClient({ tunnelMode: "direct" });

    const playback = await client.createSession("token-1", "library/chunks/abc").catch((err: unknown) => err);
    const upload = await client
      .uploadObject("token-1", "library/chunks/abc", new Uint8Array([1]), { uploadId: "u1" })
      .catch((err: unknown) => err);
    dump("unpaid");
    for (const err of [playback, upload]) {
      expect(err).toBeInstanceOf(StorageTunnelError);
      expect((err as StorageTunnelError).status).toBe(402);
      expect(isSubscriptionUnpaidError(err)).toBe(true);
      expect(readSubscriptionUnpaidWipeAt(err)).toBe(WIPE_AT);
    }

    const bytes = await client.downloadObject("token-1", "library/chunks/abc", { downloadId: "d1", purpose: "export" });
    expect(Array.from(bytes)).toEqual(Array.from(payload));
  });

  it("treats a 402 as final in waterfall mode: no other address, never the API", async () => {
    installBackend({ unpaid: true });
    const client = newClient({ tunnelMode: "waterfall" });
    const err = await client.createSession("token-1", "library/chunks/abc").catch((e: unknown) => e);
    dump("waterfall-402");
    expect(isSubscriptionUnpaidError(err)).toBe(true);
    // One direct attempt, then the 402 is final — no other candidate and no `${API}/storage/tunnel/session`.
    console.info(`[${SUITE}:waterfall-402] session urls=${JSON.stringify(sessionCalls().map((c) => c.url))}`);
    expect(sessionCalls().map((c) => c.url)).toEqual([`${GATEWAY}/storage/tunnel/session`]);
    expect(sessionCalls().filter((c) => c.url.startsWith(API))).toHaveLength(0);
  });
});

describe("isSubscriptionUnpaidError", () => {
  it("only matches status 402 with the subscription_unpaid code", () => {
    expect(isSubscriptionUnpaidError(new StorageTunnelError(402, { error: "subscription_unpaid", wipeAt: WIPE_AT }))).toBe(true);
    expect(isSubscriptionUnpaidError(new StorageTunnelError(402, { error: "other" }))).toBe(false);
    expect(isSubscriptionUnpaidError(new StorageTunnelError(403, { error: "subscription_unpaid" }))).toBe(false);
    expect(isSubscriptionUnpaidError(new Error("subscription_unpaid"))).toBe(false);
    expect(isSubscriptionUnpaidError(null)).toBe(false);
  });

  it("reads wipeAt only when it is a valid ISO date", () => {
    expect(readSubscriptionUnpaidWipeAt(new StorageTunnelError(402, { error: "subscription_unpaid", wipeAt: WIPE_AT }))).toBe(WIPE_AT);
    expect(readSubscriptionUnpaidWipeAt(new StorageTunnelError(402, { error: "subscription_unpaid", wipeAt: "nope" }))).toBeNull();
    expect(readSubscriptionUnpaidWipeAt(new StorageTunnelError(402, { error: "subscription_unpaid" }))).toBeNull();
  });
});
