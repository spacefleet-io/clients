/**
 * @test-id INTG-JF-V4-001
 * @level integration (real IntegrationRuntime + SDK + shared update latch against a fake API; shared codec vectors)
 * @why Vault v4 (LIB-FMT-11/12/13, REL-CD-29) ships the Jellyfin sidecar in the same release as every other reader.
 *   The sidecar reads the library through the shared runtime, so what is Jellyfin's own is: it says who it is on every
 *   call (`x-space-client: badger/jellyfin/<plugin version>`), it declares op stream 4 on reads, a 426 or a library too
 *   new for it stops the sync with nothing applied and reports `update_required` with the message the plugin shows,
 *   the switch's own 426 (an op stream it reads) is not "please update", and the packed chunk lists of the shared
 *   vectors play as the same HLS segments as the version-3 rows they replace.
 *
 * @req LIB-FMT-11[badger-jellyfin] LIB-FMT-13[badger-jellyfin] REL-CD-29[badger-jellyfin]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkListFromJson, unpackChunkList, type ChunkRef, type PackedChunkListJson } from "@space/library-db-definition/chunkLists";
import { LibraryFormatTooNewError } from "@space/library-db-runtime";
import { __resetAppVersionStateForTests, setClientIdentity, setLibraryReadOpStreamVersion } from "@space/shared/appVersion";
import { READ_OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import { loadIntegrationConfig } from "../src/config";
import { segmentsFromChunks } from "../src/hls";
import { IntegrationRuntime } from "../src/runtime";
import { handleIntegrationRequest, type IntegrationStatus } from "../src/server";
import { UPDATE_REQUIRED_MESSAGE, updateRequiredFromResponse } from "../src/updateRequired";

const TAG = "[INTG-JF-V4-001]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const API = "http://api.test";
const VERSION = "0.2.0.0";
const PROFILE = { id: "11111111-1111-4111-8111-111111111111", name: "Main", avatar: 0, createdAt: "2026-11-01T00:00:00.000Z", isMain: true };

type Seen = { method: string; path: string; headers: Record<string, string> };
type Route = (seen: Seen) => Response | null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (extra: Record<string, unknown> = {}) =>
  json({ error: "app_update_required", app: "badger", platform: "jellyfin", version: VERSION, minVersion: "0.3.0.0", ...extra }, 426);

describe("Jellyfin sidecar vault v4 gate", () => {
  const dirs: string[] = [];
  const realFetch = globalThis.fetch;
  const runtimes: IntegrationRuntime[] = [];
  let seen: Seen[] = [];

  beforeEach(() => {
    __resetAppVersionStateForTests();
    // The reset also clears what importing the runtime's api module declared at load; declare it again, as main does.
    setLibraryReadOpStreamVersion(READ_OP_STREAM_VERSION);
    setClientIdentity({ app: "badger", platform: "jellyfin", version: VERSION });
    seen = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.stop();
    globalThis.fetch = realFetch;
    __resetAppVersionStateForTests();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Fake API: records every call with its headers; unmatched routes answer 404. */
  const serve = (route: Route) => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const url = new URL(request.url);
      const call = { method: request.method, path: url.pathname, headers };
      seen.push(call);
      return route(call) ?? json({ error: "not_found" }, 404);
    }) as typeof fetch;
  };

  /** A signed-in sidecar with a key file and one followed profile, like a paired Jellyfin server after a restart. */
  const signedIn = (extraEnv: Record<string, string> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-intg-v4-"));
    dirs.push(dir);
    const keyFile = path.join(dir, "library.key");
    fs.writeFileSync(keyFile, `${randomBytes(32).toString("base64")}\n`);
    const config = loadIntegrationConfig({
      HEADLESS_DEV_TICKET_KEY: "1",
      HEADLESS_STATE_DIR: path.join(dir, "state"),
      HEADLESS_LIBRARY_KEY_FILE: keyFile,
      HEADLESS_API_URL: API,
      HEADLESS_API_TOKEN: "token-v4",
      HEADLESS_VERSION: VERSION,
      HEADLESS_SYNC_INTERVAL_MS: "3600000",
      ...extraEnv,
    });
    const lines: string[] = [];
    const runtime = new IntegrationRuntime(config, (message, meta) => {
      lines.push(message);
      log(`sidecar: ${message}`, meta);
    });
    runtimes.push(runtime);
    const status = async () =>
      (await (await handleIntegrationRequest(new Request("http://127.0.0.1:8790/integration/v1/status"), runtime.buildDeps())).json()) as IntegrationStatus;
    return { runtime, status, lines, dir };
  };

  const profilesRoute: Route = ({ path: p }) => (p === "/profiles" ? json({ profiles: [PROFILE] }) : null);

  it("states badger/jellyfin/<version> on its own calls and op stream 4 on library reads", async () => {
    serve((call) => profilesRoute(call) ?? (call.path === "/library/db/meta" ? refusal() : null));
    const { runtime } = signedIn();
    await runtime.start();
    log("calls", seen.map(({ method, path: p, headers }) => ({ method, p, client: headers["x-space-client"], op: headers["x-library-op-stream-version"] ?? null })));
    const profiles = seen.find((call) => call.path === "/profiles");
    const meta = seen.find((call) => call.path === "/library/db/meta");
    expect(profiles?.headers["x-space-client"]).toBe(`badger/jellyfin/${VERSION}`);
    expect(meta?.headers["x-space-client"]).toBe(`badger/jellyfin/${VERSION}`);
    expect(meta?.headers["x-library-op-stream-version"]).toBe("4");
  });

  it("a 426 on the library read stops the sync before anything is applied and reports update_required", async () => {
    serve((call) => profilesRoute(call) ?? (call.path === "/library/db/meta" ? refusal() : null));
    const { runtime, status, lines } = signedIn();
    await runtime.start();
    const after = await status();
    log("status after 426", { state: after.state, lastError: after.lastError, updateRequired: after.updateRequired, libraryVersion: after.libraryVersion });
    expect(after.state).toBe("update_required");
    expect(after.updateRequired).toMatchObject({ reason: "api_refused", minVersion: "0.3.0.0", message: UPDATE_REQUIRED_MESSAGE });
    expect(after.lastError).toBe("update_required: api_refused");
    // Nothing applied: no library opened, no snapshot or ops fetched.
    expect(after.libraryVersion).toBeNull();
    expect(seen.some((call) => call.path.startsWith("/library/db") && call.path !== "/library/db/meta")).toBe(false);
    expect(lines).toContain(`update required: ${UPDATE_REQUIRED_MESSAGE}`);
    // Stopped: neither the open loop nor a sync sends anything more.
    const calls = seen.length;
    // Test seam: `tick` is the private open/sync loop; driving it directly proves the latch holds without timers.
    const loop = runtime as unknown as { tick(): Promise<void> };
    await loop.tick();
    await runtime.syncOnce("test");
    expect(seen.length).toBe(calls);
  });

  it("after stop(), the open loop and a sync neither open the library nor send a request", async () => {
    serve(profilesRoute);
    const { runtime, status } = signedIn();
    await runtime.start();
    await runtime.stop();
    const calls = seen.length;
    // Test seam: `tick` is the private open/sync loop that the interval and wake() drive; calling it directly stands in for a late timer.
    const loop = runtime as unknown as { tick(): Promise<void> };
    await loop.tick();
    await runtime.syncOnce("test");
    expect(seen.length).toBe(calls);
    expect((await status()).libraryVersion).toBeNull();
  });

  it("a 426 on a hand-written call (auth/me, login) latches the same state", async () => {
    serve((call) => (call.path === "/auth/login" ? refusal() : null));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-intg-v4-login-"));
    dirs.push(dir);
    const config = loadIntegrationConfig({
      HEADLESS_DEV_TICKET_KEY: "1",
      HEADLESS_STATE_DIR: path.join(dir, "state"),
      HEADLESS_LIBRARY_KEY_FILE: path.join(dir, "library.key"),
      HEADLESS_API_URL: API,
      HEADLESS_EMAIL: "a@b.c",
      HEADLESS_PASSWORD: "pw",
      HEADLESS_VERSION: VERSION,
    });
    const runtime = new IntegrationRuntime(config, (message) => log(`sidecar: ${message}`));
    runtimes.push(runtime);
    await runtime.start();
    const login = seen.find((call) => call.path === "/auth/login");
    expect(login?.headers["x-space-client"]).toBe(`badger/jellyfin/${VERSION}`);
    const state = runtime.status();
    log("status after login 426", { state: state.state, updateRequired: state.updateRequired });
    expect(state.state).toBe("update_required");
    expect(state.updateRequired?.reason).toBe("api_refused");
  });

  it("the switch's own 426 (op stream 4, which this build reads) is not 'please update'; a newer op stream is", async () => {
    let opStream = 4;
    serve((call) => profilesRoute(call) ?? (call.path === "/library/db/meta" ? refusal({ reason: "library_op_stream", opStreamVersion: opStream, minVersion: "" }) : null));
    const first = signedIn();
    await first.runtime.start();
    const switchState = await first.status();
    log("426 op stream 4", { state: switchState.state, lastError: switchState.lastError });
    expect(switchState.state).not.toBe("update_required");
    expect(switchState.updateRequired).toBeNull();

    opStream = 5;
    const second = signedIn();
    await second.runtime.start();
    const tooNew = await second.status();
    log("426 op stream 5", { state: tooNew.state, updateRequired: tooNew.updateRequired });
    expect(tooNew.state).toBe("update_required");
    expect(tooNew.updateRequired).toMatchObject({ reason: "api_refused", minVersion: null });
  });

  it("a library too new for this build stops the sync with nothing applied", async () => {
    serve(profilesRoute);
    const { runtime, status, lines } = signedIn();
    let syncs = 0;
    const fakeDb = {
      getVersion: () => 41,
      syncFromRemoteIfNewer: async () => {
        syncs += 1;
        throw new LibraryFormatTooNewError({ surface: "op-stream", observed: 5, supported: 4 });
      },
      listMedia: () => [],
      close: () => undefined,
    };
    // Test seam: install a library that refuses as too new, as LibraryDb does on a forward skew, without a real open.
    const internals = runtime as unknown as { db: unknown; profile: unknown; starting: boolean };
    internals.db = fakeDb;
    internals.profile = { id: PROFILE.id, name: PROFILE.name, prefix: "" };
    internals.starting = false;
    await runtime.syncOnce("interval");
    const after = await status();
    log("status after too-new", { state: after.state, updateRequired: after.updateRequired, libraryVersion: after.libraryVersion });
    expect(after.state).toBe("update_required");
    expect(after.updateRequired?.reason).toBe("library_format_too_new");
    expect(after.libraryVersion).toBe(41);
    expect(lines).toContain("library sync stopped: update required, nothing applied");
    await runtime.syncOnce("interval");
    expect(syncs).toBe(1);
  });

  it("only a 426 app_update_required body counts as a refusal", () => {
    expect(updateRequiredFromResponse(426, { error: "app_update_required", minVersion: "0.3.0.0" })).toMatchObject({ reason: "api_refused", minVersion: "0.3.0.0" });
    expect(updateRequiredFromResponse(426, { error: "app_update_required", reason: "library_op_stream", opStreamVersion: 5 })).toMatchObject({ reason: "api_refused", minVersion: null });
    expect(updateRequiredFromResponse(426, { error: "other" })).toBeNull();
    expect(updateRequiredFromResponse(503, { error: "app_update_required" })).toBeNull();
    expect(updateRequiredFromResponse(426, null)).toBeNull();
  });
});

