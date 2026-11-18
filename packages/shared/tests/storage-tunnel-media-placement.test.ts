import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUserStorageTunnelClient,
  StorageMediaPlacementError,
  StorageTunnelError,
} from "../src/storageTunnel";

/**
 * Per-media silo placement (#145), client side: uploads with a placementId
 * claim the placement (POST /storage/placement/media), land on that silo
 * under `media/<placementId>/`, and downloads of `media/<id>/…` keys resolve
 * the silo via POST /storage/placement/media/resolve. Non-media keys keep
 * rendezvous + `shards/<id>/`.
 */

const SUITE = "storage-tunnel-media-placement";
const API = "http://api.test:3000";
const PID = "0f8c2a3e-1b2c-4d5e-8f90-123456789abc";
const OTHER_PID = "7d1e0c4b-aaaa-4bbb-8ccc-0123456789ab";
/** STOR-BW-11: every Badger client carries the active profile; playback sessions require it. */
const PROFILE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  console.info(`[${SUITE}:teardown] resetting fetch mock (calls=${fetchMock.mock.calls.length})`);
  fetchMock.mockReset();
});

type Call = { url: string; method: string; body: Record<string, unknown> | null };

const calls = (): Call[] =>
  fetchMock.mock.calls.map(([url, init]) => {
    const raw = (init as RequestInit | undefined)?.body;
    let body: Record<string, unknown> | null = null;
    try {
      body = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    return { url: String(url), method: (init as RequestInit | undefined)?.method ?? "GET", body };
  });

const dump = (label: string) => {
  console.info(`[${SUITE}:${label}] fetch calls:\n${JSON.stringify(calls(), null, 2)}`);
};

const mediaPlacement = (placementId: string, gatewayUrl = "http://silo-a:3010") => ({
  placementId,
  poolId: "silo-a",
  shard: { id: "silo-a", gatewayUrl, weight: 1, status: "active", addresses: ["http://10.0.0.9:3010"] },
});

type GatewayOptions = {
  /** POST /storage/placement/media response. */
  acquire?: () => Response;
  /** POST /storage/placement/media/resolve response. */
  resolve?: (placementIds: string[]) => Response;
  /** Direct gateway session failure (every waterfall candidate refuses). */
  directSessionFails?: boolean;
  /** Holds the claim response until the test releases it (overlapping uploads). */
  acquireGate?: Promise<void>;
  /** Overrides a tunnel frame response (return undefined to use the default). */
  frame?: (kind: string, frame: Record<string, unknown>) => Response | undefined;
  /** Overrides a POST …/storage/tunnel/session response (return undefined for the default). */
  session?: () => Response | undefined;
};

/**
 * Minimal API + gateway: answers placement, session and HTTP frame routes so
 * a whole upload/download runs over the HTTP fallback (no WebSocket).
 */
const installGateway = (options: GatewayOptions = {}) => {
  const downloadPayload = new Uint8Array([9, 8, 7]);
  const downloadChecksum = `sha256:${createHash("sha256").update(downloadPayload).digest("hex")}`;
  let sessionSeq = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url === `${API}/storage/placement`) {
      return Response.json({
        policy: {
          policy: "rendezvous-v1",
          epoch: 1,
          seed: "s",
          replicaCount: 1,
          shards: [{ id: "gw-1", gatewayUrl: "http://gw-1:3010", weight: 1, status: "active" }],
        },
      });
    }
    if (url === `${API}/storage/placement/media`) {
      await options.acquireGate;
      return options.acquire?.() ?? Response.json({ placement: mediaPlacement(String(body.placementId)) });
    }
    if (url === `${API}/storage/placement/media/resolve`) {
      const ids = (body.placementIds as string[]) ?? [];
      return options.resolve?.(ids) ?? Response.json({ placements: ids.map((id) => mediaPlacement(id)) });
    }
    if (url.endsWith("/storage/tunnel/session")) {
      const sessionOverride = options.session?.();
      if (sessionOverride) return sessionOverride;
      if (options.directSessionFails) throw new Error("connection refused");
      sessionSeq += 1;
      return Response.json({ sessionId: `sess-${sessionSeq}`, protocolVersion: 1, createdAt: 1, expiresAt: 2 });
    }
    if (url.endsWith("/storage/tunnel/frame")) {
      const frame = (body.frame ?? {}) as Record<string, unknown>;
      const kind = String(frame.kind ?? "");
      const frameOverride = options.frame?.(kind, frame);
      if (frameOverride) return frameOverride;
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
            checksum: downloadChecksum,
            ciphertext: Array.from(downloadPayload),
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

describe("storage tunnel per-media placement", () => {
  it("uploads with a placementId to the placement's silo under media/<placementId>/", async () => {
    installGateway();
    const client = newClient();
    console.info(`[${SUITE}:upload] uploading media/video/init with placementId=${PID}`);
    const key = await client.uploadObject("token-1", "media/video/init", new Uint8Array([1, 2, 3]), {
      uploadId: "u1",
      placementId: PID,
    });
    dump("upload");
    const all = calls();
    const acquire = all.find((c) => c.url === `${API}/storage/placement/media`);
    const session = all.find((c) => c.url.endsWith("/storage/tunnel/session"));
    const open = all.find((c) => (c.body?.frame as Record<string, unknown> | undefined)?.kind === "upload.open");
    expect(acquire?.body).toEqual({ placementId: PID });
    expect(session?.url).toBe("http://silo-a:3010/storage/tunnel/session");
    expect(session?.body?.objectKeyPrefix).toBe(`media/${PID}`);
    expect(session?.body?.shardId).toBe("silo-a");
    expect((open?.body?.frame as Record<string, unknown>).objectKey).toBe(`media/${PID}/media/video/init`);
    expect(key).toBe(`media/${PID}/media/video/init`);
    expect(all.some((c) => c.url === `${API}/storage/placement`)).toBe(false);
  });

  it("claims a placement once for concurrent and repeat uploads inside the cache window", async () => {
    const gate = Promise.withResolvers<void>();
    installGateway({ acquireGate: gate.promise });
    const client = newClient();
    console.info(`[${SUITE}:cache] 3 concurrent + 1 sequential upload under one placementId`);
    const concurrent = Promise.all(
      ["a", "b", "c"].map((name) =>
        client.uploadObject("token-1", `obj-${name}`, new Uint8Array([1]), { uploadId: `u-${name}`, placementId: PID })
      )
    );
    // Release the claim only once it is in flight, so all three overlap it.
    await vi.waitFor(() => {
      expect(calls().some((c) => c.url === `${API}/storage/placement/media`)).toBe(true);
    });
    gate.resolve();
    await concurrent;
    await client.uploadObject("token-1", "obj-d", new Uint8Array([1]), { uploadId: "u-d", placementId: PID });
    const acquires = calls().filter((c) => c.url === `${API}/storage/placement/media`);
    console.info(`[${SUITE}:cache] acquire requests=${acquires.length} (expect 1)`);
    if (acquires.length !== 1) dump("cache");
    expect(acquires).toHaveLength(1);
  });

  it("re-claims after the cache window expires", async () => {
    installGateway();
    const client = newClient({ placementCacheTtlMs: 0 });
    await client.uploadObject("token-1", "obj-a", new Uint8Array([1]), { uploadId: "u-a", placementId: PID });
    await client.uploadObject("token-1", "obj-b", new Uint8Array([1]), { uploadId: "u-b", placementId: PID });
    const acquires = calls().filter((c) => c.url === `${API}/storage/placement/media`);
    console.info(`[${SUITE}:cache-expiry] ttl=0 → acquire requests=${acquires.length} (expect 2)`);
    expect(acquires).toHaveLength(2);
  });

  it("passes the media prefix to the placement's silo on upload and download", async () => {
    installGateway();
    const client = newClient();
    console.info(`[${SUITE}:media-prefix] upload + download straight to the silo of ${PID}`);
    await client.uploadObject("token-1", "seg-1", new Uint8Array([1, 2]), { uploadId: "u1", placementId: PID });
    await client.createSession("token-1", `media/${PID}/seg-1`);
    dump("media-prefix");
    const sessions = calls().filter((c) => c.url.endsWith("/storage/tunnel/session"));
    expect(sessions.map((c) => c.url)).toEqual([
      "http://silo-a:3010/storage/tunnel/session",
      "http://silo-a:3010/storage/tunnel/session",
    ]);
    expect(sessions[0].body).toMatchObject({ shardId: "silo-a", objectKeyPrefix: `media/${PID}`, purpose: "upload" });
    expect(sessions[1].body).toMatchObject({
      shardId: "silo-a",
      objectKeyPrefix: `media/${PID}`,
      purpose: "playback",
      profileId: PROFILE_ID,
    });
    expect(calls().some((c) => c.url === `${API}/storage/tunnel/session`)).toBe(false);
    expect(calls().filter((c) => c.url === `${API}/storage/placement/media`)).toHaveLength(1);
  });

  it("waterfall tries every silo address, then throws the last error (never the API)", async () => {
    installGateway({ directSessionFails: true });
    const client = newClient({ tunnelMode: "waterfall", sessionOpenRetryDelaysMs: [] });
    console.info(`[${SUITE}:waterfall] every silo address refuses → expect last direct error, no API session`);
    const err = await client.createSession("token-1", "seg-2", { placementId: PID }).catch((e: unknown) => e);
    dump("waterfall");
    console.info(`[${SUITE}:waterfall] err=${err instanceof Error ? err.message : String(err)}`);
    const all = calls();
    const direct = all.filter((c) => c.url.endsWith("/storage/tunnel/session"));
    // Every silo address is tried (waterfall order is the existing candidate build).
    expect(direct.map((c) => c.url)).toEqual([
      "http://10.0.0.9:3010/storage/tunnel/session",
      "http://silo-a:3010/storage/tunnel/session",
    ]);
    for (const call of direct) {
      expect(call.body).toMatchObject({ objectKeyPrefix: `media/${PID}`, purpose: "upload" });
    }
    expect(all.some((c) => c.url === `${API}/storage/tunnel/session`)).toBe(false);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("connection refused");
  });

  it("downloads a media key from the silo resolved via /storage/placement/media/resolve, cached", async () => {
    installGateway();
    const client = newClient();
    console.info(`[${SUITE}:download] two downloads of media/${PID}/seg-1`);
    const first = await client.downloadObject("token-1", `media/${PID}/seg-1`, { downloadId: "d1" });
    const second = await client.downloadObject("token-1", `media/${PID}/seg-1`, { downloadId: "d2" });
    dump("download");
    const all = calls();
    const resolves = all.filter((c) => c.url === `${API}/storage/placement/media/resolve`);
    const sessions = all.filter((c) => c.url.endsWith("/storage/tunnel/session"));
    const opens = all.filter((c) => (c.body?.frame as Record<string, unknown> | undefined)?.kind === "download.open");
    expect(Array.from(first)).toEqual([9, 8, 7]);
    expect(Array.from(second)).toEqual([9, 8, 7]);
    expect(resolves).toHaveLength(1);
    expect(resolves[0].body).toEqual({ placementIds: [PID] });
    expect(sessions.map((c) => c.url)).toEqual([
      "http://silo-a:3010/storage/tunnel/session",
      "http://silo-a:3010/storage/tunnel/session",
    ]);
    expect(sessions[0].body?.objectKeyPrefix).toBe(`media/${PID}`);
    expect(opens.map((c) => (c.body?.frame as Record<string, unknown>).objectKey)).toEqual([
      `media/${PID}/seg-1`,
      `media/${PID}/seg-1`,
    ]);
    expect(all.some((c) => c.url === `${API}/storage/placement/media`)).toBe(false);
  });

  it("batch-resolves placements once, mapping a dead silo to null and omitting unknown ids", async () => {
    installGateway({
      resolve: () =>
        Response.json({
          placements: [mediaPlacement(PID), { placementId: OTHER_PID, poolId: "silo-dead", shard: null }],
        }),
    });
    const client = newClient();
    const unknown = "unknown-placement-01";
    const [a, b] = await Promise.all([
      client.resolveMediaPlacements("token-1", [PID, OTHER_PID, unknown]),
      client.resolveMediaPlacements("token-1", [PID, unknown]),
    ]);
    console.info(`[${SUITE}:batch] a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    expect(calls().filter((c) => c.url === `${API}/storage/placement/media/resolve`)).toHaveLength(1);
    expect(a[PID]?.shard.id).toBe("silo-a");
    expect(a[OTHER_PID]).toBeNull();
    expect(unknown in a).toBe(false);
    expect(b[PID]?.shard.id).toBe("silo-a");
    expect(unknown in b).toBe(false);
  });

  it("raises typed errors for unknown and unavailable placements on read", async () => {
    installGateway({
      resolve: () => Response.json({ placements: [{ placementId: OTHER_PID, poolId: "silo-dead", shard: null }] }),
    });
    const client = newClient();
    const notFound = await client.resolveMediaPlacement("token-1", PID).catch((err: unknown) => err);
    const dead = await client.downloadObject("token-1", `media/${OTHER_PID}/seg`).catch((err: unknown) => err);
    console.info(`[${SUITE}:read-errors] notFound=${String(notFound)} dead=${String(dead)}`);
    expect(notFound).toBeInstanceOf(StorageMediaPlacementError);
    expect((notFound as StorageMediaPlacementError).status).toBe(404);
    expect((notFound as StorageMediaPlacementError).code).toBe("placement_not_found");
    expect(dead).toBeInstanceOf(StorageMediaPlacementError);
    expect((dead as StorageMediaPlacementError).status).toBe(503);
    expect((dead as StorageMediaPlacementError).code).toBe("placement_silo_unavailable");
    expect((dead as StorageMediaPlacementError).placementId).toBe(OTHER_PID);
  });

  it.each(["placement_silo_unavailable", "no_storage_capacity"] as const)(
    "maps a 503 %s from the claim to StorageMediaPlacementError",
    async (code) => {
      installGateway({
        acquire: () => new Response(JSON.stringify({ error: code, placementId: PID }), { status: 503 }),
      });
      const client = newClient();
      const err = await client
        .uploadObject("token-1", "obj", new Uint8Array([1]), { uploadId: "u1", placementId: PID })
        .catch((e: unknown) => e);
      console.info(`[${SUITE}:claim-503] code=${code} err=${String(err)}`);
      expect(err).toBeInstanceOf(StorageMediaPlacementError);
      expect(err).toBeInstanceOf(StorageTunnelError);
      expect((err as StorageMediaPlacementError).code).toBe(code);
      expect((err as StorageMediaPlacementError).placementId).toBe(PID);
      expect(calls().some((c) => c.url.endsWith("/storage/tunnel/session"))).toBe(false);
    }
  );

  describe("409 placement_moving (#145 step 3)", () => {
    const movingBody = () => JSON.stringify({ error: "placement_moving", placementId: PID });
    const acquires = () => calls().filter((c) => c.url === `${API}/storage/placement/media`);

    it("retries the claim until the move flips, then uploads", async () => {
      let claims = 0;
      installGateway({
        acquire: () => {
          claims += 1;
          return claims <= 2
            ? new Response(movingBody(), { status: 409 })
            : Response.json({ placement: mediaPlacement(PID, "http://silo-b:3010") });
        },
      });
      const client = newClient({ placementMovingRetryDelaysMs: [0, 0, 0] });
      console.info(`[${SUITE}:moving-claim] claim answers 409 twice, then the flipped silo-b`);
      const key = await client.uploadObject("token-1", "obj", new Uint8Array([1]), { uploadId: "u1", placementId: PID });
      dump("moving-claim");
      const session = calls().find((c) => c.url.endsWith("/storage/tunnel/session"));
      expect(acquires()).toHaveLength(3);
      expect(session?.url).toBe("http://silo-b:3010/storage/tunnel/session");
      expect(key).toBe(`media/${PID}/obj`);
    });

    it("drops the cached placement and re-claims when the gateway rejects the commit as moving", async () => {
      let closes = 0;
      installGateway({
        frame: (kind, frame) => {
          if (kind !== "upload.close") return undefined;
          closes += 1;
          return closes === 1
            ? Response.json({
                frame: { kind: "upload.error", uploadId: frame.uploadId, code: "terminal", message: "placement_moving" },
              })
            : undefined;
        },
      });
      const client = newClient({ placementMovingRetryDelaysMs: [0, 0] });
      console.info(`[${SUITE}:moving-commit] first close is rejected with placement_moving`);
      const key = await client.uploadObject("token-1", "obj", new Uint8Array([1]), { uploadId: "u1", placementId: PID });
      dump("moving-commit");
      // Cache was dropped: the retry hits POST /storage/placement/media again.
      expect(acquires()).toHaveLength(2);
      expect(closes).toBe(2);
      expect(key).toBe(`media/${PID}/obj`);
    });

    it("gives up with a typed 409 once the bounded retries are spent", async () => {
      installGateway({ acquire: () => new Response(movingBody(), { status: 409 }) });
      const client = newClient({ placementMovingRetryDelaysMs: [0, 0, 0] });
      const err = await client
        .uploadObject("token-1", "obj", new Uint8Array([1]), { uploadId: "u1", placementId: PID })
        .catch((e: unknown) => e);
      console.info(`[${SUITE}:moving-bounded] err=${String(err)} claims=${acquires().length}`);
      expect(err).toBeInstanceOf(StorageMediaPlacementError);
      expect((err as StorageMediaPlacementError).status).toBe(409);
      expect((err as StorageMediaPlacementError).code).toBe("placement_moving");
      expect((err as StorageMediaPlacementError).placementId).toBe(PID);
      // 1 try + 3 retries.
      expect(acquires()).toHaveLength(4);
      expect(calls().some((c) => c.url.endsWith("/storage/tunnel/session"))).toBe(false);
    });

    it("defaults to 5 retries over about 2 minutes", async () => {
      vi.useFakeTimers();
      try {
        installGateway({ acquire: () => new Response(movingBody(), { status: 409 }) });
        const client = newClient();
        const pending = client
          .uploadObject("token-1", "obj", new Uint8Array([1]), { uploadId: "u1", placementId: PID })
          .catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(120_000);
        const err = await pending;
        console.info(`[${SUITE}:moving-default] err=${String(err)} claims=${acquires().length}`);
        expect(err).toBeInstanceOf(StorageMediaPlacementError);
        expect(acquires()).toHaveLength(6);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries a 409 from the silo's session open and marks the session as an upload", async () => {
      let sessionAttempts = 0;
      installGateway({
        session: () => {
          sessionAttempts += 1;
          return sessionAttempts === 1 ? new Response(movingBody(), { status: 409 }) : undefined;
        },
      });
      const client = newClient({ placementMovingRetryDelaysMs: [0] });
      await client.uploadObject("token-1", "seg-1", new Uint8Array([1]), { uploadId: "u1", placementId: PID });
      const sessions = calls().filter((c) => c.url.endsWith("/storage/tunnel/session"));
      console.info(`[${SUITE}:moving-session] sessions=${sessions.length} acquires=${acquires().length}`);
      if (sessions.length !== 2) dump("moving-session");
      expect(sessions).toHaveLength(2);
      expect(sessions[0].url).toBe("http://silo-a:3010/storage/tunnel/session");
      expect(sessions[0].body).toMatchObject({ objectKeyPrefix: `media/${PID}`, purpose: "upload" });
      expect(acquires()).toHaveLength(2);
    });

    it("does not mark reads as uploads", async () => {
      installGateway();
      const client = newClient();
      await client.createSession("token-1", `media/${PID}/seg-1`);
      const session = calls().find((c) => c.url.endsWith("/storage/tunnel/session"));
      console.info(`[${SUITE}:read-purpose] session=${JSON.stringify(session)}`);
      expect(session?.url).toBe("http://silo-a:3010/storage/tunnel/session");
      expect(session?.body).toMatchObject({ objectKeyPrefix: `media/${PID}`, purpose: "playback", profileId: PROFILE_ID });
      expect(session?.body).not.toHaveProperty("intent");
    });
  });

  it("keeps non-media keys on rendezvous with the shards/<id>/ prefix", async () => {
    installGateway();
    const client = newClient();
    const key = await client.uploadObject("token-1", "library/chunks/a", new Uint8Array([1]), { uploadId: "u1" });
    dump("non-media");
    const all = calls();
    const session = all.find((c) => c.url.endsWith("/storage/tunnel/session"));
    expect(key).toBe("shards/gw-1/library/chunks/a");
    expect(session?.url).toBe("http://gw-1:3010/storage/tunnel/session");
    expect(session?.body?.objectKeyPrefix).toBe("shards/gw-1");
    expect(all.some((c) => c.url.includes("/storage/placement/media"))).toBe(false);
  });
});
