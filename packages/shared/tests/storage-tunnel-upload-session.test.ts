import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserStorageTunnelClient } from "../src/storageTunnel";

/**
 * STOR-REUSE-01: many small objects of one media go through one upload session (created, started and ended
 * once) instead of a session per object; each object still has its own upload.open / upload.close. A failed upload
 * drops the session and is retried through the ordinary per-object path; an old session is renewed.
 */

const SUITE = "storage-tunnel-upload-session";
const API = "http://api.test:3000";
const PID = "0f8c2a3e-1b2c-4d5e-8f90-123456789abc";
const PROFILE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

type Event = { route: "session" | "frame"; sessionId?: string; kind?: string; objectKey?: string; prefix?: unknown };

/** API + silo gateway over the HTTP frame fallback; `failClose` refuses the commit of the keys it names, once each. */
const installGateway = (failClose = new Set<string>()) => {
  const events: Event[] = [];
  const openKeys = new Map<string, string>();
  let sessionSeq = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url === `${API}/storage/placement/media`) {
      return Response.json({
        placement: {
          placementId: String(body.placementId),
          poolId: "silo-a",
          shard: { id: "silo-a", gatewayUrl: "http://silo-a:3010", weight: 1, status: "active", addresses: [] },
        },
      });
    }
    if (url.endsWith("/storage/tunnel/session")) {
      sessionSeq += 1;
      events.push({ route: "session", sessionId: `sess-${sessionSeq}`, prefix: body.objectKeyPrefix });
      return Response.json({ sessionId: `sess-${sessionSeq}`, protocolVersion: 1, createdAt: 1, expiresAt: 2 });
    }
    if (url.endsWith("/storage/tunnel/frame")) {
      const frame = (body.frame ?? {}) as Record<string, unknown>;
      const kind = String(frame.kind ?? "");
      const sessionId = String(body.sessionId);
      if (kind === "upload.open") openKeys.set(String(frame.uploadId), String(frame.objectKey));
      const objectKey = kind.startsWith("upload.") ? openKeys.get(String(frame.uploadId)) : undefined;
      events.push({ route: "frame", sessionId, kind, ...(objectKey ? { objectKey } : {}) });
      if (kind === "session.start" || kind === "session.end") return Response.json({ frame: { kind: "session.ack" } });
      if (kind === "upload.open") return Response.json({ frame: { kind: "upload.progress", uploadId: frame.uploadId } });
      if (kind === "upload.data") return Response.json({ frame: { kind: "upload.ack", uploadId: frame.uploadId, seq: frame.seq } });
      if (kind === "upload.close") {
        if (objectKey && failClose.delete(objectKey)) return Response.json({ frame: { kind: "error", error: "commit_failed" } });
        return Response.json({ frame: { kind: "upload.complete", uploadId: frame.uploadId } });
      }
    }
    return new Response(JSON.stringify({ error: "unexpected", url }), { status: 500 });
  });
  return events;
};

const newClient = () =>
  createUserStorageTunnelClient({
    getApiBaseUrl: () => API,
    getProfileId: () => PROFILE_ID,
    fetchImpl: fetchMock as unknown as typeof fetch,
    preferWebSocket: false,
  });

const kinds = (events: Event[], kind: string) => events.filter((event) => event.kind === kind);

// @req STOR-REUSE-01
describe("storage tunnel reused upload session", () => {
  it("uploads many objects of one media through one session, each with its own open and close", async () => {
    const events = installGateway();
    const session = newClient().createUploadSession("token-1", { placementId: PID, clientType: "parrot-test" });
    const keys = await Promise.all(["c0", "c1", "c2"].map((key) => session.upload(key, new Uint8Array([1, 2, 3]))));
    console.info(`[${SUITE}:reuse] before close`, JSON.stringify(events));
    expect(keys).toEqual(["c0", "c1", "c2"].map((key) => `media/${PID}/${key}`));
    expect(events.filter((event) => event.route === "session")).toEqual([{ route: "session", sessionId: "sess-1", prefix: `media/${PID}` }]);
    expect(kinds(events, "session.start")).toHaveLength(1);
    expect(kinds(events, "upload.open").map((event) => event.objectKey)).toEqual(keys);
    expect(kinds(events, "upload.close").every((event) => event.sessionId === "sess-1")).toBe(true);
    expect(kinds(events, "session.end")).toEqual([]);

    await session.close();
    expect(kinds(events, "session.end")).toEqual([{ route: "frame", sessionId: "sess-1", kind: "session.end" }]);
    await expect(session.upload("late", new Uint8Array([1]))).rejects.toThrow("TUNNEL_UPLOAD_SESSION_CLOSED");
  });

  it("ends a session whose upload failed, retries that object on its own session and opens a new one after", async () => {
    const events = installGateway(new Set([`media/${PID}/c1`]));
    const session = newClient().createUploadSession("token-1", { placementId: PID });
    const keys = [];
    for (const key of ["c0", "c1", "c2"]) keys.push(await session.upload(key, new Uint8Array([4, 5])));
    await session.close();
    console.info(`[${SUITE}:fallback]`, JSON.stringify(events));
    expect(keys).toEqual(["c0", "c1", "c2"].map((key) => `media/${PID}/${key}`));
    // sess-1 carried c0 and the refused c1; sess-2 is c1's own retry; sess-3 the new reused session for c2.
    expect(events.filter((event) => event.route === "session").map((event) => event.sessionId)).toEqual(["sess-1", "sess-2", "sess-3"]);
    expect(kinds(events, "upload.close").map((event) => [event.sessionId, event.objectKey])).toEqual([
      ["sess-1", `media/${PID}/c0`],
      ["sess-1", `media/${PID}/c1`],
      ["sess-2", `media/${PID}/c1`],
      ["sess-3", `media/${PID}/c2`],
    ]);
    expect(kinds(events, "session.end").map((event) => event.sessionId).sort()).toEqual(["sess-1", "sess-2", "sess-3"]);
  });

  it("renews a session past four minutes, inside the gateway's session TTL", async () => {
    const events = installGateway();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const session = newClient().createUploadSession("token-1", { placementId: PID });
    await session.upload("c0", new Uint8Array([1]));
    now += 3 * 60_000;
    await session.upload("c1", new Uint8Array([1]));
    now += 2 * 60_000;
    await session.upload("c2", new Uint8Array([1]));
    await session.close();
    console.info(`[${SUITE}:renew]`, JSON.stringify(events));
    expect(kinds(events, "upload.open").map((event) => event.sessionId)).toEqual(["sess-1", "sess-1", "sess-2"]);
    expect(kinds(events, "session.end").map((event) => event.sessionId)).toEqual(["sess-1", "sess-2"]);
  });
});
