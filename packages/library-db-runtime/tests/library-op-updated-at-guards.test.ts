/**
 * @test-id LIB-OP-UPDATED-AT-GUARDS-001
 * @level integration (real bun:sqlite, core group DDL, real op statements)
 *
 * @req LIB-SYNC-08[runtime]
 * @req LIB-SYNC-08[badger-desktop]
 *
 * An older change never overwrites a newer one: the SQL every client runs for
 * media.upsert / media.progress / setting.set is guarded by the row's own
 * timestamp, and re-saving a media's details never carries viewing progress.
 * Before: `INSERT OR REPLACE media_items` wrote the author's frozen
 * progress_pct / last_watched_at over a progress op another device sent in
 * the meantime, and progress / setting ops were unconditional.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildOpStatements, ensureLibrarySchema, type SqliteDb } from "@space/library-db-definition";
import type { MediaDetails } from "@space/shared";
import type { LibraryOp } from "@space/shared/libraryOps";

const log = (phase: string, data?: unknown) =>
  console.info(`[library-op-updated-at-guards] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const T1 = "2026-01-01T10:00:00.000Z";
const T2 = "2026-01-01T11:00:00.000Z";
const T3 = "2026-01-01T12:00:00.000Z";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  ensureLibrarySchema(db as unknown as SqliteDb, "core");
  log("setup: in-memory core db ready");
});

afterEach(() => db.close());

const details = (overrides: Partial<MediaDetails> = {}): MediaDetails =>
  ({
    id: "media-1",
    type: "movie",
    catalogId: 42,
    title: "Title",
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2020",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [28],
    addedAt: T1,
    updatedAt: T1,
    hasFiles: false,
    progressPct: 0,
    lastWatchedAt: null,
    totalEpisodes: null,
    episodeCount: 0,
    cast: [],
    playlistIds: [],
    seasons: [],
    episodes: [],
    trailers: [],
    files: [],
    formats: [],
    audioTracks: [],
    subtitleTracks: [],
    subtitles: [],
    chapters: [],
    skipMarkers: [],
    hasLocalFiles: false,
    ...overrides,
  }) as MediaDetails;

let idCounter = 0;
const apply = (op: unknown) => {
  const out = buildOpStatements(op as LibraryOp, () => `gen-${++idCounter}`);
  for (const statement of out.core ?? []) {
    db.prepare(statement.sql).run(...(statement.params as never[]));
  }
};

const upsert = (d: MediaDetails) => apply({ id: `up-${d.updatedAt}-${d.title}`, type: "media.upsert", createdAt: d.updatedAt, payload: { details: d } });
const progress = (progressPct: number, updatedAt: string, lastWatchedAt: string | null = updatedAt) =>
  apply({ id: `pr-${updatedAt}`, type: "media.progress", createdAt: updatedAt, payload: { mediaId: "media-1", progressPct, lastWatchedAt, updatedAt } });
const setting = (key: string, value: string, updatedAt: string) =>
  apply({ id: `st-${updatedAt}`, type: "setting.set", createdAt: updatedAt, payload: { key, value, updatedAt } });

const row = () =>
  db.prepare("SELECT title, updated_at, progress_pct, last_watched_at, has_files, preferred_audio_language FROM media_items WHERE id = 'media-1'").get() as Record<string, unknown> | null;
const settingRow = (key: string) =>
  db.prepare("SELECT value, updated_at FROM app_settings WHERE key = ?").get(key) as Record<string, unknown> | null;
const dump = (label: string, extra?: unknown) => log(label, { row: row(), extra });

describe("media.upsert never carries progress and never goes back in time", () => {
  it("a stale upsert arriving after newer progress does not roll progress back", () => {
    upsert(details({ updatedAt: T1 }));
    progress(50, T3);
    dump("after progress@T3");
    // Frozen details of an offline device: old progress, older timestamp.
    upsert(details({ updatedAt: T2, title: "Stale title", progressPct: 10, lastWatchedAt: T1 }));
    dump("after stale upsert@T2");
    expect(row()?.progress_pct).toBe(50);
    expect(row()?.last_watched_at).toBe(T3);
  });

  it("a newer upsert updates the details but leaves progress untouched", () => {
    upsert(details({ updatedAt: T1 }));
    progress(50, T2);
    upsert(details({ updatedAt: T3, title: "Renamed", hasFiles: true, progressPct: 0, lastWatchedAt: null }));
    dump("after newer upsert@T3");
    expect(row()?.title).toBe("Renamed");
    expect(row()?.has_files).toBe(1);
    expect(row()?.progress_pct).toBe(50);
    expect(row()?.last_watched_at).toBe(T2);
  });

  it("an upsert older than the stored details is ignored", () => {
    upsert(details({ updatedAt: T3, title: "Newest" }));
    upsert(details({ updatedAt: T2, title: "Older" }));
    dump("after older upsert");
    expect(row()?.title).toBe("Newest");
    expect(row()?.updated_at).toBe(T3);
  });

  it("an upsert for a media the device does not hold yet inserts it, with the progress it carries", () => {
    upsert(details({ progressPct: 30, lastWatchedAt: T1 }));
    dump("after first upsert");
    expect(row()?.title).toBe("Title");
    expect(row()?.progress_pct).toBe(30);
  });

  it("an upsert keeps device-local columns of the row (preferred audio language)", () => {
    upsert(details({ updatedAt: T1 }));
    db.prepare("UPDATE media_items SET preferred_audio_language = 'fr' WHERE id = 'media-1'").run();
    upsert(details({ updatedAt: T2, title: "Retitled" }));
    dump("after retitle");
    expect(row()?.title).toBe("Retitled");
    expect(row()?.preferred_audio_language).toBe("fr");
  });
});

describe("media.progress guard", () => {
  it("ignores progress older than the progress the device holds, applies newer and equal", () => {
    upsert(details());
    progress(40, T2);
    progress(10, T1);
    dump("after older progress@T1");
    expect(row()?.progress_pct).toBe(40);
    progress(60, T3);
    expect(row()?.progress_pct).toBe(60);
    progress(70, T3);
    expect(row()?.progress_pct).toBe(70);
    dump("after newer + equal progress");
  });

  it("is not blocked by a later edit of the media's details", () => {
    upsert(details({ updatedAt: T3, title: "Edited at T3" }));
    progress(25, T2);
    dump("after progress@T2 following details@T3");
    expect(row()?.progress_pct).toBe(25);
    expect(row()?.title).toBe("Edited at T3");
  });

  it("applies to a row that has no progress yet", () => {
    upsert(details());
    progress(15, T1);
    expect(row()?.progress_pct).toBe(15);
  });
});

describe("setting.set guard", () => {
  it("ignores an older value, applies a newer and an equal one", () => {
    setting("episode_resume_v1:e1", "v2", T2);
    setting("episode_resume_v1:e1", "v1", T1);
    dump("after older setting", settingRow("episode_resume_v1:e1"));
    expect(settingRow("episode_resume_v1:e1")).toEqual({ value: "v2", updated_at: T2 });
    setting("episode_resume_v1:e1", "v3", T3);
    expect(settingRow("episode_resume_v1:e1")).toEqual({ value: "v3", updated_at: T3 });
    setting("episode_resume_v1:e1", "v3b", T3);
    expect(settingRow("episode_resume_v1:e1")).toEqual({ value: "v3b", updated_at: T3 });
  });

  it("inserts a key the device has not seen", () => {
    setting("some_key", "x", T1);
    expect(settingRow("some_key")).toEqual({ value: "x", updated_at: T1 });
  });
});
