import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUserStorageTunnelClient,
  isFreePlaybackRefusedError,
  isPlaybackStoppedError,
  parseStorageTraffic,
  STORAGE_FREE_PLAYBACK_REFUSED_CODE,
  STORAGE_PLAYBACK_STOPPED_CODE,
  STORAGE_TRAFFIC_REFRESH_MIN_INTERVAL_MS,
  STORAGE_TRAFFIC_STATE_TTL_MS,
  storageTrafficFromError,
  type StorageTraffic,
} from "../src/storageTunnel";

/**
 * The bandwidth-saturation state on the client side of the tunnel. Every session response and every `session.ack` carries the
 * silo's `traffic` report; the client keeps one report per silo (one gateway = one silo = one link), merges only the
 * high-traffic state across silos (STOR-BW-01), hands each download the report of ITS silo through `hints.onTraffic`
 * (saturation, quality cap, stop: STOR-BW-07, STOR-BW-08, PLAY-QUAL-07), and polls GET /storage/traffic at most once a minute
 * per silo. These tests use a fake gateway; the server side is another worker's.
 *
 * @req STOR-BW-01[badger-desktop]
 * @req STOR-BW-07[badger-desktop]
 * @req STOR-BW-08[badger-desktop]
 * @req STOR-BW-09[badger-desktop]
 */

const SUITE = "storage-tunnel-traffic";
const API = "http://api.test:3000";
const GATEWAY_A = "http://gw-a:3010";
const GATEWAY_B = "http://gw-b:3010";
/** STOR-BW-11: every Badger client carries the active profile; playback sessions require it. */
const PROFILE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

type Silo = "gw-a" | "gw-b";
type Wire = Record<string, unknown>;
type PerSilo<T> = Partial<Record<Silo, T>>;

const GATEWAY: Record<Silo, string> = { "gw-a": GATEWAY_A, "gw-b": GATEWAY_B };
/** Object keys pinned to a silo: the placement policy honours the shard id of the key, so no media placement is needed. */
const KEY_A = "shards/gw-a/chunk";
const KEY_B = "shards/gw-b/chunk";

const fetchMock = vi.fn();

const HIGH: Wire = { state: "high", playbackBufferSeconds: 30 };
const NORMAL: Wire = { state: "normal", playbackBufferSeconds: null };
/** A free viewer's silo at saturation: the cap is 480p, nothing stopped yet. */
const SATURATED_FREE: StorageTraffic = {
  state: "high",
  playbackBufferSeconds: 30,
  saturated: true,
  qualityCap: "480p",
  playbackStopped: false,
};
const STOPPED: StorageTraffic = { ...SATURATED_FREE, playbackStopped: true };
const SATURATED_PAID: StorageTraffic = { ...SATURATED_FREE, qualityCap: "1080p" };
/** What the client makes of a report from a gateway that predates saturation: not saturated, no cap, not stopped. */
const NO_SATURATION = { saturated: false, qualityCap: null, playbackStopped: false };
const HIGH_PARSED: StorageTraffic = { state: "high", playbackBufferSeconds: 30, ...NO_SATURATION };
const NORMAL_PARSED: StorageTraffic = { state: "normal", playbackBufferSeconds: null, ...NO_SATURATION };

const payload = new Uint8Array([9, 8, 7]);
const checksum = `sha256:${createHash("sha256").update(payload).digest("hex")}`;

type Backend = {
  /** `traffic` on the POST /storage/tunnel/session response, per silo. */
  sessionTraffic: PerSilo<unknown>;
  /** `traffic` on the session.ack frames (start and end), per silo. */
  ackTraffic: PerSilo<unknown>;
  /** GET /storage/traffic answer, per silo. */
  trafficRoute: PerSilo<Wire | "fail">;
  /** A refused session POST, per silo. */
  refuse: PerSilo<{ status: number; body: Wire }>;
  /** What `download.open` answers instead of the data, per silo (a `download.error` frame). */
  downloadOpen: PerSilo<Wire>;
  /** What the HTTP fast path (POST /storage/tunnel/download) answers, per silo. */
  fastPath: PerSilo<() => Response>;
};

let backend: Backend;

