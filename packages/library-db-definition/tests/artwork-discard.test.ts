/**
 * @test-id STOR-PLACE-10-001
 * @level unit (pure shared copy and delete-key helpers, no database, no network)
 * @req STOR-PLACE-10[runtime,badger-desktop,badger-web-player,badger-jellyfin]
 * @req META-ART-01
 * @bugfix @regression-proof
 *
 * Why this exists: the Badger desktop 0.1.16 release smoke (run 38822, 2026-11-19) deleted its title while the
 * background artwork copy (META-ART-01) was uploading the poster and backdrop. The two uploads committed 0.1 s after
 * the delete, the library no longer held the title so the copy was skipped, and 299 820 bytes stayed counted against
 * the account with nothing referencing them ([server-check] expects 0 after a delete). A copy the library does not
 * take is now deleted again at once, and a title delete lists the title's own artwork, keeping a photo another title
 * still shows.
 */
import { describe, expect, it } from "vitest";
import {
  copyMediaArtwork,
  createDetailsArtworkStore,
  type ArtworkCopy,
  type ArtworkCopyStore,
  type ArtworkDetails,
  type ArtworkSlot,
} from "../src/artworkCopy";
import { collectMediaDeleteKeys } from "../src/mediaDetails";

const log = (phase: string, data?: unknown) =>
  console.info(`[artwork-discard] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const slots: ArtworkSlot[] = [
  { target: "mediaPoster", id: "m1", path: "/poster.jpg" },
  { target: "mediaBackdrop", id: "m1", path: "/backdrop.jpg" },
];

const uploader = () => {
  let n = 0;
  return async () => ({ status: "ok" as const, key: `asset:image/jpeg::assets/u${++n}.txt` });
};

describe("STOR-PLACE-10: an artwork copy the library does not take is deleted again", () => {
  it("deletes both uploads when the title was deleted while they were uploading @bugfix @regression-proof", async () => {
    // The title is gone by the time the uploads land (the smoke's delete at 11:15:41.64, commits at .755/.810).
    const store: ArtworkCopyStore = {
      listArtworkToCopy: () => slots,
      applyArtworkCopies: (_mediaId, copies) => ({ applied: 0, skipped: copies.length, unapplied: copies }),
    };
    const discarded: string[][] = [];
    const result = await copyMediaArtwork({
      store,
      mediaId: "m1",
      upload: uploader(),
      discard: async (keys) => {
        discarded.push(keys);
      },
    });
    log("title gone", { result, discarded });
    expect(result).toMatchObject({ copied: 2, applied: 0, discarded: 2 });
    expect(discarded.flat().sort()).toEqual(["assets/u1.txt", "assets/u2.txt"]);
  });

  it("deletes only the copy whose slot an edit changed meanwhile, never a copy the library took", async () => {
    let details: ArtworkDetails = { id: "m1", posterPath: "/poster.jpg", backdropPath: "/backdrop.jpg" };
    const store = createDetailsArtworkStore({
      read: () => details,
      write: (_id, next) => {
        details = next;
      },
    });
    let uploads = 0;
    const discarded: string[] = [];
    const result = await copyMediaArtwork({
      store,
      mediaId: "m1",
      concurrency: 1,
      upload: async (_kind, path) => {
        uploads += 1;
        // The user picks another backdrop while the backdrop is uploading: the user's choice wins.
        if (path === "/backdrop.jpg") details = { ...details, backdropPath: "asset:image/jpeg::assets/user.txt" };
        return { status: "ok", key: `asset:image/jpeg::assets/u${uploads}.txt` };
      },
      discard: async (keys) => {
        discarded.push(...keys);
      },
    });
    log("edited meanwhile", { result, discarded, details });
    expect(details.posterPath).toBe("asset:image/jpeg::assets/u1.txt");
    expect(details.backdropPath).toBe("asset:image/jpeg::assets/user.txt");
    expect(discarded).toEqual(["assets/u2.txt"]);
    expect(result).toMatchObject({ applied: 1, discarded: 1 });
  });

  it("reports the copies a details store could not apply, title gone included", async () => {
    const store = createDetailsArtworkStore<ArtworkDetails>({ read: () => null, write: () => undefined });
    const copies: ArtworkCopy[] = slots.map((slot, i) => ({ ...slot, value: `asset:image/jpeg::assets/u${i}.txt` }));
    const outcome = await store.applyArtworkCopies("m1", copies);
    expect(outcome).toEqual({ applied: 0, skipped: 2, unapplied: copies });
  });

  it("keeps the run going when the delete fails (the leftover clean-up reclaims it)", async () => {
    const store: ArtworkCopyStore = {
      listArtworkToCopy: () => slots,
      applyArtworkCopies: (_mediaId, copies) => ({ applied: 0, skipped: copies.length, unapplied: copies }),
    };
    const result = await copyMediaArtwork({
      store,
      mediaId: "m1",
      upload: uploader(),
      discard: async () => {
        throw new Error("offline");
      },
    });
    expect(result).toMatchObject({ copied: 2, applied: 0, discarded: 0 });
  });
});

describe("STOR-PLACE-10: a title delete removes the title's own artwork", () => {
  const details = {
    formats: [{ initKey: "media/init.mp4", chunks: [{ key: "media/c1.m4s" }] }],
    audioTracks: [],
    subtitleTracks: [],
    posterPath: "asset:image/jpeg::assets/poster.txt",
    backdropPath: "assets/backdrop.txt",
    seasons: [{ posterPath: "asset:image/jpeg::assets/season.txt" }],
    episodes: [{ stillPath: "asset:image/jpeg::assets/still.txt" }, { stillPath: "/still-not-copied.jpg" }],
    cast: [
      { personId: "p-only-here", profilePath: "asset:image/jpeg::assets/only.txt" },
      { personId: "p-shared", profilePath: "asset:image/jpeg::assets/shared.txt" },
    ],
    crew: [{ personId: "p-crew", profilePath: "asset:image/jpeg::assets/crew.txt" }],
  } as unknown as Parameters<typeof collectMediaDeleteKeys>[0];

  it("lists poster, backdrop, season posters, stills and unshared photos, never a provider path @bugfix @regression-proof", () => {
    const keys = collectMediaDeleteKeys(details, (personId) => personId === "p-shared");
    log("delete keys", keys);
    expect(keys.sort()).toEqual(
      [
        "media/init.mp4",
        "media/c1.m4s",
        "assets/poster.txt",
        "assets/backdrop.txt",
        "assets/season.txt",
        "assets/still.txt",
        "assets/only.txt",
        "assets/crew.txt",
      ].sort()
    );
    expect(keys).not.toContain("assets/shared.txt");
  });
});
