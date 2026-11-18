import { describe, expect, it } from "vitest";
import type { MediaDetails, MediaFormat } from "@space/shared/libraryTypes";
import { planFile, planScope, scopeQualityChoices, selectDownloadFormat } from "../src/lib/downloads/planner";
import { fileIdForEpisode, inScopeFileIds } from "../src/lib/downloads/scope";

const fmt = (over: Partial<MediaFormat> & { id: string; fileId: string; quality: string }): MediaFormat => ({
  mediaId: "m1",
  codec: "h264",
  bitrateKbps: 4000,
  sizeMb: 100,
  initKey: `media/p1/${over.id}/init.mp4`,
  initSize: 1000,
  durationSeconds: 600,
  totalSize: null,
  chunks: [
    { key: `media/p1/${over.id}/c0.m4s`, sizeBytes: 1_000_000, startSeconds: 0 },
    { key: `media/p1/${over.id}/c1.m4s`, sizeBytes: 3_000_000, startSeconds: 10 },
  ],
  ...over,
});

const baseDetails = (over: Partial<MediaDetails>): MediaDetails =>
  ({
    id: "m1",
    title: "Show",
    cast: [],
    playlistIds: [],
    seasons: [],
    episodes: [],
    trailers: [],
    files: [],
    formats: [],
    audioTracks: [],
    subtitleTracks: [],
    subtitles: [],
    chapters: [],
    skipMarkers: [],
    hasLocalFiles: true,
    ...over,
  }) as unknown as MediaDetails;

const showDetails = (): MediaDetails =>
  baseDetails({
    episodes: [
      { id: "e11", seasonNumber: 1, episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, airDate: null },
      { id: "e12", seasonNumber: 1, episodeNumber: 2, name: "Two", overview: null, stillPath: null, airDate: null },
      { id: "e21", seasonNumber: 2, episodeNumber: 1, name: "Back", overview: null, stillPath: null, airDate: null },
    ],
    files: [
      { id: "f21", filename: "s2e1", season: 2, episode: 1, desiredFormats: [] },
      { id: "f11", filename: "s1e1", season: 1, episode: 1, desiredFormats: [] },
      { id: "f12", filename: "s1e2", season: 1, episode: 2, desiredFormats: [] },
    ],
    formats: ["f11", "f12", "f21"].flatMap((fileId) => [
      fmt({ id: `${fileId}-1080`, fileId, quality: "1080p" }),
      fmt({ id: `${fileId}-720`, fileId, quality: "720p" }),
    ]),
    audioTracks: [
      {
        id: "a1",
        episodeId: null,
        fileId: "f11",
        initKey: "media/p1/a1/init.mp4",
        initSize: 10,
        chunks: [{ key: "media/p1/a1/c0.m4s", sizeBytes: 500, startSeconds: 0 }],
      },
    ] as unknown as MediaDetails["audioTracks"],
    subtitleTracks: [
      { id: "s1", episodeId: "e11", fileId: null, objectKey: "media/p1/s1/en.vtt" },
    ] as unknown as MediaDetails["subtitleTracks"],
  });

describe("selectDownloadFormat", () => {
  const f = (id: string, quality: string, codec = "h264", bitrateKbps = 4000) =>
    fmt({ id, fileId: "f", quality, codec, bitrateKbps });

  it("1080p: best H.264 up to 1080p", () => {
    const picked = selectDownloadFormat([f("a", "2160p", "hevc"), f("b", "1080p", "hevc"), f("c", "1080p", "h264"), f("d", "720p")], "1080p");
    console.info("1080p pick", picked?.id);
    expect(picked?.id).toBe("c");
  });

  it("1080p: falls back to any codec ≤1080p when no H.264 is there", () => {
    expect(selectDownloadFormat([f("a", "2160p", "hevc"), f("b", "1080p", "av1"), f("c", "720p", "av1")], "1080p")?.id).toBe("b");
  });

  it("1080p: everything above 1080p → lowest available", () => {
    expect(selectDownloadFormat([f("a", "2160p"), f("b", "1440p-unknown")], "1080p")?.id).toBe("a");
  });

  it("explicit preset: best at or below the preset", () => {
    const formats = [f("a", "1080p"), f("b", "720p"), f("c", "480p")];
    expect(selectDownloadFormat(formats, "720p")?.id).toBe("b");
    expect(selectDownloadFormat(formats, "480p")?.id).toBe("c");
    expect(selectDownloadFormat(formats, "2160p")?.id).toBe("a");
  });

  it("explicit preset: nothing at or below → lowest above", () => {
    expect(selectDownloadFormat([f("a", "2160p"), f("b", "1080p")], "720p")?.id).toBe("b");
  });

  it("same quality: H.264 beats a higher-bitrate HEVC", () => {
    expect(selectDownloadFormat([f("a", "720p", "hevc", 9000), f("b", "720p", "h264", 2000)], "720p")?.id).toBe("b");
  });

  it("ignores formats without init/chunks and returns null when nothing is playable", () => {
    const broken = fmt({ id: "x", fileId: "f", quality: "1080p", initKey: null });
    const empty = fmt({ id: "y", fileId: "f", quality: "1080p", chunks: [] });
    expect(selectDownloadFormat([broken, empty], "1080p")).toBeNull();
  });
});

