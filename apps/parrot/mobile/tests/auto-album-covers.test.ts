/**
 * @test-id PARROT-MOBILE-AUTO-ALBUM-COVERS-001
 * @level unit
 * @req PAR-META-20[parrot]
 * @why Chris 2026-11-16: loading must never look like "no cover", and the phone looks covers up on its own like the
 *   desktop. The phone's library module opens a real SQLite library (node:sqlite standing in for the phone's SQLite)
 *   and `autoFetchAlbumCovers` asks only the albums with a known catalog id and no cover, tells which albums it
 *   still waits on (their tiles shimmer), seals and stores a found cover in both sizes, saves it through the phone's
 *   save queue, remembers on this device which albums were asked so the next pass asks none, and saves nothing once
 *   signed out. The lookup, the sealing and the upload are replaced; the queries, the pass and the ops are the real code.
 * @covers apps/parrot/mobile/src/lib/library.ts
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { MusicCoverSize, MusicImage } from "@space/shared/api";
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type * as ParrotCore from "@space/parrot-core";
import { PARROT_LIBRARY_MIGRATIONS, PARROT_LIBRARY_SCHEMA_VERSION } from "@space/parrot-library-db-definition/migrations";

const state = vi.hoisted(() => ({
  db: null as null | DatabaseSync,
  saves: [] as string[],
  version: 7,
  storage: new Map<string, string>(),
  stored: [] as number[],
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-AUTO-ALBUM-COVERS-001] ${step}`, JSON.stringify(detail));

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
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => state.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void state.storage.set(key, value),
    removeItem: async (key: string) => void state.storage.delete(key),
  },
}));
vi.mock("@space/shared/api", () => ({
  getLibraryDb: async () => ({}),
  // The sealed copy is "stored" under a key naming its size, so the test reads which copy went where.
  uploadStorageObjectViaTunnel: async (_token: string, _key: string, bytes: Uint8Array) => {
    state.stored.push(bytes.length);
    return `obj-${bytes.length}`;
  },
}));
vi.mock("@space/mobile-shell/librarySnapshot", () => ({
  openRemoteLibrarySnapshot: async () => ({ dbBytes: new Uint8Array([1]), snapshotVersion: 7 }),
}));
vi.mock("@space/mobile-shell/libraryEnvelope", () => ({
  decryptBytesToBytes: async (_key: string, bytes: Uint8Array) => bytes,
  encryptBytesToBytes: async (_key: string, bytes: Uint8Array) => bytes,
}));
vi.mock("@space/library-db-definition/storageFormat", () => ({ STORAGE_FORMAT_VERSION: 1 }));
// Cover copies use React Native's Image: a large copy of 3 bytes and a small one of 1.
vi.mock("../src/lib/coverCopies", () => ({ phoneCoverCopies: async () => ({ large: new Uint8Array(3), thumb: new Uint8Array(1) }) }));
vi.mock("../src/config", () => ({ API_BASE_URL: "http://localhost:8000" }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../src/lib/saveEdits", async () => {
  const { parrotOpStatements } = await vi.importActual<typeof ParrotCore>("@space/parrot-core");
  return {
    createPhoneOpsSaver: () => ({
      save: async (label: string, build: (library: unknown) => Promise<readonly ParrotLibraryOp[]>) => {
        const ops = await build({ baseVersion: state.version, playlists: [] });
        for (const { sql, params } of parrotOpStatements(ops)) state.db!.prepare(sql).run(...(params as never[]));
        state.saves.push(`${label}: ${ops.map((op) => (op.type === "album.upsert" ? `${op.payload.id}=${op.payload.coverObjectKey}` : op.type)).join(",")}`);
        state.version += 1;
        return state.version;
      },
      serial: async <T,>(task: () => Promise<T>) => task(),
      publish: async () => state.version,
      savePlaylistEdits: async () => state.version,
    }),
  };
});

import { autoFetchAlbumCovers, openLibrary } from "../src/lib/library";

const library = () => {
  const db = new DatabaseSync(":memory:");
  for (const sql of PARROT_LIBRARY_MIGRATIONS.flat()) db.exec(sql);
  db.exec(`PRAGMA user_version = ${PARROT_LIBRARY_SCHEMA_VERSION}`);
  db.exec(`INSERT INTO artists (id, name, sort_name) VALUES ('ar-1', 'Linnet Park', 'Linnet Park')`);
  const album = db.prepare(`INSERT INTO albums (id, title, album_artist_id, year, created_at, music_id, cover_object_key) VALUES (?, ?, 'ar-1', 2000, 0, ?, ?)`);
  album.run("al-found", "Hollow Signal", "album-found", null);
  album.run("al-none", "Meltway", "album-none", null);
  album.run("al-unknown", "Bootleg", null, null); // no catalog id: never asked
  album.run("al-covered", "Minutes to Daybreak", "album-covered", "obj-kept"); // has a cover: never asked
  return db;
};

const COVER: MusicImage = { mime: "image/jpeg", base64: Buffer.from("cover").toString("base64") };

describe("the phone's automatic album-cover lookup", () => {
  it("asks only coverless albums with a catalog id, says which it waits on, saves the found cover, and asks nothing next time", async () => {
    state.db = library();
    state.saves = [];
    state.stored = [];
    state.storage.clear();
    await openLibrary("token", "library-key");
    const asked: Array<[string, MusicCoverSize]> = [];
    const lookup = async (albumId: string, size: MusicCoverSize) => {
      asked.push([albumId, size]);
      return { cover: albumId === "album-found" ? COVER : null };
    };
    const waiting: string[][] = [];
    const versions: number[] = [];
    const report = await autoFetchAlbumCovers({
      lookup,
      signal: new AbortController().signal,
      canSpend: () => true,
      saved: (version) => versions.push(version),
      onWaiting: (ids) => waiting.push([...ids].sort()),
    });
    log("first pass", { report, asked, waiting, saves: state.saves, stored: state.stored, versions });
    expect(asked.map(([albumId]) => albumId).sort()).toEqual(["album-found", "album-none"]);
    expect(report).toMatchObject({ asked: 2, found: 1, none: 1, failed: 0, stopped: false });
    expect(waiting[0], "both covers shimmer from the start").toEqual(["al-found", "al-none"]);
    expect(waiting.at(-1), "nothing waits at the end").toEqual([]);
    expect(state.stored.sort()).toEqual([1, 3]);
    expect(state.saves).toEqual(["covers for 1 album(s), looked up on their own: al-found=obj-3"]);
    expect(versions).toEqual([8]);
    expect(state.db.prepare("SELECT cover_thumb_object_key AS thumb FROM albums WHERE id = 'al-found'").get()).toEqual({ thumb: "obj-1" });
    const kept = JSON.parse(state.storage.get("parrot.albumCovers.asked") ?? "{}") as Record<string, number>;
    expect(Object.keys(kept).sort(), "remembered on this device").toEqual(["al-found", "al-none"]);

    const again = await autoFetchAlbumCovers({ lookup, signal: new AbortController().signal, canSpend: () => true, saved: () => undefined, onWaiting: () => undefined });
    log("second pass", { again });
    expect(again.asked, "Meltway was answered lately: not asked again").toBe(0);
    expect(state.saves).toHaveLength(1);
  });

  it("saves nothing once signed out", async () => {
    state.db = library();
    state.saves = [];
    state.storage.clear();
    await openLibrary("token", "library-key");
    const stop = new AbortController();
    const lookup = async () => {
      stop.abort();
      return { cover: COVER };
    };
    const report = await autoFetchAlbumCovers({ lookup, signal: stop.signal, canSpend: () => true, saved: () => undefined, onWaiting: () => undefined });
    log("signed out", { report, saves: state.saves });
    expect(report.stopped).toBe(true);
    expect(state.saves).toEqual([]);
  });
});
