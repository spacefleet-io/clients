/**
 * @test-id MOBILE-LIBRARY-MEDIA-DELETE-CLEANUP-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: a `media.delete` op from another device only ran the core / metadata / playback
 * statements on the phone. The ingest rows (`ingest_jobs`, `ingest_job_events`) of the title stayed in the
 * ingest DB, and its offline downloads (native queue + files on disk) were never removed, so the phone kept
 * pointing at / storing a media that no longer exists. A phone that catches up through a snapshot never sees
 * the `media.delete` op at all (the snapshot compacted it away), so its downloads of deleted titles stayed too.
 *
 * A delete started on this device (phone or TV Delete button, `LibraryDb.deleteMedia`) ran its own hand-written
 * cleanup that also left the ingest rows and the offline downloads; it now runs the remote path's cleanup.
 *
 * Drives the real LibraryDb over real in-memory SQLite dbs (node:sqlite) and a fake native download queue.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type * as SharedApi from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import { LibraryDb } from "../src/lib/libraryDb";
import type { DownloadItem } from "@space/mobile-media-proxy/downloads";
import {
  createSnapshotHandle,
  fx,
  readCacheJson,
  resetFixture,
  seedSplitCache,
  setServer,
  settingOp,
  settle,
  sqliteFile,
  sqliteRows,
} from "./library-db-fixture";

const TAG = "[library-media-delete-cleanup]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const native = vi.hoisted(() => ({
  items: [] as Array<Pick<DownloadItem, "id" | "mediaId">>,
  removed: [] as string[][],
  removeError: null as Error | null,
}));

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("../src/lib/library/opsPage", async (importOriginal) => (await import("./library-db-fixture")).opsPageMock(await importOriginal()));
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => {
  const fixture = await import("./library-db-fixture");
  return {
    ...fixture.transportMock(),
    // The server's current snapshot: its manifest is "{}" once decoded and its db comes from `fx.snapshots`.
    fetchRemoteManifestWithRetry: async () => ({
      remote: {
        exists: true,
        version: fixture.fx.serverVersion,
        snapshotVersion: fixture.fx.serverSnapshotVersion,
        updatedAt: "2026-10-15T00:00:00.000Z",
        manifestKey: "library/manifest",
      },
      manifestBytes: new Uint8Array(),
    }),
  };
});
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).sqliteDbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => {
  const fixture = await import("./library-db-fixture");
  return {
    ...fixture.snapshotMock(),
    decodeStoredManifest: async () => new TextEncoder().encode("{}"),
    decryptFileToDb: async (_key: string, _source: string, target: string) => {
      fixture.fx.files.set(target, "db");
    },
  };
});
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));
vi.mock("@space/mobile-media-proxy/downloads", () => ({
  nativeGetState: async () => ({ items: native.items, networkAllowed: true, wifiOnly: true }),
  nativeRemove: async (ids: string[]) => {
    native.removed.push(ids);
    if (native.removeError) throw native.removeError;
    return true;
  },
}));

const CORE = "library.core.sqlite";
const INGEST = "library.ingest.sqlite";

const deleteOp = (id: string, mediaId: string): LibraryOp => ({
  id,
  type: "media.delete",
  createdAt: "2026-10-15T00:00:00.000Z",
  payload: { mediaId },
});

type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & { secondaryOpsInFlight: Promise<void> | null };

/** Media rows (core) for these titles. */
const seedTitles = (db: DatabaseSync, mediaIds: string[]) => {
  for (const mediaId of mediaIds) {
    db.prepare(
      "INSERT INTO media_items (id, type, title, added_at, updated_at) VALUES (?, 'movie', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');"
    ).run(mediaId, `Movie ${mediaId}`);
  }
};

