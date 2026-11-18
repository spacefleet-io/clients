/**
 * #145 one media = one silo: subtitles attached in the import dialog must
 * upload under the placementId of the video they belong to, never a fresh one.
 * Pins the pure helpers FileIngestionDialog.handleAdd uses to pick that id.
 */
import { describe, expect, it } from "vitest";
import type { LabQueueFileInput } from "../src/shared/labQueueShared";
import {
  existingMediaPlacementId,
  pickSubtitleBindFilename,
  placementIdsBySourceFilename,
} from "../src/renderer/src/components/fileIngestionSubtitlePlacement";

const SUITE = "file-ingestion-subtitle-placement";

// Fixture: only the fields the helpers read; the rest of LabQueueFileInput
// is irrelevant to placement.
const file = (filename: string, over: Partial<LabQueueFileInput> = {}): LabQueueFileInput =>
  ({ id: `id-${filename}`, filename, jobType: "source", includeSource: true, ...over }) as LabQueueFileInput;

type Details = NonNullable<Parameters<typeof existingMediaPlacementId>[0]>;

// Fixture: only the fields findMediaPlacementId reads.
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

const format = (fileId: string, prefix: string) => ({
  fileId,
  initKey: `${prefix}/init`,
  chunks: [{ key: `${prefix}/seg-1`, sizeBytes: 1, startSeconds: 0 }],
});

describe(`[${SUITE}] pickSubtitleBindFilename`, () => {
  it("binds to the primary (transcode) source when it is submitted", () => {
    const files = [file("/m/movie.720p.mkv"), file("/m/movie.1080p.mkv")];
    const bound = pickSubtitleBindFilename(files, "/m/movie.1080p.mkv");
    console.info(`[${SUITE}:primary] bound=${bound}`);
    expect(bound).toBe("/m/movie.1080p.mkv");
  });

  it("skips audio-only donors and the synthetic transcode entry", () => {
    const files = [
      file("/m/donor.mkv", { includeSource: false }),
      file("/m/movie.mkv"),
      file("/m/movie.mkv", { jobType: "transcode", includeSource: false }),
    ];
    const bound = pickSubtitleBindFilename(files, null);
    console.info(`[${SUITE}:donor] bound=${bound}`);
    expect(bound).toBe("/m/movie.mkv");
  });

  it("is null when the episode submits no video (subtitles only)", () => {
    expect(pickSubtitleBindFilename([], null)).toBeNull();
    expect(pickSubtitleBindFilename([file("/m/donor.mkv", { includeSource: false })], null)).toBeNull();
  });
});

describe(`[${SUITE}] placementIdsBySourceFilename`, () => {
  it("TV multi-episode submit: each episode file maps to its own source's placementId", () => {
    const sources = [{ filename: "/tv/S01E01.mkv" }, { filename: "/tv/S01E02.mkv" }];
    const submitted = [{ placementId: "placement-ep-1" }, { placementId: "placement-ep-2" }];
    const map = placementIdsBySourceFilename(sources, submitted);
    console.info(`[${SUITE}:tv] map=${JSON.stringify([...map])}`);
    expect(map.get("/tv/S01E01.mkv")).toBe("placement-ep-1");
    expect(map.get("/tv/S01E02.mkv")).toBe("placement-ep-2");
    // A subtitle of episode 2 binds to episode 2's file, so to its silo.
    const ep2Files = [file("/tv/S01E02.mkv")];
    expect(map.get(pickSubtitleBindFilename(ep2Files, "/tv/S01E02.mkv") ?? "")).toBe("placement-ep-2");
  });

  it("keeps the id a deduped source answers with (the existing job's placement)", () => {
    const map = placementIdsBySourceFilename([{ filename: "/m/movie.mkv" }], [{ placementId: "existing-job-placement" }]);
    expect(map.get("/m/movie.mkv")).toBe("existing-job-placement");
  });

  it("drops null / invalid ids so the upload mints instead", () => {
    const map = placementIdsBySourceFilename(
      [{ filename: "/a.mkv" }, { filename: "/b.mkv" }, { filename: "/c.mkv" }],
      [{ placementId: null }, { placementId: "bad id!" }]
    );
    console.info(`[${SUITE}:invalid] size=${map.size}`);
    expect(map.size).toBe(0);
  });
});

describe(`[${SUITE}] existingMediaPlacementId (subtitles only, media already in library)`, () => {
  it("film: the placement parsed from its existing keys", () => {
    const film = details({
      files: [{ id: "f1", season: null, episode: null }],
      formats: [format("f1", "media/placement-film")],
    });
    expect(existingMediaPlacementId(film, null, null)).toBe("placement-film");
  });

  it("TV: the episode's own file, never a sibling episode on another silo", () => {
    const show = details({
      type: "tv",
      episodes: [
        { id: "e1", seasonNumber: 1, episodeNumber: 1 },
        { id: "e2", seasonNumber: 1, episodeNumber: 2 },
      ],
      files: [
        { id: "f1", season: 1, episode: 1 },
        { id: "f2", season: 1, episode: 2 },
      ],
      formats: [format("f1", "media/placement-ep-1"), format("f2", "media/placement-ep-2")],
    });
    const ep2 = existingMediaPlacementId(show, 1, 2);
    console.info(`[${SUITE}:tv-existing] ep2=${ep2}`);
    expect(ep2).toBe("placement-ep-2");
    expect(existingMediaPlacementId(show, 1, 1)).toBe("placement-ep-1");
  });

  it("TV with an unknown episode, legacy keys, or no details → null (fresh placement)", () => {
    const show = details({
      type: "tv",
      episodes: [{ id: "e1", seasonNumber: 1, episodeNumber: 1 }],
      files: [{ id: "f1", season: 1, episode: 1 }],
      formats: [format("f1", "media/placement-ep-1")],
    });
    expect(existingMediaPlacementId(show, 1, 9)).toBeNull();
    expect(existingMediaPlacementId(show, null, null)).toBeNull();
    const legacy = details({
      files: [{ id: "f1", season: null, episode: null }],
      formats: [format("f1", "shards/dev")],
    });
    expect(existingMediaPlacementId(legacy, null, null)).toBeNull();
    expect(existingMediaPlacementId(null, null, null)).toBeNull();
  });
});