/** A fake placement policy with both silos and the gateways' own session/traffic routes. */
const installBackend = () => {
  let seq = 0;
  const sessionSilo: Record<string, Silo> = {};
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Wire) : {};
    const urlSilo: Silo = url.replace(/\/storage\/.*$/, "") === GATEWAY_B ? "gw-b" : "gw-a";
    if (url === `${API}/storage/placement`) {
      return Response.json({
        policy: {
          policy: "rendezvous-v1",
          epoch: 1,
          seed: "s",
          replicaCount: 1,
          shards: (Object.keys(GATEWAY) as Silo[]).map((id) => ({ id, gatewayUrl: GATEWAY[id], weight: 1, status: "active" })),
        },
      });
    }
    if (url.split("?")[0].endsWith("/storage/traffic")) {
      const answer = backend.trafficRoute[urlSilo];
      if (!answer || answer === "fail") return Response.json({ error: "nope" }, { status: 500 });
      return Response.json({ traffic: answer });
    }
    if (url.endsWith("/storage/tunnel/session")) {
      const refused = backend.refuse[urlSilo];
      if (refused) return Response.json(refused.body, { status: refused.status });
      seq += 1;
      const sessionId = `sess-${seq}`;
      sessionSilo[sessionId] = urlSilo;
      const traffic = backend.sessionTraffic[urlSilo];
      return Response.json({
        sessionId,
        protocolVersion: 1,
        createdAt: 1,
        expiresAt: 2,
        ...(traffic === undefined ? {} : { traffic }),
      });
    }
    if (url.endsWith("/storage/tunnel/download")) {
      const answer = backend.fastPath[urlSilo];
      return answer ? answer() : Response.json({ error: "nope" }, { status: 500 });
    }
    if (url.endsWith("/storage/tunnel/frame")) {
      const silo = sessionSilo[String(body.sessionId)] ?? "gw-a";
      const frame = (body.frame ?? {}) as Wire;
      const kind = String(frame.kind ?? "");
      if (kind === "session.start" || kind === "session.end") {
        const traffic = backend.ackTraffic[silo];
        return Response.json({ frame: { kind: "session.ack", ...(traffic === undefined ? {} : { traffic }) } });
      }
      if (kind === "download.open") {
        const failure = backend.downloadOpen[silo];
        if (failure) return Response.json({ frame: { ...failure, downloadId: frame.downloadId } });
        return Response.json({
          frame: { kind: "download.data", downloadId: frame.downloadId, seq: 0, checksum, ciphertext: Array.from(payload) },
        });
      }
      return Response.json({ frame: { kind: "download.complete", downloadId: frame.downloadId } });
    }
    return new Response(JSON.stringify({ error: "unexpected", url }), { status: 500 });
  });
};

const frames = (kind: string): Wire[] =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/storage/tunnel/frame"))
    .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { frame: Wire }).frame)
    .filter((frame) => frame.kind === kind);

const sessionPosts = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/storage/tunnel/session"));
const sessionBodies = () => sessionPosts().map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Wire);
const trafficGets = () => fetchMock.mock.calls.filter(([url]) => String(url).split("?")[0].endsWith("/storage/traffic"));
const fastPathPosts = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/storage/tunnel/download"));

const newClient = (overrides: Partial<Parameters<typeof createUserStorageTunnelClient>[0]> = {}) =>
  createUserStorageTunnelClient({
    getApiBaseUrl: () => API,
    getProfileId: () => PROFILE_ID,
    fetchImpl: fetchMock as unknown as typeof fetch,
    preferWebSocket: false,
    ...overrides,
  });

/** Collects what `hints.onTraffic` is told. */
const listen = () => {
  const seen: StorageTraffic[] = [];
  return { seen, hints: { onTraffic: (traffic: StorageTraffic) => seen.push(traffic) } };
};

beforeEach(() => {
  backend = { sessionTraffic: {}, ackTraffic: {}, trafficRoute: {}, refuse: {}, downloadOpen: {}, fastPath: {} };
});

afterEach(() => {
  console.info(`[${SUITE}:teardown] fetch calls=${fetchMock.mock.calls.length}`);
  fetchMock.mockReset();
  vi.useRealTimers();
});

