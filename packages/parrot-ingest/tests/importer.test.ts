/**
 * @test-id PARROT-INGEST-IMPORTER-001
 * @level unit
 * @why PAR-FMT-01 / INGS-RESUME-01: an import uploads each new audio file whole as 1 MiB SFV1 chunks on the song's
 *      own placement, adds the song to the library and publishes the snapshot; the same import run again uploads
 *      nothing; one bad file does not stop the others; a publish conflict replays the batch on the newer
 *      snapshot. Everything runs against an in-memory transport, and global fetch is replaced so any real
 *      network call fails the test.
 * @covers packages/parrot-ingest/src/importer.ts
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { decryptMediaObject } from "@space/media-crypto";
import { TRACK_FILE_CHUNK_SIZE_BYTES } from "@space/parrot-library-db-definition";
import { parrotCoverMime } from "@space/parrot-core";
import jpeg from "jpeg-js";
import { openParrotCover } from "../src/covers";
import { parrotAudioFormatFor } from "../src/formats";
import { parrotChunkKey, parrotPlacementId, parrotTrackIds, sha256Hex } from "../src/ids";
import { importParrotFiles, PARROT_APP_ID, type ParrotImportProgress, type ParrotImportTransport } from "../src/importer";
import { getParrotFile, listParrotAlbums, listParrotTracks, openParrotLibrary, serializeParrotLibrary } from "../src/library";
import { readParrotTrackInfo, type ParrotTrackInfo } from "../src/readTrack";
import { makeAudioFixture, makeCoverPicture, makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-IMPORTER-001");
const CHUNK = TRACK_FILE_CHUNK_SIZE_BYTES;
const USER_ID = "user-chris";
const TOKEN = "token-abc";
const CLIENT_TYPE = "parrot-desktop";

type UploadCall = { token: string; objectKey: string; payload: Uint8Array; options: Record<string, unknown>; appId: string };
type PublishCall = { token: string; keyBase64: string; dbBytes: Uint8Array; baseVersion: number; appId: string };

/** An in-memory server: uploaded objects, the published snapshot and every call made to it. */
const createFakeServer = () => {
  const objects = new Map<string, Uint8Array>();
  const uploads: UploadCall[] = [];
  const publishes: PublishCall[] = [];
  const fetches: Array<{ token: string; keyBase64: string; appId: string }> = [];
  const state = {
    version: 0,
    dbBytes: null as Uint8Array | null,
    failUpload: null as ((objectKey: string) => boolean) | null,
    conflictOnce: null as (() => void) | null,
    /** This many next publishes each meet a save another writer made first (the same library, one version on). */
    conflicts: 0,
  };

  const upload = async (token: string, objectKey: string, payload: Uint8Array, options: Record<string, unknown> = {}, appId = "") => {
    uploads.push({ token, objectKey, payload, options, appId });
    if (state.failUpload?.(objectKey)) throw new Error(`upload refused: ${objectKey}`);
    // Library objects (covers) have no placement: they keep the key the client gave.
    const placed = options.placementId ? `media/${String(options.placementId)}/${objectKey}` : objectKey;
    objects.set(placed, payload);
    return placed;
  };
  const fetchSnapshot = async (input: { token: string; keyBase64: string; appId: string }) => {
    fetches.push(input);
    return state.dbBytes ? { snapshotVersion: state.version, dbBytes: state.dbBytes } : null;
  };
  const publishSnapshot = async (input: PublishCall) => {
    publishes.push({ ...input, dbBytes: new Uint8Array(input.dbBytes) });
    if (state.conflictOnce) {
      const makeConflict = state.conflictOnce;
      state.conflictOnce = null;
      makeConflict();
    }
    if (state.conflicts > 0) {
      state.conflicts -= 1;
      state.version += 1;
      state.dbBytes ??= serializeParrotLibrary(openParrotLibrary(null));
    }
    if (input.baseVersion !== state.version) throw Object.assign(new Error(`library_db_conflict: base ${input.baseVersion}, server ${state.version}`), { status: 409 });
    state.version += 1;
    state.dbBytes = new Uint8Array(input.dbBytes);
    return { version: state.version, snapshotId: `snap-${state.version}`, manifest: {}, stateHash: null, lastOpId: null };
  };
  // One reused session per upload lane (STOR-REUSE-01): its objects carry the session's placement and client.
  const sessions: Array<{ placementId: string; clientType?: string; appId: string; objects: number; closed: boolean }> = [];
  let inFlight = 0;
  const peak = { inFlight: 0 };
  const openUploadSession = (token: string, opened: { placementId: string; clientType?: string }, appId = "") => {
    const session = { ...opened, appId, objects: 0, closed: false };
    sessions.push(session);
    return {
      async upload(objectKey: string, payload: Uint8Array, options: Record<string, unknown> = {}) {
        if (session.closed) throw new Error("upload on a closed session");
        session.objects += 1;
        inFlight += 1;
        peak.inFlight = Math.max(peak.inFlight, inFlight);
        try {
          // Yields once so the other lanes start before this object is stored.
          await Promise.resolve();
          return await upload(token, objectKey, payload, { ...options, placementId: opened.placementId, clientType: opened.clientType }, appId);
        } finally {
          inFlight -= 1;
        }
      },
      async close() {
        session.closed = true;
      },
    };
  };
  // The fake implements only what the importer reads from each call's input and result.
  const transport = { upload, openUploadSession, fetchSnapshot, publishSnapshot } as unknown as ParrotImportTransport;
  const dump = () => ({
    version: state.version,
    objects: [...objects.keys()],
    uploads: uploads.map(({ payload, ...rest }) => ({ ...rest, payloadBytes: payload.length })),
    publishes: publishes.map(({ dbBytes, keyBase64: _key, ...rest }) => ({ ...rest, dbBytes: dbBytes.length })),
    fetches: fetches.length,
    tracks: state.dbBytes ? listParrotTracks(openParrotLibrary(state.dbBytes)).map((track) => `${track.artistName} / ${track.albumTitle} / ${track.number} ${track.title}`) : [],
  });
  return { objects, uploads, publishes, fetches, sessions, peak, state, transport, dump };
};

