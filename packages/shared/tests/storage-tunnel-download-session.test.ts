import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserStorageTunnelClient } from "../src/storageTunnel";

/**
 * STOR-REUSE-02: many objects of one media are downloaded through one playback session (created, started and ended
 * once) instead of a session per object (2026-11-21: a Parrot song's 1 MiB chunks paid ~0.9 s of session each, 13 s
 * before a song whose index sits at its end started). Each object still has its own download.open / download.close.
 * A failed download drops the session and is tried once more on a fresh one; a key of another media gets its own
 * session; a late frame of the download before on the reused websocket never ends the next download.
 * @bugfix @regression-proof
 */

const SUITE = "storage-tunnel-download-session";
const API = "http://api.test:3000";
const GATEWAY = "http://silo-a:3010";
const PID = "0f8c2a3e-1b2c-4d5e-8f90-123456789abc";
const OTHER_PID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PROFILE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

const bytesOf = (objectKey: string) => new TextEncoder().encode(`bytes of ${objectKey}`);
const dataFrame = (downloadId: unknown, objectKey: string) => {
  const payload = bytesOf(objectKey);
  return {
    kind: "download.data",
    downloadId,
    seq: 0,
    checksum: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
    ciphertext: Array.from(payload),
  };
};

type Event = { route: "session" | "frame"; sessionId?: string; kind?: string; objectKey?: string; prefix?: unknown };

/** API + silo gateway. `failOpen` refuses the download of the keys it names, once each. */
const installGateway = (failOpen = new Set<string>()) => {
  const events: Event[] = [];
  const openKeys = new Map<string, string>();
  let sessionSeq = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url === `${API}/storage/placement/media/resolve`) {
      const ids = (body.placementIds as string[]) ?? [];
      return Response.json({
        placements: ids.map((placementId) => ({
          placementId,
          poolId: "silo-a",
          shard: { id: "silo-a", gatewayUrl: GATEWAY, weight: 1, status: "active", addresses: [] },
        })),
      });
    }
    if (url.includes("/storage/traffic")) return Response.json({ traffic: { state: "normal", saturated: false } });
    if (url.endsWith("/storage/tunnel/session")) {
      sessionSeq += 1;
      events.push({ route: "session", sessionId: `sess-${sessionSeq}`, prefix: body.objectKeyPrefix ?? body.objectKey });
      return Response.json({ sessionId: `sess-${sessionSeq}`, protocolVersion: 1, createdAt: 1, expiresAt: 2 });
    }
    if (url.endsWith("/storage/tunnel/frame")) {
      const frame = (body.frame ?? {}) as Record<string, unknown>;
      const kind = String(frame.kind ?? "");
      const sessionId = String(body.sessionId);
      if (kind === "download.open") openKeys.set(String(frame.downloadId), String(frame.objectKey));
      const objectKey = kind.startsWith("download.") ? openKeys.get(String(frame.downloadId)) : undefined;
      events.push({ route: "frame", sessionId, kind, ...(objectKey ? { objectKey } : {}) });
      if (kind === "session.start" || kind === "session.end") return Response.json({ frame: { kind: "session.ack" } });
      if (kind === "download.open") {
        if (objectKey && failOpen.delete(objectKey)) {
          return Response.json({ frame: { kind: "download.error", downloadId: frame.downloadId, error: "read_failed" } });
        }
        return Response.json({ frame: dataFrame(frame.downloadId, objectKey ?? "") });
      }
      return Response.json({ frame: { kind: "download.complete", downloadId: frame.downloadId } });
    }
    return new Response(JSON.stringify({ error: "unexpected", url }), { status: 500 });
  });
  return events;
};

const newClient = (overrides: Partial<Parameters<typeof createUserStorageTunnelClient>[0]> = {}) =>
  createUserStorageTunnelClient({
    getApiBaseUrl: () => API,
    getProfileId: () => PROFILE_ID,
    fetchImpl: fetchMock as unknown as typeof fetch,
    preferWebSocket: false,
    ...overrides,
  });

