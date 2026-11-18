/**
 * @test-id META-ART-COPY-001
 * @level integration (real LibraryDb over bun:sqlite, no server; the uploader is a fake)
 * @req META-ART-01
 *
 * Why this exists: a matched title kept TMDB image paths for its poster, backdrop, cast, season posters and
 * episode stills, so every client fetched TMDB again (or nothing, offline) instead of the user's own encrypted copy
 * (#470). The shared copy lists every slot still holding a TMDB path, uploads each through the client's uploader and
 * writes the asset key back, compare-and-set, so a user edit made meanwhile wins. A missing image becomes null, a
 * failure keeps the path for the next run, and an empty ticket reserve (or the client's floor) stops the run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyMediaArtwork, createArtworkCopyQueue, type ArtworkKind, type ArtworkUploadOutcome } from "@space/library-db-definition/artworkCopy";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[artwork-copy]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let root = "";
let originalFetch: typeof globalThis.fetch | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-artwork-copy-"));
  process.env.SF_USER_DATA_PATH = root;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const show = () => ({
  id: 8101,
  type: "tv" as const,
  title: "Art Show",
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2025",
  rating: null,
  posterPath: "/poster.jpg",
  backdropPath: "/backdrop.jpg",
  genres: [],
  cast: [
    { tmdbId: 501, name: "Anna Actor", role: "Lead", profilePath: "/anna.jpg", order: 0 },
    { tmdbId: 502, name: "Bob Actor", role: "Support", profilePath: "/bob.jpg", order: 1 },
  ],
  trailers: [],
  seasons: [{ seasonNumber: 1, name: "Season 1", overview: null, posterPath: "/s1.jpg", episodeCount: 2, airDate: null }],
  episodes: [
    { seasonNumber: 1, episodeNumber: 1, name: "One", overview: null, stillPath: "/e1.jpg", airDate: null },
    { seasonNumber: 1, episodeNumber: 2, name: "Two", overview: null, stillPath: "/e2.jpg", airDate: null },
  ],
  totalEpisodes: 2,
  status: null,
  nextEpisodeAirDate: null,
});

const artworkOf = (db: LibraryDb, mediaId: string) => {
  const details = db.getMediaDetails(mediaId)!;
  return {
    poster: details.posterPath,
    backdrop: details.backdropPath,
    cast: details.cast.map((member) => member.profilePath),
    seasons: details.seasons.map((season) => season.posterPath),
    stills: details.episodes.map((episode) => episode.stillPath),
  };
};

const fakeUpload = (calls: Array<[ArtworkKind, string]>, override?: (path: string) => ArtworkUploadOutcome | null) =>
  async (kind: ArtworkKind, path: string): Promise<ArtworkUploadOutcome> => {
    calls.push([kind, path]);
    const forced = override?.(path);
    if (forced) return forced;
    return { status: "ok", key: `asset:image/jpeg::assets/${kind}-${path.slice(1, -4)}.txt` };
  };

const open = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

describe("copying matched artwork into the user's storage (META-ART-01)", () => {
  it("@req META-ART-01[badger-desktop] a match ends with asset keys for poster, backdrop, cast, season posters and stills", async () => {
    const db = await open();
    const mediaId = await db.addMediaFromTmdb(show());
    log("phase: matched", artworkOf(db, mediaId));
    const slots = db.listArtworkToCopy(mediaId);
    log("phase: slots", slots);
    expect(new Set(slots.map((slot) => slot.target))).toEqual(
      new Set(["mediaPoster", "mediaBackdrop", "seasonPoster", "personProfile", "episodeStill"])
    );
    expect(slots).toHaveLength(7);

    const calls: Array<[ArtworkKind, string]> = [];
    const result = await copyMediaArtwork({ store: db, mediaId, upload: fakeUpload(calls) });
    log("phase: copied", { result, calls });
    expect(result).toMatchObject({ total: 7, copied: 7, failed: 0, missing: 0, applied: 7, stoppedForTickets: false });
    const expectedKinds: ArtworkKind[] = ["backdrop", "poster", "poster", "profile", "profile", "still", "still"];
    expect(calls.map(([kind]) => kind).sort()).toEqual(expectedKinds.sort());

    const art = artworkOf(db, mediaId);
    log("phase: after", art);
    expect(art.poster).toBe("asset:image/jpeg::assets/poster-poster.txt");
    expect(art.backdrop).toBe("asset:image/jpeg::assets/backdrop-backdrop.txt");
    expect(art.cast.sort()).toEqual(["asset:image/jpeg::assets/profile-anna.txt", "asset:image/jpeg::assets/profile-bob.txt"]);
    expect(art.seasons).toEqual(["asset:image/jpeg::assets/poster-s1.txt"]);
    expect(art.stills).toEqual(["asset:image/jpeg::assets/still-e1.txt", "asset:image/jpeg::assets/still-e2.txt"]);
    expect(db.listArtworkToCopy(mediaId), "nothing left to copy").toEqual([]);
  });

  it("@req META-ART-01[badger-desktop] a user edit made during the copy wins (compare-and-set)", async () => {
    const db = await open();
    const mediaId = await db.addMediaFromTmdb(show());
    const result = await copyMediaArtwork({
      store: db,
      mediaId,
      upload: async (kind, path) => {
        if (path === "/poster.jpg") {
          await db.updateMediaMetadata({ mediaId, media: { posterPath: "asset:image/png::assets/user.txt" } });
        }
        return { status: "ok", key: `asset:image/jpeg::assets/${kind}${path.replace(/\W/g, "")}.txt` };
      },
    });
    log("phase: raced", result);
    expect(artworkOf(db, mediaId).poster).toBe("asset:image/png::assets/user.txt");
    expect(result.applied).toBe(6);
  });

  it("@req META-ART-01[badger-desktop] a missing image becomes null, a failure keeps its TMDB path for the next run", async () => {
    const db = await open();
    const mediaId = await db.addMediaFromTmdb(show());
    const calls: Array<[ArtworkKind, string]> = [];
    const result = await copyMediaArtwork({
      store: db,
      mediaId,
      upload: fakeUpload(calls, (path) =>
        path === "/backdrop.jpg" ? { status: "missing" } : path === "/e2.jpg" ? { status: "unavailable" } : null
      ),
    });
    const art = artworkOf(db, mediaId);
    log("phase: partial", { result, art });
    expect(result).toMatchObject({ copied: 5, missing: 1, failed: 1 });
    expect(art.backdrop).toBeNull();
    expect(art.stills[1]).toBe("/e2.jpg");
    expect(db.listArtworkToCopy(mediaId).map((slot) => slot.path), "only the failure is retried").toEqual(["/e2.jpg"]);

    const retry = await copyMediaArtwork({ store: db, mediaId, upload: fakeUpload([]) });
    log("phase: retried", retry);
    expect(artworkOf(db, mediaId).stills[1]).toBe("asset:image/jpeg::assets/still-e2.txt");
  });

  it("@req META-ART-01[badger-desktop] no ticket (or the client's floor) stops the run without touching the rest", async () => {
    const db = await open();
    const mediaId = await db.addMediaFromTmdb(show());
    const calls: Array<[ArtworkKind, string]> = [];
    const noTicket = await copyMediaArtwork({
      store: db,
      mediaId,
      concurrency: 1,
      upload: fakeUpload(calls, (path) => (path === "/backdrop.jpg" ? { status: "no_ticket" } : null)),
    });
    log("phase: no ticket", { noTicket, calls });
    expect(noTicket.stoppedForTickets).toBe(true);
    expect(calls).toHaveLength(2);
    expect(artworkOf(db, mediaId).poster).toBe("asset:image/jpeg::assets/poster-poster.txt");
    expect(artworkOf(db, mediaId).backdrop).toBe("/backdrop.jpg");

    const floorCalls: Array<[ArtworkKind, string]> = [];
    const floor = await copyMediaArtwork({ store: db, mediaId, upload: fakeUpload(floorCalls), canSpend: () => false });
    log("phase: floor", floor);
    expect(floor.stoppedForTickets).toBe(true);
    expect(floorCalls).toEqual([]);
  });

  it("the queue runs one title at a time, drops a duplicate still waiting, reruns one scheduled mid-run and survives errors", async () => {
    const ran: string[] = [];
    const errors: string[] = [];
    const queue = createArtworkCopyQueue({
      run: async (mediaId) => {
        ran.push(mediaId);
        if (mediaId === "bad") throw new Error("boom");
      },
      onError: (mediaId) => errors.push(mediaId),
    });
    queue.schedule("a"); // starts at once
    queue.schedule("bad");
    queue.schedule("b");
    queue.schedule("b"); // still waiting: dropped
    queue.schedule("a"); // "a" is running: a rerun picks up paths written meanwhile
    await queue.idle();
    log("phase: queue", { ran, errors });
    expect(ran).toEqual(["a", "bad", "b", "a"]);
    expect(errors).toEqual(["bad"]);
  });

  it("@req META-ART-01[badger-desktop] the migration lists every title still holding a provider path in any slot, and no other", async () => {
    const db = await open();
    const copied = await db.addMediaFromTmdb(show());
    const untouched = await db.addMediaFromTmdb({ ...show(), id: 8102, title: "Second Show" });
    const oneStillLeft = await db.addMediaFromTmdb({ ...show(), id: 8103, title: "Third Show" });
    log("phase: before", { listed: db.listMediaWithArtworkToCopy() });
    expect(new Set(db.listMediaWithArtworkToCopy())).toEqual(new Set([copied, untouched, oneStillLeft]));

    await copyMediaArtwork({ store: db, mediaId: copied, upload: fakeUpload([]) });
    await copyMediaArtwork({
      store: db,
      mediaId: oneStillLeft,
      upload: fakeUpload([], (path) => (path === "/e2.jpg" ? { status: "unavailable" } : null)),
    });
    const listed = db.listMediaWithArtworkToCopy();
    log("phase: after", { listed, copied, untouched, oneStillLeft });
    expect(new Set(listed)).toEqual(new Set([untouched, oneStillLeft]));
  });
});
