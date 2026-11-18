/**
 * @test-id META-ART-COPY-PERSON-SHARE-001
 * @level integration (real LibraryDb over bun:sqlite, no server; the uploader is a fake)
 * @req META-ART-01
 *
 * Why this exists: a person is one row shared by every title they play in, but importing a second title put the
 * provider path back over the person's copied photo, so the copy fetched and stored the same photo again for every
 * title (one image lookup per title instead of one per person). A person's photo is now copied once and every
 * title shows that one copy; a user edit still wins (compare-and-set), and deleting one title keeps a photo another
 * title still shows.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyMediaArtwork, type ArtworkKind, type ArtworkUploadOutcome } from "@space/library-db-definition/artworkCopy";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[artwork-person-share]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let root = "";
let originalFetch: typeof globalThis.fetch | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-artwork-person-share-"));
  process.env.SF_USER_DATA_PATH = root;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof globalThis.fetch;
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
  year: "2025",
  rating: null,
  posterPath: `/poster-${id}.jpg`,
  backdropPath: null,
  genres: [],
  cast: cast.map((member, order) => ({ ...member, role: "Role", order })),
  trailers: [],
  seasons: [],
  episodes: [],
  totalEpisodes: null,
  status: null,
  nextEpisodeAirDate: null,
});

const anna = { personId: 701, name: "Anna Shared", profilePath: "/anna.jpg" };
const bob = { personId: 702, name: "Bob Only", profilePath: "/bob.jpg" };

const fakeUpload = (calls: Array<[ArtworkKind, string]>) =>
  async (kind: ArtworkKind, path: string): Promise<ArtworkUploadOutcome> => {
    calls.push([kind, path]);
    return { status: "ok", key: `asset:image/jpeg::assets/${kind}-${path.slice(1, -4)}.txt` };
  };

const castOf = (db: LibraryDb, mediaId: string) =>
  Object.fromEntries(db.getMediaDetails(mediaId)!.cast.map((member) => [member.name, member.profilePath]));

const open = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

describe("a person's photo is copied once and shared by every title (META-ART-01)", () => {
  it("@req META-ART-01[badger-desktop] a second title with the same actor reuses the copy and fetches nothing for them", async () => {
    const db = await open();
    const first = await db.addMediaFromCatalog(movie(9101, "First", [anna, bob]));
    const calls: Array<[ArtworkKind, string]> = [];
    await copyMediaArtwork({ store: db, mediaId: first, upload: fakeUpload(calls) });
    log("phase: first title copied", { calls, cast: castOf(db, first) });
    expect(castOf(db, first)["Anna Shared"]).toBe("asset:image/jpeg::assets/profile-anna.txt");

    const second = await db.addMediaFromCatalog(movie(9102, "Second", [anna]));
    const slots = db.listArtworkToCopy(second);
    log("phase: second title imported", { slots, cast: castOf(db, second), firstCast: castOf(db, first) });
    expect(slots.filter((slot) => slot.target === "personProfile"), "the shared actor needs no new copy").toEqual([]);
    expect(castOf(db, second)["Anna Shared"]).toBe("asset:image/jpeg::assets/profile-anna.txt");
    expect(castOf(db, first)["Anna Shared"], "the first title keeps showing the copy").toBe(
      "asset:image/jpeg::assets/profile-anna.txt"
    );

    await copyMediaArtwork({ store: db, mediaId: second, upload: fakeUpload(calls) });
    log("phase: second title copied", { calls });
    expect(calls.filter(([, path]) => path === "/anna.jpg"), "the actor's photo is fetched once in total").toHaveLength(1);
  });

  it("@req META-ART-01[badger-desktop] a user's own photo for a person survives importing another title with them", async () => {
    const db = await open();
    const first = await db.addMediaFromCatalog(movie(9201, "First", [anna]));
    const personId = db.getMediaDetails(first)!.cast[0]!.personId;
    await db.updateMediaMetadata({
      mediaId: first,
      cast: [{ personId, name: anna.name, role: "Role", profilePath: "asset:image/png::assets/user-anna.txt" }],
    });
    log("phase: user set a photo", castOf(db, first));

    const second = await db.addMediaFromCatalog(movie(9202, "Second", [anna]));
    log("phase: second title imported", { first: castOf(db, first), second: castOf(db, second) });
    expect(castOf(db, second)["Anna Shared"]).toBe("asset:image/png::assets/user-anna.txt");
    expect(db.listArtworkToCopy(second).filter((slot) => slot.target === "personProfile")).toEqual([]);
  });

  it("@req META-ART-01[badger-desktop] a provider path still replaces an older provider path (no copy yet)", async () => {
    const db = await open();
    await db.addMediaFromCatalog(movie(9301, "First", [anna]));
    const second = await db.addMediaFromCatalog(movie(9302, "Second", [{ ...anna, profilePath: "/anna-new.jpg" }]));
    log("phase: second title imported", castOf(db, second));
    expect(castOf(db, second)["Anna Shared"]).toBe("/anna-new.jpg");
  });

  it("@req META-ART-01[badger-desktop] deleting one title keeps a shared photo and frees a photo nobody else shows", async () => {
    const db = await open();
    const first = await db.addMediaFromCatalog(movie(9401, "First", [anna, bob]));
    await copyMediaArtwork({ store: db, mediaId: first, upload: fakeUpload([]) });
    const second = await db.addMediaFromCatalog(movie(9402, "Second", [anna]));
    await copyMediaArtwork({ store: db, mediaId: second, upload: fakeUpload([]) });
    expect(castOf(db, first)["Anna Shared"], "both titles show the one copy").toBe("asset:image/jpeg::assets/profile-anna.txt");

    const keys = db.getMediaObjectKeys(first);
    log("phase: keys freed with the first title", keys);
    expect(keys).toContain("asset:image/jpeg::assets/profile-bob.txt");
    expect(keys, "the second title still shows this photo").not.toContain("asset:image/jpeg::assets/profile-anna.txt");
    expect(db.getMediaObjectKeys(second)).not.toContain("asset:image/jpeg::assets/profile-anna.txt");
  });
});
