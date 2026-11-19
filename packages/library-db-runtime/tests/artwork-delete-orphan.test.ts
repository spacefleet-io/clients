/**
 * @test-id STOR-PLACE-10-RUNTIME-001
 * @level integration (real LibraryDb over bun:sqlite; the uploader is a fake, /storage/delete is recorded)
 * @req STOR-PLACE-10[runtime,badger-desktop,badger-jellyfin]
 * @req META-ART-01
 * @bugfix @regression-proof
 *
 * Why this exists: the Badger desktop 0.1.16 release smoke (run 38822, 2026-11-19) opened its title (which schedules
 * the artwork copy) and deleted it 0.6 s later. The poster and backdrop uploads committed 0.1 s after the delete; the
 * title was gone, so the copy was skipped and both pictures (299 820 bytes) stayed counted against the account with
 * nothing referencing them, and the smoke's [server-check] (0 bytes 60 s after the delete) failed. A copy the library
 * does not take is now deleted again at once, and the library's own delete (`deleteMedia`, Jellyfin and desktop) lists
 * the title's artwork, keeping a photo another title still shows.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyMediaArtwork, type ArtworkKind, type ArtworkUploadOutcome } from "@space/library-db-definition/artworkCopy";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[artwork-delete-orphan]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let root = "";
let originalFetch: typeof globalThis.fetch | null = null;
let deletedKeys: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-artwork-delete-orphan-"));
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

const movie = (id: number, title: string, cast: Array<{ personId: number; name: string; profilePath: string }>) => ({
  id,
  type: "movie" as const,
  title,
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2008",
  rating: null,
  posterPath: `/poster-${id}.jpg`,
  backdropPath: `/backdrop-${id}.jpg`,
  genres: [],
  cast: cast.map((member, order) => ({ ...member, role: "Role", order })),
  trailers: [],
  seasons: [],
  episodes: [],
  totalEpisodes: null,
  status: null,
  nextEpisodeAirDate: null,
});

const anna = { personId: 801, name: "Anna Shared", profilePath: "/anna.jpg" };
const bob = { personId: 802, name: "Bob Only", profilePath: "/bob.jpg" };

const keyFor = (kind: ArtworkKind, path: string) => `assets/${kind}-${path.slice(1, -4)}.txt`;
const fakeUpload = (onUpload?: () => Promise<void>) => async (kind: ArtworkKind, path: string): Promise<ArtworkUploadOutcome> => {
  await onUpload?.();
  return { status: "ok", key: `asset:image/jpeg::${keyFor(kind, path)}` };
};

const open = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

describe("STOR-PLACE-10 on the shared library runtime", () => {
  it("@req STOR-PLACE-10[runtime,badger-desktop,badger-jellyfin] a copy that lands after its title was deleted is deleted again @bugfix @regression-proof", async () => {
    const db = await open();
    const mediaId = await db.addMediaFromCatalog(movie(10378, "Big Buck Bunny", []));
    let deleting: Promise<unknown> | null = null;
    // The user deletes the title while its pictures upload (the smoke: delete at .64, commits at .755 / .810).
    const upload = fakeUpload(async () => {
      deleting ??= db.deleteMedia(mediaId);
      await deleting;
    });
    const discarded: string[] = [];
    const result = await copyMediaArtwork({
      store: db,
      mediaId,
      upload,
      discard: async (keys) => {
        discarded.push(...keys);
      },
    });
    log("phase: title deleted mid-copy", { result, discarded, title: db.getMediaDetails(mediaId) });
    expect(db.getMediaDetails(mediaId)).toBeFalsy();
    expect(result).toMatchObject({ copied: 2, applied: 0, discarded: 2 });
    expect(discarded.sort()).toEqual([keyFor("poster", "/poster-10378.jpg"), keyFor("backdrop", "/backdrop-10378.jpg")].sort());
  });

  it("@req STOR-PLACE-10[runtime,badger-desktop,badger-jellyfin] deleteMedia removes the title's own artwork and keeps a photo another title shows @bugfix @regression-proof", async () => {
    const db = await open();
    const first = await db.addMediaFromCatalog(movie(9501, "First", [anna, bob]));
    await copyMediaArtwork({ store: db, mediaId: first, upload: fakeUpload() });
    const second = await db.addMediaFromCatalog(movie(9502, "Second", [anna]));
    await copyMediaArtwork({ store: db, mediaId: second, upload: fakeUpload() });
    deletedKeys = [];

    await db.deleteMedia(first);
    log("phase: first title deleted", { deletedKeys });
    expect(deletedKeys).toEqual(
      expect.arrayContaining([keyFor("poster", "/poster-9501.jpg"), keyFor("backdrop", "/backdrop-9501.jpg"), keyFor("profile", "/bob.jpg")])
    );
    expect(deletedKeys, "the second title still shows Anna's photo").not.toContain(keyFor("profile", "/anna.jpg"));
  });
});