describe("scope helpers", () => {
  const d = showDetails();
  it("covers movie/episode/season/show scopes in watch order", () => {
    expect(inScopeFileIds(d, { kind: "movie" })).toEqual([]);
    expect(inScopeFileIds(d, { kind: "episode", seasonNumber: 1, episodeNumber: 2 })).toEqual(["f12"]);
    expect(inScopeFileIds(d, { kind: "season", seasonNumber: 1 })).toEqual(["f11", "f12"]);
    expect(inScopeFileIds(d, { kind: "show" })).toEqual(["f11", "f12", "f21"]);
    expect(fileIdForEpisode(d, 2, 1)).toBe("f21");
    expect(fileIdForEpisode(d, 9, 9)).toBeNull();
  });

  it("movie scope picks the file without season/episode", () => {
    const movie = baseDetails({ files: [{ id: "mf", filename: "m", season: null, episode: null, desiredFormats: [] }] });
    expect(inScopeFileIds(movie, { kind: "movie" })).toEqual(["mf"]);
    expect(inScopeFileIds(movie, { kind: "show" })).toEqual([]);
  });
});

describe("planFile / planScope", () => {
  it("stores init + chunks of the chosen format, scoped audio and subtitle objects, with sizes", () => {
    const planned = planFile(showDetails(), "f11", "1080p");
    if ("skip" in planned) throw new Error("unexpected skip");
    const keys = planned.spec.objects.map(([k]) => k);
    console.info("f11 objects", planned.spec.objects, "estimated", planned.spec.estimatedBytes);
    expect(planned.spec.formatId).toBe("f11-1080");
    expect(planned.spec.subtitle).toBe("S1E1 · Pilot");
    expect(keys).toContain("media/p1/f11-1080/init.mp4");
    expect(keys).toContain("media/p1/f11-1080/c1.m4s");
    expect(keys).toContain("media/p1/a1/c0.m4s");
    expect(keys).toContain("media/p1/s1/en.vtt");
    expect(keys.some((k) => k.includes("f11-720"))).toBe(false);
    expect(planned.spec.estimatedBytes).toBe(1000 + 1_000_000 + 3_000_000 + 10 + 500);
  });

  it("de-duplicates objects and estimates unknown chunk sizes from the track average", () => {
    const d = baseDetails({
      files: [{ id: "mf", filename: "m", season: null, episode: null, desiredFormats: [] }],
      formats: [
        fmt({
          id: "mf-1",
          fileId: "mf",
          quality: "1080p",
          chunks: [
            { key: "k0", sizeBytes: 100, startSeconds: 0 },
            { key: "k1", sizeBytes: null, startSeconds: 1 },
            { key: "k0", sizeBytes: 100, startSeconds: 2 },
          ],
          initKey: "init",
          initSize: 10,
        }),
      ],
    });
    const planned = planFile(d, "mf", "1080p");
    if ("skip" in planned) throw new Error("unexpected skip");
    expect(planned.spec.objects).toEqual([
      ["init", 10],
      ["k0", 100],
      ["k1", 100],
    ]);
    expect(planned.spec.estimatedBytes).toBe(210);
  });

  it("season scope plans each episode in order, show scope all of them", () => {
    const d = showDetails();
    const season = planScope(d, [{ kind: "season", seasonNumber: 1 }], "1080p", []);
    const show = planScope(d, [{ kind: "show" }], "1080p", []);
    expect(season.items.map((p) => p.spec.id)).toEqual(["f11", "f12"]);
    expect(show.items.map((p) => p.spec.id)).toEqual(["f11", "f12", "f21"]);
    expect(show.totalEstimatedBytes).toBe(show.items.reduce((s, p) => s + p.spec.estimatedBytes, 0));
  });

  it("skips files already queued/downloading/completed but re-plans failed ones", () => {
    const plan = planScope(showDetails(), [{ kind: "show" }], "1080p", [
      { id: "f11", status: "completed" },
      { id: "f12", status: "downloading" },
      { id: "f21", status: "failed" },
    ]);
    console.info("skips", plan.skipped);
    expect(plan.skipped).toEqual([
      { fileId: "f11", reason: "already-local" },
      { fileId: "f12", reason: "already-local" },
    ]);
    expect(plan.items.map((p) => p.spec.id)).toEqual(["f21"]);
  });

  it("reports no-quality-available / no-file", () => {
    const d = baseDetails({ files: [{ id: "mf", filename: "m", season: null, episode: null, desiredFormats: [] }] });
    expect(planFile(d, "mf", "1080p")).toEqual({ skip: "no-quality-available" });
    expect(planFile(d, "nope", "1080p")).toEqual({ skip: "no-file" });
  });

  it("explicit preset changes the planned format", () => {
    const planned = planFile(showDetails(), "f12", "720p");
    if ("skip" in planned) throw new Error("unexpected skip");
    expect(planned.spec.formatId).toBe("f12-720");
  });

  it("several season scopes in one plan: each file once, in order", () => {
    const plan = planScope(showDetails(), [{ kind: "season", seasonNumber: 2 }, { kind: "season", seasonNumber: 1 }, { kind: "show" }], "720p", []);
    console.info("multi-scope plan", plan.items.map((p) => [p.spec.id, p.spec.formatId]));
    expect(plan.items.map((p) => p.spec.id).sort()).toEqual(["f11", "f12", "f21"]);
    expect(new Set(plan.items.map((p) => p.spec.id)).size).toBe(3);
    expect(plan.items.every((p) => p.spec.formatId.endsWith("-720"))).toBe(true);
  });
});

