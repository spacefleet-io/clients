/**
 * @test-id PARROT-INGEST-PUBLISH-OPSTREAM-001
 * @level unit (real node:sqlite library, real snapshot transport and API client; fake HTTP server, no storage)
 * @bugfix @regression-proof
 * @why Parrot's desktop saves published every snapshot declaring Badger's change-type version (2) instead of
 *      Parrot's own (4). Once Parrot mobile had published at 4, the server's downgrade guard (LIB-FMT-05) refused every
 *      later desktop save with 409 `library_format_downgrade` (observed 2, stored 4), so playlists, edits and imports
 *      made on the computer stopped reaching the account. Each app must declare its own version (LIB-FMT-09).
 * @covers packages/parrot-ingest/src/publish.ts, packages/library-db-runtime/src/snapshotTransport.ts
 *         (publishLibrarySnapshot), packages/library-db-runtime/src/api.ts (putLibraryDb)
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { parrotPlaylistEditOps, type ParrotPlaylistEdit } from "@space/parrot-core";
import { PARROT_OP_STREAM_VERSION } from "@space/parrot-library-db-definition/ops";
import { OP_STREAM_VERSION as BADGER_OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import * as realApi from "@space/library-db-runtime/api";
import { applyParrotOps, listParrotPlaylists, openParrotLibrary, serializeParrotLibrary } from "../src/library";
import { publishParrotEdits, type ParrotSnapshotTransport } from "../src/publish";
import { testLog } from "./helpers";

const log = testLog("PARROT-INGEST-PUBLISH-OPSTREAM-001");
const TOKEN = "token-parrot";
const KEY = Buffer.alloc(32, 9).toString("base64");
const API = "http://api.parrot-opstream.test";

// The chunk uploads go through the storage tunnel and the key check reads the account's probe; neither matters
// here, so only those two calls are stubbed. PUT /library/db stays the real API client over the fake server below.
const uploads: string[] = [];
mock.module("@space/library-db-runtime/api", () => ({
  ...realApi,
  uploadStorageObjectViaTunnel: async (_token: string, objectKey: string) => {
    uploads.push(objectKey);
    return { objectKey };
  },
  getLibraryMeta: async () => ({ exists: true, keyProbe: null }),
}));
// Loaded after mock.module so the transport binds the stubbed upload and meta calls.
const { publishLibrarySnapshot } = await import("@space/library-db-runtime/snapshotTransport");

/** The API's library row for one account and app: version, stored format versions, and every PUT body it saw. */
const server = { version: 0, opStreamVersion: 1, dbBytes: null as Uint8Array | null, bodies: [] as Record<string, unknown>[] };
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
const previousBase = process.env.SF_API_BASE_URL;
beforeAll(() => {
  process.env.SF_API_BASE_URL = API;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (request.method !== "PUT" || url.pathname !== "/library/db") return json({ error: "unexpected" }, 500);
    const body = (await request.json()) as Record<string, unknown>;
    server.bodies.push(body);
    log("PUT /library/db", { app: request.headers.get("x-space-app"), expectedVersion: body.expectedVersion, opStreamVersion: body.opStreamVersion, stored: server.opStreamVersion });
    // The API's putLibraryBlob: a declared format below the stored one is a downgrade (LIB-FMT-05), checked first.
    const declared = Number(body.opStreamVersion ?? 1);
    if (declared < server.opStreamVersion) {
      return json({ error: "library_format_downgrade", surface: "op-stream", observed: declared, stored: server.opStreamVersion }, 409);
    }
    if (body.expectedVersion !== server.version) return json({ error: "version_conflict", version: server.version }, 409);
    server.version += 1;
    server.opStreamVersion = Math.max(server.opStreamVersion, declared);
    return json({ version: server.version, stateHash: null, lastOpId: null }, 200);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (previousBase === undefined) delete process.env.SF_API_BASE_URL;
  else process.env.SF_API_BASE_URL = previousBase;
});

let ids = 0;
const context = () => ({ now: 5_000 + ids, newId: () => `op-${(ids += 1)}` });

describe("Parrot desktop publish declares Parrot's own change-type version", () => {
  // @req LIB-FMT-09[parrot]
  it("saves a playlist into a library Parrot mobile already stamped at op stream 4 (no library_format_downgrade)", async () => {
    // Parrot mobile published v1 at its op-stream version: the server now holds the library stamped at 4.
    const mobile = openParrotLibrary(null);
    server.version = 1;
    server.opStreamVersion = PARROT_OP_STREAM_VERSION;
    server.dbBytes = serializeParrotLibrary(mobile);
    log("server after the phone's publish", { version: server.version, opStreamVersion: server.opStreamVersion, badger: BADGER_OP_STREAM_VERSION });

    const transport: ParrotSnapshotTransport = {
      fetchSnapshot: (async () => ({ snapshotVersion: server.version, dbBytes: server.dbBytes })) as unknown as ParrotSnapshotTransport["fetchSnapshot"],
      publishSnapshot: publishLibrarySnapshot,
    };
    const messages: string[] = [];
    const state = { db: openParrotLibrary(server.dbBytes), baseVersion: server.version };
    const edits: ParrotPlaylistEdit[] = [{ kind: "create", id: "road", name: "Road trip", trackIds: ["t1"] }];
    const build = (db: typeof state.db) => parrotPlaylistEditOps(listParrotPlaylists(db), edits, context());
    applyParrotOps(state.db, build(state.db));

    const outcome = await publishParrotEdits(state, build, { transport, token: TOKEN, libraryKeyBase64: KEY, log: (m) => messages.push(m) }).then(
      (version) => ({ version, error: null as string | null }),
      (error: unknown) => ({ version: null, error: error instanceof Error ? error.message : String(error) })
    );
    log("outcome", outcome, { messages, declared: server.bodies.map((body) => body.opStreamVersion), uploads: uploads.length });

    expect(server.bodies.length).toBeGreaterThan(0);
    for (const body of server.bodies) expect(body.opStreamVersion).toBe(PARROT_OP_STREAM_VERSION);
    expect(outcome.error).toBeNull();
    expect(outcome.version).toBe(2);
    expect(server.opStreamVersion).toBe(PARROT_OP_STREAM_VERSION);
    // A format refusal is not a stale-base conflict: nothing is replayed.
    expect(messages.some((m) => m.includes("replaying"))).toBe(false);
  });
});
