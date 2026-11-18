/**
 * Shared edition logic every Badger app uses: which editions a film or episode has, the lengths its page shows, and the
 * "Which edition?" order. Pure functions over `MediaDetails`. The rules are credited once an app wires them (its own
 * tests), so this file only names the formats and orders the spec writes out.
 */
import { describe, expect, it } from "vitest";
import type { MediaDetails, MediaFormat } from "../src/libraryTypes";
import {
  defaultEditionId,
  detailsForEdition,
  editionResumeKey,
  editionResumeValue,
  formatEditionLength,
  listEditions,
  orderEditionsForChooser,
  orderEditionsForPage,
  readEditionResume,
} from "../src/mediaEditions";

const log = (phase: string, data: unknown) => console.info(`[media-editions] ${phase}`, JSON.stringify(data));

const format = (id: string, fileId: string, quality: string, durationSeconds: number | null): MediaFormat =>
  ({ id, fileId, quality, codec: "h264", durationSeconds }) as MediaFormat;

const sintel = {
  id: "sintel",
  editions: [
    { id: "ed-ext", season: null, episode: null, name: "Extended", nameUserSet: true, durationSeconds: null, createdAt: "2026-01-02" },
    { id: "ed-th", season: null, episode: null, name: "Theatrical", nameUserSet: true, durationSeconds: 888, createdAt: "2026-01-01" },
    { id: "ed-empty", season: null, episode: null, name: "Workprint", nameUserSet: true, durationSeconds: 900, createdAt: "2026-01-03" },
  ],
  files: [
    { id: "f-th", filename: "Sintel.mkv", season: null, episode: null, desiredFormats: [], editionId: "ed-th" },
    { id: "f-ext-4k", filename: "Sintel.ext.4k.mkv", season: null, episode: null, desiredFormats: [], editionId: "ed-ext" },
    { id: "f-ext-1080", filename: "Sintel.ext.1080.mkv", season: null, episode: null, desiredFormats: [], editionId: "ed-ext" },
  ],
  formats: [
    format("v-th-1080", "f-th", "1080p", 887.5),
    format("v-th-720", "f-th", "720p", 887.5),
    format("v-ext-4k", "f-ext-4k", "2160p", 13_080),
    format("v-ext-1080", "f-ext-1080", "1080p", 13_079),
  ],
} as unknown as MediaDetails;

describe("listEditions", () => {
  it("groups a film's versions by edition and skips an edition with nothing to play", () => {
    const editions = listEditions(sintel, null);
    log("film", editions.map((e) => ({ id: e.id, length: e.durationSeconds, versions: e.versions.map((v) => v.id) })));
    expect(editions.map((e) => [e.id, e.name, e.durationSeconds, e.versions.map((v) => v.id)])).toEqual([
      ["ed-ext", "Extended", 13_080, ["v-ext-4k", "v-ext-1080"]],
      ["ed-th", "Theatrical", 888, ["v-th-1080", "v-th-720"]],
    ]);
  });

  it("puts files from before editions in the unit's unnamed edition, per episode", () => {
    const show = {
      id: "show",
      files: [
        { id: "f1", filename: "S01E01.mkv", season: 1, episode: 1, desiredFormats: [] },
        { id: "f2", filename: "S01E02.mkv", season: 1, episode: 2, desiredFormats: [] },
      ],
      formats: [format("v1", "f1", "1080p", 1_500), format("v2", "f2", "1080p", 1_600)],
    } as unknown as MediaDetails;
    const editions = listEditions(show, { season: 1, episode: 2 });
    log("episode", editions);
    expect(editions.map((e) => [e.id, e.name, e.durationSeconds])).toEqual([[defaultEditionId("show", 1, 2), "", 1_600]]);
  });
});

describe("formatEditionLength", () => {
  it("writes hours and minutes as 2h58, under an hour as 58 min, rounded down", () => {
    const cases = [10_739, 10_680, 3_600, 3_599, 59, 13_708].map((s) => [s, formatEditionLength(s)]);
    log("lengths", cases);
    expect(cases).toEqual([
      [10_739, "2h58"],
      [10_680, "2h58"],
      [3_600, "1h00"],
      [3_599, "59 min"],
      [59, "0 min"],
      [13_708, "3h48"],
    ]);
  });
});

