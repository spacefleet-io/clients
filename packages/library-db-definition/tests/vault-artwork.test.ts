/**
 * @test-id META-ART-VAULT-001
 * @level unit (pure shared pieces, no database, no network)
 * @req META-ART-01
 * @req META-ART-02
 *
 * Why this exists: the metadata service's "Slow responses" alert (2026-11-13..15) fired on pictures asked again and
 * again at display time: 1,454 `image` lookups for 468 distinct pictures in three days on one router. The model
 * (2026-11-16): pictures are fetched at import, stored in the user's vault, and shown from there. These pieces are
 * what every client shares for it: where a stored value is shown from (never the service), the details-based copy
 * store for clients that write whole titles, the paced migration of an existing library, and the uploader.
 */
import { describe, expect, it } from "vitest";
import {
  applyArtworkCopiesToDetails,
  artworkDisplaySource,
  buildArtworkAssetRef,
  copyMediaArtwork,
  createArtworkCopyQueue,
  createDetailsArtworkStore,
  createVaultArtworkUpload,
  listDetailsArtworkSlots,
  scheduleArtworkMigration,
  type ArtworkDetails,
} from "../src/artworkCopy";

const log = (phase: string, data?: unknown) =>
  console.info(`[vault-artwork] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const show = (): ArtworkDetails => ({
  id: "m1",
  posterPath: "/poster.jpg",
  backdropPath: "asset:image/jpeg::assets/aaa.txt",
  seasons: [{ id: "s1", posterPath: "/s1.jpg" }],
  cast: [
    { personId: "p1", profilePath: "/p1.jpg" },
    { personId: "p1", profilePath: "/p1.jpg" },
    { personId: "p2", profilePath: null },
  ],
  episodes: [
    { id: "e1", stillPath: "/e1.jpg" },
    { id: "e2", stillPath: "https://example.test/own.jpg" },
  ],
});

describe("artworkDisplaySource", () => {
  it("shows only vault copies; a provider path is pending, never a lookup", () => {
    log("phase: classify");
    expect(artworkDisplaySource("asset:image/jpeg::assets/x.txt")).toBe("vault");
    expect(artworkDisplaySource("assets/x.txt")).toBe("vault");
    expect(artworkDisplaySource("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("vault");
    expect(artworkDisplaySource("/abc.jpg")).toBe("pending");
    expect(artworkDisplaySource("asset:broken")).toBe("none");
    expect(artworkDisplaySource("https://example.test/a.jpg")).toBe("none");
    expect(artworkDisplaySource("")).toBe("none");
    expect(artworkDisplaySource(null)).toBe("none");
  });
});

describe("details copy store", () => {
  it("lists provider paths in library order, one per person", () => {
    const slots = listDetailsArtworkSlots(show());
    log("phase: slots", slots);
    expect(slots.map((slot) => `${slot.target}:${slot.id}`)).toEqual([
      "mediaPoster:m1",
      "seasonPoster:s1",
      "personProfile:p1",
      "episodeStill:e1",
    ]);
  });

  it("swaps copies in compare-and-set, every role of a person", () => {
    const details = show();
    const { details: next, applied } = applyArtworkCopiesToDetails(details, [
      { target: "mediaPoster", id: "m1", path: "/poster.jpg", value: "asset:image/jpeg::assets/p.txt" },
      { target: "seasonPoster", id: "s1", path: "/changed-meanwhile.jpg", value: "asset:image/jpeg::assets/s.txt" },
      { target: "personProfile", id: "p1", path: "/p1.jpg", value: "asset:image/jpeg::assets/p1.txt" },
      { target: "episodeStill", id: "e1", path: "/e1.jpg", value: null },
    ]);
    log("phase: applied", { applied });
    expect(applied).toBe(3);
    expect(next.posterPath).toBe("asset:image/jpeg::assets/p.txt");
    expect(next.seasons?.[0]?.posterPath).toBe("/s1.jpg");
    expect(next.cast?.map((member) => member.profilePath)).toEqual([
      "asset:image/jpeg::assets/p1.txt",
      "asset:image/jpeg::assets/p1.txt",
      null,
    ]);
    expect(next.episodes?.[0]?.stillPath).toBeNull();
    expect(details.posterPath).toBe("/poster.jpg");
  });

  /**
   * @bugfix @regression-proof Hand try 2026-11-16 (lane vaht, web player): every page load of a library holding
   * The General (1926) asked the metadata service for one picture again. Buster Keaton is in its cast and its crew;
   * the copy swapped his cast rows only, and `media.upsert` writes the crew's `people` row after the cast's, so his
   * one `people.profile_path` went back to the provider path and the next migration copied it again, forever.
   */
  it("swaps a person's crew rows with the cast rows, so the one people row keeps the copy @bugfix @regression-proof", () => {
    const details = {
      ...show(),
      crew: [
        { personId: "p1", profilePath: "/p1.jpg" },
        { personId: "p9", profilePath: "/p9.jpg" },
      ],
    };
    const { details: next, applied } = applyArtworkCopiesToDetails(details, [
      { target: "personProfile", id: "p1", path: "/p1.jpg", value: "asset:image/jpeg::assets/p1.txt" },
    ]);
    log("phase: applied with crew", { applied, crew: next.crew });
    expect(applied).toBe(1);
    expect(next.crew?.map((member) => member.profilePath)).toEqual(["asset:image/jpeg::assets/p1.txt", "/p9.jpg"]);
    expect(details.crew[0]?.profilePath).toBe("/p1.jpg");
  });

  it("runs the shared copy over a details library and writes once per batch", async () => {
    let stored: ArtworkDetails = show();
    const writes: ArtworkDetails[] = [];
    const store = createDetailsArtworkStore({
      read: () => stored,
      write: (_id, details) => {
        stored = details;
        writes.push(details);
      },
    });
    const result = await copyMediaArtwork({
      store,
      mediaId: "m1",
      upload: async (kind, path) => (path === "/e1.jpg" ? { status: "missing" } : { status: "ok", key: `asset:image/jpeg::${kind}${path}` }),
    });
    log("phase: copy result", result);
    expect(result).toMatchObject({ total: 4, copied: 3, missing: 1, applied: 4 });
    expect(writes).toHaveLength(1);
    expect(listDetailsArtworkSlots(stored)).toEqual([]);
  });
});

describe("paced migration", () => {
  it("schedules only titles holding provider paths and pauses between titles", async () => {
    const ran: string[] = [];
    const pauses: number[] = [];
    const queue = createArtworkCopyQueue({
      run: async (mediaId) => {
        ran.push(mediaId);
      },
      pauseMs: 2_000,
      now: () => 1_000,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    const scheduled = await scheduleArtworkMigration({
      listMediaIds: () => ["a", "b", "c"],
      hasArtworkToCopy: (id) => id !== "b",
      queue,
    });
    await queue.idle();
    log("phase: migration", { scheduled, ran, pauses });
    expect(scheduled).toBe(2);
    expect(ran).toEqual(["a", "c"]);
    expect(pauses).toEqual([2_000]);
  });

  it("a title the user acts on runs before the migration and without its pause", async () => {
    const ran: string[] = [];
    const pauses: number[] = [];
    let release: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let unblock: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const queue = createArtworkCopyQueue({
      run: async (mediaId) => {
        ran.push(mediaId);
        if (mediaId === "m1") {
          release();
          await blocked;
        }
      },
      pauseMs: 2_000,
      now: () => 1_000,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    for (const id of ["m1", "m2", "m3"]) queue.schedule(id, { background: true });
    await firstStarted;
    log("phase: migration running, user matches u1 and opens m3");
    queue.schedule("u1");
    queue.schedule("m3");
    queue.schedule("m2", { background: true });
    unblock();
    await queue.idle();
    log("phase: priority", { ran, pauses });
    expect(ran).toEqual(["m1", "u1", "m3", "m2"]);
    expect(pauses, "only the step into the background lane waits").toEqual([2_000]);
  });
});

describe("vault uploader", () => {
  it("stores fetched bytes encrypted and passes through why there is none", async () => {
    const upload = createVaultArtworkUpload({
      fetchImage: async (_kind, path) =>
        path === "/none.jpg" ? { status: "missing" } : path === "/boom.jpg" ? Promise.reject(new Error("down")) : { status: "ok", bytes: new Uint8Array([1, 2]), contentType: "image/jpeg; q=1" },
      storeEncrypted: async (bytes, type) => buildArtworkAssetRef(`assets/${bytes.length}.txt`, type),
    });
    const outcomes = await Promise.all([upload("poster", "/a.jpg"), upload("poster", "/none.jpg"), upload("poster", "/boom.jpg")]);
    log("phase: outcomes", outcomes);
    expect(outcomes).toEqual([{ status: "ok", key: "asset:image/jpeg::assets/2.txt" }, { status: "missing" }, { status: "unavailable" }]);
  });
});