/** A version-3 format or audio track row: chunks inline. */
type V3Row = { id: string; durationSeconds?: number | null; chunks?: ChunkRef[] };
/** The same row in a version-4 playback set: chunks packed. */
type V4Row = { id: string; chunkList: PackedChunkListJson };

type Vectors = {
  explicit: Array<{ name: string; expected: { json: PackedChunkListJson; keys: string[]; decodedStarts: Array<number | null> } }>;
  seeded: Array<{ name: string; expected: { json: PackedChunkListJson; keys: string[]; decodedStarts: Array<number | null> } }>;
  translations: Array<{
    name: string;
    input: { payload: { details: { formats?: V3Row[]; audioTracks?: V3Row[] } } };
    expected: { playbackSets: Array<{ payload: { formats: V4Row[]; audioTracks: V4Row[] } }> };
  }>;
};

const vectors: Vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../../../../packages/library-db-definition/test-vectors/chunk-lists.json"), "utf8")
);

describe("shared packed chunk-list vectors play as the same HLS segments (LIB-FMT-11)", () => {
  it.each([...vectors.explicit, ...vectors.seeded].map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    const chunks = unpackChunkList(chunkListFromJson(vector.expected.json));
    const segments = segmentsFromChunks(chunks, null);
    log(`vector ${vector.name}`, { count: chunks.length, segments: segments.slice(0, 3) });
    expect(segments.map((segment) => segment.key)).toEqual(vector.expected.keys);
    expect(chunks.map((chunk) => chunk.startSeconds)).toEqual(vector.expected.decodedStarts);
    for (const [index, segment] of segments.entries()) {
      const start = vector.expected.decodedStarts[index];
      const next = vector.expected.decodedStarts[index + 1];
      if (typeof start === "number" && typeof next === "number" && next > start) expect(segment.durationSeconds).toBeCloseTo(next - start, 6);
      expect(segment.durationSeconds).toBeGreaterThan(0);
    }
  });

  it.each(vectors.translations.map((vector) => [vector.name, vector] as const))("translation %s keeps every playable segment", (_name, vector) => {
    const details = vector.input.payload.details;
    const translated = vector.expected.playbackSets.flatMap((set) => [...set.payload.formats, ...set.payload.audioTracks]);
    const before = [...(details.formats ?? []), ...(details.audioTracks ?? [])].filter((row) => (row.chunks?.length ?? 0) > 0);
    log(`translation ${vector.name}`, { v3Rows: before.length, v4Rows: translated.length });
    for (const row of before) {
      const v3Chunks = row.chunks ?? [];
      const match = translated.find((entry) => entry.id === row.id);
      expect(match, String(row.id)).toBeDefined();
      const v4Chunks = unpackChunkList(chunkListFromJson(match!.chunkList));
      const duration = row.durationSeconds ?? null;
      const v3Segments = segmentsFromChunks(v3Chunks, duration);
      const v4Segments = segmentsFromChunks(v4Chunks, duration);
      expect(v4Segments.map((segment) => segment.key)).toEqual(v3Segments.map((segment) => segment.key));
      // Starts are stored to the millisecond (LIB-FMT-11), so durations agree to 1 ms.
      for (const [index, segment] of v4Segments.entries()) expect(Math.abs(segment.durationSeconds - v3Segments[index]!.durationSeconds)).toBeLessThanOrEqual(0.0011);
    }
  });
});
