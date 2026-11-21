/**
 * @test-id LIB-DB-VAULT-V4-OPS-001
 * @level unit (real SQLite: node:sqlite)
 * @req LIB-FMT-11
 * @req LIB-FMT-12
 * @why Vault v4 moves every title's chunks into one packed row per format / audio track and splits playback into
 *   per-file groups with their own clock. Ops carry no version, so the payload's shape decides how an upsert applies
 *   (the shape rule), and an old upsert is translated. This suite runs the statements on a real SQLite and proves:
 *   - the shape rule (a version-4 upsert never prunes; an old one prunes, `formats: []` prunes everything);
 *   - the per-file clock (an older set changes nothing, an equal one applies; a newer file survives a prune);
 *   - set / delete / episode delete / media delete on the packed tables;
 *   - the new ops refuse the old layout, malformed payloads are refused;
 *   - a synthetic 75-title library reads the same before and after `convertPlaybackToPackedLayout`, and the same
 *     again when its old ops are applied translated onto the packed layout.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  AudioTrack,
  MediaChapter,
  MediaDetails,
  MediaEpisode,
  MediaFile,
  MediaFormat,
  SubtitleTrack,
} from "@space/shared/libraryTypes";
import type { LibraryOp, MediaFilePlaybackSetOp, MediaUpsertOp } from "@space/shared/libraryOps";
import { chunkListToJson, packChunkList, type ChunkRef } from "../src/chunkLists";
import { ALL_LIBRARY_DB_GROUPS } from "../src/manifest";
import { readMediaDetailsSync } from "../src/mediaDetails";
import { getGroupDdlStatements } from "../src/migrations";
import {
  buildMediaDeleteStatements,
  buildOpStatements,
  LibraryOpShapeError,
  PlaybackLayoutError,
  playbackFileIdFromKey,
  playbackFileKey,
  type BuildOpOptions,
  type OpStatementsByGroup,
} from "../src/ops";
import { convertPlaybackToPackedLayout } from "../src/packedPlayback";

const SUITE = "vault-v4-ops";
const log = (label: string, data?: unknown) =>
  console.info(`[${SUITE}:${label}]${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-02T00:00:00.000Z";
const T2 = "2026-11-03T00:00:00.000Z";
const T3 = "2026-11-04T00:00:00.000Z";

// --- database --------------------------------------------------------------------------------------------------------

const newDb = () => {
  // Foreign keys off, as every non-core group runs (cross-group-cascade-lint.test.ts): a statement must remove what
  // it removes itself, never through a cascade the split files do not have.
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const group of ALL_LIBRARY_DB_GROUPS) for (const sql of getGroupDdlStatements(group)) db.exec(sql);
  return db;
};

let nextId = 0;
const idGen = () => `gen-${++nextId}`;

/** A builder param as node:sqlite takes it (booleans as 0/1, as the other drivers bind them). */
const sqlValue = (value: unknown): SQLInputValue => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error(`[${SUITE}:bind] unbindable param ${JSON.stringify(value)}`);
};

const run = (db: DatabaseSync, statements: OpStatementsByGroup) => {
  for (const group of ALL_LIBRARY_DB_GROUPS) {
    for (const { sql, params } of statements[group] ?? []) db.prepare(sql).run(...params.map(sqlValue));
  }
};

const apply = (db: DatabaseSync, op: LibraryOp, options: BuildOpOptions = {}) => run(db, buildOpStatements(op, idGen, options));
const applyPacked = (db: DatabaseSync, op: LibraryOp) => apply(db, op, { packedPlayback: true });

const count = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) => {
  const row = db.prepare(sql).get(...params);
  return Number(row?.n ?? 0);
};

const read = (db: DatabaseSync, mediaId: string) =>
  readMediaDetailsSync((query) => db.prepare(query.sql).all(...query.params.map(sqlValue)), mediaId, { chunks: true });