/** One finished ingest job with one event per title. */
const seedIngest = (db: DatabaseSync, mediaIds: string[]) => {
  for (const mediaId of mediaIds) {
    db.prepare(
      "INSERT INTO ingest_jobs (id, media_id, worker_peer_id, kind, status, created_at, updated_at) VALUES (?, ?, 'peer-1', 'upload', 'completed', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');"
    ).run(`job-${mediaId}`, mediaId);
    db.prepare(
      "INSERT INTO ingest_job_events (id, job_id, level, message, created_at) VALUES (?, ?, 'info', 'done', '2026-10-01T00:00:00.000Z');"
    ).run(`event-${mediaId}`, `job-${mediaId}`);
  }
};

/** The phone's saved split library at version 3, holding these titles. */
const seedPhone = (mediaIds: string[]) => {
  seedSplitCache({ version: 3 });
  seedTitles(sqliteFile(CORE), mediaIds);
  seedIngest(sqliteFile(INGEST), mediaIds);
};

/** A server snapshot holding these titles, handed to the next `openSnapshotDb`. */
const queueSnapshot = (mediaIds: string[]) => {
  const snapshot = createSnapshotHandle();
  seedTitles(snapshot.db, mediaIds);
  seedIngest(snapshot.db, mediaIds);
  fx.snapshots.push(snapshot);
};

const openAndSync = async () => {
  const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
  await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
  await settle(db);
  return db;
};

const syncDelete = async (mediaId: string) => {
  seedPhone(["media-1", "media-2"]);
  setServer({
    version: 4,
    snapshotVersion: 3,
    ops: [{ opId: "op-4", version: 4, op: deleteOp("op-4", mediaId) }],
  });
  return openAndSync();
};

const libraryIds = () => sqliteRows(CORE, "SELECT id FROM media_items ORDER BY id;").map((row) => row.id);

beforeEach(() => {
  resetFixture();
  native.items = [];
  native.removed = [];
  native.removeError = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a remote media.delete removes everything of the media on the phone", () => {
  // @req LIB-OPS-02[badger-mobile,badger-tv]
  it("@bugfix @regression-proof deletes the ingest jobs and job events of the deleted media, and only those", async () => {
    await syncDelete("media-1");
    const jobs = sqliteRows(INGEST, "SELECT id, media_id FROM ingest_jobs ORDER BY id;");
    const events = sqliteRows(INGEST, "SELECT id, job_id FROM ingest_job_events ORDER BY id;");
    log("ingest rows after delete", { jobs, events, library: libraryIds() });
    expect(libraryIds()).toEqual(["media-2"]);
    expect(jobs, "only the other title's ingest job is left").toEqual([{ id: "job-media-2", media_id: "media-2" }]);
    expect(events, "only the other title's job event is left").toEqual([{ id: "event-media-2", job_id: "job-media-2" }]);
  });

  // @req LIB-OPS-02[badger-mobile]
  it("@bugfix @regression-proof removes the offline downloads of the deleted media, and only those", async () => {
    native.items = [
      { id: "file-a", mediaId: "media-1" },
      { id: "file-b", mediaId: "media-1" },
      { id: "file-other", mediaId: "media-2" },
    ];
    await syncDelete("media-1");
    log("native remove calls", native.removed);
    expect(native.removed.flat().sort()).toEqual(["file-a", "file-b"]);
  });

  // @req LIB-OPS-02[badger-mobile]
  it("does not call the native queue when the deleted media has no downloads", async () => {
    native.items = [{ id: "file-other", mediaId: "media-2" }];
    await syncDelete("media-1");
    log("native remove calls", native.removed);
    expect(native.removed).toEqual([]);
  });

  // @req LIB-OPS-02[badger-mobile]
  it("a failing download removal does not stop the sync cursor from advancing", async () => {
    native.items = [{ id: "file-a", mediaId: "media-1" }];
    native.removeError = new Error("native down");
    await syncDelete("media-1");
    log("cache after failed removal", readCacheJson());
    expect(native.removed.length).toBe(1);
    expect(readCacheJson()?.version, "the delete rows are on disk; the cursor moves on").toBe(4);
  });
});

/** The phone at the server's version, then a delete started on this device (phone or TV Delete button). */
const localDelete = async (mediaId: string) => {
  seedPhone(["media-1", "media-2"]);
  setServer({ version: 3, snapshotVersion: 3 });
  const db = await openAndSync();
  log("local delete: before", { library: libraryIds(), native: native.items });
  await db.deleteMedia(mediaId);
  await settle(db);
  return db;
};

