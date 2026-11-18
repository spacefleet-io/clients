/**
 * #145 one media = one silo: `findMediaPlacementId` names the silo a film or
 * one episode already lives on, parsed from its own object keys only.
 */
import { describe, expect, it } from "vitest";
import { findMediaPlacementId, mediaPlacementUnits } from "../src/mediaPlacement";

const SUITE = "media-placement-find";

type Details = Parameters<typeof findMediaPlacementId>[0];

// Fixture: only the fields findMediaPlacementId reads; the full MediaDetails
// rows carry many unrelated columns.
const details = (over: Partial<Record<keyof Details, unknown>>): Details =>
  ({
    type: "movie",
    episodes: [],
    files: [],
    formats: [],
    audioTracks: [],
    subtitleTracks: [],
    ...over,
  }) as unknown as Details;

const format = (fileId: string, prefix: string, initKey: string | null = `${prefix}/init.mp4`) => ({
  fileId,
  initKey,
  chunks: [{ key: `${prefix}/seg-00001.m4s` }],
});

const showFixture = () =>
  details({
    type: "tv",
    episodes: [
      { id: "ep-1", seasonNumber: 1, episodeNumber: 1 },
      { id: "ep-2", seasonNumber: 1, episodeNumber: 2 },
    ],
    files: [
      { id: "file-1", season: 1, episode: 1 },
      { id: "file-2", season: 1, episode: 2 },
    ],
    formats: [format("file-1", "media/placement-ep1/f1080")],
    audioTracks: [
      // Unscoped track (no episodeId, no fileId): could belong to any sibling.
      { episodeId: null, fileId: null, initKey: "media/placement-other/a/init.mp4", chunks: [] },
    ],
    subtitleTracks: [{ episodeId: "ep-2", fileId: null, objectKey: "media/placement-ep2/subs/en.vtt" }],
  });

describe(`[${SUITE}] findMediaPlacementId`, () => {
  it("film: the id from its format keys (init null → falls through to chunks)", () => {
    const film = details({
      files: [{ id: "file-1", season: null, episode: null }],
      formats: [format("file-1", "media/placement-film/f720", null)],
    });
    const id = findMediaPlacementId(film, null);
    console.info(`[${SUITE}:film] id=${id}`);
    expect(id).toBe("placement-film");
  });

  it("episode scoping: each episode resolves its own silo, never a sibling's", () => {
    const show = showFixture();
    const ep1 = findMediaPlacementId(show, "ep-1");
    const ep2 = findMediaPlacementId(show, "ep-2");
    console.info(`[${SUITE}:episodes] ep1=${ep1} ep2=${ep2}`);
    expect(ep1).toBe("placement-ep1");
    // ep-2 has no formats; its own subtitle names the silo, not ep-1's
    // formats nor the unscoped audio track.
    expect(ep2).toBe("placement-ep2");
  });

  it("unscoped tracks are ignored: an episode with only them has no placement", () => {
    const show = showFixture();
    const onlyUnscoped = details({ ...show, formats: [], subtitleTracks: [] });
    const id = findMediaPlacementId(onlyUnscoped, "ep-1");
    console.info(`[${SUITE}:unscoped] id=${id}`);
    expect(id).toBeNull();
  });

  it("legacy shards/ keys → null (caller allocates a fresh placement)", () => {
    const legacy = details({
      files: [{ id: "file-1", season: null, episode: null }],
      formats: [format("file-1", "shards/dev-1/user/f1080")],
      subtitleTracks: [{ episodeId: null, fileId: "file-1", objectKey: "user/subs/en.vtt" }],
    });
    expect(findMediaPlacementId(legacy, null)).toBeNull();
  });

  it("media without objects → null", () => {
    expect(findMediaPlacementId(details({}), null)).toBeNull();
    expect(
      findMediaPlacementId(details({ files: [{ id: "file-1", season: null, episode: null }] }), null)
    ).toBeNull();
  });
});

describe(`[${SUITE}] mediaPlacementUnits`, () => {
  it("names every placement of a show with its episode, and a film's placements with no episode", () => {
    const units = mediaPlacementUnits(showFixture());
    console.info(`[${SUITE}:units]`, [...units]);
    expect(units.get("placement-ep1")).toBe("ep-1");
    expect(units.get("placement-ep2")).toBe("ep-2");
    // The unscoped audio track still names its placement, tied to no episode.
    expect(units.get("placement-other")).toBeNull();

    const film = details({
      files: [
        { id: "file-1", season: null, episode: null },
        { id: "file-2", season: null, episode: null },
      ],
      formats: [format("file-1", "media/placement-a/f720"), format("file-2", "media/placement-b/f1080")],
    });
    expect([...mediaPlacementUnits(film)]).toEqual([
      ["placement-a", null],
      ["placement-b", null],
    ]);
    expect(mediaPlacementUnits(details({ formats: [format("file-1", "shards/dev-1/user/f1080")] })).size).toBe(0);
  });
});