const playbackCounts = (db: DatabaseSync, mediaId: string) => ({
  formats: count(db, "SELECT COUNT(*) AS n FROM media_formats WHERE media_id = ?;", mediaId),
  tracks: count(db, "SELECT COUNT(*) AS n FROM media_audio_tracks WHERE media_id = ?;", mediaId),
  subtitles: count(db, "SELECT COUNT(*) AS n FROM media_subtitles WHERE media_id = ?;", mediaId),
  chapters: count(
    db,
    "SELECT COUNT(*) AS n FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
    mediaId
  ),
  lists: count(
    db,
    `SELECT COUNT(*) AS n FROM media_chunk_lists WHERE owner_id IN
      (SELECT id FROM media_formats WHERE media_id = ? UNION SELECT id FROM media_audio_tracks WHERE media_id = ?);`,
    mediaId,
    mediaId
  ),
  oldChunks:
    count(db, "SELECT COUNT(*) AS n FROM media_format_chunks;") + count(db, "SELECT COUNT(*) AS n FROM media_audio_chunks;"),
  clocks: db
    .prepare("SELECT file_id, updated_at FROM media_file_playback WHERE media_id = ? ORDER BY file_id;")
    .all(mediaId)
    .map((row) => `${String(row.file_id)}@${String(row.updated_at)}`),
});

// --- fixtures --------------------------------------------------------------------------------------------------------

const P = "0b9a3c52-6f1e-4d7a-9c11-2e5f8d3a7b40";
const uuidKey = (n: number) => `media/${P}/${n.toString(16).padStart(8, "0")}-1d2e-4f30-8a41-${(0x5c6d7e8f9a00 + n).toString(16)}`;
const chunks = (seed: number, n: number, style: "uuid" | "shard"): ChunkRef[] =>
  Array.from({ length: n }, (_, i) => ({
    key: style === "uuid" ? uuidKey(seed * 1000 + i) : `shards/${seed}/${i}`,
    sizeBytes: i === 1 ? null : 1_000_000 + seed + i,
    startSeconds: i === 2 ? null : i * 6.006,
  }));

const fileRow = (id: string, season: number | null, episode: number | null): MediaFile => ({
  id,
  filename: `${id}.mkv`,
  season,
  episode,
  desiredFormats: [],
});

const formatRow = (mediaId: string, id: string, fileId: string, list: ChunkRef[]): MediaFormat => ({
  id,
  mediaId,
  fileId,
  quality: "1080p",
  codec: "h264",
  codecString: "avc1.640028",
  bitrateKbps: 5000,
  sizeMb: 12,
  initKey: `media/${P}/init-${id}`,
  initSize: 900,
  durationSeconds: 42,
  totalSize: 12_000_000,
  isSource: true,
  chunks: list,
});

const trackRow = (mediaId: string, id: string, fileId: string | null, episodeId: string | null, list: ChunkRef[]): AudioTrack => ({
  id,
  mediaId,
  fileId,
  episodeId,
  language: "fr",
  label: "Français",
  isDefault: fileId === null,
  source: fileId === null ? "added" : "embedded",
  codec: "aac",
  codecString: "mp4a.40.2",
  initKey: null,
  initSize: null,
  durationSeconds: 42,
  totalSize: 600,
  chunks: list,
});

const subtitleRow = (mediaId: string, id: string, fileId: string | null, episodeId: string | null): SubtitleTrack => ({
  id,
  mediaId,
  fileId,
  episodeId,
  language: "en",
  label: "English",
  objectKey: `subtitles/${id}.vtt`,
  format: "vtt",
  isDefault: false,
  source: "embedded",
  derivedFromSubtitleId: null,
  createdAt: T0,
});

type Playback = Pick<MediaDetails, "files" | "formats" | "audioTracks" | "subtitles" | "chapters" | "episodes">;

const details = (id: string, type: "movie" | "tv", updatedAt: string, playback: Playback): MediaDetails => ({
  id,
  type,
  catalogId: null,
  title: `Title ${id}`,
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2001",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [18],
  addedAt: T0,
  updatedAt,
  hasFiles: playback.files.length > 0,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: type === "tv" ? playback.episodes.length : null,
  episodeCount: playback.episodes.length,
  cast: [],
  playlistIds: [],
  seasons: [],
  trailers: [],
  skipMarkers: [],
  hasLocalFiles: false,
  subtitleTracks: playback.subtitles,
  ...playback,
});

const upsert = (opId: string, d: MediaDetails): MediaUpsertOp => ({
  id: opId,
  type: "media.upsert",
  createdAt: d.updatedAt,
  payload: { details: d },
});

