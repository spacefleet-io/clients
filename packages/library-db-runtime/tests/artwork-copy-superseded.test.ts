/**
 * @test-id STOR-PLACE-11-RUNTIME-001
 * @level integration (real LibraryDb over bun:sqlite; the other device's change arrives as a synced op, /storage/delete is recorded)
 * @req STOR-PLACE-11[runtime,badger-desktop]
 * @req META-ART-01
 * @bugfix @regression-proof
 *
 * Why this exists: the Badger desktop 0.1.52 release smoke (run 47195, job 125347, 2026-11-23) failed its
 * [server-check] with 299 820 bytes left after the app's delete. A second signed-in desktop on the same account
 * copied the new title's poster and backdrop one second after the smoke's own app did. Sync kept one device's row
 * (LIB-SYNC-08); the other copy was referenced by nothing and stayed on the account until the 7-day leftover
 * clean-up. A device now deletes its own copy as soon as a synced change from another device replaces it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyMediaArtwork, type ArtworkKind, type ArtworkUploadOutcome } from "@space/library-db-definition/artworkCopy";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[artwork-copy-superseded]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let root = "";
let originalFetch: typeof globalThis.fetch | null = null;
let deletedKeys: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-artwork-copy-superseded-"));
  process.env.SF_USER_DATA_PATH = root;
  deletedKeys = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (/\/storage\/delete(\?|$)/.test(url)) {
      const body = JSON.parse(input instanceof Request ? await input.clone().text() : String(init?.body ?? "{}")) as { keys?: string[] };
      deletedKeys.push(...(body.keys ?? []));
      return new Response(JSON.stringify({ deleted: body.keys?.length ?? 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 503 });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

type Internals = {
  applyLibraryOps(ops: unknown[]): Promise<void>;
  secondaryOpsInFlight: Promise<void> | null;
};
const internalsOf = (db: LibraryDb) => db as unknown as Internals;

const movie = (id: number) => ({
  id,
  type: "movie" as const,
  title: "Big Buck Bunny",
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2008",
  rating: null,
  posterPath: `/poster-${id}.jpg`,
  backdropPath: `/backdrop-${id}.jpg`,
  genres: [],
  cast: [],
  trailers: [],
  seasons: [],
  episodes: [],
  totalEpisodes: null,
  status: null,
  nextEpisodeAirDate: null,
});

const ownKey = (kind: ArtworkKind, path: string) => `assets/own-${kind}-${path.slice(1, -4)}.txt`;
const otherRef = (kind: string) => `asset:image/jpeg::assets/other-device-${kind}.txt`;
const upload = async (kind: ArtworkKind, path: string): Promise<ArtworkUploadOutcome> => ({
  status: "ok",
  key: `asset:image/jpeg::${ownKey(kind, path)}`,
});

const open = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

/** This device adds the title and copies its poster and backdrop, as META-ART-01 does on every signed-in device. */
const addWithOwnCopy = async (db: LibraryDb) => {
  const mediaId = await db.addMediaFromCatalog(movie(10378));
  const result = await copyMediaArtwork({ store: db, mediaId, upload });
  expect(result).toMatchObject({ copied: 2, applied: 2 });
  deletedKeys = [];
  return mediaId;
};

/** The other device's `media.upsert` for the same title, as sync hands it over. */
const remoteUpsert = (db: LibraryDb, mediaId: string, change: { posterPath: string; backdropPath: string; updatedAt: string }) => {
  const details = structuredClone(db.getMediaDetails(mediaId));
  if (!details) throw new Error("title missing");
  return {
    id: `other-device-${change.updatedAt}`,
    type: "media.upsert",
    createdAt: change.updatedAt,
    payload: { details: { ...details, ...change } },
  };
};

const applyRemote = async (db: LibraryDb, ops: unknown[]) => {
  await internalsOf(db).applyLibraryOps(ops);
  await internalsOf(db).secondaryOpsInFlight;
};

const ownKeys = [ownKey("poster", "/poster-10378.jpg"), ownKey("backdrop", "/backdrop-10378.jpg")].sort();

describe("STOR-PLACE-11 on the shared library runtime", () => {
  it("@req STOR-PLACE-11[runtime,badger-desktop] another device's newer copy replaces ours: ours is deleted at once @bugfix @regression-proof", async () => {
    const db = await open();
    const mediaId = await addWithOwnCopy(db);
    const later = new Date(Date.now() + 60_000).toISOString();
    await applyRemote(db, [remoteUpsert(db, mediaId, { posterPath: otherRef("poster"), backdropPath: otherRef("backdrop"), updatedAt: later })]);
    const details = db.getMediaDetails(mediaId);
    log("phase: other device's copy synced", { poster: details?.posterPath, deletedKeys });
    expect(details?.posterPath).toBe(otherRef("poster"));
    expect([...deletedKeys].sort()).toEqual(ownKeys);
  });

  it("@req STOR-PLACE-11[runtime,badger-desktop] our copy stays when the other device's change is older or still shows it @regression-proof", async () => {
    const db = await open();
    const mediaId = await addWithOwnCopy(db);
    const own = db.getMediaDetails(mediaId)!;

    // The other device lost the race: its older row is ignored (LIB-SYNC-08), our copy is what the library shows.
    const earlier = new Date(Date.parse(own.updatedAt) - 60_000).toISOString();
    await applyRemote(db, [remoteUpsert(db, mediaId, { posterPath: otherRef("poster"), backdropPath: otherRef("backdrop"), updatedAt: earlier })]);
    log("phase: older remote copy ignored", { poster: db.getMediaDetails(mediaId)?.posterPath, deletedKeys });
    expect(db.getMediaDetails(mediaId)?.posterPath).toBe(own.posterPath);

    // A newer change from a device that already took our copy (it edits something else): the pictures stay ours.
    const later = new Date(Date.now() + 60_000).toISOString();
    await applyRemote(db, [remoteUpsert(db, mediaId, { posterPath: own.posterPath!, backdropPath: own.backdropPath!, updatedAt: later })]);
    log("phase: newer remote row holding our copy", { deletedKeys });
    expect(deletedKeys).toEqual([]);
  });
});
