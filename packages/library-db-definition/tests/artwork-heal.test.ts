/**
 * @test-id LIB-DEF-ARTHEAL
 * @level unit (end-to-end-ish: fake vault, fake library, fake metadata service)
 * @req STOR-PLACE-09
 * @why A user's library must never show a broken picture: artwork whose stored copy vanished while its media is
 *   still in the library is fetched back, stored again and swapped in. A gateway or network error must never be read
 *   as "missing" (that would refetch the whole library on every outage).
 */
import { describe, expect, it } from "vitest";
import {
  createArtworkHealer,
  isMissingObjectError,
  listHealSlots,
  sourcePathFor,
  type ArtworkHealerDeps,
  type ArtworkRefChange,
  type HealableMedia,
  type HealSourceDetails,
} from "../src/artworkHeal";

const ID = "LIB-DEF-ARTHEAL";
const phase = (name: string, detail?: unknown) => console.log(`[${ID}] ${name}`, detail === undefined ? "" : JSON.stringify(detail));

const ref = (key: string) => `asset:image/jpeg::${key}`;

/** A small world: the user's vault (key → bytes), the library (media rows) and the metadata service. */
const makeWorld = () => {
  const vault = new Map<string, Uint8Array>();
  const library = new Map<string, HealableMedia>();
  const sourceDetails = new Map<number, HealSourceDetails>();
  const calls = { exists: [] as string[][], details: [] as string[], images: [] as string[], stores: 0, replaces: [] as ArtworkRefChange[][] };
  let gatewayDown = false;
  let uploads = 0;

  const orchard: HealableMedia = {
    id: "m-orchard",
    type: "movie",
    tmdbId: 900912,
    posterPath: ref("assets/orchard-poster.txt"),
    backdropPath: ref("assets/orchard-backdrop.txt"),
    cast: [{ personId: "p-ines", tmdbId: 1010, profilePath: ref("assets/ines.txt") }],
    crew: [{ personId: "p-ines", tmdbId: 1010, profilePath: ref("assets/ines.txt") }],
  };
  const brigade: HealableMedia = {
    id: "m-brigade",
    type: "tv",
    tmdbId: 900315,
    posterPath: ref("assets/brigade-poster.txt"),
    backdropPath: "/tmdb-backdrop.jpg",
    seasons: [{ id: "s-brigade-3", seasonNumber: 3, posterPath: ref("assets/brigade-s3.txt") }],
    episodes: [{ id: "e-brigade-3-1", seasonNumber: 3, episodeNumber: 1, stillPath: ref("assets/brigade-s3e1.txt") }],
  };
  library.set(orchard.id, orchard);
  library.set(brigade.id, brigade);
  for (const media of library.values()) for (const slot of listHealSlots(media)) vault.set(slot.key, new Uint8Array([1, 2, 3]));
  sourceDetails.set(900912, { posterPath: "/orchard.jpg", backdropPath: "/orchard-bd.jpg", cast: [{ tmdbId: 1010, profilePath: "/ines.jpg" }] });
  sourceDetails.set(900315, {
    posterPath: "/brigade.jpg",
    seasons: [{ seasonNumber: 3, posterPath: "/brigade-s3.jpg" }],
    episodes: [{ seasonNumber: 3, episodeNumber: 1, stillPath: "/brigade-s3e1.jpg" }],
  });

  const deps: ArtworkHealerDeps = {
    exists: async (keys) => {
      calls.exists.push(keys);
      if (gatewayDown) throw new Error("storage_head_failed");
      return Object.fromEntries(keys.map((key) => [key, vault.has(key)]));
    },
    listMediaIds: async () => [...library.keys()],
    loadMedia: async (mediaId) => structuredClone(library.get(mediaId) ?? null),
    fetchDetails: async (media) => {
      calls.details.push(media.id);
      return sourceDetails.get(media.tmdbId ?? -1) ?? null;
    },
    fetchImage: async (kind, path) => {
      calls.images.push(`${kind}:${path}`);
      return { bytes: new TextEncoder().encode(`image ${path}`), contentType: "image/jpeg" };
    },
    store: async (image) => {
      calls.stores += 1;
      uploads += 1;
      const key = `assets/healed-${uploads}.txt`;
      vault.set(key, image.bytes);
      return ref(key);
    },
    replaceRefs: async (mediaId, changes) => {
      calls.replaces.push(changes);
      const media = library.get(mediaId);
      if (!media) return 0;
      let applied = 0;
      for (const change of changes) {
        if (change.target === "mediaPoster" && media.posterPath === change.path) (media.posterPath = change.value), applied++;
        if (change.target === "mediaBackdrop" && media.backdropPath === change.path) (media.backdropPath = change.value), applied++;
        for (const season of media.seasons ?? []) {
          if (change.target === "seasonPoster" && season.id === change.id && season.posterPath === change.path) (season.posterPath = change.value), applied++;
        }
        for (const episode of media.episodes ?? []) {
          if (change.target === "episodeStill" && episode.id === change.id && episode.stillPath === change.path) (episode.stillPath = change.value), applied++;
        }
        if (change.target === "personProfile") {
          for (const person of [...(media.cast ?? []), ...(media.crew ?? [])]) {
            if (person.personId === change.id && person.profilePath === change.path) (person.profilePath = change.value), applied++;
          }
        }
      }
      return applied;
    },
    log: (event, detail) => console.log(`[${ID}] log ${event}`, JSON.stringify(detail)),
    sleep: async () => undefined,
  };
  return {
    vault,
    library,
    calls,
    deps,
    setGatewayDown: (down: boolean) => {
      gatewayDown = down;
    },
  };
};