describe("edition order", () => {
  const editions = [
    { id: "a", name: "Extended", durationSeconds: 13_708 },
    { id: "b", name: "Theatrical", durationSeconds: 10_680 },
    { id: "c", name: "Director's Cut", durationSeconds: 13_708 },
    { id: "d", name: "", durationSeconds: null },
  ];

  it("the page lists editions shortest first, then by name, unknown lengths last", () => {
    expect(orderEditionsForPage(editions).map((e) => e.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("the chooser lists editions in progress first, most recent first, then the page order", () => {
    const order = orderEditionsForChooser(editions, {
      a: { positionSeconds: 7_800, updatedAt: "2026-11-01T20:00:00Z" },
      d: { positionSeconds: 60, updatedAt: "2026-11-02T20:00:00Z" },
    });
    log("chooser", order.map((e) => e.id));
    expect(order.map((e) => e.id)).toEqual(["d", "a", "b", "c"]);
  });
});

describe("edition resume spots", () => {
  const editions = [
    { id: "ed-th", durationSeconds: 888 },
    { id: "ed-ext", durationSeconds: 960 },
    { id: "ed-new", durationSeconds: 900 },
  ];

  it("keeps spots past the resume thresholds and drops finished or barely started ones", () => {
    const stored: Record<string, string> = {
      [editionResumeKey("ed-th")]: editionResumeValue({ progressPct: 50, updatedAt: "2026-11-01", positionSeconds: 444, durationSeconds: 888 }),
      [editionResumeKey("ed-ext")]: editionResumeValue({ progressPct: 100, updatedAt: "2026-11-02", positionSeconds: 960, durationSeconds: 960 }),
      [editionResumeKey("ed-new")]: editionResumeValue({ progressPct: 1, updatedAt: "2026-11-03", positionSeconds: 9, durationSeconds: 900 }),
    };
    log("stored", stored);
    expect(stored[editionResumeKey("ed-ext")]).toBe("");
    expect(readEditionResume(editions, (key) => stored[key])).toEqual({
      "ed-th": { positionSeconds: 444, updatedAt: "2026-11-01" },
    });
  });
});

describe("detailsForEdition", () => {
  it("drops the other editions' files, versions and tracks; tracks with no file stay", () => {
    const details = {
      ...sintel,
      audioTracks: [
        { id: "a-th", fileId: "f-th" },
        { id: "a-ext", fileId: "f-ext-4k" },
      ],
      subtitleTracks: [{ id: "s-all", fileId: null }],
      subtitles: [{ id: "sub-ext", fileId: "f-ext-1080" }],
    } as unknown as MediaDetails;
    const scoped = detailsForEdition(details, listEditions(details, null), "ed-ext");
    const ids = {
      files: scoped.files.map((f) => f.id),
      formats: scoped.formats.map((f) => f.id),
      audio: scoped.audioTracks.map((t) => t.id),
      subtitleTracks: scoped.subtitleTracks.map((t) => t.id),
      subtitles: scoped.subtitles.map((t) => t.id),
    };
    log("extended only", ids);
    expect(ids).toEqual({
      files: ["f-ext-4k", "f-ext-1080"],
      formats: ["v-ext-4k", "v-ext-1080"],
      audio: ["a-ext"],
      subtitleTracks: ["s-all"],
      subtitles: ["sub-ext"],
    });
  });

  it("keeps the other episodes' files, so next episode still plays", () => {
    const show = {
      id: "show",
      editions: [
        { id: "e2-a", season: 1, episode: 2, name: "Broadcast", nameUserSet: true, durationSeconds: null, createdAt: "1" },
        { id: "e2-b", season: 1, episode: 2, name: "Uncut", nameUserSet: true, durationSeconds: null, createdAt: "2" },
      ],
      files: [
        { id: "f1", filename: "S01E01.mkv", season: 1, episode: 1, desiredFormats: [] },
        { id: "f2a", filename: "S01E02.mkv", season: 1, episode: 2, desiredFormats: [], editionId: "e2-a" },
        { id: "f2b", filename: "S01E02.uncut.mkv", season: 1, episode: 2, desiredFormats: [], editionId: "e2-b" },
      ],
      formats: [format("v1", "f1", "1080p", 1_500), format("v2a", "f2a", "1080p", 1_600), format("v2b", "f2b", "1080p", 1_900)],
      audioTracks: [],
      subtitleTracks: [],
      subtitles: [],
    } as unknown as MediaDetails;
    const scoped = detailsForEdition(show, listEditions(show, { season: 1, episode: 2 }), "e2-b");
    log("episode edition", scoped.formats.map((f) => f.id));
    expect(scoped.formats.map((f) => f.id)).toEqual(["v1", "v2b"]);
  });
});