describe("a media deleted on this device removes everything of the media, like a remote media.delete", () => {
  // @req LIB-OPS-02[badger-mobile,badger-tv]
  it("@bugfix @regression-proof deletes the ingest jobs and job events of the deleted media, and only those", async () => {
    await localDelete("media-1");
    const jobs = sqliteRows(INGEST, "SELECT id, media_id FROM ingest_jobs ORDER BY id;");
    const events = sqliteRows(INGEST, "SELECT id, job_id FROM ingest_job_events ORDER BY id;");
    log("local delete: ingest rows after", { jobs, events, library: libraryIds() });
    expect(libraryIds()).toEqual(["media-2"]);
    expect(jobs, "only the other title's ingest job is left").toEqual([{ id: "job-media-2", media_id: "media-2" }]);
    expect(events, "only the other title's job event is left").toEqual([{ id: "event-media-2", job_id: "job-media-2" }]);
  });

  // @req LIB-OPS-02[badger-mobile,badger-tv]
  it("@bugfix @regression-proof removes the offline downloads of the deleted media, and only those", async () => {
    native.items = [
      { id: "file-a", mediaId: "media-1" },
      { id: "file-b", mediaId: "media-1" },
      { id: "file-other", mediaId: "media-2" },
    ];
    await localDelete("media-1");
    log("local delete: native remove calls", native.removed);
    expect(native.removed.flat().sort()).toEqual(["file-a", "file-b"]);
  });

  // @req LIB-OPS-02[badger-mobile,badger-tv]
  it("clears every profile's progress, resume points, track choices and playlist entries of the deleted media", async () => {
    seedPhone(["media-1", "media-2"]);
    const metadata = sqliteFile("library.metadata.sqlite");
    for (const [id, mediaId] of [["ep-1", "media-1"], ["ep-9", "media-2"]]) {
      metadata
        .prepare("INSERT INTO media_episodes (id, media_id, season_number, episode_number, title) VALUES (?, ?, 1, 1, 'Pilot');")
        .run(id, mediaId);
    }
    const playlist = (mediaIds: string[]) =>
      JSON.stringify({
        name: "Favorites",
        slug: "favorites",
        isSystem: true,
        items: mediaIds.map((mediaId) => ({ mediaId, addedAt: "2026-10-01T00:00:00.000Z" })),
        createdAt: "",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
    const settings: Array<[string, string]> = [
      ["p:kids:media_progress_v1:media-1", "{\"progressPct\":30}"],
      ["p:kids:track_prefs_v1:media-1", "{\"audioLanguage\":\"fr\"}"],
      ["p:kids:episode_resume_v1:ep-1", "{\"positionSeconds\":60}"],
      ["p:kids:episode_resume_v1:ep-9", "{\"positionSeconds\":90}"],
      ["p:kids:playlist_v1:favorites", playlist(["media-1", "media-2"])],
      ["p:kids:media_progress_v1:media-2", "{\"progressPct\":50}"],
    ];
    const core = sqliteFile(CORE);
    for (const [key, value] of settings) {
      core.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, '2026-10-01T00:00:00.000Z');").run(key, value);
    }
    setServer({ version: 3, snapshotVersion: 3 });
    const db = await openAndSync();
    await db.deleteMedia("media-1");
    await settle(db);

    const after = Object.fromEntries(
      sqliteRows(CORE, "SELECT key, value FROM app_settings WHERE key LIKE 'p:%' ORDER BY key;").map((row) => [row.key, row.value])
    );
    // The pending-ops file is this device's own queue, written by LibraryDb.queueOp.
    const pendingOps: LibraryOp[] = JSON.parse(fx.files.get("/docs/library/pending_ops.json") ?? "[]");
    const queued = pendingOps.flatMap((op) => (op.type === "setting.set" ? [op.payload.key] : [])).sort();
    log("local delete: profile keys after", { after, queued });
    expect(after["p:kids:media_progress_v1:media-1"]).toBe("");
    expect(after["p:kids:track_prefs_v1:media-1"]).toBe("");
    expect(after["p:kids:episode_resume_v1:ep-1"]).toBe("");
    expect(after["p:kids:episode_resume_v1:ep-9"], "another title's resume point stays").toBe("{\"positionSeconds\":90}");
    expect(after["p:kids:media_progress_v1:media-2"], "another title's progress stays").toBe("{\"progressPct\":50}");
    expect(JSON.parse(String(after["p:kids:playlist_v1:favorites"])).items.map((item: { mediaId: string }) => item.mediaId)).toEqual([
      "media-2",
    ]);
    expect(queued, "the other devices get the same blanks as setting.set ops").toEqual([
      "p:kids:episode_resume_v1:ep-1",
      "p:kids:media_progress_v1:media-1",
      "p:kids:playlist_v1:favorites",
      "p:kids:track_prefs_v1:media-1",
    ]);
  });
});

describe("a snapshot that replaces the library removes the downloads of titles it no longer holds", () => {
  // @req LIB-OPS-02[badger-mobile]
  it("@bugfix @regression-proof a phone too far behind for ops catches up through the snapshot and drops the deleted title's downloads", async () => {
    // media-1 was deleted on another device and the server compacted that op into snapshot 5.
    seedPhone(["media-1", "media-2"]);
    native.items = [
      { id: "file-a", mediaId: "media-1" },
      { id: "file-b", mediaId: "media-2" },
    ];
    setServer({ version: 5, snapshotVersion: 5 });
    fx.opsTooOld = true;
    queueSnapshot(["media-2"]);

    await openAndSync();

    log("after snapshot catch-up", { library: libraryIds(), removed: native.removed, cache: readCacheJson() });
    expect(libraryIds(), "the library is the snapshot's").toEqual(["media-2"]);
    expect(sqliteRows(INGEST, "SELECT id FROM ingest_jobs;"), "the ingest rows are the snapshot's").toEqual([
      { id: "job-media-2" },
    ]);
    expect(native.removed, "only the deleted title's download goes").toEqual([["file-a"]]);
  });

  // @req LIB-OPS-02[badger-mobile]
  it("a first open from the server's current snapshot drops the downloads of titles it no longer holds", async () => {
    // No saved library (cleared cache), but the native download queue survived.
    native.items = [
      { id: "file-a", mediaId: "media-1" },
      { id: "file-b", mediaId: "media-2" },
    ];
    setServer({ version: 5, snapshotVersion: 5 });
    queueSnapshot(["media-2"]);

    await openAndSync();

    log("after first open", { library: libraryIds(), removed: native.removed });
    expect(libraryIds()).toEqual(["media-2"]);
    expect(native.removed).toEqual([["file-a"]]);
  });

  // @req LIB-OPS-02[badger-mobile]
  it("keeps every download while the snapshot is older than the library, and prunes once the library is current", async () => {
    // A snapshot behind both what the phone had (3) and the server (6) may lack titles the phone downloaded.
    seedPhone(["media-1", "media-2"]);
    native.items = [
      { id: "file-a", mediaId: "media-1" },
      { id: "file-b", mediaId: "media-2" },
    ];
    setServer({ version: 6, snapshotVersion: 2 });
    fx.opsTooOld = true;
    queueSnapshot(["media-2"]);

    const db = await openAndSync();
    log("after stale snapshot", { library: libraryIds(), removed: native.removed });
    expect(libraryIds()).toEqual(["media-2"]);
    expect(native.removed, "nothing is removed from a library that may be incomplete").toEqual([]);

    fx.opsTooOld = false;
    fx.serverOps = [{ opId: "op-6", version: 6, op: settingOp("op-6", "theme", "dark") }];
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    await settle(db);

    log("after catching up", { library: libraryIds(), removed: native.removed, cache: readCacheJson() });
    expect(native.removed, "the library is current: titles missing from it are gone").toEqual([["file-a"]]);
  });
});
