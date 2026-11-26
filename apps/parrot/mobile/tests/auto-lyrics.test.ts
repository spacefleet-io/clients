/**
 * @test-id PARROT-MOBILE-AUTO-LYRICS-001
 * @level unit
 * @req PAR-LYR-01[parrot]
 * @why PAR-LYR-01: the phone runs the same automatic lyrics lookup as the desktop. The phone's library module opens a
 *   real SQLite library (node:sqlite standing in for the phone's SQLite) and `autoFetchLyrics` asks only the songs never
 *   looked up (not a song whose file has words), saves the words found and the final "No lyrics" through the phone's
 *   save queue, leaves out a song deleted while the pass ran, asks nothing on the next pass, and saves nothing once
 *   signed out. The lookup and the snapshot upload are replaced; the queries, the pass and the ops are the real code.
 * @covers apps/parrot/mobile/src/lib/library.ts
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { MusicLyrics, MusicLyricsQuery } from "@space/shared/api";
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type * as ParrotCore from "@space/parrot-core";
import { PARROT_LIBRARY_MIGRATIONS, PARROT_LIBRARY_SCHEMA_VERSION } from "@space/parrot-library-db-definition/migrations";

const state = vi.hoisted(() => ({ db: null as null | DatabaseSync, saves: [] as string[], version: 7 }));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-AUTO-LYRICS-001] ${step}`, JSON.stringify(detail));

vi.mock("react-native-quick-crypto", async () => ({ default: await vi.importActual("node:crypto") }));
vi.mock("react-native-fs", () => ({
  default: {
    DocumentDirectoryPath: "/data/app/files",
    CachesDirectoryPath: "/data/app/cache",
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    unlink: async () => undefined,
    exists: async () => false,
  },
}));
vi.mock("react-native-sqlite-storage", () => ({
  default: {
    enablePromise: () => undefined,
    openDatabase: async () => {
      const db = state.db!;
      return {
        executeSql: async (sql: string, params: unknown[] = []) => {
          const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
          return [{ rows: { length: rows.length, item: (i: number) => rows[i] }, rowsAffected: 0 }];
        },
        sqlBatch: async () => undefined,
        close: async () => undefined,
      };
    },
  },
}));
vi.mock("@space/shared/api", () => ({ getLibraryDb: async () => ({}) }));
vi.mock("@space/mobile-shell/librarySnapshot", () => ({
  openRemoteLibrarySnapshot: async () => ({ dbBytes: new Uint8Array([1]), snapshotVersion: 7 }),
}));
vi.mock("@space/mobile-shell/libraryEnvelope", () => ({ decryptBytesToBytes: async (_key: string, bytes: Uint8Array) => bytes }));
vi.mock("@space/library-db-definition/storageFormat", () => ({ STORAGE_FORMAT_VERSION: 1 }));
// Cover copies use React Native's Image; no cover is made here.
vi.mock("../src/lib/coverCopies", () => ({ phoneCoverCopies: async () => null }));
vi.mock("../src/config", () => ({ API_BASE_URL: "http://localhost:8000" }));
// Platform picks where the library file lives (@space/mobile-shell/app-data).
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
// The save queue: the ops are applied to the open library as the real one does, the upload is left out.
vi.mock("../src/lib/saveEdits", async () => {
  const { parrotOpStatements } = await vi.importActual<typeof ParrotCore>("@space/parrot-core");
  return {
    createPhoneOpsSaver: () => ({
      save: async (label: string, build: (library: unknown) => Promise<readonly ParrotLibraryOp[]>) => {
        const ops = await build({ baseVersion: state.version, playlists: [] });
        for (const { sql, params } of parrotOpStatements(ops)) state.db!.prepare(sql).run(...(params as never[]));
        state.saves.push(`${label}: ${ops.map((op) => (op.type === "lyrics.set" ? `${op.payload.trackId}=${op.payload.source}` : op.type)).join(",")}`);
        state.version += 1;
        return state.version;
      },
      serial: async <T,>(task: () => Promise<T>) => task(),
      publish: async () => state.version,
      savePlaylistEdits: async () => state.version,
    }),
  };
});

import { autoFetchLyrics, openLibrary, readTrackLyrics } from "../src/lib/library";

const library = () => {
  const db = new DatabaseSync(":memory:");
  for (const sql of PARROT_LIBRARY_MIGRATIONS.flat()) db.exec(sql);
  db.exec(`PRAGMA user_version = ${PARROT_LIBRARY_SCHEMA_VERSION}`);
  db.exec(`INSERT INTO artists (id, name, sort_name) VALUES ('ar-1', 'Linnet Park', 'Linnet Park')`);
  db.exec(`INSERT INTO albums (id, title, album_artist_id, year, created_at) VALUES ('al-1', 'Hollow Signal', 'ar-1', 2000, 0)`);
  const track = db.prepare(`INSERT INTO tracks (id, album_id, number, title, artist_id, duration_ms) VALUES (?, 'al-1', ?, ?, 'ar-1', 200000)`);
  track.run("tr-end", 8, "At the Gate");
  track.run("tr-fable", 9, "Fable");
  track.run("tr-cresting", 2, "Cresting");
  track.run("tr-gone", 10, "Deleted Meanwhile");
  // Cresting's file carries its own words: never asked.
  db.exec(`INSERT INTO lyrics (track_id, plain, synced, source, fetched_at) VALUES ('tr-cresting', 'Cresting the morning tide', NULL, 'file', NULL)`);
  return db;
};

const SYNCED = "[00:01.00]The ferry leaves at noon\n[00:04.00]The gulls are calling";

describe("the phone's automatic lyrics lookup", () => {
  it("looks up every song never asked, saves the words and the final No lyrics, and asks nothing next time", async () => {
    state.db = library();
    state.saves = [];
    await openLibrary("token", "library-key");
    const asked: string[] = [];
    const lookup = async (question: MusicLyricsQuery): Promise<MusicLyrics> => {
      asked.push(question.title);
      // Another device deletes this song while the pass runs.
      if (question.title === "Deleted Meanwhile") state.db!.exec("DELETE FROM tracks WHERE id = 'tr-gone'");
      return question.title === "At the Gate" ? { plain: null, synced: SYNCED } : { plain: null, synced: null };
    };
    const versions: number[] = [];
    const report = await autoFetchLyrics({ lookup, signal: new AbortController().signal, canSpend: () => true, saved: (version) => versions.push(version) });
    log("first pass", { report, asked, saves: state.saves, versions });
    expect(asked).toEqual(["At the Gate", "Fable", "Deleted Meanwhile"]);
    expect(report).toMatchObject({ asked: 3, found: 1, none: 2, failed: 0, stopped: false });
    expect(state.saves).toEqual(["lyrics for 3 song(s), looked up on their own: tr-end=fetched,tr-fable=none"]);
    expect(versions).toEqual([8]);
    expect((await readTrackLyrics("tr-end"))?.synced?.[0]?.text).toBe("The ferry leaves at noon");
    expect(await readTrackLyrics("tr-fable")).toMatchObject({ notFound: true });
    expect((await readTrackLyrics("tr-cresting"))?.plain).toBe("Cresting the morning tide");

    const again = await autoFetchLyrics({ lookup, signal: new AbortController().signal, canSpend: () => true, saved: (version) => versions.push(version) });
    log("second pass", { again });
    expect(again.asked).toBe(0);
    expect(state.saves).toHaveLength(1);
  });

  it("saves nothing once signed out", async () => {
    state.db = library();
    state.saves = [];
    await openLibrary("token", "library-key");
    const stop = new AbortController();
    const lookup = async (): Promise<MusicLyrics> => {
      stop.abort();
      return { plain: null, synced: SYNCED };
    };
    const report = await autoFetchLyrics({ lookup, signal: stop.signal, canSpend: () => true, saved: () => undefined });
    log("signed out", { report, saves: state.saves });
    expect(report.stopped).toBe(true);
    expect(state.saves).toEqual([]);
  });
});
