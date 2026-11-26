/**
 * A fake storage and library server as slow as Chris's line on 2026-11-26 (Artie Shaw import, Parrot 0.1.61): every
 * object shares one link of `mbps` (about 3 MB/s) after `objectLatencyMs` of server round trips (lease, placement,
 * commit), a snapshot PUT takes `publishMs`, a snapshot read `fetchMs`. The import throughput test and the bench time
 * imports against it; `timeline` records when each upload and publish started and ended.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parrotAudioFormatFor } from "../src/formats";
import type { ParrotImportOptions, ParrotImportResult, ParrotImportTransport } from "../src/importer";
import { importParrotFiles } from "../src/importJobs";
import type { ParrotTrackInfo } from "../src/readTrack";

export type SlowServerTiming = {
  /** Bytes per second through the one shared link. */
  bytesPerSec: number;
  /** Fixed server time each stored object costs, on top of its bytes. */
  objectLatencyMs: number;
  publishMs: number;
  fetchMs: number;
};

/** Chris's line: ~3 MB/s, ~300 ms of lease and placement calls per object, ~1.2 s per snapshot PUT (log 2026-11-26). */
export const CHRIS_LINE: SlowServerTiming = { bytesPerSec: 3_000_000, objectLatencyMs: 300, publishMs: 1200, fetchMs: 300 };

export type SlowServerEvent = { kind: "upload" | "publish"; key: string; start: number; end: number };

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, Math.max(0, ms));
  return promise;
};

/** `scale` multiplies every delay (0.1: ten times faster than real, same shape). */
export const createSlowServer = (timing: SlowServerTiming = CHRIS_LINE, scale = 1) => {
  const objects = new Map<string, Uint8Array>();
  const timeline: SlowServerEvent[] = [];
  const state = { version: 0, dbBytes: null as Uint8Array | null };
  const t0 = Date.now();
  // The link is busy until this time: each object's bytes go through after the ones before them.
  let linkFreeAt = 0;
  const sendBytes = async (bytes: number) => {
    const now = Date.now();
    const start = Math.max(now, linkFreeAt);
    linkFreeAt = start + ((bytes / timing.bytesPerSec) * 1000) * scale;
    await sleep(linkFreeAt - now);
  };
  const store = async (objectKey: string, payload: Uint8Array, options: Record<string, unknown>) => {
    const start = Date.now() - t0;
    await sleep(timing.objectLatencyMs * scale);
    await sendBytes(payload.length);
    const placed = options.placementId ? `media/${String(options.placementId)}/${objectKey}` : objectKey;
    objects.set(placed, payload);
    timeline.push({ kind: "upload", key: placed, start, end: Date.now() - t0 });
    return placed;
  };
  const upload = async (_token: string, objectKey: string, payload: Uint8Array, options: Record<string, unknown> = {}) => store(objectKey, payload, options);
  const openUploadSession = (_token: string, opened: { placementId: string; clientType?: string }) => ({
    upload: (objectKey: string, payload: Uint8Array, options: Record<string, unknown> = {}) => store(objectKey, payload, { ...options, placementId: opened.placementId }),
    close: async () => {},
  });
  const fetchSnapshot = async () => {
    await sleep(timing.fetchMs * scale);
    return state.dbBytes ? { snapshotVersion: state.version, dbBytes: state.dbBytes } : null;
  };
  const publishSnapshot = async (input: { dbBytes: Uint8Array; baseVersion: number }) => {
    const start = Date.now() - t0;
    await sleep(timing.publishMs * scale);
    if (input.baseVersion !== state.version) throw Object.assign(new Error(`library_db_conflict: base ${input.baseVersion}, server ${state.version}`), { status: 409 });
    state.version += 1;
    state.dbBytes = new Uint8Array(input.dbBytes);
    timeline.push({ kind: "publish", key: `v${state.version}`, start, end: Date.now() - t0 });
    return { version: state.version, snapshotId: `snap-${state.version}`, manifest: {}, stateHash: null, lastOpId: null };
  };
  // The fake implements only what the importer reads from each call's input and result.
  const transport = { upload, openUploadSession, fetchSnapshot, publishSnapshot } as unknown as ParrotImportTransport;
  /** The most uploads of different songs (placements) running at the same moment. */
  const peakSongsUploading = () => {
    const spans = timeline.filter((event) => event.kind === "upload" && event.key.startsWith("media/"));
    const placementOf = (key: string) => key.split("/")[1]!;
    let peak = 0;
    for (const span of spans) {
      const at = span.start;
      const live = new Set(spans.filter((other) => other.start <= at && other.end > at).map((other) => placementOf(other.key)));
      peak = Math.max(peak, live.size);
    }
    return peak;
  };
  /** The most stored objects (chunks) in flight at the same moment, across songs. */
  const peakObjectsInFlight = () => {
    const spans = timeline.filter((event) => event.kind === "upload");
    return spans.reduce((peak, span) => Math.max(peak, spans.filter((other) => other.start <= span.start && other.end > span.start).length), 0);
  };
  return { startedAt: t0, objects, timeline, state, transport, peakSongsUploading, peakObjectsInFlight, publishes: () => timeline.filter((event) => event.kind === "publish").length };
};

