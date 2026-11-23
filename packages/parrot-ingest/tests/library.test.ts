/**
 * @test-id PARROT-INGEST-LIBRARY-001
 * @level unit
 * @why The desktop app and the seed script build Parrot's library snapshot with node:sqlite: a new library gets the
 *      current schema, the import's ops land as artists/albums/songs/files with their chunk maps, the listings the
 *      app shows come back in album order, a serialized snapshot reopens unchanged, and a failing batch leaves
 *      nothing half-applied.
 * @covers packages/parrot-ingest/src/library.ts, packages/parrot-ingest/src/importer.ts: buildParrotTrackOps
 */
import { describe, expect, it } from "bun:test";
import { createParrotOp, PARROT_LIBRARY_SCHEMA_VERSION, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { parrotAudioFormatFor } from "../src/formats";
import { parrotTrackIds, sha256Hex } from "../src/ids";
import { buildParrotTrackOps } from "../src/importer";
import {
  applyParrotOps,
  getParrotFile,
  hasParrotFile,
  listParrotAlbums,
  listParrotArtists,
  listParrotTracks,
  openParrotLibrary,
  serializeParrotLibrary,
  type ParrotLibraryDb,
} from "../src/library";
import type { ParrotTrackInfo } from "../src/readTrack";
import { applyParrotImportEdit } from "../src/scan";
import { testLog } from "./helpers";

const log = testLog("PARROT-INGEST-LIBRARY-001");

const song = (patch: Partial<ParrotTrackInfo> & { title: string; number: number }): ParrotTrackInfo => ({
  file: `/music/${patch.title}.mp3`,
  artist: "Linnet Park",
  albumArtist: "Linnet Park",
  album: "Meltway",
  disc: 1,
  year: 2003,
  durationMs: 187_000,
  bitrateKbps: 320,
  sampleRate: 44100,
  format: parrotAudioFormatFor("x.mp3")!,
  ...patch,
});

const addSong = (db: ParrotLibraryDb, info: ParrotTrackInfo, chunkCount = 2) => {
  const fileHash = sha256Hex(`bytes of ${info.album}/${info.title}`);
  const ids = parrotTrackIds({ ...info, fileHash });
  const chunks = Array.from({ length: chunkCount }, (_, idx) => ({
    idx,
    objectKey: `media/p/${ids.fileId}/chunk-${idx}`,
    plainOffset: idx * 1000,
    plainSize: idx === chunkCount - 1 ? 500 : 1000,
  }));
  const ops = buildParrotTrackOps({ info, fileHash, sizeBytes: (chunkCount - 1) * 1000 + 500, chunks, now: 1_700_000_000_000 });
  log(`ops for ${info.title}`, ops.map((op) => op.type));
  applyParrotOps(db, ops);
  return { ids, ops, chunks };
};

const dumpDb = (db: ParrotLibraryDb) => {
  const state = {
    artists: listParrotArtists(db),
    albums: listParrotAlbums(db),
    tracks: listParrotTracks(db),
  };
  log("library state", state);
  return state;
};

describe("parrot library db", () => {
  it("opens a new library at the current schema with empty listings", () => {
    const db = openParrotLibrary(null);
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    log("new library", { version, tables });
    expect(version).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
    expect(tables).toEqual(["albums", "artists", "lyrics", "playlist_tracks", "playlists", "settings", "track_file_chunks", "track_files", "tracks"]);
    expect(dumpDb(db)).toEqual({ artists: [], albums: [], tracks: [] });
    db.close();
  });

  it("builds the music library from import ops", () => {
    const db = openParrotLibrary(null);
    const nook = addSong(db, song({ title: "Nook", number: 13 }));
    const forecast = addSong(db, song({ title: "Forecast", number: 1, durationMs: 13_000 }), 1);
    const paperboat = addSong(db, song({ title: "Paperboat", number: 3, album: "Hollow Signal", year: 2000 }), 3);
    const state = dumpDb(db);

    expect(nook.ops.map((op) => op.type)).toEqual(["artist.upsert", "album.upsert", "track.upsert", "track_file.upsert"]);
    expect(state.artists).toEqual([
      {
        id: nook.ids.artistId,
        name: "Linnet Park",
        albumCount: 2,
        trackCount: 3,
        pictureObjectKey: null,
        pictureThumbObjectKey: null,
        pictureAuthor: null,
        pictureLicence: null,
        pictureLicenceUrl: null,
      },
    ]);
    expect(state.albums).toEqual([
      { id: paperboat.ids.albumId, title: "Hollow Signal", artistId: nook.ids.artistId, artistName: "Linnet Park", year: 2000, genre: null, trackCount: 1, coverObjectKey: null, coverThumbObjectKey: null, addedAt: expect.any(Number), tracklist: null },
      { id: nook.ids.albumId, title: "Meltway", artistId: nook.ids.artistId, artistName: "Linnet Park", year: 2003, genre: null, trackCount: 2, coverObjectKey: null, coverThumbObjectKey: null, addedAt: expect.any(Number), tracklist: null },
    ]);
    expect(state.tracks.map((track) => [track.albumTitle, track.number, track.title])).toEqual([
      ["Hollow Signal", 3, "Paperboat"],
      ["Meltway", 1, "Forecast"],
      ["Meltway", 13, "Nook"],
    ]);
    const nookRow = state.tracks.find((track) => track.title === "Nook")!;
    expect(nookRow).toEqual({
      id: nook.ids.trackId,
      title: "Nook",
      albumId: nook.ids.albumId,
      albumTitle: "Meltway",
      artistId: nook.ids.artistId,
      artistName: "Linnet Park",
      disc: 1,
      number: 13,
      durationMs: 187_000,
      fileId: nook.ids.fileId,
      mime: "audio/mpeg",
      sizeBytes: 1500,
      gainDb: null,
      peak: null,
      albumGainDb: null,
      albumPeak: null,
      unidentified: false,
      year: 2003,
      genre: null,
      lossless: false,
      hasLyrics: false,
    });

    const file = getParrotFile(db, paperboat.ids.fileId);
    log("paperboat file", file);
    expect(file).toEqual({ id: paperboat.ids.fileId, trackId: paperboat.ids.trackId, mime: "audio/mpeg", codec: "mp3", sizeBytes: 2500, chunks: paperboat.chunks });
    expect(hasParrotFile(db, forecast.ids.fileId)).toBe(true);
    expect(hasParrotFile(db, "tf-missing")).toBe(false);
    expect(getParrotFile(db, "tf-missing")).toBeNull();
    db.close();
  });

  it("@req PAR-LIB-05[parrot] stores the confirmed album's full tracklist and a kept-as-is song's unidentified flag, through a snapshot", () => {
    const db = openParrotLibrary(null);
    const tracklist = [
      { disc: 1, number: 1, title: "Forecast", durationMs: 13_000 },
      { disc: 1, number: 2, title: "Don't Linger", durationMs: 187_000 },
      { disc: 1, number: 13, title: "Nook", durationMs: 187_000 },
    ];
    // An album first imported without a match (no tracklist) takes the list a later matched import brings.
    const forecast = addSong(db, song({ title: "Forecast", number: 1 }));
    expect(listParrotAlbums(db)[0]!.tracklist).toBeNull();
    const confirmed = applyParrotImportEdit(song({ title: "Nook", number: 13 }), { artist: "", album: "", title: "", tracklist });
    log("confirmed info", { tracklist: confirmed.tracklist, unidentified: confirmed.unidentified });
    addSong(db, confirmed);
    // A song kept as is lands on its own tagged album, marked unidentified.
    const kept = addSong(db, applyParrotImportEdit(song({ title: "Demo 4", number: 4, album: "Demos" }), { artist: "", album: "", title: "", unidentified: true }));
    // A later import of the same album without a match keeps the stored list.
    addSong(db, song({ title: "Hit the Gravel", number: 11 }));
    const reopened = openParrotLibrary(serializeParrotLibrary(db));
    const state = dumpDb(reopened);
    const meltway = state.albums.find((album) => album.id === forecast.ids.albumId)!;
    expect(meltway.tracklist).toEqual(tracklist);
    expect(state.albums.find((album) => album.title === "Demos")!.tracklist).toBeNull();
    expect(state.tracks.filter((track) => track.unidentified).map((track) => track.id)).toEqual([kept.ids.trackId]);
    db.close();
    reopened.close();
  });

  it("adds a separate album artist only when it differs from the song's artist", () => {
    const db = openParrotLibrary(null);
    const { ids, ops } = addSong(db, song({ title: "Nook/Reprise", number: 1, artist: "Jun-O", albumArtist: "Jun-O & Linnet Park", album: "Crossing Current", year: 2004 }));
    expect(ops.filter((op) => op.type === "artist.upsert")).toHaveLength(2);
    const state = dumpDb(db);
    expect(state.artists.map((artist) => [artist.name, artist.albumCount, artist.trackCount])).toEqual([
      ["Jun-O", 0, 1],
      ["Jun-O & Linnet Park", 1, 0],
    ]);
    expect(state.albums[0]!.artistId).toBe(ids.albumArtistId);
    expect(state.tracks[0]!.artistId).toBe(ids.artistId);
    db.close();
  });

  it("re-applying the same ops is idempotent and replaces the chunk map", () => {
    const db = openParrotLibrary(null);
    const first = addSong(db, song({ title: "Nook", number: 13 }), 3);
    addSong(db, song({ title: "Nook", number: 13 }), 2);
    const state = dumpDb(db);
    expect(state.tracks).toHaveLength(1);
    expect(state.artists).toHaveLength(1);
    expect(getParrotFile(db, first.ids.fileId)!.chunks.map((chunk) => chunk.idx)).toEqual([0, 1]);
    db.close();
  });

  it("serializes to bytes that reopen to the same library", () => {
    const db = openParrotLibrary(null);
    addSong(db, song({ title: "Nook", number: 13 }));
    addSong(db, song({ title: "Fable", number: 7 }));
    const before = dumpDb(db);
    const bytes = serializeParrotLibrary(db);
    log("snapshot bytes", bytes.length);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe("SQLite format 3");
    db.close();

    const reopened = openParrotLibrary(bytes);
    expect(dumpDb(reopened)).toEqual(before);
    expect(reopened.prepare("PRAGMA user_version").get()?.user_version).toBe(PARROT_LIBRARY_SCHEMA_VERSION);
    reopened.close();
  });

  it("rolls back the whole batch when one op fails", () => {
    const db = openParrotLibrary(null);
    const good = buildParrotTrackOps({
      info: song({ title: "Nook", number: 13 }),
      fileHash: sha256Hex("nook"),
      sizeBytes: 10,
      chunks: [{ idx: 0, objectKey: "k", plainOffset: 0, plainSize: 10 }],
      now: 1,
    });
    const bad = createParrotOp("bogus.op" as "setting.set", { key: "k", value: "v" }, { id: "op-bad", createdAt: new Date(0).toISOString() });
    let thrown: unknown;
    try {
      applyParrotOps(db, [...good, bad as ParrotLibraryOp]);
    } catch (error) {
      thrown = error;
    }
    log("apply error", String(thrown));
    expect(String(thrown)).toContain("UNKNOWN_OP_TYPE: bogus.op");
    expect(dumpDb(db)).toEqual({ artists: [], albums: [], tracks: [] });
    // The db is still usable after the rollback.
    applyParrotOps(db, good);
    expect(listParrotTracks(db)).toHaveLength(1);
    db.close();
  });
});