describe("parseStorageTraffic", () => {
  it("accepts the full wire shape in either state", () => {
    expect(parseStorageTraffic(SATURATED_FREE)).toEqual(SATURATED_FREE);
    expect(parseStorageTraffic(STOPPED)).toEqual(STOPPED);
    expect(parseStorageTraffic(SATURATED_PAID)).toEqual(SATURATED_PAID);
    expect(parseStorageTraffic({ state: "normal", playbackBufferSeconds: null, saturated: false, qualityCap: null, playbackStopped: false })).toEqual(
      NORMAL_PARSED
    );
  });

  it("reads a payload from a gateway that predates saturation as not saturated, no cap, not stopped", () => {
    expect(parseStorageTraffic(HIGH)).toEqual(HIGH_PARSED);
    expect(parseStorageTraffic(NORMAL)).toEqual(NORMAL_PARSED);
  });

  it("reads an unknown cap or a non-boolean flag as off", () => {
    expect(parseStorageTraffic({ ...HIGH, qualityCap: "4k" })).toEqual(HIGH_PARSED);
    expect(parseStorageTraffic({ ...HIGH, qualityCap: 480 })).toEqual(HIGH_PARSED);
    expect(parseStorageTraffic({ ...HIGH, saturated: "yes", playbackStopped: 1 })).toEqual(HIGH_PARSED);
  });

  it("rounds the buffer and keeps a high state without a usable buffer length", () => {
    expect(parseStorageTraffic({ state: "high", playbackBufferSeconds: 12.7 })).toEqual({ ...HIGH_PARSED, playbackBufferSeconds: 13 });
    expect(parseStorageTraffic({ state: "high", playbackBufferSeconds: null })).toEqual({ ...HIGH_PARSED, playbackBufferSeconds: null });
    expect(parseStorageTraffic({ state: "high", playbackBufferSeconds: -4 })).toEqual({ ...HIGH_PARSED, playbackBufferSeconds: null });
  });

  it("rejects anything that is not a known state", () => {
    expect(parseStorageTraffic({ state: "busy", playbackBufferSeconds: 5 })).toBeNull();
    expect(parseStorageTraffic({ state: 3 })).toBeNull();
    expect(parseStorageTraffic("high")).toBeNull();
    expect(parseStorageTraffic(undefined)).toBeNull();
    expect(parseStorageTraffic(null)).toBeNull();
  });
});