/** A movie with two files, chapters, an added (no-file) audio track and subtitles on both sides. */
const movie = (id: string, updatedAt: string, seed: number): MediaDetails => {
  const fileA = `${id}-file-a`;
  const fileB = `${id}-file-b`;
  return details(id, "movie", updatedAt, {
    files: [fileRow(fileA, null, null), fileRow(fileB, null, null)],
    episodes: [],
    formats: [
      formatRow(id, `${id}-fmt-a`, fileA, chunks(seed, 4, "uuid")),
      formatRow(id, `${id}-fmt-b`, fileB, chunks(seed + 1, 2, "shard")),
    ],
    audioTracks: [
      trackRow(id, `${id}-aud-a`, fileA, null, chunks(seed + 2, 3, "uuid")),
      trackRow(id, `${id}-aud-added`, null, null, chunks(seed + 3, 2, "uuid")),
    ],
    subtitles: [subtitleRow(id, `${id}-sub-a`, fileA, null), subtitleRow(id, `${id}-sub-added`, null, null)],
    chapters: [
      { id: `${id}-ch-1`, formatId: `${id}-fmt-a`, title: "Opening", startSeconds: 0 },
      { id: `${id}-ch-2`, formatId: `${id}-fmt-b`, title: "Credits", startSeconds: 40 },
    ],
  });
};

/** A show: one file per episode, an episode-scoped added track on episode 1, a format with no chunks on the last. */
const show = (id: string, updatedAt: string, seed: number, episodeCount: number): MediaDetails => {
  const episodes: MediaEpisode[] = [];
  const files: MediaFile[] = [];
  const formats: MediaFormat[] = [];
  const audioTracks: AudioTrack[] = [];
  const subtitles: SubtitleTrack[] = [];
  const chapters: MediaChapter[] = [];
  for (let e = 1; e <= episodeCount; e += 1) {
    const episodeId = `${id}-ep-${e}`;
    const fileId = `${id}-file-${e}`;
    episodes.push({ id: episodeId, seasonNumber: 1, episodeNumber: e, name: `E${e}`, overview: null, stillPath: null, airDate: null });
    files.push(fileRow(fileId, 1, e));
    formats.push(formatRow(id, `${id}-fmt-${e}`, fileId, e === episodeCount ? [] : chunks(seed + e, 1 + (e % 5), e % 2 ? "uuid" : "shard")));
    audioTracks.push(trackRow(id, `${id}-aud-${e}`, fileId, episodeId, chunks(seed + 100 + e, 2, "uuid")));
    subtitles.push(subtitleRow(id, `${id}-sub-${e}`, fileId, episodeId));
    chapters.push({ id: `${id}-ch-${e}`, formatId: `${id}-fmt-${e}`, title: `Intro ${e}`, startSeconds: 1.5 });
  }
  audioTracks.push(trackRow(id, `${id}-aud-commentary`, null, `${id}-ep-1`, chunks(seed + 999, 3, "uuid")));
  return details(id, "tv", updatedAt, { files, episodes, formats, audioTracks, subtitles, chapters });
};

const byId = <T extends { id: string }>(rows: ReadonlyArray<T>) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
/** What a reader sees of a title's playback, order-free. */
const playbackView = (d: MediaDetails | null) => ({
  formats: byId(d?.formats ?? []),
  audioTracks: byId(d?.audioTracks ?? []),
  subtitles: byId(d?.subtitles ?? []),
  chapters: byId(d?.chapters ?? []),
  files: byId(d?.files ?? []),
  episodes: byId(d?.episodes ?? []),
});

const playbackSet = (
  mediaId: string,
  fileId: string | null,
  updatedAt: string,
  rows: { formats?: MediaFormat[]; audioTracks?: AudioTrack[]; subtitles?: SubtitleTrack[]; chapters?: MediaChapter[] }
): MediaFilePlaybackSetOp => ({
  id: `set-${mediaId}-${playbackFileKey(fileId)}-${updatedAt}`,
  type: "media.file.playback.set",
  createdAt: updatedAt,
  payload: {
    mediaId,
    fileId,
    updatedAt,
    formats: (rows.formats ?? []).map(({ chunks: list, ...format }) => ({ ...format, chunkList: chunkListToJson(packChunkList(list)) })),
    audioTracks: (rows.audioTracks ?? []).map(({ chunks: list, ...track }) => ({ ...track, chunkList: chunkListToJson(packChunkList(list)) })),
    subtitles: rows.subtitles ?? [],
    chapters: rows.chapters ?? [],
  },
});

