/**
 * @test-id PARROT-MOBILE-PLAYLIST-SAVE-001
 * @level unit
 * @req PAR-PL-01[parrot]
 * @req PAR-PL-02[parrot]
 * @req PAR-PL-03[parrot]
 * @req PAR-PL-04[parrot]
 * @why A heart or playlist change on the phone shows at once and is only real once the server holds it: the edit
 *   runs on the phone's open copy (the screens are told to read it again before the publish starts), which is sealed
 *   and published as the next snapshot through the shared loop and snapshot steps. When another device published
 *   first the change is rebuilt on the latest library and published once more; any other failure reopens the
 *   server's library (so no screen keeps a change the server lacks), or, when that cannot be opened either (no
 *   connection), puts back the copy from before the change, and reports it. Saves go one at a time, each on the
 *   library the previous one left.
 * @covers apps/parrot/mobile/src/lib/saveEdits.ts
 */
import { describe, expect, it } from "vitest";
import { parrotPlaylistEditOps, type ParrotPlaylistEdit } from "@space/parrot-core";
import { createParrotOp } from "@space/parrot-library-db-definition";
import { createPhoneOpsSaver, type PhoneLibraryState, type PhoneSaveDeps } from "../src/lib/saveEdits";

const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-PLAYLIST-SAVE-001] ${step}`, JSON.stringify(detail));
const conflict = () => Object.assign(new Error("library_db_conflict"), { status: 409 });
const identity = (bytes: Uint8Array) => bytes;

/** The phone's open copy is a list of statement batches; the server a version and the puts it took. */
const harness = (failures: unknown[] = [], { reloadFails = false } = {}) => {
  const server = { version: 5, puts: [] as number[], chunks: 0 };
  const phone = { baseVersion: 5, batches: [] as string[][], loads: 0, reloads: 0, restores: 0, published: [] as number[] };
  const events: string[] = [];
  const library = (): PhoneLibraryState => ({ baseVersion: phone.baseVersion, playlists: [] });
  const deps: PhoneSaveDeps = {
    current: async () => library(),
    loadLatest: async () => {
      phone.loads += 1;
      phone.baseVersion = server.version;
      phone.batches = [];
      return library();
    },
    run: async (statements) => {
      events.push(`run:${statements.length}`);
      phone.batches.push(statements.map((statement) => statement.sql));
    },
    readBytes: async () => new TextEncoder().encode(JSON.stringify(phone.batches)),
    published: (version) => {
      phone.baseVersion = version;
      phone.published.push(version);
    },
    reload: async () => {
      phone.reloads += 1;
      events.push("reload");
      if (reloadFails) throw new Error("offline");
      phone.batches = [];
    },
    keep: async () => {
      const before = phone.batches.map((batch) => [...batch]);
      return async () => {
        phone.restores += 1;
        events.push("restore");
        phone.batches = before;
      };
    },
    changed: () => void events.push("changed"),
    snapshot: {
      seal: async (plaintext) => plaintext,
      codec: { deflateRaw: identity, inflateRaw: identity },
      sha256Hex: async (bytes) => `h${bytes.length}`,
      randomId: () => "snap-1",
      uploadChunk: async () => void (server.chunks += 1),
      putSnapshot: async ({ baseVersion }) => {
        server.puts.push(baseVersion);
        events.push(`put:${baseVersion}`);
        for (let tick = 0; tick < 5; tick += 1) await null; // other saves get their turn, if anything lets them in
        const failure = failures.shift();
        if (failure) throw failure;
        server.version += 1;
        return { version: server.version };
      },
    },
    now: () => 1_700_000_000_000,
    newId: (() => {
      let next = 0;
      return () => `op-${(next += 1)}`;
    })(),
  };
  return { server, phone, events, deps };
};

const like: ParrotPlaylistEdit = { kind: "like", trackId: "t1", liked: true };
const create: ParrotPlaylistEdit = { kind: "create", id: "pl-road", name: "Road trip", trackIds: ["t1", "t2"] };

describe("saving a phone edit", () => {
  it("runs the edit on the open library and publishes it as the next snapshot", async () => {
    const { server, phone, deps } = harness();
    const version = await createPhoneOpsSaver(deps).savePlaylistEdits([like, create]);
    log("saved", { version, server, phone });
    expect(version).toBe(6);
    expect(server.puts).toEqual([5]);
    expect(server.chunks).toBeGreaterThan(0);
    expect(phone.batches).toHaveLength(1);
    expect(phone.batches[0]!.length).toBeGreaterThan(0);
    expect(phone.published).toEqual([6]);
    expect(phone.reloads).toBe(0);
  });

  it("rebuilds the edit on the latest library and publishes once more when another device published first", async () => {
    const { server, phone, deps } = harness([conflict()]);
    server.version = 7;
    const version = await createPhoneOpsSaver(deps).savePlaylistEdits([like]);
    log("replayed", { version, server, phone });
    expect(server.puts).toEqual([5, 7]);
    expect(phone.loads).toBe(1);
    expect(phone.batches).toHaveLength(1);
    expect(version).toBe(8);
    expect(phone.published).toEqual([8]);
  });

  it("reopens the server's library and reports the error when the save fails", async () => {
    const offline = new Error("network down");
    const { server, phone, deps } = harness([offline]);
    await expect(createPhoneOpsSaver(deps).savePlaylistEdits([like])).rejects.toBe(offline);
    log("failed", { server, phone });
    expect(phone.reloads).toBe(1);
    expect(phone.loads).toBe(0);
    expect(phone.published).toEqual([]);
    expect(phone.batches).toEqual([]);
  });

  it("gives up after a second conflict, reopening the server's library", async () => {
    const { phone, deps } = harness([conflict(), conflict()]);
    await expect(createPhoneOpsSaver(deps).savePlaylistEdits([like])).rejects.toMatchObject({ status: 409 });
    expect(phone.loads).toBe(1);
    expect(phone.reloads).toBe(1);
  });

  it("saves one edit at a time, each on the version the previous one published, even after a failure", async () => {
    const { events, phone, deps } = harness([undefined, new Error("lost")]);
    const save = createPhoneOpsSaver(deps).savePlaylistEdits;
    const results = await Promise.allSettled([save([like]), save([create]), save([{ kind: "rename", id: "pl-road", name: "Roads" }])]);
    log("serial", { events, results: results.map((result) => result.status) });
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(events.filter((event) => event.startsWith("put:"))).toEqual(["put:5", "put:6", "put:6"]);
    expect(events.map((event) => event.split(":")[0])).toEqual(
      ["run", "changed", "put", "run", "changed", "put", "reload", "changed", "run", "changed", "put"]
    );
    expect(phone.published).toEqual([6, 7]);
  });

  it("tells the screens the change is there before the publish starts", async () => {
    const { events, deps } = harness();
    await createPhoneOpsSaver(deps).savePlaylistEdits([like]);
    log("shown-first", { events });
    expect(events.indexOf("changed")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("changed")).toBeLessThan(events.findIndex((event) => event.startsWith("put:")));
  });

  it("tells the screens again when the change is rebuilt on another device's library", async () => {
    const { events, server, deps } = harness([conflict()]);
    server.version = 7;
    await createPhoneOpsSaver(deps).savePlaylistEdits([like]);
    log("replay-shown", { events });
    expect(events.map((event) => event.split(":")[0])).toEqual(["run", "changed", "put", "run", "changed", "put"]);
  });

  it("puts back the copy from before the change when the server's library cannot be reopened either", async () => {
    const offline = new Error("network down");
    const { events, phone, deps } = harness([offline], { reloadFails: true });
    phone.batches = [["earlier"]];
    await expect(createPhoneOpsSaver(deps).savePlaylistEdits([like])).rejects.toBe(offline);
    log("restored", { events, phone });
    expect(phone.restores).toBe(1);
    expect(phone.batches).toEqual([["earlier"]]);
    expect(events.slice(-3)).toEqual(["reload", "restore", "changed"]);
  });
});

// @req PAR-LYR-05[parrot]
describe("saving fetched lyrics from the phone", () => {
  it("publishes a lyrics op through the same queue as playlist edits, rebuilding it on the latest library", async () => {
    const { server, phone, events, deps } = harness([undefined, conflict()]);
    const saver = createPhoneOpsSaver(deps);
    const save = saver.save;
    const savePlaylists = (edits: readonly ParrotPlaylistEdit[]) =>
      save(`${edits.length} playlist edit(s)`, (library) => parrotPlaylistEditOps(library.playlists, edits, { now: deps.now(), newId: deps.newId }));
    let builds = 0;
    const lyrics = createParrotOp(
      "lyrics.set",
      { trackId: "t1", plain: "Words", synced: "[00:01.00]Words", source: "fetched", fetchedAt: 1_700_000_000_000 },
      { id: "op-lyrics", createdAt: "2026-11-10T00:00:00.000Z" }
    );
    const [first, second] = await Promise.all([
      savePlaylists([like]),
      save("lyrics for song t1", async () => {
        builds += 1;
        return [lyrics];
      }),
    ]);
    log("lyrics saved", { first, second, builds, server, phone, events });
    expect(first).toBe(6);
    expect(second).toBe(7);
    expect(builds).toBe(2);
    expect(server.puts).toEqual([5, 6, 6]);
    expect(phone.batches.flat().some((sql) => /lyrics/i.test(sql))).toBe(true);
  });
});