export type SlowAlbumImport = {
  /** Wall time of the import against the scaled server, in ms. */
  ms: number;
  /** The same time at real speed (`ms / scale`). */
  realMs: number;
  publishes: number;
  peakSongsUploading: number;
  peakObjectsInFlight: number;
  /** Server events, ms from `serverStartedAt`. */
  timeline: SlowServerEvent[];
  /** Epoch ms the fake server started. */
  serverStartedAt: number;
  result: ParrotImportResult;
};

/** `songs` m4a files of `bytesPerSong` random bytes each in `dir`, named "NN Song N.m4a". */
export const writeSlowAlbum = async (dir: string, songs: number, bytesPerSong: number): Promise<string[]> => {
  const files: string[] = [];
  for (let index = 1; index <= songs; index += 1) {
    const file = path.join(dir, `${String(index).padStart(2, "0")} Song ${index}.m4a`);
    await fs.writeFile(file, randomBytes(bytesPerSong));
    files.push(file);
  }
  return files;
};

/** The tags of a `writeSlowAlbum` file: Artie Shaw's album, the number from the file name. */
export const slowAlbumInfo = async (file: string): Promise<ParrotTrackInfo> => {
  const number = Number(path.basename(file).slice(0, 2));
  return {
    file,
    artist: "Artie Shaw",
    albumArtist: "Artie Shaw",
    album: "Dancing on the Ceiling",
    title: `Song ${number}`,
    disc: 1,
    number,
    year: 1938,
    durationMs: 180_000,
    bitrateKbps: 256,
    sampleRate: 44100,
    format: parrotAudioFormatFor(file)!,
  };
};

/**
 * Imports an album of `songs` m4a files of `bytesPerSong` random bytes each against `createSlowServer`, with a light
 * copy encoder that takes `encodeMs` (1.5 s on Chris's computer) and returns a quarter of the original, and times it.
 */
export const timeSlowAlbumImport = async (
  input: { songs?: number; bytesPerSong?: number; scale?: number; encodeMs?: number; log?: (message: string) => void; options?: Partial<ParrotImportOptions> } = {}
): Promise<SlowAlbumImport> => {
  const songs = input.songs ?? 24;
  const bytesPerSong = input.bytesPerSong ?? 3_000_000;
  const scale = input.scale ?? 0.1;
  const encodeMs = input.encodeMs ?? 1500;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parrot-slow-album-"));
  try {
    const files = await writeSlowAlbum(dir, songs, bytesPerSong);
    const readInfo = slowAlbumInfo;
    const server = createSlowServer(CHRIS_LINE, scale);
    const started = Date.now();
    const result = await importParrotFiles(files, {
      token: "token",
      userId: "user-chris",
      libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      clientType: "parrot-desktop",
      transport: server.transport,
      roots: [dir],
      readInfo,
      makeLightCopy: async (original) => {
        await sleep(encodeMs * scale);
        return randomBytes(Math.round(original.size / 4));
      },
      log: input.log,
      ...input.options,
    });
    const ms = Date.now() - started;
    return { ms, realMs: Math.round(ms / scale), publishes: server.publishes(), peakSongsUploading: server.peakSongsUploading(), peakObjectsInFlight: server.peakObjectsInFlight(), timeline: server.timeline, serverStartedAt: server.startedAt, result };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};