describe("merged high-traffic view", () => {
  it("starts normal and learns the state from the session response", async () => {
    installBackend();
    backend.sessionTraffic["gw-a"] = HIGH;
    const client = newClient();
    expect(client.getTraffic()).toEqual({ state: "normal", playbackBufferSeconds: null, observedAt: null });
    await client.createSession("tok", KEY_A);
    expect(client.getTraffic()).toMatchObject({ state: "high", playbackBufferSeconds: 30 });
    expect(client.getTraffic().observedAt).toBeTypeOf("number");
  });

  it("carries the state and the buffer only: nothing per silo is merged across silos", async () => {
    installBackend();
    backend.sessionTraffic["gw-a"] = SATURATED_FREE;
    backend.sessionTraffic["gw-b"] = NORMAL;
    const client = newClient();
    await client.createSession("tok", KEY_A);
    await client.createSession("tok", KEY_B);
    expect(Object.keys(client.getTraffic()).sort()).toEqual(["observedAt", "playbackBufferSeconds", "state"]);
    expect(client.getTraffic()).toMatchObject({ state: "high", playbackBufferSeconds: 30 });
  });

  it("refreshes the state from every session.ack and notifies only when the state or the buffer changes", async () => {
    installBackend();
    const changes: Array<{ state: string; playbackBufferSeconds: number | null }> = [];
    const client = newClient({ onTrafficChange: (snapshot) => changes.push({ ...snapshot }) });
    backend.ackTraffic["gw-a"] = HIGH;
    await client.downloadObject("tok", KEY_A, { downloadId: "d1" });
    expect(client.getTraffic()).toMatchObject({ state: "high", playbackBufferSeconds: 30 });
    await client.downloadObject("tok", KEY_A, { downloadId: "d2" });
    expect(changes).toEqual([{ state: "high", playbackBufferSeconds: 30, observedAt: expect.any(Number) }]);

    // Saturation alone is not a change of the merged view.
    backend.ackTraffic["gw-a"] = SATURATED_FREE;
    await client.downloadObject("tok", KEY_A, { downloadId: "d3" });
    expect(changes).toHaveLength(1);

    backend.ackTraffic["gw-a"] = NORMAL;
    await client.downloadObject("tok", KEY_A, { downloadId: "d4" });
    expect(client.getTraffic()).toMatchObject({ state: "normal", playbackBufferSeconds: null });
    expect(changes.map((c) => c.state)).toEqual(["high", "normal"]);
  });

  it("keeps working against a gateway that sends no traffic (old gateway) or garbage", async () => {
    installBackend();
    const client = newClient();
    const { seen, hints } = listen();
    await client.downloadObject("tok", KEY_A, { downloadId: "d1", hints });
    expect(client.getTraffic().state).toBe("normal");
    expect(seen).toEqual([]);
    backend.ackTraffic["gw-a"] = { state: "stormy", playbackBufferSeconds: "lots" };
    backend.sessionTraffic["gw-a"] = 42;
    const bytes = await client.downloadObject("tok", KEY_A, { downloadId: "d2", hints });
    expect(Array.from(bytes)).toEqual(Array.from(payload));
    expect(client.getTraffic().state).toBe("normal");
    expect(seen).toEqual([]);
  });

  it("is high if any silo is, the shortest buffer wins, and a stale report expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    installBackend();
    const client = newClient();
    backend.sessionTraffic["gw-a"] = { state: "high", playbackBufferSeconds: 30 };
    backend.sessionTraffic["gw-b"] = { state: "high", playbackBufferSeconds: 20 };
    await client.createSession("tok", KEY_A);
    expect(client.getTraffic()).toMatchObject({ state: "high", playbackBufferSeconds: 30 });
    await client.createSession("tok", KEY_B);
    expect(client.getTraffic()).toMatchObject({ state: "high", playbackBufferSeconds: 20 });

    vi.setSystemTime(Date.now() + STORAGE_TRAFFIC_STATE_TTL_MS + 1);
    expect(client.getTraffic()).toMatchObject({ state: "normal", playbackBufferSeconds: null });
  });

  it("notifies normal when a high report went silent past the TTL and the gateway then reports normal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    installBackend();
    const changes: Array<{ state: string; playbackBufferSeconds: number | null }> = [];
    const client = newClient({
      onTrafficChange: (snapshot) => changes.push({ state: snapshot.state, playbackBufferSeconds: snapshot.playbackBufferSeconds }),
    });
    backend.sessionTraffic["gw-a"] = HIGH;
    await client.createSession("tok", KEY_A);
    expect(changes).toEqual([{ state: "high", playbackBufferSeconds: 30 }]);

    vi.setSystemTime(Date.now() + STORAGE_TRAFFIC_STATE_TTL_MS + 1);
    backend.sessionTraffic["gw-a"] = NORMAL;
    await client.createSession("tok", KEY_A);
    expect(changes).toEqual([
      { state: "high", playbackBufferSeconds: 30 },
      { state: "normal", playbackBufferSeconds: null },
    ]);
  });

  it("notifies normal when a high report expires and the state is read, without any new report", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    installBackend();
    const changes: string[] = [];
    const client = newClient({ onTrafficChange: (snapshot) => changes.push(snapshot.state) });
    backend.sessionTraffic["gw-a"] = HIGH;
    await client.createSession("tok", KEY_A);
    expect(changes).toEqual(["high"]);

    vi.setSystemTime(Date.now() + STORAGE_TRAFFIC_STATE_TTL_MS + 1);
    expect(client.getTraffic().state).toBe("normal");
    expect(changes).toEqual(["high", "normal"]);
    client.getTraffic();
    expect(changes).toEqual(["high", "normal"]);
  });
});