const info = (file: string, patch: Partial<ParrotTrackInfo> = {}): ParrotTrackInfo => ({
  file,
  artist: "Linnet Park",
  albumArtist: "Linnet Park",
  album: "Meltway",
  title: path.basename(file, path.extname(file)),
  disc: 1,
  number: 1,
  year: 2003,
  durationMs: 1000,
  bitrateKbps: 128,
  sampleRate: 44100,
  format: parrotAudioFormatFor(file)!,
  ...patch,
});

describe("importParrotFiles", () => {
  let root: string;
  let nookMp3: string;
  let nookFlac: string;
  let bigFile: string;
  let bigBytes: Uint8Array;
  const keyBase64 = randomBytes(32).toString("base64");
  const realFetch = globalThis.fetch;
  const networkCalls: string[] = [];

  beforeAll(async () => {
    root = await makeTempDir("import");
    const meltway = path.join(root, "Linnet Park", "Meltway");
    await fs.mkdir(meltway, { recursive: true });
    nookMp3 = makeAudioFixture(path.join(meltway, "13 - Nook.mp3"), { title: "Nook", artist: "Linnet Park", album: "Meltway", track: "13", date: "2003" }, 1, log);
    nookFlac = makeAudioFixture(path.join(meltway, "13 - Nook (lossless).flac"), { title: "Nook (Lossless)", artist: "Linnet Park", album: "Meltway", track: "13", date: "2003" }, 1, log);
    bigFile = path.join(root, "big.mp3");
    // No 0xFF byte, so no MPEG/ADTS frame sync: random bytes sometimes read as an
    // ADTS frame and readParrotTrackInfo threw "Invalid ADTS frame length" (ci run 34854).
    bigBytes = new Uint8Array(randomBytes(2 * CHUNK + 4321)).map((byte) => (byte === 0xff ? 0xfe : byte));
    await fs.writeFile(bigFile, bigBytes);
    log("fixtures", { root, nookMp3: (await fs.stat(nookMp3)).size, nookFlac: (await fs.stat(nookFlac)).size, big: bigBytes.length });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    networkCalls.length = 0;
    const refuseNetwork = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      networkCalls.push(url);
      throw new Error(`network call in a unit test: ${url}`);
    };
    globalThis.fetch = Object.assign(refuseNetwork, { preconnect: realFetch.preconnect });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    log("network calls", networkCalls);
    expect(networkCalls).toEqual([]);
  });

  // @req PAR-UP-03 @req PAR-UP-04
  it("uploads tagged files as sealed chunks on their own placement and publishes the library", async () => {
    const server = createFakeServer();
    const progress: ParrotImportProgress[] = [];
    const messages: string[] = [];
    const result = await importParrotFiles([nookMp3, nookFlac], {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: server.transport,
      onProgress: (event) => progress.push(event),
      log: (message) => messages.push(message),
    });
    log("result", result);
    log("server", server.dump());
    log("importer log", messages);
    log("progress", progress);

    expect(result).toEqual({ imported: [nookMp3, nookFlac], skipped: [], failed: [], snapshotVersion: 2 });
    expect(server.fetches).toEqual([{ token: TOKEN, keyBase64, appId: PARROT_APP_ID }]);
    expect(server.uploads).toHaveLength(2);

    for (const [index, file] of [nookMp3, nookFlac].entries()) {
      const bytes = new Uint8Array(await fs.readFile(file));
      const fileHash = sha256Hex(bytes);
      const call = server.uploads[index]!;
      const fileId = call.objectKey.split("/")[0]!;
      log(`upload ${path.basename(file)}`, { objectKey: call.objectKey, options: call.options, appId: call.appId, payload: call.payload.length, plain: bytes.length });
      expect(call.token).toBe(TOKEN);
      expect(call.appId).toBe(PARROT_APP_ID);
      expect(call.objectKey).toBe(parrotChunkKey(fileId, 0));
      expect(fileId).toBe(`tf-${sha256Hex(fileHash).slice(0, 24)}`);
      expect(call.options).toEqual({
        placementId: parrotPlacementId(USER_ID, fileHash),
        objectNamespace: "media",
        contentType: "application/octet-stream",
        clientType: CLIENT_TYPE,
        // STOR-USE-02: a song counts at the size of the file the user picked (one chunk here).
        counting: { role: "source", declaredBytes: bytes.length },
      });
      expect(new TextDecoder().decode(call.payload.subarray(0, 4))).toBe("SFV1");
      // Padding hides the exact size: the sealed object is larger than plaintext + the fixed 54-byte overhead.
      expect(call.payload.length).toBeGreaterThanOrEqual(bytes.length + 54);
      expect(Buffer.from(decryptMediaObject(call.payload, keyBase64)).equals(Buffer.from(bytes))).toBe(true);
    }

    // PAR-UP-03: one publish per stored song, the first with one song, the second with both.
    expect(server.publishes.map((call) => call.baseVersion)).toEqual([0, 1]);
    expect(listParrotTracks(openParrotLibrary(server.publishes[0]!.dbBytes)).map((track) => track.title)).toEqual(["Nook"]);
    const publish = server.publishes[1]!;
    expect({ token: publish.token, keyBase64: publish.keyBase64, baseVersion: publish.baseVersion, appId: publish.appId }).toEqual({
      token: TOKEN,
      keyBase64,
      baseVersion: 1,
      appId: PARROT_APP_ID,
    });

    const db = openParrotLibrary(publish.dbBytes);
    const tracks = listParrotTracks(db);
    log("published tracks", tracks);
    expect(tracks.map((track) => [track.artistName, track.albumTitle, track.number, track.title, track.mime])).toEqual([
      ["Linnet Park", "Meltway", 13, "Nook", "audio/mpeg"],
      ["Linnet Park", "Meltway", 13, "Nook (Lossless)", "audio/flac"],
    ]);
    const file = getParrotFile(db, tracks[0]!.fileId!);
    log("nook file row", file);
    expect(file!.sizeBytes).toBe((await fs.stat(nookMp3)).size);
    expect(file!.chunks).toEqual([{ idx: 0, objectKey: `media/${server.uploads[0]!.options.placementId}/${server.uploads[0]!.objectKey}`, plainOffset: 0, plainSize: file!.sizeBytes }]);
    db.close();

    // PAR-UP-04: the bytes go up as each file is through; `published` counts the library versions.
    const sizes = [(await fs.stat(nookMp3)).size, (await fs.stat(nookFlac)).size];
    const bytesTotal = sizes[0]! + sizes[1]!;
    expect(progress.every((event) => event.bytesTotal === bytesTotal)).toBe(true);
    const afterFirst = progress.find((event) => event.done === 1)!;
    expect(afterFirst).toMatchObject({ imported: 1, bytesDone: sizes[0], published: 0 });
    expect(progress.find((event) => event.published === 1)).toMatchObject({ done: 1, bytesDone: sizes[0] });
    const bytesSeen = progress.map((event) => event.bytesDone);
    expect(bytesSeen).toEqual([...bytesSeen].sort((a, b) => a - b));
    expect(progress.at(-1)).toEqual({
      phase: "done",
      total: 2,
      done: 2,
      imported: 2,
      skipped: 0,
      failed: 0,
      currentFile: null,
      bytesDone: bytesTotal,
      bytesTotal,
      published: 2,
    });
    expect(messages.some((message) => message.includes("no library snapshot yet"))).toBe(true);
    expect(messages.some((message) => message.includes("published library snapshot v1"))).toBe(true);
  });

  it("cuts a large file into 1 MiB chunks in order, each decrypting to its slice", async () => {
    const server = createFakeServer();
    const result = await importParrotFiles([bigFile], {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: server.transport,
      readInfo: async (file) => info(file, { title: "Big One" }),
      log: (message) => log(message),
    });
    log("result", result);
    log("server", server.dump());
    expect(result.imported).toEqual([bigFile]);
    const { fileId } = parrotTrackIds({ ...info(bigFile, { title: "Big One" }), fileHash: sha256Hex(bigBytes) });
    expect(server.uploads.map((call) => call.objectKey)).toEqual([0, 1, 2].map((idx) => parrotChunkKey(fileId, idx)));
    const placementIds = new Set(server.uploads.map((call) => call.options.placementId));
    expect(placementIds).toEqual(new Set([parrotPlacementId(USER_ID, sha256Hex(bigBytes))]));
    const plain = server.uploads.map((call) => decryptMediaObject(call.payload, keyBase64));
    expect(plain.map((part) => part.length)).toEqual([CHUNK, CHUNK, 4321]);
    expect(Buffer.concat(plain).equals(Buffer.from(bigBytes))).toBe(true);

    const db = openParrotLibrary(server.state.dbBytes);
    const file = getParrotFile(db, fileId)!;
    log("chunk map", file.chunks);
    expect(file.chunks.map(({ idx, plainOffset, plainSize }) => ({ idx, plainOffset, plainSize }))).toEqual([
      { idx: 0, plainOffset: 0, plainSize: CHUNK },
      { idx: 1, plainOffset: CHUNK, plainSize: CHUNK },
      { idx: 2, plainOffset: 2 * CHUNK, plainSize: 4321 },
    ]);
    expect(file.chunks.every((chunk) => server.objects.has(chunk.objectKey))).toBe(true);
    db.close();
  });

  // @bugfix: an import paid a new upload session, start, websocket and end for every 1 MiB chunk, one chunk at a
  // time (PAR-UP-02).
  // @req PAR-UP-02 @req STOR-REUSE-01
  it("uploads a file's chunks side by side, each lane on one reused session closed at the end", async () => {
    const server = createFakeServer();
    const fileHash = sha256Hex(bigBytes);
    const result = await importParrotFiles([bigFile], {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: server.transport,
      readInfo: async (file) => info(file, { title: "Big One" }),
    });
    log("sessions", server.sessions, "peak", server.peak);
    expect(result.imported).toEqual([bigFile]);
    // Three chunks: three lanes, all in flight at once, one object each.
    expect(server.peak.inFlight).toBe(3);
    expect(server.sessions).toEqual(
      [1, 2, 3].map(() => ({ placementId: parrotPlacementId(USER_ID, fileHash), clientType: CLIENT_TYPE, appId: PARROT_APP_ID, objects: 1, closed: true }))
    );
  });

  it("sends every chunk through its own upload when the transport has no reusable session", async () => {
    const server = createFakeServer();
    const { openUploadSession: _none, ...withoutSessions } = server.transport;
    const result = await importParrotFiles([bigFile], {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: withoutSessions,
      readInfo: async (file) => info(file, { title: "Big One" }),
    });
    expect(result.imported).toEqual([bigFile]);
    expect(server.sessions).toEqual([]);
    const { fileId } = parrotTrackIds({ ...info(bigFile, { title: "Big One" }), fileHash: sha256Hex(bigBytes) });
    expect(server.uploads.map((call) => call.objectKey)).toEqual([0, 1, 2].map((idx) => parrotChunkKey(fileId, idx)));
    expect(server.uploads.every((call) => call.options.placementId === parrotPlacementId(USER_ID, sha256Hex(bigBytes)))).toBe(true);
  });

  it("fails the file when one chunk fails, stops the other lanes and closes every session", async () => {
    const server = createFakeServer();
    const { fileId } = parrotTrackIds({ ...info(bigFile, { title: "Big One" }), fileHash: sha256Hex(bigBytes) });
    server.state.failUpload = (objectKey) => objectKey === parrotChunkKey(fileId, 1);
    const result = await importParrotFiles([bigFile, nookMp3], {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: server.transport,
      readInfo: async (file) => info(file, { title: file === bigFile ? "Big One" : "Nook" }),
    });
    log("result", result, "sessions", server.sessions);
    expect(result.failed).toEqual([{ file: bigFile, error: `upload refused: ${parrotChunkKey(fileId, 1)}` }]);
    expect(result.imported).toEqual([nookMp3]);
    expect(server.sessions.every((session) => session.closed)).toBe(true);
    expect(listParrotTracks(openParrotLibrary(server.state.dbBytes!)).map((track) => track.title)).toEqual(["Nook"]);
  });

  it("skips files already in the library when the import runs again", async () => {
    const server = createFakeServer();
    const options = { token: TOKEN, userId: USER_ID, libraryKeyBase64: keyBase64, clientType: CLIENT_TYPE, transport: server.transport, log: (message: string) => log(message) };
    await importParrotFiles([nookMp3], options);
    const uploadsAfterFirst = server.uploads.length;
    const second = await importParrotFiles([nookMp3, nookFlac], options);
    log("second run", second);
    log("server", server.dump());
    expect(second).toEqual({ imported: [nookFlac], skipped: [nookMp3], failed: [], snapshotVersion: 2 });
    expect(server.uploads.length - uploadsAfterFirst).toBe(1);
    expect(server.publishes.map((call) => call.baseVersion)).toEqual([0, 1]);

    const third = await importParrotFiles([nookMp3, nookFlac], options);
    log("third run", third);
    expect(third).toEqual({ imported: [], skipped: [nookMp3, nookFlac], failed: [], snapshotVersion: null });
    expect(server.publishes).toHaveLength(2);
  });

  it("publishes every N new songs so an interrupted import keeps what it uploaded", async () => {
    const server = createFakeServer();
    const shown: Array<{ version: number; songs: number }> = [];
    const files = [nookMp3, nookFlac, bigFile];
    const result = await importParrotFiles(files, {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: server.transport,
      publishEvery: 2,
      readInfo: async (file) => info(file, { number: files.indexOf(file) + 1 }),
      // #2509: the app shows each publish from the importer's own library, so it hears of each with its songs.
      onPublished: ({ version, db }) => shown.push({ version, songs: listParrotTracks(db).length }),
    });
    log("result", result);
    log("server", server.dump());
    expect(result.snapshotVersion).toBe(2);
    expect(server.publishes.map((call) => call.baseVersion)).toEqual([0, 1]);
    expect(listParrotTracks(openParrotLibrary(server.publishes[0]!.dbBytes))).toHaveLength(2);
    expect(listParrotTracks(openParrotLibrary(server.publishes[1]!.dbBytes))).toHaveLength(3);
    expect(shown).toEqual([
      { version: 1, songs: 2 },
      { version: 2, songs: 3 },
    ]);
  });

  // @req PAR-UP-02
  it("uploads the next file while the song before it is still being published", async () => {
    const server = createFakeServer();
    const files = [nookMp3, nookFlac];
    const events: string[] = [];
    const ids = await Promise.all(
      files.map(async (file) => parrotTrackIds({ ...info(file, { number: files.indexOf(file) + 1 }), fileHash: sha256Hex(new Uint8Array(await fs.readFile(file))) }).fileId)
    );
    // The first publish waits until the second file is uploading: run one after the other, the import never ends.
    const secondUploading = Promise.withResolvers<void>();
    const upload: typeof server.transport.upload = async (token, objectKey, payload, options, appId) => {
      events.push(`upload ${objectKey.split("/")[0]}`);
      if (objectKey.startsWith(ids[1]!)) secondUploading.resolve();
      return server.transport.upload(token, objectKey, payload, options, appId);
    };
    const publishSnapshot: typeof server.transport.publishSnapshot = async (input) => {
      const tracks = listParrotTracks(openParrotLibrary(input.dbBytes)).length;
      events.push(`publish ${tracks} start`);
      if (tracks === 1) await secondUploading.promise;
      events.push(`publish ${tracks} end`);
      return server.transport.publishSnapshot(input);
    };
    await importParrotFiles(files, {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: { ...server.transport, upload, openUploadSession: undefined, publishSnapshot },
      readInfo: async (file) => info(file, { number: files.indexOf(file) + 1 }),
    });
    log("events", events);
    expect(events.indexOf(`upload ${ids[1]}`)).toBeGreaterThan(events.indexOf(`upload ${ids[0]}`));
    expect(events.indexOf(`upload ${ids[1]}`)).toBeLessThan(events.indexOf("publish 1 end"));
    expect(events.slice(-2)).toEqual(["publish 2 start", "publish 2 end"]);
  });

  // @bugfix: the picked folders reach readInfo, so folder names above them never become album or artist names.
  it("hands each file the deepest picked folder it was found under", async () => {
    const server = createFakeServer();
    const meltway = path.dirname(nookMp3);
    const seen: Array<[string, string | undefined]> = [];
    await importParrotFiles([nookMp3, bigFile], {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: server.transport,
      roots: [root, `${meltway}${path.sep}`],
      readInfo: async (file, pickedRoot) => {
        seen.push([path.relative(root, file), pickedRoot && path.relative(root, pickedRoot)]);
        return info(file);
      },
    });
    log("readInfo calls", seen);
    expect(seen).toEqual([
      [path.relative(root, nookMp3), path.join("Linnet Park", "Meltway")],
      ["big.mp3", ""],
    ]);
  });

  it("records one failing file and imports the others", async () => {
    const server = createFakeServer();
    const missing = path.join(root, "gone.mp3");
    server.state.failUpload = (objectKey) => objectKey.endsWith("chunk-00001");
    const result = await importParrotFiles([nookMp3, missing, bigFile, nookFlac], {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: server.transport,
      log: (message) => log(message),
    });
    log("result", result);
    log("server", server.dump());
    expect(result.imported).toEqual([nookMp3, nookFlac]);
    expect(result.skipped).toEqual([]);
    expect(result.failed.map((entry) => entry.file)).toEqual([missing, bigFile]);
    expect(result.failed[0]!.error).toContain("ENOENT");
    expect(result.failed[1]!.error).toContain("upload refused");
    expect(server.dump().tracks).toEqual(["Linnet Park / Meltway / 13 Nook", "Linnet Park / Meltway / 13 Nook (Lossless)"]);
  });

  it("replays the batch on the newer snapshot when another device published meanwhile", async () => {
    const server = createFakeServer();
    const options = { token: TOKEN, userId: USER_ID, libraryKeyBase64: keyBase64, clientType: CLIENT_TYPE, transport: server.transport };
    await importParrotFiles([nookMp3], options);
    // Another device, starting from the same v1, publishes v2 with one more song while this import runs.
    const other = createFakeServer();
    other.state.version = server.state.version;
    other.state.dbBytes = server.state.dbBytes;
    await importParrotFiles([bigFile], { ...options, transport: other.transport, readInfo: async (file) => info(file, { title: "From Phone", album: "Other" }) });
    expect(other.state.version).toBe(2);
    server.state.conflictOnce = () => {
      server.state.version += 1;
      server.state.dbBytes = other.state.dbBytes;
    };
    const messages: string[] = [];
    const result = await importParrotFiles([nookFlac], { ...options, log: (message) => messages.push(message) });
    log("result", result);
    log("importer log", messages);
    log("server", server.dump());
    expect(result).toEqual({ imported: [nookFlac], skipped: [], failed: [], snapshotVersion: 3 });
    expect(server.publishes.map((call) => call.baseVersion)).toEqual([0, 1, 2]);
    expect(messages.some((message) => message.includes("publish on v1 failed (library_db_conflict"))).toBe(true);
    expect(server.dump().tracks).toEqual([
      "Linnet Park / Meltway / 13 Nook",
      "Linnet Park / Meltway / 13 Nook (Lossless)",
      "Linnet Park / Other / 1 From Phone",
    ]);
  });

  // @bugfix: a between-songs publish that met other saves twice counted its song as failed ("13 imported, 1 failed",
  // Jobs showing "version_conflict") though the song went out with the next publish.
  it("keeps a song whose between-songs publish met other saves twice as imported, and publishes it with the next one", async () => {
    const server = createFakeServer();
    server.state.conflicts = 2;
    const messages: string[] = [];
    const result = await importParrotFiles([nookMp3, nookFlac], {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: server.transport,
      log: (message) => messages.push(message),
    });
    log("result", result);
    log("importer log", messages);
    log("publishes", server.publishes.map((call) => call.baseVersion));
    log("server", server.dump());
    expect(result.imported).toEqual([nookMp3, nookFlac]);
    expect(result.failed).toEqual([]);
    expect(server.dump().tracks).toEqual(["Linnet Park / Meltway / 13 Nook", "Linnet Park / Meltway / 13 Nook (Lossless)"]);
    expect(result.snapshotVersion).toBe(server.state.version);
  });

  it("tries the last publish again when it meets other saves twice, so the import still ends", async () => {
    const server = createFakeServer();
    server.state.conflicts = 4;
    const messages: string[] = [];
    const result = await importParrotFiles([nookMp3], {
      token: TOKEN,
      userId: USER_ID,
      libraryKeyBase64: keyBase64,
      clientType: CLIENT_TYPE,
      transport: server.transport,
      log: (message) => messages.push(message),
    });
    log("result", result);
    log("importer log", messages);
    log("publishes", server.publishes.map((call) => call.baseVersion));
    expect(result).toEqual({ imported: [nookMp3], skipped: [], failed: [], snapshotVersion: 5 });
    expect(server.dump().tracks).toEqual(["Linnet Park / Meltway / 13 Nook"]);
  });

  it("refuses a library key that is not 32 bytes", async () => {
    const server = createFakeServer();
    await expect(
      importParrotFiles([nookMp3], { token: TOKEN, userId: USER_ID, libraryKeyBase64: randomBytes(16).toString("base64"), clientType: CLIENT_TYPE, transport: server.transport })
    ).rejects.toThrow("the library key must be 32 bytes of base64");
    log("server", server.dump());
    expect(server.fetches).toHaveLength(0);
  });

  it("stops on abort without recording the file as failed", async () => {
    const server = createFakeServer();
    const controller = new AbortController();
    server.state.failUpload = () => {
      controller.abort(new Error("user cancelled"));
      return false;
    };
    let thrown: unknown;
    try {
      await importParrotFiles([bigFile, nookMp3], {
        token: TOKEN,
        userId: USER_ID,
        libraryKeyBase64: keyBase64,
        clientType: CLIENT_TYPE,
        transport: server.transport,
        signal: controller.signal,
        readInfo: async (file) => info(file),
      });
    } catch (error) {
      thrown = error;
    }
    log("abort error", String(thrown));
    log("server", server.dump());
    expect(String(thrown)).toContain("user cancelled");
    // The three lanes had their chunks in flight when the cancel came; none takes a new one after it.
    expect(server.uploads).toHaveLength(3);
    expect(server.publishes).toHaveLength(0);
  });
});

