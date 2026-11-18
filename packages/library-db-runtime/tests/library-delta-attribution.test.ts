/**
 * @test-id LIB-DELTA-ATTRIBUTION-001
 * @req LIB-STORE-05
 * @req PERF-MEM-03
 *
 * #671 R3: `LibraryDb` names the media each write touched (`takeChangedMedia`)
 * so the runtime can publish a `library.updated` delta instead of the whole
 * snapshot, and `getSnapshotDelta` builds the matching partial snapshot.
 * The contract that keeps the consumer correct:
 *   - a write that names its media reports exactly those media;
 *   - a write that cannot name its media reports `all: true` (consumer
 *     refetches everything): slower, never wrong;
 *   - media-free writes (settings, playlists, ingest jobs) report nothing;
 *   - `takeChangedMedia` resets;
 *   - `getSnapshotDelta(ids)` is `getSnapshot()` with `mediaDetails` limited to
 *     `ids`: every other list complete.
 *
 * Bun test runner + real better-sqlite3 (library-db-runtime convention).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LibraryMeta } from "../src/api";
import { LibraryDb } from "../src/libraryDb";
import type { LibrarySnapshot } from "@space/shared/libraryTypes";

const SUITE = "library-delta-attribution";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-lib-delta-attr-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[${SUITE}:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[${SUITE}:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const openDb = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

type TitleItem = Parameters<LibraryDb["addMediaFromCatalog"]>[0];

type CastMember = { personId: number; name: string; role: string; profilePath: string | null; order: number };

const addMovie = (db: LibraryDb, id: number, title: string, cast: CastMember[] = []) =>
  db.addMediaFromCatalog({
    id,
    type: "movie",
    title,
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2026",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast,
    trailers: [],
    seasons: [],
    episodes: [],
    totalEpisodes: 0,
    // The minimal movie the other library-db-runtime suites use; the rest of TitleDetails is optional at runtime.
  } as unknown as TitleItem);

/** Drain whatever the setup writes noted, so each test measures only its own write. */
const drain = (db: LibraryDb, label: string) => {
  const taken = db.takeChangedMedia();
  console.info(`[${SUITE}:drain] ${label} -> ${JSON.stringify(taken)}`);
  return taken;
};

describe("LibraryDb change attribution (#671 R3)", () => {
  it("a new media is reported as changed, attributed", async () => {
    const db = await openDb();
    drain(db, "fresh open");
    const mediaId = await addMovie(db, 9701, "Attributed Movie");
    const taken = drain(db, "addMediaFromCatalog");
    expect(taken.mediaIds).toContain(mediaId);
    expect(taken.all).toBe(false);
  });

  it("setProgress reports exactly its media", async () => {
    const db = await openDb();
    const a = await addMovie(db, 9702, "Progress A");
    await addMovie(db, 9703, "Progress B");
    drain(db, "setup");
    await db.setProgress(a, 42);
    const taken = drain(db, "setProgress");
    expect(taken).toEqual({ mediaIds: [a], all: false });
  });

  it("setTrackPrefs reports exactly its media", async () => {
    const db = await openDb();
    const a = await addMovie(db, 9704, "Prefs A");
    drain(db, "setup");
    await db.setTrackPrefs(a, { audioLanguage: "fr" });
    const taken = drain(db, "setTrackPrefs");
    expect(taken).toEqual({ mediaIds: [a], all: false });
  });

  it("playlist membership writes report the media they move; deleting a playlist reports its members", async () => {
    const db = await openDb();
    const a = await addMovie(db, 9705, "Playlist A");
    const b = await addMovie(db, 9706, "Playlist B");
    await db.createPlaylist("Delta list");
    const playlistId = db.listPlaylists().find((p) => p.name === "Delta list")!.id;
    drain(db, "setup");

    await db.addToPlaylist(playlistId, a);
    expect(drain(db, "addToPlaylist")).toEqual({ mediaIds: [a], all: false });

    await db.addToPlaylist(playlistId, b);
    drain(db, "addToPlaylist b");
    await db.removeFromPlaylist(playlistId, a);
    expect(drain(db, "removeFromPlaylist")).toEqual({ mediaIds: [a], all: false });

    await db.deletePlaylist(playlistId);
    const deleted = drain(db, "deletePlaylist");
    expect(deleted.all).toBe(false);
    // Only `b` was still in the playlist: its details lose the playlist id.
    expect(deleted.mediaIds).toEqual([b]);
  });

  it("media-free writes (settings, playlists, ingest jobs) report nothing and are not unattributed", async () => {
    const db = await openDb();
    await addMovie(db, 9707, "Media free");
    drain(db, "setup");
    await db.setSetting("delta-test", "1");
    expect(drain(db, "setSetting")).toEqual({ mediaIds: [], all: false });
    await db.createPlaylist("Another");
    expect(drain(db, "createPlaylist")).toEqual({ mediaIds: [], all: false });
  });

  it("a write that cannot name its media is reported unattributed (consumer refetches all)", async () => {
    const db = await openDb();
    const mediaId = await addMovie(db, 9708, "Unattributed");
    const fileId = await db.linkFileToMedia(mediaId, "unattributed.mkv");
    drain(db, "setup");
    // `setMediaFileTemplate` persists without naming a media.
    await db.setMediaFileTemplate(fileId, null);
    const taken = drain(db, "setMediaFileTemplate");
    expect(taken.all).toBe(true);
  });

  it("takeChangedMedia resets: a second call reports nothing", async () => {
    const db = await openDb();
    const a = await addMovie(db, 9709, "Reset");
    expect(drain(db, "first").mediaIds).toContain(a);
    expect(drain(db, "second")).toEqual({ mediaIds: [], all: false });
  });
});

