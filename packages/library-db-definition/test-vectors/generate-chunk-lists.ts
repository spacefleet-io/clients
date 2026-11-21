/**
 * Writes `chunk-lists.json`, the packed chunk list contract (LIB-FMT-11) the TS, Kotlin, Swift and Python codecs
 * check against. Inputs live here; expected outputs come from `src/chunkLists.ts`, and
 * `tests/chunk-lists-vectors.test.ts` re-derives the seed keys and varints independently of it.
 * Any codec change edits this file first, then: `bun packages/library-db-definition/test-vectors/generate-chunk-lists.ts`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  chunkListKeys,
  chunkListToJson,
  decodeChunkStarts,
  packChunkList,
  packSeededChunkList,
  seedChunkKey,
  type ChunkRef,
  type PackedChunkList,
} from "../src/chunkLists";
import { translateV3MediaUpsert } from "../src/ops";
import type { MediaUpsertOp } from "@space/shared/libraryOps";

const hex = (bytes: Uint8Array | null) => (bytes === null ? null : Buffer.from(bytes).toString("hex"));
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));

const P = "0b9a3c52-6f1e-4d7a-9c11-2e5f8d3a7b40";
const uuidKey = (n: number) => `media/${P}/${n.toString(16).padStart(8, "0")}-1d2e-4f30-8a41-${(0x5c6d7e8f9a00 + n).toString(16)}`;

const expected = (list: PackedChunkList) => ({
  placementId: list.placementId,
  keyMode: list.keyMode,
  count: list.count,
  keyDataHex: hex(list.keyData),
  sizesHex: hex(list.sizes),
  startsHex: hex(list.starts),
  json: chunkListToJson(list),
  keys: chunkListKeys(list),
  decodedStarts: decodeChunkStarts(list.starts, list.count),
});

const explicitCases: Array<{ name: string; note: string; chunks: ChunkRef[] }> = [
  {
    name: "uuid-keys-one-placement",
    note: "every key media/<placement>/<lowercase uuid>: key mode 1, 16 bytes per chunk; 23.976 fps segment starts",
    chunks: [0, 1, 2, 3].map((i) => ({ key: uuidKey(i), sizeBytes: 1_048_576 + i * 1000, startSeconds: [0, 6.006, 12.012, 18.018][i]! })),
  },
  {
    name: "mixed-placements-and-nulls",
    note: "two placements: key mode 0, placementId empty; null size, null start in the middle, a start going backwards",
    chunks: [
      { key: uuidKey(10), sizeBytes: 0, startSeconds: 10 },
      { key: `media/other-placement/${uuidKey(11).split("/")[2]}`, sizeBytes: null, startSeconds: null },
      { key: uuidKey(12), sizeBytes: 4_294_967_296 + 7, startSeconds: 4.5 },
    ],
  },
  {
    name: "shard-keys",
    note: "old shard keys and a non-ASCII key: key mode 0, UTF-8 texts joined by \\n",
    chunks: [
      { key: "shards/42/a", sizeBytes: 127, startSeconds: 0 },
      { key: "shards/42/b", sizeBytes: 128, startSeconds: 12.0106 },
      { key: "shards/42/é", sizeBytes: 16_383, startSeconds: 24.0004 },
    ],
  },
  {
    name: "uppercase-uuid-falls-back",
    note: "an uppercase uuid would not round-trip through bytes: key mode 0 with the placement kept",
    chunks: [{ key: `media/${P}/ABCDEF01-1D2E-4F30-8A41-5C6D7E8F9A00`, sizeBytes: 5, startSeconds: null }],
  },
  {
    name: "no-starts",
    note: "every start null: starts is null",
    chunks: [
      { key: uuidKey(20), sizeBytes: 300, startSeconds: null },
      { key: uuidKey(21), sizeBytes: null, startSeconds: null },
    ],
  },
  { name: "empty", note: "no chunks: key mode 0, empty key data and sizes, starts null", chunks: [] },
];

const seedCases = [
  {
    name: "seed-five-chunks",
    note: "key mode 2: keys derived from the seed; 12 s audio segments",
    placementId: P,
    seedHex: "000102030405060708090a0b0c0d0e0f",
    sizes: [196_608, 196_611, null, 196_500, 1],
    starts: [0, 12, 24, 36, 48],
  },
  {
    name: "seed-one-chunk-no-start",
    note: "key mode 2, a single chunk with no start time",
    placementId: "p-1",
    seedHex: "ffeeddccbbaa99887766554433221100",
    sizes: [42],
    starts: [null],
  },
];

// --- Translation of an old `media.upsert` (vault v4 plan §1.1, LIB-FMT-11 shape rule) ---------------------------------

const M = "5d1c9a20-0000-4000-8000-00000000a001";
const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-02T10:00:00.000Z";

const baseDetails = {
  id: M,
  type: "movie" as const,
  catalogId: 603,
  title: "Vector Movie",
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "1999",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [28],
  addedAt: T0,
  updatedAt: T1,
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: null,
  episodeCount: 0,
  cast: [],
  playlistIds: [],
  seasons: [],
  episodes: [],
  trailers: [],
  skipMarkers: [],
  hasLocalFiles: false,
  files: [
    { id: "file-a", filename: "a.mkv", season: null, episode: null, desiredFormats: [] },
    { id: "file-b", filename: "b.mkv", season: null, episode: null, desiredFormats: [] },
  ],
};

const format = (id: string, fileId: string, chunks: ChunkRef[]) => ({
  id,
  mediaId: M,
  fileId,
  quality: "1080p",
  codec: "h264",
  codecString: "avc1.640028",
  bitrateKbps: 5000,
  sizeMb: 10,
  initKey: `media/${P}/init-${id}`,
  initSize: 900,
  durationSeconds: 18.018,
  totalSize: 3_145_728,
  isSource: true,
  chunks,
});

const audio = (id: string, fileId: string | null, chunks: ChunkRef[]) => ({
  id,
  mediaId: M,
  fileId,
  episodeId: null,
  language: "fr",
  label: "Français",
  isDefault: fileId === null,
  source: fileId === null ? "added" : "embedded",
  codec: "aac",
  codecString: "mp4a.40.2",
  initKey: null,
  initSize: null,
  durationSeconds: 18,
  totalSize: 600,
  chunks,
});

const subtitle = (id: string, fileId: string | null) => ({
  id,
  mediaId: M,
  fileId,
  episodeId: null,
  language: "en",
  label: "English",
  objectKey: `subtitles/${id}.vtt`,
  format: "vtt",
  isDefault: false,
  source: "embedded",
  createdAt: T0,
});

const translationCases: Array<{ name: string; note: string; op: MediaUpsertOp }> = [
  {
    name: "movie-two-files",
    note:
      "two files, chapters, an added audio track with no file, subtitles under `subtitles`; a chapter of a format not in the payload is dropped; a set per file then the no-file set",
    op: {
      id: "op-movie-1",
      type: "media.upsert",
      createdAt: T1,
      payload: {
        details: {
          ...baseDetails,
          formats: [
            format("fmt-a", "file-a", [0, 1, 2].map((i) => ({ key: uuidKey(30 + i), sizeBytes: 1_000_000 + i, startSeconds: i * 6.006 }))),
            format("fmt-b", "file-b", [{ key: "shards/9/x", sizeBytes: 77, startSeconds: null }]),
          ],
          audioTracks: [
            audio("aud-a", "file-a", [{ key: uuidKey(40), sizeBytes: 600, startSeconds: 0 }]),
            audio("aud-added", null, [
              { key: uuidKey(41), sizeBytes: 300, startSeconds: 0 },
              { key: uuidKey(42), sizeBytes: 300, startSeconds: 12 },
            ]),
          ],
          subtitles: [subtitle("sub-a", "file-a"), subtitle("sub-added", null)],
          subtitleTracks: [subtitle("sub-a", "file-a"), subtitle("sub-added", null)],
          chapters: [
            { id: "ch-1", formatId: "fmt-a", title: "Opening", startSeconds: 0 },
            { id: "ch-2", formatId: "fmt-a", title: "End", startSeconds: 12.5 },
            { id: "ch-gone", formatId: "fmt-missing", title: "Dropped", startSeconds: 1 },
          ],
        },
      },
    },
  },
  {
    name: "empty-playback-prunes-all",
    note:
      "formats: [] (old semantics: the title's whole playback replaced by nothing): keepFileIds = the files only, every set empty, so every stored row of the title goes",
    op: {
      id: "op-movie-2",
      type: "media.upsert",
      createdAt: T1,
      payload: {
        details: {
          ...baseDetails,
          files: [baseDetails.files[0]!],
          formats: [],
          audioTracks: [],
          subtitles: [],
          subtitleTracks: [],
          chapters: [],
        },
      },
    },
  },
  {
    name: "row-file-not-in-files",
    note: "a format names a file missing from `files`: that file still gets its set and is kept, after the listed files",
    op: {
      id: "op-movie-3",
      type: "media.upsert",
      createdAt: T1,
      payload: {
        details: {
          ...baseDetails,
          files: [baseDetails.files[1]!],
          formats: [format("fmt-c", "file-c", [{ key: uuidKey(50), sizeBytes: 1, startSeconds: 0 }])],
          audioTracks: [],
          subtitles: [],
          subtitleTracks: [],
          chapters: [],
        },
      },
    },
  },
];

const vectors = {
  description:
    "Packed chunk lists (LIB-FMT-11, vault v4 plan §1.2-1.5). Generated by generate-chunk-lists.ts from src/chunkLists.ts; do not edit by hand. Hex fields are lowercase; json is the op-stream-4 object (standard padded base64).",
  layout: {
    sizes: "unsigned LEB128 varint per chunk of sizeBytes + 1; 0 = null",
    starts:
      "null when every start is null; else unsigned LEB128 varint per chunk: 0 = null start, else zigzag(ms - previousMs) + 1, ms = round(startSeconds * 1000), previousMs = last non-null ms (0 initially); decoded start = ms / 1000",
    keyMode0: "UTF-8 key texts joined by \\n; placementId = the one media/<p>/ placement shared by every key, else empty",
    keyMode1: "16 raw bytes per chunk of the lowercase uuid in media/<placementId>/<uuid>; used only when every key has that shape with one placement",
    keyMode2:
      "keyData = 16-byte seed; key i = media/<placementId>/ + lowercase 8-4-4-4-12 hex of the first 16 bytes of HMAC-SHA256(key = seed, message = ASCII 'chunk:' || u32 big-endian i)",
  },
  translation:
    "translateV3MediaUpsert (LIB-FMT-11): an upsert whose details hold any of formats/audioTracks/subtitles/subtitleTracks/chapters is the old type. upsert = details without those keys, id <op>:upsert. playbackSets = one per file id (files, then other file ids rows name, first-seen order) then fileId null, id <op>:playback:<fileId or ''>, updatedAt = details.updatedAt; rows go to the set of their fileId; chunks packed (packChunkList); subtitles = subtitles ?? subtitleTracks ?? []; a chapter goes to its format's set, dropped when its format is absent. prune = {mediaId, updatedAt, keepFileIds = the file ids of the sets}: rows of other files are deleted unless that file's clock is newer than updatedAt.",
  explicit: explicitCases.map(({ name, note, chunks }) => ({ name, note, input: { chunks }, expected: expected(packChunkList(chunks)) })),
  seeded: seedCases.map(({ name, note, placementId, seedHex, sizes, starts }) => ({
    name,
    note,
    input: { placementId, seedHex, sizes, starts },
    expected: expected(packSeededChunkList({ placementId, seed: fromHex(seedHex), sizes, starts })),
  })),
  seedKeys: [0, 1, 255, 256, 65_536, 4_294_967_295].map((index) => ({
    seedHex: "000102030405060708090a0b0c0d0e0f",
    placementId: P,
    index,
    key: seedChunkKey(fromHex("000102030405060708090a0b0c0d0e0f"), P, index),
  })),
  translations: translationCases.map(({ name, note, op }) => ({ name, note, input: op, expected: translateV3MediaUpsert(op) })),
  invalid: [
    { name: "sizes-short", note: "count 2 but one size", json: { placementId: "", keyMode: 0, keyData: btoa("a\nb"), count: 2, sizes: "AQ==", starts: null } },
    { name: "sizes-trailing", note: "bytes left after count sizes", json: { placementId: "", keyMode: 0, keyData: btoa("a"), count: 1, sizes: "AQE=", starts: null } },
    { name: "key-texts-count", note: "two key texts for count 1", json: { placementId: "", keyMode: 0, keyData: btoa("a\nb"), count: 1, sizes: "AQ==", starts: null } },
    { name: "uuid-bytes-length", note: "15 key bytes for count 1", json: { placementId: P, keyMode: 1, keyData: btoa("x".repeat(15)), count: 1, sizes: "AQ==", starts: null } },
    { name: "seed-length", note: "15-byte seed", json: { placementId: P, keyMode: 2, keyData: btoa("x".repeat(15)), count: 1, sizes: "AQ==", starts: null } },
    { name: "unknown-key-mode", note: "key mode 3", json: { placementId: P, keyMode: 3, keyData: "", count: 0, sizes: "", starts: null } },
    { name: "starts-truncated", note: "varint continuation bit on the last byte", json: { placementId: "", keyMode: 0, keyData: btoa("a"), count: 1, sizes: "AQ==", starts: "gA==" } },
  ],
};

const path = join(import.meta.dir, "chunk-lists.json");
writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`);
console.info(
  `wrote ${path}: ${vectors.explicit.length} explicit, ${vectors.seeded.length} seeded, ${vectors.seedKeys.length} seed keys, ${vectors.translations.length} translations, ${vectors.invalid.length} invalid`
);