const kinds = (events: Event[], kind: string) => events.filter((event) => event.kind === kind);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// @req STOR-REUSE-02
describe("storage tunnel reused download session", () => {
  it("downloads many objects of one media through one session, each with its own open and close", async () => {
    const events = installGateway();
    const keys = ["c0", "c1", "c2", "c3"].map((name) => `media/${PID}/${name}`);
    const session = newClient().createDownloadSession("token-1", { objectKey: keys[0]!, profileId: PROFILE_ID, clientType: "parrot-test" });
    const got = await Promise.all(keys.map((key) => session.download(key)));
    console.info(`[${SUITE}:reuse] before close`, JSON.stringify(events));
    expect(got.map(decode)).toEqual(keys.map((key) => decode(bytesOf(key))));
    expect(events.filter((event) => event.route === "session")).toHaveLength(1);
    expect(kinds(events, "session.start")).toHaveLength(1);
    expect(kinds(events, "download.open").map((event) => [event.sessionId, event.objectKey])).toEqual(keys.map((key) => ["sess-1", key]));
    expect(kinds(events, "download.close")).toHaveLength(keys.length);
    expect(kinds(events, "session.end")).toEqual([]);

    await session.close();
    expect(kinds(events, "session.end")).toEqual([{ route: "frame", sessionId: "sess-1", kind: "session.end" }]);
    await expect(session.download(keys[0]!)).rejects.toThrow("TUNNEL_DOWNLOAD_SESSION_CLOSED");
  });

  it("drops a session whose download failed, retries that object on a fresh session and opens a new one after", async () => {
    const keys = ["c0", "c1", "c2"].map((name) => `media/${PID}/${name}`);
    const events = installGateway(new Set([keys[1]!]));
    const session = newClient().createDownloadSession("token-1", { objectKey: keys[0]!, profileId: PROFILE_ID });
    const got: string[] = [];
    for (const key of keys) got.push(decode(await session.download(key)));
    await session.close();
    console.info(`[${SUITE}:fallback]`, JSON.stringify(events));
    expect(got).toEqual(keys.map((key) => decode(bytesOf(key))));
    // sess-1 carried c0 and the refused c1; sess-2 is c1's own retry; sess-3 the new reused session for c2.
    expect(events.filter((event) => event.route === "session").map((event) => event.sessionId)).toEqual(["sess-1", "sess-2", "sess-3"]);
    expect(kinds(events, "download.open").map((event) => [event.sessionId, event.objectKey])).toEqual([
      ["sess-1", keys[0]],
      ["sess-1", keys[1]],
      ["sess-2", keys[1]],
      ["sess-3", keys[2]],
    ]);
    expect(kinds(events, "session.end").map((event) => event.sessionId).sort()).toEqual(["sess-1", "sess-2", "sess-3"]);
  });

  it("downloads a key of another media on a session of its own", async () => {
    const events = installGateway();
    const session = newClient().createDownloadSession("token-1", { objectKey: `media/${PID}/c0`, profileId: PROFILE_ID });
    await session.download(`media/${PID}/c0`);
    const other = await session.download(`media/${OTHER_PID}/c0`);
    await session.download(`media/${PID}/c1`);
    await session.close();
    console.info(`[${SUITE}:other-media]`, JSON.stringify(events));
    expect(decode(other)).toBe(decode(bytesOf(`media/${OTHER_PID}/c0`)));
    expect(kinds(events, "download.open").map((event) => event.sessionId)).toEqual(["sess-1", "sess-2", "sess-1"]);
  });

  it("skips a late frame of the download before on the reused websocket", async () => {
    installGateway();
    const sent: Array<Record<string, unknown>> = [];
    class Ws {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;
      constructor(_url: string) {
        queueMicrotask(() => this.onopen?.({}));
      }
      private reply(frame: Record<string, unknown>) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ frame }) }));
      }
      send(data: unknown) {
        if (typeof data !== "string") throw new Error("binary frame not expected in this test");
        const frame = (JSON.parse(data) as { frame: Record<string, unknown> }).frame;
        sent.push(frame);
        const kind = String(frame.kind ?? "");
        if (kind === "session.start" || kind === "session.end") this.reply({ kind: "session.ack" });
        if (kind === "download.open") {
          this.reply(dataFrame(frame.downloadId, String(frame.objectKey)));
          this.reply({ kind: "download.complete", downloadId: frame.downloadId });
        }
        if (kind === "download.close") {
          // The gateway's answer to a close can trail a last progress frame: the close reads that one, and the
          // `download.complete` stays queued on the socket for the next download.
          this.reply({ kind: "download.progress", downloadId: frame.downloadId, bytesRemaining: 0 });
          this.reply({ kind: "download.complete", downloadId: frame.downloadId });
        }
      }
      close() {
        this.onclose?.({});
      }
    }
    const client = newClient({ preferWebSocket: true, WebSocketImpl: Ws as never });
    const keys = ["c0", "c1", "c2"].map((name) => `media/${PID}/${name}`);
    const session = client.createDownloadSession("token-1", { objectKey: keys[0]!, profileId: PROFILE_ID });
    const got: string[] = [];
    for (const key of keys) got.push(decode(await session.download(key)));
    await session.close();
    console.info(`[${SUITE}:ws-stale]`, JSON.stringify(sent.map((frame) => [frame.kind, frame.downloadId])));
    expect(got).toEqual(keys.map((key) => decode(bytesOf(key))));
    expect(sent.filter((frame) => frame.kind === "download.open")).toHaveLength(3);
    expect(sent.filter((frame) => frame.kind === "session.start")).toHaveLength(1);
  });
});