describe("LibraryDb.getSnapshotDelta (#671 R3)", () => {
  it("returns every list complete but mediaDetails only for the requested media", async () => {
    const db = await openDb();
    const a = await addMovie(db, 9711, "Delta A");
    const b = await addMovie(db, 9712, "Delta B");
    const c = await addMovie(db, 9713, "Delta C");
    await db.setSetting("delta-snapshot", "yes");

    const full = db.getSnapshot();
    const delta = db.getSnapshotDelta([b]);
    console.info(
      `[${SUITE}:delta] full media=${full.media.length} details=${full.mediaDetails?.length} delta media=${delta.media.length} details=${delta.mediaDetails?.length}`
    );

    expect(full.mediaDetails?.map((d) => d.id).sort()).toEqual([a, b, c].sort());
    expect(delta.mediaDetails?.map((d) => d.id)).toEqual([b]);
    // The requested media's details are the same as the full snapshot's.
    expect(delta.mediaDetails?.[0]).toEqual(full.mediaDetails?.find((d) => d.id === b));
    // Everything else is complete.
    expect(delta.media).toEqual(full.media);
    expect(delta.playlists).toEqual(full.playlists);
    expect(delta.playlistItems).toEqual(full.playlistItems);
    expect(delta.ingestJobs).toEqual(full.ingestJobs);
    expect(delta.settings).toEqual(full.settings);
  });

  it("an unknown or empty id list yields no details, never an error", async () => {
    const db = await openDb();
    await addMovie(db, 9714, "Delta D");
    expect(db.getSnapshotDelta(["no-such-media"]).mediaDetails).toEqual([]);
    expect(db.getSnapshotDelta([]).mediaDetails).toEqual([]);
  });
});