const keyOf = (value: string | null | undefined) => (value ?? "").split("::")[1];

describe("artwork self-heal (STOR-PLACE-09)", () => {
  it("lists every stored artwork slot once and maps it back to its TMDB path", () => {
    const world = makeWorld();
    const slots = listHealSlots(world.library.get("m-brigade")!);
    phase("slots", slots);
    expect(slots.map((slot) => slot.target)).toEqual(["mediaPoster", "seasonPoster", "episodeStill"]);
    const orchard = listHealSlots(world.library.get("m-orchard")!);
    expect(orchard.filter((slot) => slot.target === "personProfile")).toHaveLength(1);
    expect(sourcePathFor(orchard.find((slot) => slot.target === "personProfile")!, { cast: [{ tmdbId: 1010, profilePath: "/a.jpg" }] })).toBe("/a.jpg");
    expect(sourcePathFor(slots[2], { episodes: [{ seasonNumber: 3, episodeNumber: 1, stillPath: "/s.jpg" }] })).toBe("/s.jpg");
    expect(sourcePathFor(slots[0], { posterPath: "assets/x.txt" })).toBeNull();
  });

  it("recognises only the gateway's missing-object error as a hint", () => {
    expect(isMissingObjectError(new Error("download_source_missing"))).toBe(true);
    expect(isMissingObjectError(new Error("storage_tunnel_download_failed:download_source_missing"))).toBe(true);
    expect(isMissingObjectError(new Error("storage_head_failed"))).toBe(false);
    expect(isMissingObjectError(new Error("fetch failed"))).toBe(false);
  });

  it("sweep: a deleted poster, season poster and photo are fetched back, stored and swapped in", async () => {
    const world = makeWorld();
    phase("setup: delete three objects from the vault");
    world.vault.delete("assets/orchard-poster.txt");
    world.vault.delete("assets/ines.txt");
    world.vault.delete("assets/brigade-s3.txt");
    const healer = createArtworkHealer(world.deps);

    const result = await healer.sweep();
    const orchard = world.library.get("m-orchard")!;
    const brigade = world.library.get("m-brigade")!;
    phase("state", { result, calls: world.calls, orchard, brigade, vault: [...world.vault.keys()] });

    expect(result).toEqual({ checked: 6, missing: 3, healed: 3, aborted: false });
    expect(world.calls.exists).toHaveLength(1);
    expect(world.calls.details.sort()).toEqual(["m-brigade", "m-orchard"]);
    expect(world.calls.images.sort()).toEqual(["poster:/brigade-s3.jpg", "poster:/orchard.jpg", "profile:/ines.jpg"]);
    for (const value of [orchard.posterPath, orchard.cast![0].profilePath, orchard.crew![0].profilePath, brigade.seasons![0].posterPath]) {
      expect(value).toMatch(/^asset:image\/jpeg::assets\/healed-\d\.txt$/);
      expect(world.vault.has(keyOf(value))).toBe(true);
    }
    expect(orchard.backdropPath).toBe(ref("assets/orchard-backdrop.txt"));
    expect(healer.healedRef(ref("assets/orchard-poster.txt"))).toBe(orchard.posterPath);

    phase("second sweep: nothing left to heal");
    const again = await healer.sweep();
    phase("state", { again });
    expect(again.missing).toBe(0);
    expect(world.calls.images).toHaveLength(3);
  });

  it("display path: a failed download is confirmed missing, then healed once for concurrent viewers", async () => {
    const world = makeWorld();
    world.vault.delete("assets/brigade-s3e1.txt");
    const healer = createArtworkHealer(world.deps);
    const [a, b] = await Promise.all([healer.reportMissing(ref("assets/brigade-s3e1.txt")), healer.reportMissing(ref("assets/brigade-s3e1.txt"))]);
    const brigade = world.library.get("m-brigade")!;
    phase("state", { a, b, calls: world.calls, still: brigade.episodes![0].stillPath });
    expect(a).toBe(b);
    expect(a).toBe(brigade.episodes![0].stillPath);
    expect(world.calls.images).toEqual(["still:/brigade-s3e1.jpg"]);
    expect(world.vault.has(keyOf(a))).toBe(true);
  });

  it("a gateway error never refetches anything", async () => {
    const world = makeWorld();
    world.vault.delete("assets/orchard-poster.txt");
    world.setGatewayDown(true);
    const healer = createArtworkHealer(world.deps);

    const swept = await healer.sweep();
    const reported = await healer.reportMissing(ref("assets/orchard-poster.txt"));
    phase("state", { swept, reported, calls: world.calls });

    expect(swept.aborted).toBe(true);
    expect(reported).toBeNull();
    expect(world.calls.details).toEqual([]);
    expect(world.calls.images).toEqual([]);
    expect(world.calls.stores).toBe(0);
    expect(world.calls.replaces).toEqual([]);
    expect(world.library.get("m-orchard")!.posterPath).toBe(ref("assets/orchard-poster.txt"));
  });

  it("a download error on an object that still exists does not refetch", async () => {
    const world = makeWorld();
    const healer = createArtworkHealer(world.deps);
    const reported = await healer.reportMissing(ref("assets/orchard-poster.txt"));
    phase("state", { reported, calls: world.calls });
    expect(reported).toBeNull();
    expect(world.calls.exists).toEqual([["assets/orchard-poster.txt"]]);
    expect(world.calls.images).toEqual([]);
  });

  it("artwork no media in the library uses is not refetched", async () => {
    const world = makeWorld();
    world.vault.delete("assets/orchard-poster.txt");
    world.library.delete("m-orchard");
    const healer = createArtworkHealer(world.deps);
    const reported = await healer.reportMissing(ref("assets/orchard-poster.txt"));
    phase("state", { reported, calls: world.calls });
    expect(reported).toBeNull();
    expect(world.calls.images).toEqual([]);
  });

  it("is rate limited per rolling minute", async () => {
    const world = makeWorld();
    for (const key of ["assets/orchard-poster.txt", "assets/orchard-backdrop.txt", "assets/ines.txt"]) world.vault.delete(key);
    let clock = 0;
    const sleeps: number[] = [];
    const healer = createArtworkHealer({
      ...world.deps,
      maxImagesPerMinute: 2,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const result = await healer.sweep();
    phase("state", { result, sleeps });
    expect(result.healed).toBe(3);
    expect(sleeps).toEqual([60_000]);
  });
});
