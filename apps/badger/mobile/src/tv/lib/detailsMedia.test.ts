/**
 * @test-id TV-DETAILS-MEDIA-001
 * @level unit
 * @why A TV title page shows one video per movie and per episode, in several qualities (the original first, marked),
 *   with its audio and subtitles; a show has no qualities of its own, each episode has its own (Chris 2026-10-28, design
 *   demo). These helpers turn the library's formats and tracks into exactly that, and pick the YouTube trailer link.
 *
 * @req UX-TV-07[badger-tv]
 * @req UX-TV-06[badger-tv]
 * @req UX-TV-40[badger-tv]
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { changeLanguage, initI18n } from "@space/mobile-shell/i18n";
import type { AudioTrack, MediaDetails, MediaFormat, MediaRow, SubtitleTrack } from "@space/shared/libraryTypes";
import { getStorageUnitBase, setStorageUnitBase } from "@space/shared/format";
import {
  codecLabel,
  episodeMediaBlocks,
  formatRating,
  formatSizeMb,
  initials,
  mediaBlockForFile,
  minutesLeft,
  movieMediaBlock,
  qualitiesLine,
  qualityLabel,
  runtimeParts,
  similarTitles,
  tvDetailsTabs,
  tvVersionChips,
  youtubeTrailer,
} from "./detailsMedia";

const log = (step: string, value: unknown) => console.info(`[TV-DETAILS-MEDIA-001] ${step}:`, JSON.stringify(value));

const format = (id: string, fileId: string, quality: string, codec: string, extra: Partial<MediaFormat> = {}): MediaFormat => ({
  id,
  mediaId: "m",
  fileId,
  quality,
  codec,
  codecString: null,
  bitrateKbps: null,
  sizeMb: 1000,
  initKey: null,
  initSize: null,
  durationSeconds: 3000,
  totalSize: null,
  chunks: [],
  isSource: false,
  ...extra,
});

const audio = (id: string, label: string, scope: { fileId?: string; episodeId?: string } = {}): AudioTrack => ({
  id,
  mediaId: "m",
  fileId: scope.fileId ?? null,
  episodeId: scope.episodeId ?? null,
  language: "en",
  label,
  isDefault: false,
  source: "ingest",
  codec: null,
  initKey: null,
  initSize: null,
  durationSeconds: null,
  totalSize: null,
  chunks: [],
});

const subtitle = (id: string, label: string, scope: { fileId?: string; episodeId?: string } = {}): SubtitleTrack => ({
  id,
  mediaId: "m",
  fileId: scope.fileId ?? null,
  episodeId: scope.episodeId ?? null,
  language: "en",
  label,
  objectKey: null,
  format: "vtt",
  isDefault: false,
  source: "ingest",
  createdAt: "2026-10-01T00:00:00Z",
});

const movie = {
  id: "m",
  type: "movie",
  files: [{ id: "f1", filename: "movie.mkv", season: null, episode: null, desiredFormats: [] }],
  formats: [
    format("q720", "f1", "720p", "h264", { sizeMb: 900 }),
    format("src", "f1", "2160p", "hevc", { isSource: true, codecString: "dvh1.05.06", sizeMb: 18841.6, durationSeconds: 7740 }),
    format("q1080", "f1", "1080p", "h264", { sizeMb: 3000 }),
    format("q1080hevc", "f1", "1080p", "hevc", { sizeMb: 2500 }),
    format("other", "f2", "480p", "h264"),
  ],
  audioTracks: [audio("a1", "English 5.1", { fileId: "f1" }), audio("a2", "French 5.1"), audio("a3", "German", { fileId: "f2" })],
  subtitleTracks: [subtitle("s1", "English", { fileId: "f1" }), subtitle("s2", "Dutch", { fileId: "f2" })],
  episodes: [],
  trailers: [],
} as unknown as MediaDetails;

const show = {
  id: "s",
  type: "tv",
  files: [
    { id: "e1f", filename: "s01e01.mkv", season: 1, episode: 1, desiredFormats: [] },
    { id: "e2f", filename: "s01e02.mkv", season: 1, episode: 2, desiredFormats: [] },
  ],
  formats: [
    format("e1-1080", "e1f", "1080p", "h264", { isSource: true }),
    format("e1-720", "e1f", "720p", "h264"),
    format("e2-2160", "e2f", "2160p", "hevc", { isSource: true, codecString: "dvhe.05.06" }),
    format("e2-1080", "e2f", "1080p", "h264"),
    format("e2-720", "e2f", "720p", "h264"),
  ],
  audioTracks: [audio("ea1", "English 5.1", { episodeId: "e1" }), audio("ea2", "English 5.1 Atmos", { episodeId: "e2" })],
  subtitleTracks: [subtitle("es1", "French", { episodeId: "e2" })],
  episodes: [
    { id: "e1", seasonNumber: 1, episodeNumber: 1, name: "One", overview: null, stillPath: null, airDate: null },
    { id: "e2", seasonNumber: 1, episodeNumber: 2, name: "Two", overview: null, stillPath: null, airDate: null },
    { id: "e3", seasonNumber: 1, episodeNumber: 3, name: "Three", overview: null, stillPath: null, airDate: null },
  ],
  trailers: [],
} as unknown as MediaDetails;

describe("TV details media mapping (TV-DETAILS-MEDIA-001)", () => {
  beforeAll(async () => {
    await initI18n("en");
    // These size expectations are written in 1024-based units; the 1000-based device case has its own test (STOR-UNIT-01).
    setStorageUnitBase(1024);
    log("storage unit base", getStorageUnitBase());
  });

  it("@req UX-TV-06[badger-tv] lists a movie's tabs and a show's tabs in the approved order, without an empty tab", () => {
    log("tabs", { movie: tvDetailsTabs("movie", true, true), show: tvDetailsTabs("tv", true, true), bare: tvDetailsTabs("tv", false, false) });
    expect(tvDetailsTabs("movie", true, true)).toEqual(["cast", "versions", "similar"]);
    expect(tvDetailsTabs("tv", true, true)).toEqual(["episodes", "cast", "similar"]);
    expect(tvDetailsTabs("movie", false, true)).toEqual(["versions", "similar"]);
    expect(tvDetailsTabs("movie", true, false)).toEqual(["cast", "versions"]);
    expect(tvDetailsTabs("tv", false, false)).toEqual(["episodes"]);
  });

  it("@req UX-TV-06[badger-tv] puts a movie's qualities, the one Play starts first, then its named cuts in the version chips; a show has none", () => {
    const block = movieMediaBlock(movie);
    const editions = [
      { id: "ed0", season: null, episode: null, name: "", nameUserSet: false, durationSeconds: null, createdAt: "2026-01-01" },
      { id: "ed1", season: null, episode: null, name: "Restored 2010 cut", nameUserSet: true, durationSeconds: null, createdAt: "2026-01-02" },
      { id: "ed2", season: 1, episode: 1, name: "Episode cut", nameUserSet: true, durationSeconds: null, createdAt: "2026-01-02" },
    ];
    const chips = tvVersionChips({ type: "movie", editions }, block);
    log("version chips", chips);
    expect(chips).toEqual([
      { key: "quality-2160p HDR", label: "2160p HDR", playing: true },
      { key: "quality-1080p", label: "1080p", playing: false },
      { key: "quality-720p", label: "720p", playing: false },
      { key: "edition-ed1", label: "Restored 2010 cut", playing: false },
    ]);
    expect(tvVersionChips({ type: "movie", editions: undefined }, null)).toEqual([]);
    expect(tvVersionChips({ type: "tv", editions }, block)).toEqual([]);
  });

  it("@req UX-TV-40[badger-tv] lists the library's titles of the same kind sharing the most genres, best rated next, never the title itself", () => {
    const row = (id: string, type: "movie" | "tv", genres: number[], rating: number | null, addedAt = "2026-10-01T00:00:00Z") =>
      ({ id, type, genres, rating, addedAt, title: id }) as unknown as MediaRow;
    const media = [
      row("self", "movie", [878, 18], 8),
      row("one-shared-high", "movie", [878], 9),
      row("two-shared", "movie", [878, 18, 53], 5),
      row("one-shared-low", "movie", [18], 4),
      row("one-shared-low-newer", "movie", [18], 4, "2026-11-01T00:00:00Z"),
      row("no-genre-shared", "movie", [35], 10),
      row("a-show", "tv", [878, 18], 9),
    ];
    const similar = similarTitles({ id: "self", type: "movie", genres: [878, 18] }, media);
    log("similar", similar.map((item) => item.id));
    expect(similar.map((item) => item.id)).toEqual(["two-shared", "one-shared-high", "one-shared-low-newer", "one-shared-low"]);
    expect(similarTitles({ id: "self", type: "movie", genres: [878, 18] }, media, 2).map((item) => item.id)).toEqual(["two-shared", "one-shared-high"]);
    expect(similarTitles({ id: "self", type: "movie", genres: [] }, media)).toEqual([]);
  });

  it("puts the original quality first, marked, then one chip per smaller copy, highest first", () => {
    const block = mediaBlockForFile(movie, "f1", null);
    log("movie block", block);
    expect(block.original).toEqual({ quality: "2160p HDR", format: "HEVC · Dolby Vision", size: "18.4 GB" });
    expect(block.qualities).toEqual([
      { label: "2160p HDR", original: true },
      { label: "1080p", original: false },
      { label: "720p", original: false },
    ]);
    expect(block.durationSeconds).toBe(7740);
  });

  it("keeps only the movie file's own and unscoped tracks, as the player does", () => {
    const block = mediaBlockForFile(movie, "f1", null);
    log("movie tracks", { audio: block.audio, subtitles: block.subtitles });
    expect(block.audio).toEqual(["English 5.1", "French 5.1"]);
    expect(block.subtitles).toEqual(["English"]);
  });

  it("never lists an OCR twin, whatever its label (PLAY-TRACK-05)", () => {
    // @req PLAY-TRACK-05[badger-tv]
    const withTwin = {
      ...movie,
      subtitleTracks: [
        subtitle("s1", "English", { fileId: "f1" }),
        { ...subtitle("t1", "English (OCR)", { fileId: "f1" }), source: "ocr", format: "srt", derivedFromSubtitleId: "s1" },
      ],
    } as unknown as MediaDetails;
    expect(mediaBlockForFile(withTwin, "f1", null).subtitles).toEqual(["English"]);
  });

  it("shows the first file of a movie with several files, and logs it", () => {
    const info = vi.spyOn(console, "info");
    const twoFiles = {
      ...movie,
      files: [...movie.files, { id: "f2", filename: "cut.mkv", season: null, episode: null, desiredFormats: [] }],
    } as MediaDetails;
    const block = movieMediaBlock(twoFiles);
    log("two files", { fileId: block?.fileId });
    expect(block?.fileId).toBe("f1");
    expect(info.mock.calls.some(([event]) => event === "tv.details.movieFiles")).toBe(true);
    expect(movieMediaBlock({ ...movie, files: [] } as MediaDetails)).toBeNull();
  });

  it("gives each episode its own qualities and tracks, and none to an episode without a file", () => {
    const blocks = episodeMediaBlocks(show);
    log("episode blocks", Object.fromEntries(blocks));
    expect(qualitiesLine(blocks.get("e1")!)).toBe("1080p · 720p");
    expect(qualitiesLine(blocks.get("e2")!)).toBe("2160p HDR · 1080p · 720p");
    expect(blocks.get("e1")!.audio).toEqual(["English 5.1"]);
    expect(blocks.get("e2")!.audio).toEqual(["English 5.1 Atmos"]);
    expect(blocks.get("e2")!.subtitles).toEqual(["French"]);
    expect(blocks.get("e1")!.subtitles).toEqual([]);
    expect(blocks.has("e3")).toBe(false);
    expect(episodeMediaBlocks(movie).size).toBe(0);
    expect(episodeMediaBlocks(null).size).toBe(0);
  });

  it("names codecs, HDR and sizes plainly", () => {
    expect(codecLabel({ codec: "h264", codecString: null })).toBe("H.264");
    expect(codecLabel({ codec: "av1", codecString: null })).toBe("AV1");
    expect(qualityLabel({ quality: "1080p", codecString: "avc1.640028" })).toBe("1080p");
    expect(qualityLabel({ quality: "2160p HDR", codecString: "dvh1.05.06" })).toBe("2160p HDR");
    expect(formatSizeMb(850)).toBe("850 MB");
    expect(formatSizeMb(2355)).toBe("2.3 GB");
    expect(formatSizeMb(0)).toBeNull();
  });

  // @req STOR-UNIT-01
  it("[STOR-UNIT-01-TV-01] sizes in MiB read 1000-based on a TV/phone, like its file manager, and 1024-based when pinned", () => {
    setStorageUnitBase(1000);
    const decimal = { small: formatSizeMb(850), large: formatSizeMb(2355) };
    setStorageUnitBase(1024);
    const binary = { small: formatSizeMb(850), large: formatSizeMb(2355) };
    log("[STOR-UNIT-01-TV-01] sizes per base", { decimal, binary });
    expect(decimal).toEqual({ small: "891 MB", large: "2.5 GB" });
    expect(binary).toEqual({ small: "850 MB", large: "2.3 GB" });
  });

  // @bugfix @regression-proof — German TV showed "6.3 GB" and "★ 7.4": sizes and ratings used a dot whatever the language.
  // English last, so the tests after this one run in the default language again.
  // @req STOR-UNIT-02[badger-tv]
  for (const [lng, size, rating] of [
    ["de", "6,3 GB", "7,4"],
    ["nl", "6,3 GB", "7,4"],
    ["fr", "6,3 Go", "7,4"],
    ["en", "6.3 GB", "7.4"],
  ] as const) {
    it(`[TV-DECIMAL-001] ${lng}: sizes and ratings use the language's decimal mark ("${size}", "${rating}")`, async () => {
      await changeLanguage(lng);
      const got = { size: formatSizeMb(6451), small: formatSizeMb(850), rating: formatRating(7.4) };
      log(`decimal mark ${lng}`, got);
      expect(got).toEqual({ size, small: lng === "fr" ? "850 Mo" : "850 MB", rating });
    });
  }

  // @req UX-TV-06[badger-tv]
  it("links the first YouTube trailer to the tvOS YouTube app (youtube://watch/<id>), with the web page as fallback", () => {
    const link = youtubeTrailer([
      { provider: "youtube", key: " ", name: null, language: "en" },
      { provider: "youtube", key: " dQw4w9WgXcQ ", name: "Trailer", language: "en" },
    ]);
    log("trailer", link);
    expect(link).toEqual({ key: "dQw4w9WgXcQ", appUrl: "youtube://watch/dQw4w9WgXcQ" });
    expect(youtubeTrailer([])).toBeNull();
    expect(youtubeTrailer(undefined)).toBeNull();
  });

  it("works out minutes left, runtime and initials", () => {
    expect(minutesLeft(40, 7740)).toBe(77);
    expect(minutesLeft(40, null)).toBeNull();
    expect(minutesLeft(99.9, 3600)).toBe(1);
    expect(runtimeParts(7740)).toEqual({ hours: 2, minutes: 9 });
    expect(runtimeParts(null)).toBeNull();
    expect(initials("Ian McKellen")).toBe("IM");
    expect(initials("Cher")).toBe("C");
    expect(initials("  ")).toBe("?");
  });
});