describe("delta equals full snapshot (#671 R3 review)", () => {
  type Snapshot = LibrarySnapshot;

  /** The consumer's merge (apps/badger/desktop `mergeSnapshotDelta`): lists replaced, details taken fresh for the changed media. */
  const mergeDelta = (base: Snapshot, delta: Snapshot): Snapshot => {
    const fresh = new Map((delta.mediaDetails ?? []).map((d) => [d.id, d]));
    const cached = new Map((base.mediaDetails ?? []).map((d) => [d.id, d]));
    const mediaDetails = delta.media.map((row) => {
      const details = fresh.get(row.id) ?? cached.get(row.id);
      if (!details) throw new Error(`no details for ${row.id}: the consumer would full-fetch here`);
      return details;
    });
    return { ...base, ...delta, mediaDetails };
  };

  /**
   * Snapshot, run the write, then rebuild the snapshot the way the runtime and
   * the desktop do (delta for the named media, everything when unattributed)
   * and require it to equal the real one. Returns what the write reported.
   */
  const expectDeltaEquivalent = async (db: LibraryDb, label: string, write: () => unknown) => {
    drain(db, `${label}: before`);
    const before = db.getSnapshot();
    await write();
    const taken = drain(db, label);
    const real = db.getSnapshot();
    const rebuilt = taken.all ? real : mergeDelta(before, db.getSnapshotDelta(taken.mediaIds));
    expect(rebuilt).toEqual(real);
    return taken;
  };

  it("every media-scoped writer leaves the merged delta equal to the full snapshot", async () => {
    const db = await openDb();
    const a = await addMovie(db, 9801, "Equiv A");
    const b = await addMovie(db, 9802, "Equiv B");
    await db.createPlaylist("Equiv list");
    const playlistId = db.listPlaylists().find((p) => p.name === "Equiv list")!.id;
    const fileId = await db.linkFileToMedia(a, "equiv.mkv");

    await expectDeltaEquivalent(db, "setProgress", () => db.setProgress(a, 17));
    await expectDeltaEquivalent(db, "setTrackPrefs", () => db.setTrackPrefs(b, { audioLanguage: "de" }));
    await expectDeltaEquivalent(db, "updateMediaMetadata", () =>
      db.updateMediaMetadata({ mediaId: a, media: { title: "Equiv A renamed", overview: "new overview" } })
    );
    await expectDeltaEquivalent(db, "addToPlaylist", () => db.addToPlaylist(playlistId, a));
    await expectDeltaEquivalent(db, "removeFromPlaylist", () => db.removeFromPlaylist(playlistId, a));
    await expectDeltaEquivalent(db, "markMediaPlayable", () => db.markMediaPlayable(a));
    await expectDeltaEquivalent(db, "setMediaFileTemplate", () => db.setMediaFileTemplate(fileId, null));
    await expectDeltaEquivalent(db, "linkFileToMedia", () => db.linkFileToMedia(b, "equiv-b.mkv"));
    await expectDeltaEquivalent(db, "setSetting", () => db.setSetting("equiv", "1"));
    await expectDeltaEquivalent(db, "deleteMedia", () => db.deleteMedia(b));
  });

  it("renaming a person shared by two media reports both, so the other title's cast is not stale", async () => {
    const db = await openDb();
    const person = { personId: 4242, name: "Old Name", role: "Lead", profilePath: null, order: 0 };
    const a = await addMovie(db, 9803, "Shared cast A", [person]);
    const b = await addMovie(db, 9804, "Shared cast B", [person]);

    const taken = await expectDeltaEquivalent(db, "re-add A with a renamed person", () =>
      addMovie(db, 9803, "Shared cast A", [{ ...person, name: "New Name" }])
    );
    expect(taken.all || taken.mediaIds.includes(b)).toBe(true);
    expect(taken.all || taken.mediaIds.includes(a)).toBe(true);
    expect(db.getMediaDetails(b)?.cast.map((member) => member.name)).toEqual(["New Name"]);
  });

  it("a TV-progress setting is not media-free: its show's details change with it", async () => {
    const db = await openDb();
    await addMovie(db, 9805, "Settings host");
    drain(db, "setup");
    await db.setSetting("episode_resume_v1:some-episode", JSON.stringify({ positionSeconds: 5 }));
    expect(drain(db, "episode resume setting").all).toBe(true);
  });

  // @req LIB-STORE-05 — a non-main profile's resume point (`p:<pid>:episode_resume_v1:`) and title progress
  // (`p:<pid>:media_progress_v1:`) move that profile's view of the title, so they are never media-free either.
  it("a non-main profile's progress settings are not media-free", async () => {
    const db = await openDb();
    await addMovie(db, 9806, "Profile settings host");
    drain(db, "setup");
    await db.setSetting("p:kid:episode_resume_v1:some-episode", JSON.stringify({ progressPct: 5, updatedAt: "2026-10-29T00:00:00.000Z" }));
    expect(drain(db, "profile episode resume setting").all).toBe(true);
    await db.setSetting("p:kid:media_progress_v1:some-media", JSON.stringify({ progressPct: 5, lastWatchedAt: null }));
    expect(drain(db, "profile media progress setting").all).toBe(true);
  });

  it("a remote snapshot replaces every row, reported unattributed even with no pending local ops", async () => {
    const db = await openDb();
    await addMovie(db, 9806, "Snapshot host");
    const bytes = db.exportBytes();
    drain(db, "setup");
    const applied = await db.applyPreparedRemoteSync({
      kind: "snapshot",
      meta: { stateHash: null, lastOpId: null } as unknown as LibraryMeta,
      fromVersion: 0,
      snapshotVersion: 3,
      updatedAt: null,
      bytes,
    });
    console.info(`[${SUITE}:remote-snapshot] applied=${String(applied)}`);
    expect(applied).toBe(true);
    expect(drain(db, "remote snapshot").all).toBe(true);
  });
});
