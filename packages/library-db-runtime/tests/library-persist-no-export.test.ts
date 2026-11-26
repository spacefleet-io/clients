/**
 * @test-id LIB-PERSIST-NO-EXPORT-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 *
 * The per-group SQLite files are the canonical local store and every write
 * lands in them synchronously. A persist, a progress save, `close()` and
 * `flushPending()` must therefore not rebuild the combined single-file image
 * (ATTACH every group, copy every table): that made the cost of one change
 * proportional to the library. The image is built on demand only, by
 * `getLocalCacheBytes` (onboarding "recover from local") and `exportBytes`.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";
import { getCacheDbPath, loadCache } from "../src/libraryDbStorage";

const log = (phase: string, data?: unknown) =>
  console.info(`[LIB-PERSIST-NO-EXPORT-001] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-persist-no-export-"));
  process.env.SF_USER_DATA_PATH = root;
  log("setup", { root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

type Internals = { buildCombinedExportBytes(): Uint8Array };

/** Counts whole-library exports (the expensive step) on one instance. */
const countExports = (db: LibraryDb) => {
  const internals = db as unknown as Internals;
  const original = internals.buildCombinedExportBytes.bind(db);
  const counter = { builds: 0 };
  internals.buildCombinedExportBytes = () => {
    counter.builds += 1;
    return original();
  };
  return counter;
};

const seedMovie = (db: LibraryDb) =>
  db.addMediaFromCatalog({
    id: 25_301,
    type: "movie",
    title: "Persist No Export Movie",
    originalTitle: null,
    originalLanguage: "en",
    overview: "overview",
    year: "2026",
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    totalEpisodes: null,
    seasons: [],
    episodes: [],
  });

const waitFor = async (label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    // Polls the awaited condition; the persist runs on LibraryDb's real idle scheduler.
    await Bun.sleep(10);
  }
  log(`waitFor:ok ${label}`, { ms: Date.now() - started });
};

describe("LIB-STORE-05: a change never rebuilds the combined library image", () => {
  // @req LIB-STORE-05[badger-desktop]
  // @req LIB-STORE-05[runtime]
  it("persists, progress saves, flushPending and close build zero combined exports and write no library.sqlite", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await seedMovie(db);
    const counter = countExports(db);

    log("phase:60 progress saves + 1 setting");
    for (let index = 0; index < 60; index += 1) {
      await db.setProgress(mediaId, 10 + index * 0.5);
    }
    await db.setSetting("persist.no.export", "1");
    const expectedVersion = (await loadCache())?.version ?? -1;
    await waitFor("persist stamped the cache", async () => ((await loadCache())?.version ?? -1) >= 61);
    log("state:after-writes", { exports: counter.builds, cacheVersion: (await loadCache())?.version, expectedVersion, legacyFile: existsSync(getCacheDbPath()) });
    expect(counter.builds).toBe(0);
    expect(existsSync(getCacheDbPath())).toBe(false);
    expect(db.getMediaDetails(mediaId)?.progressPct).toBe(39.5);

    db.close();
    log("state:after-close", { exports: counter.builds, legacyFile: existsSync(getCacheDbPath()) });
    expect(counter.builds).toBe(0);
    expect(existsSync(getCacheDbPath())).toBe(false);
  }, 30_000);

  // @req LIB-STORE-05[badger-desktop]
  // @req LIB-STORE-05[runtime]
  it("getLocalCacheBytes assembles the single-file image on demand from the group files, with the latest progress", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await seedMovie(db);
    await db.setProgress(mediaId, 42);
    await waitFor("persist stamped the cache", async () => (await loadCache()) !== null);
    expect(existsSync(getCacheDbPath())).toBe(false);

    const bytes = await LibraryDb.getLocalCacheBytes();
    log("state:on-demand-image", { bytes: bytes?.byteLength ?? null });
    expect(bytes).not.toBeNull();
    const imagePath = join(root, "on-demand-image.sqlite");
    writeFileSync(imagePath, bytes as Uint8Array);
    const image = new Database(imagePath, { readonly: true });
    try {
      const row = image.prepare("SELECT progress_pct AS pct, title FROM media_items WHERE id = ?;").get(mediaId) as
        | { pct: number; title: string }
        | null;
      log("state:on-demand-row", row);
      expect(row?.pct).toBe(42);
      expect(row?.title).toBe("Persist No Export Movie");
    } finally {
      image.close();
      db.close();
    }
  }, 30_000);
});
