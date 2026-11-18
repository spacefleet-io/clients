/**
 * @test-id PARROT-INGEST-PUBLISH-001
 * @level unit (real node:sqlite library, in-memory snapshot server)
 * @why Playlists are saved from the desktop into the encrypted library (PAR-PL-03). When another device published
 *      first, the save fetches the newer library, rebuilds the same edits on it and publishes once more, so both
 *      devices' changes survive; a second failure reports the error and leaves a working library behind.
 * @covers packages/parrot-ingest/src/publish.ts, packages/parrot-ingest/src/library.ts: listParrotPlaylists
 */
import { describe, expect, it } from "bun:test";
import { parrotPlaylistEditOps, PARROT_LIKED_PLAYLIST_ID, type ParrotPlaylistEdit } from "@space/parrot-core";
import { applyParrotOps, listParrotPlaylists, openParrotLibrary, serializeParrotLibrary, type ParrotLibraryDb } from "../src/library";
import { fetchParrotLibraryState, publishParrotEdits, type ParrotSnapshotTransport } from "../src/publish";

const TOKEN = "token-abc";
const KEY = Buffer.alloc(32, 7).toString("base64");
let ids = 0;
const context = () => ({ now: 1_000 + ids, newId: () => `op-${(ids += 1)}` });

/** One snapshot server shared by two devices; `failNext` makes the next publish fail (not a conflict) whatever its version. */
const createServer = () => {
  const server = { version: 0, dbBytes: null as Uint8Array | null, publishes: [] as number[], failNext: 0 };
  const transport = {
    fetchSnapshot: async () => (server.dbBytes ? { snapshotVersion: server.version, dbBytes: server.dbBytes } : null),
    publishSnapshot: async (input: { dbBytes: Uint8Array; baseVersion: number }) => {
      server.publishes.push(input.baseVersion);
      if (server.failNext > 0) {
        server.failNext -= 1;
        throw new Error("network down");
      }
      if (input.baseVersion !== server.version)
        throw Object.assign(new Error(`library_db_conflict: base ${input.baseVersion}, server ${server.version}`), { status: 409 });
      server.version += 1;
      server.dbBytes = new Uint8Array(input.dbBytes);
      return { version: server.version };
    },
  } as unknown as ParrotSnapshotTransport;
  return { server, transport };
};

/** What the desktop's editPlaylists does: build, apply, publish, rebuild on conflict. */
const save = async (state: { db: ParrotLibraryDb; baseVersion: number }, edits: ParrotPlaylistEdit[], transport: ParrotSnapshotTransport, log: string[]) => {
  const build = (db: ParrotLibraryDb) => parrotPlaylistEditOps(listParrotPlaylists(db), edits, context());
  applyParrotOps(state.db, build(state.db));
  return publishParrotEdits(state, build, { transport, token: TOKEN, libraryKeyBase64: KEY, log: (m) => log.push(m) });
};
const view = (db: ParrotLibraryDb) => listParrotPlaylists(db).map((p) => `${p.name}: ${p.trackIds.join(",")}`);

describe("publishParrotEdits", () => {
  // @req PAR-PL-03
  it("replays on the newer library when another device saved first, keeping both devices' edits", async () => {
    const { server, transport } = createServer();
    const options = { transport, token: TOKEN, libraryKeyBase64: KEY };
    const log: string[] = [];
    // v1: a "Gym" playlist with one song.
    const seed = await fetchParrotLibraryState(options);
    await save(seed, [{ kind: "create", id: "gym", name: "Gym", trackIds: ["t1"] }], transport, log);
    expect(server.version).toBe(1);

    // Both computers open v1.
    const desk = await fetchParrotLibraryState(options);
    const laptop = await fetchParrotLibraryState(options);
    // The laptop saves first: t3 into Gym, and likes t1.
    await save(laptop, [{ kind: "add", id: "gym", trackIds: ["t3"] }, { kind: "like", trackId: "t1", liked: true }], transport, log);
    expect(server.version).toBe(2);
    // The desk, still on v1, adds t2 to Gym: its first publish conflicts, the replay lands.
    const version = await save(desk, [{ kind: "add", id: "gym", trackIds: ["t2"] }], transport, log);
    console.log("[PARROT-INGEST-PUBLISH-001] log", log);
    console.log("[PARROT-INGEST-PUBLISH-001] publishes (base versions)", server.publishes);
    expect(version).toBe(3);
    expect(desk.baseVersion).toBe(3);
    expect(server.publishes).toEqual([0, 1, 1, 2]);
    expect(log.some((m) => m.includes("publish on v1 failed (library_db_conflict"))).toBe(true);
    const published = openParrotLibrary(server.dbBytes);
    console.log("[PARROT-INGEST-PUBLISH-001] published playlists", view(published));
    expect(view(published)).toEqual(["Liked songs: t1", "Gym: t1,t3,t2"]);
    expect(view(desk.db)).toEqual(view(published));
    expect(listParrotPlaylists(published)[0]!.id).toBe(PARROT_LIKED_PLAYLIST_ID);
  });

  // @req PAR-PL-03
  it("replays only on a conflict: any other failure throws at once and leaves a working library", async () => {
    const { server, transport } = createServer();
    const options = { transport, token: TOKEN, libraryKeyBase64: KEY };
    const state = await fetchParrotLibraryState(options);
    server.failNext = 1;
    const log: string[] = [];
    await expect(save(state, [{ kind: "create", id: "calm", name: "Calm" }], transport, log)).rejects.toThrow("network down");
    console.log("[PARROT-INGEST-PUBLISH-001] failing log", log);
    expect(server.publishes).toEqual([0]);
    expect(log.some((m) => m.includes("replaying"))).toBe(false);
    expect(server.version).toBe(0);
    // The library is still open and readable.
    expect(view(state.db)).toEqual(["Calm: "]);
  });

  // @req PAR-PL-01
  it("a library from before playlists opens with an empty playlist list and keeps it after a round trip", () => {
    const db = openParrotLibrary(null);
    expect(listParrotPlaylists(db)).toEqual([]);
    applyParrotOps(db, parrotPlaylistEditOps([], [{ kind: "create", id: "a", name: "A", trackIds: ["x", "y"] }], context()));
    const again = openParrotLibrary(serializeParrotLibrary(db));
    expect(view(again)).toEqual(["A: x,y"]);
  });
});