const v4Upsert = (opId: string, d: MediaDetails): LibraryOp => {
  const { formats: _f, audioTracks: _a, subtitles: _s, subtitleTracks: _t, chapters: _c, ...core } = d;
  return { id: opId, type: "media.upsert", createdAt: d.updatedAt, payload: { details: core } };
};

// --- tests -----------------------------------------------------------------------------------------------------------

describe("vault v4 ops (LIB-FMT-11)", () => {
  it("playbackFileKey maps the no-file group to '' and back", () => {
    expect(playbackFileKey(null)).toBe("");
    expect(playbackFileKey("f")).toBe("f");
    expect(playbackFileIdFromKey("")).toBeNull();
    expect(playbackFileIdFromKey("f")).toBe("f");
  });

  it("the base playback DDL creates the packed tables empty", () => {
    const db = newDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('media_chunk_lists', 'media_file_playback') ORDER BY name;")
      .all()
      .map((row) => String(row.name));
    log("base-ddl", tables);
    expect(tables).toEqual(["media_chunk_lists", "media_file_playback"]);
  });

  it("the new ops refuse the old layout (PlaybackLayoutError)", () => {
    const ops: LibraryOp[] = [
      playbackSet("m", "f", T1, {}),
      { id: "d", type: "media.file.playback.delete", createdAt: T1, payload: { mediaId: "m", fileId: null } },
      {
        id: "e",
        type: "media.episode.delete",
        createdAt: T1,
        payload: { mediaId: "m", episodeId: "ep", seasonNumber: 1, episodeNumber: 1, fileIds: [] },
      },
    ];
    for (const op of ops) {
      expect(() => buildOpStatements(op, idGen), op.type).toThrow(PlaybackLayoutError);
      expect(() => buildOpStatements(op, idGen, { packedPlayback: true }), op.type).not.toThrow();
    }
  });

  it("without packedPlayback an old upsert and a media.delete build exactly today's statements", () => {
    const op = upsert("op-same", movie("m-same", T1, 1));
    const plain = JSON.stringify(buildOpStatements(op, () => "x"));
    expect(JSON.stringify(buildOpStatements(op, () => "x", { packedPlayback: false }))).toBe(plain);
    expect(plain).not.toContain("media_chunk_lists");
    expect(plain).not.toContain("media_file_playback");
    expect(JSON.stringify(buildMediaDeleteStatements("m-same"))).not.toContain("media_chunk_lists");
  });

  it("refuses malformed payloads (LibraryOpShapeError)", () => {
    const m = movie("m-shape", T1, 1);
    const [format] = playbackSet("m-shape", `m-shape-file-a`, T1, { formats: [m.formats[0]!] }).payload.formats;
    const packedInUpsert: LibraryOp = {
      id: "bad-1",
      type: "media.upsert",
      createdAt: T1,
      payload: { details: { ...m, formats: [{ ...m.formats[0]!, ...format }] } },
    };
    expect(() => buildOpStatements(packedInUpsert, idGen, { packedPlayback: true })).toThrow(LibraryOpShapeError);
    const wrongFile = playbackSet("m-shape", "other-file", T1, { formats: [m.formats[0]!] });
    expect(() => buildOpStatements(wrongFile, idGen, { packedPlayback: true })).toThrow(/LIBRARY_OP_SHAPE/);
    const strayChapter = playbackSet("m-shape", "m-shape-file-a", T1, {
      formats: [m.formats[0]!],
      chapters: [{ id: "c", formatId: "elsewhere", title: "x", startSeconds: 0 }],
    });
    expect(() => buildOpStatements(strayChapter, idGen, { packedPlayback: true })).toThrow(LibraryOpShapeError);
    const corrupt = playbackSet("m-shape", "m-shape-file-a", T1, { formats: [m.formats[0]!] });
    corrupt.payload.formats[0]!.chunkList = { ...corrupt.payload.formats[0]!.chunkList, count: 99 };
    expect(() => buildOpStatements(corrupt, idGen, { packedPlayback: true })).toThrow(/bad chunkList/);
  });

  it("an old upsert applies translated; a version-4 upsert never prunes playback", () => {
    const db = newDb();
    const m = movie("m-shape-rule", T1, 10);
    applyPacked(db, upsert("op-1", m));
    const afterOld = playbackCounts(db, m.id);
    log("after-old-upsert", afterOld);
    expect(afterOld).toEqual({
      formats: 2,
      tracks: 2,
      subtitles: 2,
      chapters: 2,
      lists: 4,
      oldChunks: 0,
      clocks: [`@${T1}`, `m-shape-rule-file-a@${T1}`, `m-shape-rule-file-b@${T1}`],
    });
    // The same title as the old layout reads it, applied with today's statements.
    const reference = newDb();
    apply(reference, upsert("op-1", m));
    expect(playbackView(read(db, m.id))).toEqual(playbackView(read(reference, m.id)));

    // Newer details naming only one file, version-4 shape: core and metadata change, playback stays whole.
    applyPacked(db, v4Upsert("op-2", { ...m, title: "Renamed", updatedAt: T2, files: [m.files[0]!] }));
    const afterV4 = playbackCounts(db, m.id);
    log("after-v4-upsert", afterV4);
    expect(afterV4).toEqual(afterOld);
    expect(read(db, m.id)?.title).toBe("Renamed");
  });

  it("an old upsert with formats: [] prunes the whole title's playback", () => {
    const db = newDb();
    const m = movie("m-prune-all", T1, 20);
    applyPacked(db, upsert("op-1", m));
    applyPacked(
      db,
      upsert("op-2", { ...m, updatedAt: T2, files: [m.files[0]!], formats: [], audioTracks: [], subtitles: [], subtitleTracks: [], chapters: [] })
    );
    const after = playbackCounts(db, m.id);
    log("after-empty-upsert", after);
    expect(after).toEqual({
      formats: 0,
      tracks: 0,
      subtitles: 0,
      chapters: 0,
      lists: 0,
      oldChunks: 0,
      clocks: [`@${T2}`, `m-prune-all-file-a@${T2}`],
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM media_chunk_lists;")).toBe(0);
  });

  it("the prune spares a file whose clock is newer than the old upsert", () => {
    const db = newDb();
    const m = movie("m-prune-newer", T1, 30);
    applyPacked(db, upsert("op-1", m));
    const fileB = m.files[1]!.id;
    applyPacked(db, playbackSet(m.id, fileB, T3, { formats: [m.formats[1]!] }));
    // An old upsert from T2 that no longer names file B: B's rows were set at T3, so they stay.
    applyPacked(db, upsert("op-2", { ...m, updatedAt: T2, files: [m.files[0]!], formats: [m.formats[0]!], chapters: [] }));
    const after = playbackCounts(db, m.id);
    log("after-prune-newer", after);
    expect(after.formats).toBe(2);
    expect(after.clocks).toEqual([`@${T2}`, `m-prune-newer-file-a@${T2}`, `${fileB}@${T3}`]);
  });

  it("media.file.playback.set: an older set changes nothing, an equal one applies", () => {
    const db = newDb();
    const m = movie("m-lww", T1, 40);
    applyPacked(db, v4Upsert("op-0", m));
    const fileA = m.files[0]!.id;
    const first = { ...m.formats[0]!, chunks: chunks(41, 3, "uuid") };
    applyPacked(db, playbackSet(m.id, fileA, T2, { formats: [first] }));
    const older = { ...m.formats[0]!, quality: "480p", chunks: chunks(42, 1, "shard") };
    applyPacked(db, playbackSet(m.id, fileA, T1, { formats: [older] }));
    let seen = read(db, m.id);
    log("after-older-set", seen?.formats.map((f) => ({ q: f.quality, n: f.chunks.length })));
    expect(seen?.formats.map(({ quality, chunks: list }) => ({ quality, list }))).toEqual([{ quality: first.quality, list: first.chunks }]);

    const equal = { ...m.formats[0]!, quality: "720p", chunks: chunks(43, 2, "uuid") };
    applyPacked(db, playbackSet(m.id, fileA, T2, { formats: [equal] }));
    seen = read(db, m.id);
    log("after-equal-set", seen?.formats.map((f) => ({ q: f.quality, n: f.chunks.length })));
    expect(seen?.formats.map(({ quality, chunks: list }) => ({ quality, list }))).toEqual([{ quality: equal.quality, list: equal.chunks }]);
    expect(playbackCounts(db, m.id).clocks).toEqual([`${fileA}@${T2}`]);
  });

  it("media.file.playback.delete removes one file group and its clock", () => {
    const db = newDb();
    const m = movie("m-file-delete", T1, 50);
    applyPacked(db, upsert("op-1", m));
    applyPacked(db, { id: "del", type: "media.file.playback.delete", createdAt: T2, payload: { mediaId: m.id, fileId: m.files[0]!.id } });
    const after = playbackCounts(db, m.id);
    log("after-file-delete", after);
    expect(after).toMatchObject({ formats: 1, tracks: 1, subtitles: 1, chapters: 1, lists: 2 });
    expect(after.clocks).toEqual([`@${T1}`, `m-file-delete-file-b@${T1}`]);
    applyPacked(db, { id: "del-null", type: "media.file.playback.delete", createdAt: T2, payload: { mediaId: m.id, fileId: null } });
    expect(playbackCounts(db, m.id)).toMatchObject({ tracks: 0, subtitles: 0, lists: 1, clocks: [`m-file-delete-file-b@${T1}`] });
  });

  it("media.episode.delete removes the episode and only its rows", () => {
    const db = newDb();
    const s = show("s-episode", T1, 60, 3);
    applyPacked(db, upsert("op-1", s));
    const before = playbackCounts(db, s.id);
    applyPacked(db, {
      id: "ep-del",
      type: "media.episode.delete",
      createdAt: T2,
      payload: { mediaId: s.id, episodeId: `${s.id}-ep-1`, seasonNumber: 1, episodeNumber: 1, fileIds: [`${s.id}-file-1`] },
    });
    const after = playbackCounts(db, s.id);
    const seen = read(db, s.id);
    log("episode-delete", { before, after, episodes: seen?.episodes.map((e) => e.id) });
    expect(seen?.episodes.map((e) => e.id)).toEqual([`${s.id}-ep-2`, `${s.id}-ep-3`]);
    expect(seen?.files.map((f) => f.id).sort()).toEqual([`${s.id}-file-2`, `${s.id}-file-3`]);
    // Episode 1: its format, its track, the episode-scoped commentary track, its subtitle and chapter all go.
    expect(after).toMatchObject({
      formats: before.formats - 1,
      tracks: before.tracks - 2,
      subtitles: before.subtitles - 1,
      chapters: before.chapters - 1,
    });
    expect(after.clocks).not.toContain(`${s.id}-file-1@${T1}`);
  });

  it("media.delete on the packed layout removes the lists and clocks too", () => {
    const db = newDb();
    const m = movie("m-delete", T1, 70);
    const other = movie("m-keep", T1, 80);
    applyPacked(db, upsert("op-1", m));
    applyPacked(db, upsert("op-2", other));
    applyPacked(db, { id: "del", type: "media.delete", createdAt: T2, payload: { mediaId: m.id } });
    const after = playbackCounts(db, m.id);
    log("after-media-delete", after);
    expect(after).toEqual({ formats: 0, tracks: 0, subtitles: 0, chapters: 0, lists: 0, oldChunks: 0, clocks: [] });
    expect(playbackCounts(db, other.id).lists).toBe(4);
    expect(count(db, "SELECT COUNT(*) AS n FROM media_chunk_lists;")).toBe(4);
  });

  it("a packed row wins over leftover per-chunk rows of the same owner", () => {
    const db = newDb();
    const m = movie("m-both", T1, 90);
    apply(db, upsert("op-1", m));
    const packed = chunks(91, 2, "uuid");
    const list = packChunkList(packed);
    db.prepare(
      "INSERT INTO media_chunk_lists (owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?);"
    ).run(m.formats[0]!.id, list.placementId, list.keyMode, list.keyData, list.count, list.sizes, list.starts, T1);
    const seen = read(db, m.id);
    expect(seen?.formats.find((f) => f.id === m.formats[0]!.id)?.chunks).toEqual(packed);
    expect(seen?.formats.find((f) => f.id === m.formats[1]!.id)?.chunks).toEqual(m.formats[1]!.chunks);
  });
});

describe("synthetic 75-title library: convert and translate (LIB-FMT-11/12)", () => {
  const titles: MediaDetails[] = [];
  for (let i = 0; i < 75; i += 1) {
    titles.push(i % 3 === 0 ? show(`t${i}`, T1, i * 10, 2 + (i % 4)) : movie(`t${i}`, T1, i * 10));
  }
  const ops = titles.map((d, i) => upsert(`op-${i}`, d));

  const snapshot = (db: DatabaseSync) => ({
    titles: count(db, "SELECT COUNT(*) AS n FROM media_items;"),
    episodes: count(db, "SELECT COUNT(*) AS n FROM media_episodes;"),
    details: titles.map((d) => ({ id: d.id, ...playbackView(read(db, d.id)) })),
  });

  it("reads the same before and after convertPlaybackToPackedLayout, and the same through translated ops", () => {
    const old = newDb();
    for (const op of ops) apply(old, op);
    const before = snapshot(old);
    const owners =
      count(old, "SELECT COUNT(DISTINCT format_id) AS n FROM media_format_chunks;") +
      count(old, "SELECT COUNT(DISTINCT track_id) AS n FROM media_audio_chunks;");
    const chunkRows =
      count(old, "SELECT COUNT(*) AS n FROM media_format_chunks;") + count(old, "SELECT COUNT(*) AS n FROM media_audio_chunks;");
    log("before", { titles: before.titles, episodes: before.episodes, owners, chunkRows });
    expect(before.titles).toBe(75);
    expect(before.details.map((d) => d.id)).toEqual(titles.map((d) => d.id));

    const stats = convertPlaybackToPackedLayout(old, T2);
    log("convert", stats);
    expect(stats).toEqual({ lists: owners, rows: chunkRows });
    expect(count(old, "SELECT COUNT(*) AS n FROM media_chunk_lists;")).toBe(owners);
    expect(count(old, "SELECT COUNT(*) AS n FROM media_format_chunks;")).toBe(0);
    expect(count(old, "SELECT COUNT(*) AS n FROM media_audio_chunks;")).toBe(0);
    expect(count(old, "SELECT COUNT(*) AS n FROM media_file_playback;")).toBe(0);
    expect(count(old, "SELECT COUNT(*) AS n FROM media_chunk_lists WHERE key_mode = 2;")).toBe(0);
    const converted = snapshot(old);
    expect(converted).toEqual(before);

    // Idempotent: a second run (a received file already converted) changes nothing.
    expect(convertPlaybackToPackedLayout(old, T3)).toEqual({ lists: 0, rows: 0 });
    expect(snapshot(old)).toEqual(before);

    const fresh = newDb();
    for (const op of ops) applyPacked(fresh, op);
    const translated = snapshot(fresh);
    log("translated", { titles: translated.titles, episodes: translated.episodes, lists: count(fresh, "SELECT COUNT(*) AS n FROM media_chunk_lists;") });
    expect(translated).toEqual(before);
    expect(count(fresh, "SELECT COUNT(*) AS n FROM media_format_chunks;")).toBe(0);
  });

  it("rolls back a conversion that fails part way", () => {
    const db = newDb();
    for (const op of ops.slice(0, 5)) apply(db, op);
    const chunkRows = count(db, "SELECT COUNT(*) AS n FROM media_format_chunks;");
    db.prepare(
      "INSERT INTO media_format_chunks (id, format_id, chunk_key, order_index, size_bytes, start_seconds) VALUES ('bad', 't1-fmt-a', 'k', 99, -5, 0);"
    ).run();
    expect(() => convertPlaybackToPackedLayout(db, T2)).toThrow();
    log("rollback", { chunkRows, lists: count(db, "SELECT COUNT(*) AS n FROM media_chunk_lists;") });
    expect(count(db, "SELECT COUNT(*) AS n FROM media_chunk_lists;")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM media_format_chunks;")).toBe(chunkRows + 1);
  });
});