describe("per-silo traffic", () => {
  it("@req STOR-BW-07 hands each download the report of its own silo: a saturated silo never marks the other", async () => {
    installBackend();
    backend.ackTraffic["gw-a"] = SATURATED_FREE;
    backend.ackTraffic["gw-b"] = HIGH;
    const client = newClient({ tunnelMode: "direct" });
    const a = listen();
    const b = listen();
    await client.downloadObject("tok", KEY_A, { downloadId: "da", hints: a.hints });
    await client.downloadObject("tok", KEY_B, { downloadId: "db", hints: b.hints });

    expect(a.seen.length).toBeGreaterThan(0);
    for (const traffic of a.seen) expect(traffic).toEqual(SATURATED_FREE);
    expect(b.seen.length).toBeGreaterThan(0);
    for (const traffic of b.seen) expect(traffic).toEqual(HIGH_PARSED);
    expect(client.getTraffic()).toMatchObject({ state: "high", playbackBufferSeconds: 30 });
    expect(Object.keys(client.getTraffic()).sort()).toEqual(["observedAt", "playbackBufferSeconds", "state"]);
  });

  it("@req STOR-BW-07 polls the report of one silo at a time", async () => {
    installBackend();
    backend.trafficRoute["gw-a"] = { ...SATURATED_FREE };
    backend.trafficRoute["gw-b"] = NORMAL;
    const client = newClient({ tunnelMode: "direct" });
    expect(await client.refreshTraffic("tok", KEY_A)).toEqual(SATURATED_FREE);
    const other = await client.refreshTraffic("tok", KEY_B);
    expect(other).toEqual(NORMAL_PARSED);
    expect(other?.saturated).toBe(false);
    expect(await client.refreshTraffic("tok", KEY_A)).toEqual(SATURATED_FREE);
    expect(trafficGets()).toHaveLength(2);
    expect(client.getTraffic()).toMatchObject({ state: "high", playbackBufferSeconds: 30 });
  });

  it("@req STOR-BW-08 routes the report of concurrent downloads to the right listener", async () => {
    installBackend();
    backend.ackTraffic["gw-a"] = STOPPED;
    backend.ackTraffic["gw-b"] = NORMAL;
    const client = newClient({ tunnelMode: "direct" });
    const a = listen();
    const b = listen();
    await Promise.all([
      client.downloadObject("tok", KEY_A, { downloadId: "da", hints: a.hints }),
      client.downloadObject("tok", KEY_B, { downloadId: "db", hints: b.hints }),
    ]);
    for (const traffic of a.seen) expect(traffic.playbackStopped).toBe(true);
    for (const traffic of b.seen) expect(traffic.playbackStopped).toBe(false);
    expect(a.seen.length).toBeGreaterThan(0);
    expect(b.seen.length).toBeGreaterThan(0);
  });
});

describe("hints.onTraffic", () => {
  it("is told the silo's report when the session opens, on the start ack and on the end ack, in that order", async () => {
    installBackend();
    backend.sessionTraffic["gw-a"] = HIGH;
    backend.ackTraffic["gw-a"] = SATURATED_FREE;
    const client = newClient();
    const { seen, hints } = listen();
    await client.downloadObject("tok", KEY_A, { downloadId: "d1", hints });
    expect(seen).toEqual([HIGH_PARSED, SATURATED_FREE, SATURATED_FREE]);
  });

  it("is not called after the download ended", async () => {
    installBackend();
    backend.ackTraffic["gw-a"] = SATURATED_FREE;
    const client = newClient();
    const { seen, hints } = listen();
    await client.downloadObject("tok", KEY_A, { downloadId: "d1", hints });
    const count = seen.length;
    await client.downloadObject("tok", KEY_A, { downloadId: "d2" });
    expect(seen).toHaveLength(count);
  });

  it("does not break the download when the listener throws", async () => {
    installBackend();
    backend.ackTraffic["gw-a"] = SATURATED_FREE;
    const client = newClient();
    const bytes = await client.downloadObject("tok", KEY_A, {
      downloadId: "d1",
      hints: {
        onTraffic: () => {
          throw new Error("listener failed");
        },
      },
    });
    expect(Array.from(bytes)).toEqual(Array.from(payload));
  });
});

describe("playback hints", () => {
  it("adds bufferedMs/playbackBps/burst on download.open and bufferedMs/playbackBps (no burst) on download.ack", async () => {
    installBackend();
    const client = newClient();
    await client.downloadObject("tok", KEY_A, {
      downloadId: "d1",
      hints: { getBufferedMs: () => 12_345.6, playbackBps: 4_000_000, burst: "seek" },
    });
    const open = frames("download.open")[0];
    expect(open).toMatchObject({ bufferedMs: 12_346, playbackBps: 4_000_000, burst: "seek" });
    const ack = frames("download.ack")[0];
    expect(ack).toMatchObject({ bufferedMs: 12_346, playbackBps: 4_000_000 });
    expect(ack).not.toHaveProperty("burst");
  });

  it("omits unknown or invalid hints and keeps the legacy frames byte for byte", async () => {
    installBackend();
    const client = newClient();
    await client.downloadObject("tok", KEY_A, { downloadId: "d1" });
    await client.downloadObject("tok", KEY_A, {
      downloadId: "d2",
      hints: { getBufferedMs: () => undefined, playbackBps: Number.NaN },
    });
    await client.downloadObject("tok", KEY_A, {
      downloadId: "d3",
      hints: { getBufferedMs: () => -5, playbackBps: 0 },
    });
    for (const frame of [...frames("download.open"), ...frames("download.ack")]) {
      expect(frame).not.toHaveProperty("bufferedMs");
      expect(frame).not.toHaveProperty("playbackBps");
      expect(frame).not.toHaveProperty("burst");
    }
  });
});

