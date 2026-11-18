/**
 * @test-id PARROT-DESKTOP-LIBRARY-DBS-001
 * @level unit
 * @why PAR-UP-03 @bugfix: during an import main replaced the current library and the save replay closed the database
 *   another save or the window was still reading ("database is not open" from parrot:library:get, the kept songs and
 *   the playlists). A database now closes only once it is neither the current library nor held by a save. Real
 *   SQLite libraries (openParrotLibrary), so a read on a closed one fails exactly as it did in the app.
 * @covers apps/parrot/desktop/src/main/libraryDbs.ts
 */
import { describe, expect, it } from "vitest";
import { listParrotTracks, openParrotLibrary, type ParrotLibraryDb } from "@space/parrot-ingest";
import { createLibraryDbs } from "../src/main/libraryDbs";

const log = (message: string, data?: unknown) => console.log(`[PARROT-DESKTOP-LIBRARY-DBS-001] ${message}`, data === undefined ? "" : JSON.stringify(data));

const setup = () => {
  const closes: ParrotLibraryDb[] = [];
  const lines: string[] = [];
  const dbs = createLibraryDbs<ParrotLibraryDb>(
    (db) => {
      closes.push(db);
      db.close();
    },
    (line) => lines.push(line)
  );
  return { dbs, closes, lines };
};

/** Reads the library the way parrot:library:get does; throws "database is not open" on a closed one. */
const read = (db: ParrotLibraryDb) => listParrotTracks(db).length;

describe("createLibraryDbs", () => {
  it("keeps a replaced library open while a save holds it, and closes it when the save ends", async () => {
    const { dbs, closes } = setup();
    const first = openParrotLibrary(null);
    const second = openParrotLibrary(null);
    dbs.setCurrent(first);
    const publishing = Promise.withResolvers<void>();
    const saving = dbs.hold(first, async () => {
      await publishing.promise;
      return read(first);
    });
    dbs.setCurrent(second);
    log("closes while held", closes.length);
    expect(closes).toEqual([]);
    expect(read(first)).toBe(0);
    publishing.resolve();
    expect(await saving).toBe(0);
    log("closes after the save", closes.length);
    expect(closes).toEqual([first]);
    expect(() => read(first)).toThrow();
    expect(read(second)).toBe(0);
  });

  it("never closes the current library, even when a replay retires it", async () => {
    const { dbs, closes } = setup();
    const current = openParrotLibrary(null);
    dbs.setCurrent(current);
    dbs.retire(current);
    await dbs.hold(current, async () => read(current));
    log("closes", closes.length);
    expect(closes).toEqual([]);
    expect(read(current)).toBe(0);
    dbs.setCurrent(null);
    expect(closes).toEqual([current]);
  });

  it("closes a retired library that is not current right away, and only once", () => {
    const { dbs, closes } = setup();
    const replayed = openParrotLibrary(null);
    dbs.retire(replayed);
    dbs.retire(replayed);
    log("closes", closes.length);
    expect(closes).toEqual([replayed]);
  });

  it("waits for every save holding the same library", async () => {
    const { dbs, closes } = setup();
    const old = openParrotLibrary(null);
    dbs.setCurrent(old);
    const publishes = [0, 1].map(() => Promise.withResolvers<void>());
    const saves = publishes.map((publishing) => dbs.hold(old, () => publishing.promise));
    dbs.setCurrent(openParrotLibrary(null));
    publishes[0]!.resolve();
    await saves[0];
    expect(closes).toEqual([]);
    publishes[1]!.resolve();
    await saves[1];
    expect(closes).toEqual([old]);
  });

  it("logs a close that fails instead of throwing it into the save", async () => {
    const lines: string[] = [];
    const dbs = createLibraryDbs<{ id: number }>(
      () => {
        throw new Error("busy");
      },
      (line) => lines.push(line)
    );
    const db = { id: 1 };
    expect(() => dbs.retire(db)).not.toThrow();
    log("lines", lines);
    expect(lines).toEqual(["[library] could not close a replaced library: busy"]);
  });
});