describe("@bugfix @regression-proof non-preset quality labels (e.g. 420p from a 1002x420 ingest)", () => {
  const f = (id: string, quality: string, codec = "h264") => fmt({ id, fileId: "f", quality, codec });

  it("a 420p format is playable and chosen for the 480p preset", () => {
    const formats = [f("a", "1080p"), f("b", "720p"), f("c", "420p"), f("d", "360p"), f("e", "144p")];
    const picked = selectDownloadFormat(formats, "480p");
    console.info("480p preset pick among height-labelled formats", picked?.id, picked?.quality);
    expect(picked?.id).toBe("c");
  });

  it("1080p still picks 1080p H.264 when odd labels are present, and 420p when it is all there is", () => {
    expect(selectDownloadFormat([f("a", "1080p"), f("c", "420p")], "1080p")?.id).toBe("a");
    expect(selectDownloadFormat([f("c", "420p"), f("e", "144p")], "1080p")?.id).toBe("c");
  });

  it("an unparseable label is never playable", () => {
    expect(selectDownloadFormat([f("x", "source")], "1080p")).toBeNull();
  });
});

// @req OFFL-QUAL-01[badger-mobile]
describe("OFFL-QUAL-01 phone quality choices", () => {
  it("OFFL-QUAL-01 lists every quality with its size and prompts when a file has several", () => {
    console.info("[OFFL-QUAL-01 choices] phase=plan");
    const d = showDetails();
    const res = scopeQualityChoices(d, [{ kind: "season", seasonNumber: 1 }], []);
    console.info("[OFFL-QUAL-01 choices] result", JSON.stringify(res));
    expect(res.prompt).toBe(true);
    expect(res.choices.map((c) => c.quality)).toEqual(["1080p", "720p"]);
    const p1080 = planScope(d, [{ kind: "season", seasonNumber: 1 }], "1080p", []).totalEstimatedBytes;
    const p720 = planScope(d, [{ kind: "season", seasonNumber: 1 }], "720p", []).totalEstimatedBytes;
    console.info("[OFFL-QUAL-01 choices] plan totals", { p1080, p720 });
    expect(res.choices[0]?.totalBytes).toBe(p1080);
    expect(res.choices[1]?.totalBytes).toBe(p720);
    expect(res.choices.every((c) => c.fallbacks.length === 0)).toBe(true);
  });

  it("OFFL-QUAL-01 single quality: no prompt", () => {
    const d = showDetails();
    d.formats = d.formats.filter((f) => f.quality === "720p");
    const res = scopeQualityChoices(d, [{ kind: "episode", seasonNumber: 1, episodeNumber: 1 }], []);
    console.info("[OFFL-QUAL-01 single] result", JSON.stringify(res));
    expect(res.prompt).toBe(false);
    expect(res.choices.map((c) => c.quality)).toEqual(["720p"]);
  });

  it("OFFL-QUAL-01 season batch: episodes without the chosen quality get the nearest lower one, counted per choice", () => {
    const d = showDetails();
    // f12 only has 720p.
    d.formats = d.formats.filter((f) => !(f.fileId === "f12" && f.quality === "1080p"));
    const res = scopeQualityChoices(d, [{ kind: "show" }], []);
    console.info("[OFFL-QUAL-01 batch] result", JSON.stringify(res));
    expect(res.prompt).toBe(true);
    expect(res.choices[0]).toMatchObject({ quality: "1080p", fallbacks: [{ quality: "720p", count: 1 }] });
    expect(res.choices[1]).toMatchObject({ quality: "720p", fallbacks: [] });
    const plan = planScope(d, [{ kind: "show" }], "1080p", []);
    console.info("[OFFL-QUAL-01 batch] plan", plan.items.map((p) => [p.spec.id, p.spec.formatId]));
    expect(plan.items.find((p) => p.spec.id === "f12")?.spec.formatId).toBe("f12-720");
    expect(res.choices[0]?.totalBytes).toBe(plan.totalEstimatedBytes);
  });

  it("OFFL-QUAL-01 already-downloaded files are left out of the sizes and the prompt", () => {
    const d = showDetails();
    const res = scopeQualityChoices(d, [{ kind: "season", seasonNumber: 1 }], [
      { id: "f11", status: "completed" },
      { id: "f12", status: "completed" },
    ]);
    console.info("[OFFL-QUAL-01 local] result", JSON.stringify(res));
    expect(res.prompt).toBe(false);
    expect(res.choices).toEqual([]);
  });
});