// @req PAR-META-04 @req PAR-COPY-01
describe("importParrotFiles album covers", () => {
  let root: string;
  let withPicture: string;
  let withoutPicture: string;
  const keyBase64 = randomBytes(32).toString("base64");
  const clog = testLog("PARROT-INGEST-IMPORTER-COVERS");

  beforeAll(async () => {
    root = await makeTempDir("covers");
    const album = path.join(root, "Linnet Park", "Hollow Signal");
    await fs.mkdir(album, { recursive: true });
    const picture = makeCoverPicture(path.join(root, "cover.jpg"));
    const tags = { artist: "Linnet Park", album: "Hollow Signal", date: "2000" };
    withPicture = makeAudioFixture(path.join(album, "01 - Paperboat.mp3"), { ...tags, title: "Paperboat", track: "1", picture }, 1, clog);
    withoutPicture = makeAudioFixture(path.join(album, "02 - One Step Farther.mp3"), { ...tags, title: "One Step Farther", track: "2" }, 1, clog);
    clog("fixtures", { root, withPicture: (await fs.stat(withPicture)).size, withoutPicture: (await fs.stat(withoutPicture)).size });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const albumOf = (dbBytes: Uint8Array) => {
    const db = openParrotLibrary(dbBytes);
    const albums = listParrotAlbums(db);
    db.close();
    clog("albums", albums);
    expect(albums).toHaveLength(1);
    return albums[0]!;
  };

  it("stores the file's picture as the album's encrypted cover, and a later song without one keeps it", async () => {
    const server = createFakeServer();
    const messages: string[] = [];
    const options = { token: TOKEN, userId: USER_ID, libraryKeyBase64: keyBase64, clientType: CLIENT_TYPE, transport: server.transport, log: (m: string) => messages.push(m) };
    const result = await importParrotFiles([withPicture, withoutPicture], options);
    clog("result", result);
    clog("importer log", messages);
    clog("server", server.dump());
    expect(result.imported).toEqual([withPicture, withoutPicture]);

    const coverUploads = server.uploads.filter((call) => call.options.objectNamespace === "library");
    expect(coverUploads).toHaveLength(1);
    expect(coverUploads[0]!.appId).toBe(PARROT_APP_ID);
    // STOR-USE-02: a cover counts at its stored bytes.
    expect(coverUploads[0]!.options).toEqual({ objectNamespace: "library", contentType: "application/octet-stream", clientType: CLIENT_TYPE, counting: { role: "artwork" } });
    expect(coverUploads[0]!.objectKey).toMatch(/^assets\/[0-9a-f-]{36}$/);

    const album = albumOf(server.state.dbBytes!);
    expect(album.coverObjectKey).toBe(coverUploads[0]!.objectKey);
    const embedded = (await readParrotTrackInfo(withPicture)).cover!;
    clog("embedded picture", { bytes: embedded.bytes.length, mime: embedded.mime });
    expect(embedded.mime).toBe("image/jpeg");
    expect(parrotCoverMime(embedded.bytes)).toBe("image/jpeg");
    const sealed = server.objects.get(album.coverObjectKey!)!;
    // The stored object is sealed, never the plain picture, and opens with the library key to the file's picture.
    expect(Buffer.from(sealed).includes(Buffer.from(embedded.bytes.subarray(0, 64)))).toBe(false);
    expect(Buffer.from(await openParrotCover(sealed, keyBase64)).equals(Buffer.from(embedded.bytes))).toBe(true);
    expect((await readParrotTrackInfo(withoutPicture)).cover).toBeNull();

    // A later import of a song without a picture leaves the cover alone.
    const later = await importParrotFiles([withoutPicture], options);
    clog("later run", later);
    expect(albumOf(server.state.dbBytes!).coverObjectKey).toBe(album.coverObjectKey);
  });

  it("fills in a missing cover from a file already in the library when the import runs again", async () => {
    const server = createFakeServer();
    server.state.failUpload = (objectKey) => objectKey.startsWith("assets/");
    const messages: string[] = [];
    const options = { token: TOKEN, userId: USER_ID, libraryKeyBase64: keyBase64, clientType: CLIENT_TYPE, transport: server.transport, log: (m: string) => messages.push(m) };
    const first = await importParrotFiles([withPicture, withoutPicture], options);
    clog("first run (cover upload refused)", { first, messages });
    expect(first.imported).toEqual([withPicture, withoutPicture]);
    expect(first.failed).toEqual([]);
    expect(albumOf(server.state.dbBytes!).coverObjectKey).toBeNull();
    // One failed try per album and run: the second song does not retry it.
    expect(server.uploads.filter((call) => call.objectKey.startsWith("assets/"))).toHaveLength(1);

    server.state.failUpload = null;
    messages.length = 0;
    const second = await importParrotFiles([withPicture, withoutPicture], options);
    clog("second run", { second, messages, server: server.dump() });
    // The first run published once per song (v1, v2); the cover found now is v3.
    expect(second).toEqual({ imported: [], skipped: [withPicture, withoutPicture], failed: [], snapshotVersion: 3 });
    const album = albumOf(server.state.dbBytes!);
    expect(album.coverObjectKey).toMatch(/^assets\//);
    expect(server.objects.has(album.coverObjectKey!)).toBe(true);
  });

  const widthOf = async (sealed: Uint8Array) => jpeg.decode(await openParrotCover(sealed, keyBase64), { useTArray: true }).width;

  it("stores a large picture as a 1200 px copy and a 500 px small copy, never the print-size original", async () => {
    const dir = path.join(root, "Big", "Meltway");
    await fs.mkdir(dir, { recursive: true });
    const picture = makeCoverPicture(path.join(root, "big.jpg"), "blue", 2000);
    const big = makeAudioFixture(path.join(dir, "01 - Forecast.mp3"), { artist: "Big", album: "Meltway", title: "Forecast", track: "1", picture }, 1, clog);
    const server = createFakeServer();
    const messages: string[] = [];
    const result = await importParrotFiles([big], { token: TOKEN, userId: USER_ID, libraryKeyBase64: keyBase64, clientType: CLIENT_TYPE, transport: server.transport, log: (m: string) => messages.push(m) });
    clog("big picture run", { result, messages });
    const album = albumOf(server.state.dbBytes!);
    expect(album.coverObjectKey).toMatch(/^assets\//);
    expect(album.coverThumbObjectKey).toMatch(/^assets\//);
    expect(server.uploads.filter((call) => call.objectKey.startsWith("assets/"))).toHaveLength(2);
    const large = server.objects.get(album.coverObjectKey!)!;
    const thumb = server.objects.get(album.coverThumbObjectKey!)!;
    const embedded = (await readParrotTrackInfo(big)).cover!;
    clog("sizes", { embedded: embedded.bytes.length, large: large.length, thumb: thumb.length });
    expect(await widthOf(large)).toBe(1200);
    expect(await widthOf(thumb)).toBe(500);
    expect(thumb.length).toBeLessThan(large.length);
    await fs.rm(path.join(root, "Big"), { recursive: true, force: true });
  });

  it("gives an album imported before small copies existed its two copies at the next import", async () => {
    const dir = path.join(root, "Old", "Minutes");
    await fs.mkdir(dir, { recursive: true });
    const picture = makeCoverPicture(path.join(root, "old.jpg"), "green", 1600);
    const song = makeAudioFixture(path.join(dir, "01 - Wake.mp3"), { artist: "Old", album: "Minutes", title: "Woken", track: "1", picture }, 1, clog);
    const server = createFakeServer();
    const options = { token: TOKEN, userId: USER_ID, libraryKeyBase64: keyBase64, clientType: CLIENT_TYPE, transport: server.transport, log: clog };
    await importParrotFiles([song], options);
    // Make it look like a library from before small copies: one cover key, no small copy.
    const db = openParrotLibrary(server.state.dbBytes!);
    db.exec("UPDATE albums SET cover_thumb_object_key = NULL");
    server.state.dbBytes = serializeParrotLibrary(db);
    db.close();
    const before = albumOf(server.state.dbBytes!);
    expect(before.coverThumbObjectKey).toBeNull();

    const again = await importParrotFiles([song], options);
    clog("second run", again);
    const after = albumOf(server.state.dbBytes!);
    expect(after.coverThumbObjectKey).toMatch(/^assets\//);
    expect(after.coverObjectKey).not.toBe(before.coverObjectKey);
    expect(await widthOf(server.objects.get(after.coverThumbObjectKey!)!)).toBe(500);

    // A third run has nothing left to add.
    const uploads = server.uploads.length;
    await importParrotFiles([song], options);
    expect(server.uploads.length).toBe(uploads);
    await fs.rm(path.join(root, "Old"), { recursive: true, force: true });
  });
});

/**
 * @test-id PARROT-INGEST-IMPORTER-LOOKUPS-001
 * @why Chris 2026-11-15 (#2504, #2505): after importing Meltway, the lyrics were not there until he pressed "Fetch
 *   lyrics", and Linnet Park had no photo at first although the import review had shown it. The import now asks both
 *   while each file uploads: a song goes out with its lyrics (or the final "no lyrics"), and the artist's photo goes
 *   out with the import instead of after it.
 */
// @req PAR-LYR-01 @req PAR-META-15 @req PAR-UP-03
describe("importParrotFiles lyrics and artist photos", () => {
  let root: string;
  let nook: string;
  let fable: string;
  let photo: Uint8Array;
  const keyBase64 = randomBytes(32).toString("base64");
  const llog = testLog("PARROT-INGEST-IMPORTER-LOOKUPS-001");
  const LP_ID = "5e1c0a2d-4b7f-4c3a-9d21-7a6b3c9e0f15";
  const CREDIT = { author: "Test Photographer", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/" };

  beforeAll(async () => {
    root = await makeTempDir("lookups");
    const dir = path.join(root, "Linnet Park", "Meltway");
    await fs.mkdir(dir, { recursive: true });
    const tags = { artist: "Linnet Park", album: "Meltway", date: "2003" };
    nook = makeAudioFixture(path.join(dir, "13 - Nook.mp3"), { ...tags, title: "Nook", track: "13" }, 1, llog);
    fable = makeAudioFixture(path.join(dir, "07 - Fable.mp3"), { ...tags, title: "Fable", track: "7" }, 1, llog);
    photo = new Uint8Array(await fs.readFile(makeCoverPicture(path.join(root, "linnet-park.jpg"), "purple", 800)));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** The tags with the album artist's catalog id the import review matched. */
  const matched = async (file: string) => ({ ...(await readParrotTrackInfo(file)), albumArtistMusicId: LP_ID });
  const base = (server: { transport: ParrotImportTransport }, messages: string[]) => ({
    token: TOKEN,
    userId: USER_ID,
    libraryKeyBase64: keyBase64,
    clientType: CLIENT_TYPE,
    transport: server.transport,
    readInfo: matched,
    lyricsGapMs: 0,
    log: (message: string) => {
      messages.push(message);
      llog(message);
    },
  });
  const lyricsIn = (dbBytes: Uint8Array) => {
    const db = openParrotLibrary(dbBytes);
    const rows = db.prepare("SELECT t.title AS title, l.plain AS plain, l.source AS source FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id ORDER BY t.title").all();
    db.close();
    return rows;
  };
  const artistsIn = (dbBytes: Uint8Array) => {
    const db = openParrotLibrary(dbBytes);
    const rows = db
      .prepare("SELECT name, music_id AS musicId, picture_object_key AS pictureObjectKey, picture_thumb_object_key AS thumb, picture_author AS author, picture_tried_at AS triedAt FROM artists")
      .all() as Array<{ name: string; musicId: string | null; pictureObjectKey: string | null; thumb: string | null; author: string | null; triedAt: number | null }>;
    db.close();
    return rows;
  };

  it("publishes each new song together with its looked-up lyrics, or the final 'no lyrics'", async () => {
    const server = createFakeServer();
    const messages: string[] = [];
    const asked: unknown[] = [];
    const result = await importParrotFiles([nook, fable], {
      ...base(server, messages),
      lookupLyrics: async (question) => {
        asked.push(question);
        return question.title === "Nook" ? { plain: "Fake plain lyric for a nook test tone", synced: null } : { plain: null, synced: null };
      },
    });
    llog("result", result);
    llog("questions", asked);
    expect(result.imported).toEqual([nook, fable]);
    expect(asked).toEqual([
      { artist: "Linnet Park", title: "Nook", album: "Meltway", durationMs: expect.any(Number) },
      { artist: "Linnet Park", title: "Fable", album: "Meltway", durationMs: expect.any(Number) },
    ]);
    // The first publish (Nook alone) already carries Nook's lyrics: it is never playable without them.
    const first = lyricsIn(server.publishes[0]!.dbBytes);
    llog("first publish", first);
    expect(first).toEqual([{ title: "Nook", plain: "Fake plain lyric for a nook test tone", source: "fetched" }]);
    const last = lyricsIn(server.state.dbBytes!);
    llog("last publish", last);
    expect(last).toEqual([
      { title: "Fable", plain: null, source: "none" },
      { title: "Nook", plain: "Fake plain lyric for a nook test tone", source: "fetched" },
    ]);
  });

  it("asks nothing for a song whose file has lyrics, and names the songs whose lookup failed or was too slow", async () => {
    const server = createFakeServer();
    const messages: string[] = [];
    const asked: string[] = [];
    const unasked: string[] = [];
    const withWords = async (file: string) => ({ ...(await matched(file)), ...(file === nook ? { lyrics: { plain: "From the file", synced: null } } : {}) });
    const result = await importParrotFiles([nook, fable], {
      ...base(server, messages),
      readInfo: withWords,
      lookupLyrics: async (question) => {
        asked.push(question.title);
        throw Object.assign(new Error("lookup unavailable"), { status: 500 });
      },
      onLyricsUnasked: (trackId) => unasked.push(trackId),
    });
    llog("failed lookup", { result, asked, unasked });
    expect(asked).toEqual(["Fable"]);
    const fableId = parrotTrackIds({ ...(await matched(fable)), fileHash: sha256Hex(await fs.readFile(fable)) }).trackId;
    expect(unasked).toEqual([fableId]);
    expect(lyricsIn(server.state.dbBytes!)).toEqual([
      { title: "Fable", plain: null, source: null },
      { title: "Nook", plain: "From the file", source: "file" },
    ]);

    const slow = createFakeServer();
    const slowUnasked: string[] = [];
    const started = Date.now();
    const late = await importParrotFiles([fable], {
      ...base(slow, messages),
      lookupWaitMs: 50,
      lookupLyrics: () => new Promise(() => undefined),
      onLyricsUnasked: (trackId) => slowUnasked.push(trackId),
    });
    llog("slow lookup", { late, ms: Date.now() - started, slowUnasked });
    expect(late.imported).toEqual([fable]);
    expect(slowUnasked).toEqual([fableId]);
    expect(lyricsIn(slow.state.dbBytes!)).toEqual([{ title: "Fable", plain: null, source: null }]);
  });

  it("stores the matched artist's photo during the import, asked once, and says which artists are being asked", async () => {
    const server = createFakeServer();
    const messages: string[] = [];
    const photoCalls: string[] = [];
    const askedSets: string[][] = [];
    const albumsImporting: string[] = [];
    // The photo comes only once both songs are uploaded: the last publish waits for it.
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    let songsPublished = 0;
    const result = await importParrotFiles([nook, fable], {
      ...base(server, messages),
      artistPhoto: async (artistId) => {
        photoCalls.push(artistId);
        await held;
        return { bytes: photo, credit: CREDIT };
      },
      onArtistPhotosAsked: (ids) => askedSets.push(ids),
      onAlbumImporting: (albumId) => albumsImporting.push(albumId),
      onProgress: (event) => {
        if (event.published > songsPublished) songsPublished = event.published;
        if (event.done === 2) release();
      },
    });
    llog("photo run", { result, photoCalls, askedSets, publishes: server.publishes.length });
    expect(photoCalls).toEqual([LP_ID]);
    const [artist] = artistsIn(server.state.dbBytes!);
    llog("artist", artist);
    expect(artist).toMatchObject({ name: "Linnet Park", musicId: LP_ID, author: CREDIT.author });
    expect(artist!.pictureObjectKey).toMatch(/^assets\//);
    expect(artist!.thumb).toMatch(/^assets\//);
    expect(server.objects.has(artist!.pictureObjectKey!)).toBe(true);
    // Asked from the first song until its photo was published, then nobody.
    expect(askedSets[0]).toEqual([parrotTrackIds({ ...(await matched(nook)), fileHash: "x" }).albumArtistId]);
    expect(askedSets.at(-1)).toEqual([]);
    // PAR-UP-07: the album is named once, when its first new song starts uploading.
    expect(albumsImporting).toEqual([parrotTrackIds({ ...(await matched(nook)), fileHash: "x" }).albumId]);
  });

  it("records 'no photo' when the lookup has none, and nothing when it fails, so the pass asks again", async () => {
    const none = createFakeServer();
    const messages: string[] = [];
    const asked: string[][] = [];
    await importParrotFiles([nook], { ...base(none, messages), artistPhoto: async () => null, onArtistPhotosAsked: (ids) => asked.push(ids) });
    const [noPhoto] = artistsIn(none.state.dbBytes!);
    llog("no photo", { noPhoto, asked });
    expect(noPhoto).toMatchObject({ musicId: LP_ID, pictureObjectKey: null, triedAt: expect.any(Number) });
    expect(asked.at(-1)).toEqual([]);

    const failing = createFakeServer();
    const failedAsked: string[][] = [];
    await importParrotFiles([nook], {
      ...base(failing, messages),
      artistPhoto: async () => {
        throw new Error("lookup down");
      },
      onArtistPhotosAsked: (ids) => failedAsked.push(ids),
    });
    const [failed] = artistsIn(failing.state.dbBytes!);
    llog("failed photo", { failed, failedAsked });
    expect(failed).toMatchObject({ musicId: LP_ID, pictureObjectKey: null, triedAt: null });
    expect(failedAsked.at(-1)).toEqual([]);
  });
});