describe("library purpose", () => {
  it("@req STOR-BW-07 opens a library session on the silo's gateway", async () => {
    installBackend();
    const client = newClient({ tunnelMode: "direct" });
    await client.createSession("tok", KEY_A, { purpose: "library" });
    await client.downloadObject("tok", KEY_A, { downloadId: "d1", purpose: "library" });
    expect(sessionBodies().map((body) => body.purpose)).toEqual(["library", "library"]);
    console.info(`[${SUITE}:library] session urls=${JSON.stringify(sessionPosts().map(([url]) => String(url)))}`);
    expect(sessionPosts().every(([url]) => String(url).startsWith(GATEWAY_A))).toBe(true);
  });
});

describe("GET /storage/traffic", () => {
  it("fetches from the object's gateway, answers that silo's report, and is rate limited to once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    installBackend();
    backend.trafficRoute["gw-a"] = HIGH;
    const client = newClient();

    expect(await client.refreshTraffic("tok", KEY_A)).toEqual(HIGH_PARSED);
    expect(trafficGets()).toHaveLength(1);
    expect(String(trafficGets()[0][0])).toBe(`${GATEWAY_A}/storage/traffic?profileId=${PROFILE_ID}`);
    expect((trafficGets()[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(client.getTraffic()).toMatchObject({ state: "high", playbackBufferSeconds: 30 });

    backend.trafficRoute["gw-a"] = NORMAL;
    vi.setSystemTime(Date.now() + STORAGE_TRAFFIC_REFRESH_MIN_INTERVAL_MS - 1_000);
    expect((await client.refreshTraffic("tok", KEY_A))?.state).toBe("high");
    expect(trafficGets()).toHaveLength(1);

    vi.setSystemTime(Date.now() + 1_001);
    expect((await client.refreshTraffic("tok", KEY_A))?.state).toBe("normal");
    expect(trafficGets()).toHaveLength(2);
  });

  it("@req STOR-BW-09 polls again at a shorter interval when the caller asks for one (a held download waits for the silo to lift)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    installBackend();
    backend.trafficRoute["gw-a"] = { ...SATURATED_FREE };
    const client = newClient();
    expect((await client.refreshTraffic("tok", KEY_A))?.saturated).toBe(true);
    backend.trafficRoute["gw-a"] = HIGH;
    vi.setSystemTime(Date.now() + 5_000);
    expect((await client.refreshTraffic("tok", KEY_A))?.saturated).toBe(true);
    expect(trafficGets()).toHaveLength(1);
    expect((await client.refreshTraffic("tok", KEY_A, { minIntervalMs: 5_000 }))?.saturated).toBe(false);
    expect(trafficGets()).toHaveLength(2);
  });

  it("keeps the last known report when the poll fails, and answers null when nothing is known", async () => {
    installBackend();
    backend.sessionTraffic["gw-a"] = SATURATED_FREE;
    backend.trafficRoute["gw-a"] = "fail";
    const client = newClient({ trafficRefreshMinIntervalMs: 0 });
    expect(await client.refreshTraffic("tok", KEY_B)).toBeNull();
    await client.createSession("tok", KEY_A);
    expect(await client.refreshTraffic("tok", KEY_A)).toEqual(SATURATED_FREE);
  });

  // Every poll goes to the gateway of the object's silo; the API has no traffic route.
  it("polls each object key's own silo gateway, never the API", async () => {
    installBackend();
    backend.trafficRoute["gw-a"] = { ...SATURATED_FREE };
    backend.trafficRoute["gw-b"] = NORMAL;
    const client = newClient({ tunnelMode: "direct" });
    expect(await client.refreshTraffic("tok", KEY_A)).toEqual(SATURATED_FREE);
    expect(await client.refreshTraffic("tok", KEY_B)).toEqual(NORMAL_PARSED);
    expect(await client.refreshTraffic("tok", KEY_A)).toEqual(SATURATED_FREE);
    const urls = trafficGets().map(([url]) => String(url));
    console.info(`[${SUITE}:traffic-per-silo] urls=${JSON.stringify(urls)}`);
    expect(urls).toEqual([
      `${GATEWAY_A}/storage/traffic?profileId=${PROFILE_ID}`,
      `${GATEWAY_B}/storage/traffic?profileId=${PROFILE_ID}`,
    ]);
    expect((trafficGets()[0][1] as RequestInit).method).toBe("GET");
    expect(urls.some((url) => url.startsWith(API))).toBe(false);
  });

  // The gateway treats the signed-in session (the bearer token) as the viewer, because the desktop plays HLS with one
  // tunnel session per object: every object of one playback is a new session of the same viewer.
  it("opens one tunnel session per object, every one with the same bearer token", async () => {
    installBackend();
    const client = newClient();
    for (const objectKey of ["shards/gw-a/a", "shards/gw-a/b", "shards/gw-a/c"]) {
      await client.downloadObject("tok", objectKey, { downloadId: `d-${objectKey}` });
    }
    expect(sessionPosts()).toHaveLength(3);
    for (const [, init] of sessionPosts()) {
      expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
    }
  });
});

describe("a refused free playback session", () => {
  const refusal = { error: STORAGE_FREE_PLAYBACK_REFUSED_CODE, traffic: SATURATED_FREE };

  it("@req STOR-BW-07 rejects with free_playback_refused (503) carrying the silo's report", async () => {
    installBackend();
    backend.refuse["gw-a"] = { status: 503, body: refusal };
    const client = newClient();
    const failure = await client.createSession("tok", KEY_A).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "Error", status: 503, code: "free_playback_refused" });
    expect(isFreePlaybackRefusedError(failure)).toBe(true);
    expect(isPlaybackStoppedError(failure)).toBe(false);
    expect(storageTrafficFromError(failure)).toEqual(SATURATED_FREE);
    expect(client.getTraffic()).toMatchObject({ state: "high", playbackBufferSeconds: 30 });
  });

  it("@req STOR-BW-07 tells the download's listener the refusing silo's report", async () => {
    installBackend();
    backend.refuse["gw-a"] = { status: 503, body: refusal };
    const client = newClient();
    const { seen, hints } = listen();
    await expect(client.downloadObject("tok", KEY_A, { downloadId: "d1", hints })).rejects.toMatchObject({ code: "free_playback_refused" });
    expect(seen).toEqual([SATURATED_FREE]);
  });

  it("@req STOR-BW-07 refuses only the saturated silo: a media on another silo opens", async () => {
    installBackend();
    backend.refuse["gw-a"] = { status: 503, body: refusal };
    const client = newClient();
    await expect(client.createSession("tok", KEY_A)).rejects.toMatchObject({ code: "free_playback_refused" });
    await expect(client.createSession("tok", KEY_B)).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it("@req STOR-BW-07 is final in waterfall mode: no other address, never the API", async () => {
    installBackend();
    backend.refuse["gw-a"] = { status: 503, body: refusal };
    const client = newClient({ tunnelMode: "waterfall" });
    await expect(client.createSession("tok", KEY_A)).rejects.toMatchObject({ code: "free_playback_refused" });
    console.info(`[${SUITE}:waterfall-refusal] session urls=${JSON.stringify(sessionPosts().map(([url]) => String(url)))}`);
    expect(sessionPosts()).toHaveLength(1);
    expect(String(sessionPosts()[0][0])).toBe(`${GATEWAY_A}/storage/tunnel/session`);
  });

  it("leaves another 503 without a report alone", async () => {
    installBackend();
    backend.refuse["gw-a"] = { status: 503, body: { error: "no_storage_gateways_available" } };
    const client = newClient({ tunnelMode: "direct", sessionOpenRetryDelaysMs: [] });
    const failure = await client.createSession("tok", KEY_A).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "no_storage_gateways_available" });
    expect(isFreePlaybackRefusedError(failure)).toBe(false);
    expect(storageTrafficFromError(failure)).toBeNull();
    expect(client.getTraffic().state).toBe("normal");
  });

  it("reads a malformed report on the refusal as none", async () => {
    installBackend();
    backend.refuse["gw-a"] = { status: 503, body: { error: STORAGE_FREE_PLAYBACK_REFUSED_CODE, traffic: { state: "stormy" } } };
    const client = newClient();
    const { seen, hints } = listen();
    const failure = await client.downloadObject("tok", KEY_A, { downloadId: "d1", hints }).catch((error: unknown) => error);
    expect(isFreePlaybackRefusedError(failure)).toBe(true);
    expect(storageTrafficFromError(failure)).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("a stopped playback", () => {
  const stopFrame = { kind: "download.error", code: STORAGE_PLAYBACK_STOPPED_CODE, traffic: STOPPED };

  it("@req STOR-BW-08 rejects with the typed 503 playback_stopped carrying the silo's report", async () => {
    installBackend();
    backend.downloadOpen["gw-a"] = stopFrame;
    const client = newClient();
    const failure = await client.downloadObject("tok", KEY_A, { downloadId: "d1" }).catch((error: unknown) => error);
    expect(isPlaybackStoppedError(failure)).toBe(true);
    expect(isFreePlaybackRefusedError(failure)).toBe(false);
    expect(failure).toMatchObject({ name: "Error", status: 503, code: "playback_stopped" });
    expect(storageTrafficFromError(failure)).toEqual(STOPPED);
  });

  it("@req STOR-BW-08 tells the listener, ends the session, and does not retry the bytes another way", async () => {
    installBackend();
    backend.downloadOpen["gw-a"] = stopFrame;
    const client = newClient();
    const { seen, hints } = listen();
    await expect(client.downloadObject("tok", KEY_A, { downloadId: "d1", hints })).rejects.toMatchObject({ code: "playback_stopped" });
    expect(seen).toContainEqual(STOPPED);
    expect(frames("download.open")).toHaveLength(1);
    expect(frames("session.end")).toHaveLength(1);
    expect(fastPathPosts()).toHaveLength(0);
  });

  it("@req STOR-BW-08 stops only the viewer of that silo", async () => {
    installBackend();
    backend.downloadOpen["gw-a"] = stopFrame;
    const client = newClient();
    await expect(client.downloadObject("tok", KEY_A, { downloadId: "da" })).rejects.toMatchObject({ code: "playback_stopped" });
    const bytes = await client.downloadObject("tok", KEY_B, { downloadId: "db" });
    expect(Array.from(bytes)).toEqual(Array.from(payload));
  });

  it("@req STOR-BW-08 is still the typed error when the frame carries no report", async () => {
    installBackend();
    backend.downloadOpen["gw-a"] = { kind: "download.error", code: STORAGE_PLAYBACK_STOPPED_CODE };
    const client = newClient();
    const failure = await client.downloadObject("tok", KEY_A, { downloadId: "d1" }).catch((error: unknown) => error);
    expect(isPlaybackStoppedError(failure)).toBe(true);
    expect(storageTrafficFromError(failure)).toBeNull();
  });

  it("@req STOR-BW-08 is the typed error in waterfall mode too, with no retry through another address", async () => {
    installBackend();
    backend.downloadOpen["gw-a"] = stopFrame;
    const client = newClient({ tunnelMode: "waterfall" });
    const { seen, hints } = listen();
    const failure = await client.downloadObject("tok", KEY_A, { downloadId: "d1", hints }).catch((error: unknown) => error);
    expect(isPlaybackStoppedError(failure)).toBe(true);
    expect(storageTrafficFromError(failure)).toEqual(STOPPED);
    expect(seen).toContainEqual(STOPPED);
  });

  it("@req STOR-BW-08 reads the 503 playback_stopped of the HTTP fast path as the same typed error", async () => {
    installBackend();
    backend.downloadOpen["gw-a"] = { kind: "download.error", code: "unavailable" };
    backend.fastPath["gw-a"] = () => Response.json({ error: STORAGE_PLAYBACK_STOPPED_CODE, traffic: STOPPED }, { status: 503 });
    const client = newClient();
    const { seen, hints } = listen();
    const failure = await client.downloadObject("tok", KEY_A, { downloadId: "d1", hints }).catch((error: unknown) => error);
    expect(fastPathPosts()).toHaveLength(1);
    expect(isPlaybackStoppedError(failure)).toBe(true);
    expect(storageTrafficFromError(failure)).toEqual(STOPPED);
    expect(seen).toContainEqual(STOPPED);
  });

  it("leaves any other download.error code a plain error", async () => {
    installBackend();
    backend.downloadOpen["gw-a"] = { kind: "download.error", code: "cancelled", traffic: STOPPED };
    const client = newClient();
    const failure = await client.downloadObject("tok", KEY_A, { downloadId: "d1" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("TUNNEL_DOWNLOAD_ERROR_cancelled");
    expect(isPlaybackStoppedError(failure)).toBe(false);
    expect(storageTrafficFromError(failure)).toBeNull();
  });
});
