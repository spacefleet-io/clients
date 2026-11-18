/**
 * @req PLAY-SUBGET-06[badger-desktop,badger-web-player,badger-mobile]
 * @req PLAY-SUBGET-14[badger-desktop,badger-web-player,badger-mobile]
 * @req PLAY-SUBGET-15[badger-desktop,badger-web-player,badger-mobile]
 * @req PLAY-SUBGET-16[badger-desktop,badger-web-player,badger-mobile]
 * @req PLAY-SUBGET-17[badger-desktop,badger-web-player]
 * @req PLAY-SUBGET-18[badger-desktop,badger-web-player,badger-mobile]
 * @req PLAY-SUBGET-19[badger-desktop,badger-web-player,badger-mobile]
 *
 * The list the user picks from after "Get subtitles": one entry per language, kind and cut, the best file picked by
 * the app against the user's file name, entry names, track names and the "Already in your media library" mark.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildSubtitleEntries,
  rankSubtitleCandidates,
  storeFetchedSubtitle,
  subtitleFetchTarget,
  subtitleLibraryLanguage,
  uniqueSubtitleTrackName,
  type SubtitleFetchCandidate,
  type SubtitleFetchLabels,
} from "../src/subtitleFetch";
import { formatTrackDisplayLabel } from "../src/mediaLanguageDisplay";

const labels: SubtitleFetchLabels = {
  hearingImpaired: "Hearing impaired",
  foreignPartsOnly: "Foreign parts only",
  cuts: { "directors-cut": "Director's cut", extended: "Extended", unrated: "Unrated" },
};

let nextId = 1;
const candidate = (overrides: Partial<SubtitleFetchCandidate>): SubtitleFetchCandidate => ({
  fileId: nextId++,
  language: "es",
  hearingImpaired: false,
  foreignPartsOnly: false,
  release: "Sandglass (2021) 1080p WEB-DL",
  fileName: "Sandglass.2021.srt",
  downloadCount: 100,
  ready: false,
  ...overrides,
});

describe("buildSubtitleEntries", () => {
  it("merges files of one language into one entry named by the language alone (PLAY-SUBGET-06)", () => {
    const entries = buildSubtitleEntries({
      candidates: [candidate({ language: "fr" }), candidate({ language: "fr" }), candidate({ language: "es" })],
      uiLanguage: "en",
      labels,
    });
    expect(entries.map((entry) => entry.name)).toEqual(["French", "Spanish"]);
    expect(entries[0]!.files).toHaveLength(2);
  });

  it("keeps a different cut separate (PLAY-SUBGET-06)", () => {
    const entries = buildSubtitleEntries({
      candidates: [
        candidate({ language: "fr" }),
        candidate({ language: "fr", release: "Neon Archive (1982) Directors Cut 1080p BluRay" }),
        candidate({ language: "fr", release: "Lantern Bay (2003) EXTENDED 720p BluRay" }),
      ],
      uiLanguage: "en",
      labels,
    });
    expect(entries.map((entry) => entry.name)).toEqual(["French", "French — Director's cut", "French — Extended"]);
  });

  it("names entries in the UI language", () => {
    const [entry] = buildSubtitleEntries({ candidates: [candidate({ language: "de" })], uiLanguage: "fr", labels });
    expect(entry!.name).toBe("Allemand");
  });

  it("makes hearing-impaired and foreign-parts files their own entries; foreign parts wins (PLAY-SUBGET-15, -16)", () => {
    const entries = buildSubtitleEntries({
      candidates: [
        candidate({ language: "es" }),
        candidate({ language: "es", hearingImpaired: true }),
        candidate({ language: "en", foreignPartsOnly: true, hearingImpaired: true }),
      ],
      uiLanguage: "en",
      labels,
    });
    expect(entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["English (Foreign parts only)", "foreign"],
      ["Spanish", "plain"],
      ["Spanish (Hearing impaired)", "hi"],
    ]);
  });

  it("maps the provider's regional tags to the library code and names the variant", () => {
    const [entry] = buildSubtitleEntries({ candidates: [candidate({ language: "pt-br" })], uiLanguage: "en", labels });
    expect(entry!.language).toBe("pt");
    expect(entry!.languageTag).toBe("pt-br");
    expect(entry!.name).toBe("Brazilian Portuguese");
    expect(subtitleLibraryLanguage("spa")).toBe("es");
  });

  it("marks an entry the copy already has, by language and kind (PLAY-SUBGET-18)", () => {
    const entries = buildSubtitleEntries({
      candidates: [candidate({ language: "es" }), candidate({ language: "es", hearingImpaired: true }), candidate({ language: "fr" })],
      existingTracks: [
        { language: "spa", label: "Spanish" },
        { language: "fr", label: "French", source: "opensubtitles" },
      ],
      uiLanguage: "en",
      labels,
    });
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    expect(byName["Spanish"]!.already).toBe("file");
    expect(byName["Spanish (Hearing impaired)"]!.already).toBeNull();
    expect(byName["French"]!.already).toBe("fetched");
  });

  it("names the added track like the entry, numbered when the name is taken (PLAY-SUBGET-17, -18)", () => {
    const entries = buildSubtitleEntries({
      candidates: [candidate({ language: "es" }), candidate({ language: "it" })],
      existingTracks: [
        { language: "es", label: "Spanish" },
        { language: "es", label: "Spanish 2" },
      ],
      uiLanguage: "en",
      labels,
    });
    expect(entries.map((entry) => entry.trackName)).toEqual(["Italian", "Spanish 3"]);
    expect(uniqueSubtitleTrackName("Spanish", ["English"])).toBe("Spanish");
  });

  it("returns nothing when no subtitle exists", () => {
    expect(buildSubtitleEntries({ candidates: [], uiLanguage: "en", labels })).toEqual([]);
  });

  it("@bugfix @regression-proof phone-subget-hermes: names entries without Intl.DisplayNames (Hermes has none)", () => {
    // Hermes, the phone's engine, has no Intl.DisplayNames: building the list threw, and every search on the phone
    // ended on "Something went wrong getting these subtitles".
    const intl = globalThis.Intl;
    vi.stubGlobal("Intl", { ...intl, DisplayNames: undefined });
    try {
      const entries = buildSubtitleEntries({
        candidates: [candidate({ language: "fr" }), candidate({ language: "nl" }), candidate({ language: "pt-br" }), candidate({ language: "zz" })],
        uiLanguage: "nl",
        labels,
      });
      expect(entries.map((entry) => entry.name)).toEqual(["French", "Nederlands", "Portuguese (BR)", "ZZ"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("rankSubtitleCandidates (PLAY-SUBGET-14)", () => {
  const fileName = "Sandglass (2021) 2160p Blu-ray Remux HEVC-final.mkv";

  it("prefers the user's version tag over download count", () => {
    const popular = candidate({ release: "Sandglass (2021) 1080p WEB-DL", downloadCount: 9000 });
    const exact = candidate({ release: "Sandglass (2021) 2160p Blu-ray Remux HEVC-final", downloadCount: 3 });
    const ranked = rankSubtitleCandidates([popular, exact], fileName);
    console.info("[subtitle-rank] version tag", { fileName, ranked: ranked.map((c) => c.release) });
    expect(ranked[0]).toBe(exact);
  });

  it("then the format and resolution, then downloads", () => {
    const web = candidate({ release: "Sandglass (2021) 2160p WEB-DL", downloadCount: 500 });
    const remux = candidate({ release: "Sandglass (2021) 1080p Blu-ray Remux", downloadCount: 10 });
    const remux4k = candidate({ release: "Sandglass (2021) 2160p Blu-ray Remux", downloadCount: 5 });
    const ranked = rankSubtitleCandidates([web, remux, remux4k], fileName);
    console.info("[subtitle-rank] format/resolution", { fileName, ranked: ranked.map((c) => c.release) });
    expect(ranked).toEqual([remux4k, remux, web]);
  });

  it("falls back to download count without a library file name", () => {
    const few = candidate({ downloadCount: 1 });
    const many = candidate({ downloadCount: 50 });
    expect(rankSubtitleCandidates([few, many], null)).toEqual([many, few]);
  });
});

describe("subtitleFetchTarget (PLAY-SUBGET-14)", () => {
  const show = {
    type: "tv",
    tmdbId: 900104,
    episodes: [{ id: "ep-s3e4", seasonNumber: 3, episodeNumber: 4 }],
    files: [
      { filename: "The.Brigade.S03E03.mkv", season: 3, episode: 3 },
      { filename: "The Brigade - S03E04 - 1080p WEB.mkv", season: 3, episode: 4 },
    ],
    subtitleTracks: [
      { episodeId: "ep-s3e4", language: "es", label: "Spanish", source: "srt" },
      { episodeId: "ep-s3e4", language: "es", label: "Spanish (OCR)", source: "ocr", derivedFromSubtitleId: "x" },
      { episodeId: "ep-other", language: "fr", label: "French", source: "srt" },
    ],
  };

  it("searches an episode by TMDB ID, season and episode only, and ranks against its own file", () => {
    expect(subtitleFetchTarget(show, "ep-s3e4")).toEqual({
      request: { type: "tv", id: 900104, season: 3, episode: 4 },
      libraryFileName: "The Brigade - S03E04 - 1080p WEB.mkv",
      existingTracks: [{ language: "es", label: "Spanish", source: "srt" }],
    });
  });

  it("searches a movie by TMDB ID; nothing without one", () => {
    const movie = { type: "movie", tmdbId: 900021, episodes: [], files: [{ filename: "Sandglass.mkv", season: null, episode: null }], subtitleTracks: [] };
    expect(subtitleFetchTarget(movie, null)?.request).toEqual({ type: "movie", id: 900021 });
    expect(subtitleFetchTarget({ ...movie, tmdbId: null }, null)).toBeNull();
    expect(subtitleFetchTarget(show, null)).toBeNull();
  });
});

describe("storeFetchedSubtitle (PLAY-SUBGET-17, -19)", () => {
  it("downloads the picked file, stores it under the entry's name with its origin, and remembers it", async () => {
    const [entry] = buildSubtitleEntries({
      candidates: [candidate({ language: "es", fileId: 77 })],
      existingTracks: [{ language: "es", label: "Spanish" }],
      uiLanguage: "en",
      labels,
    });
    const calls: unknown[] = [];
    const stages: string[] = [];
    await storeFetchedSubtitle(entry!, (stage) => stages.push(stage), {
      download: async (fileId) => (calls.push(["download", fileId]), { format: "srt", content: "1\n" }),
      upload: async (content, format) => (calls.push(["upload", content, format]), "obj/key"),
      addTrack: async (track) => void calls.push(["addTrack", track]),
      rememberChoice: async (choice) => void calls.push(["remember", choice]),
    });
    expect(stages).toEqual(["downloading", "saving"]);
    expect(calls).toEqual([
      ["download", 77],
      ["upload", "1\n", "srt"],
      ["addTrack", { language: "es", label: "Spanish 2", objectKey: "obj/key", format: "srt", source: "opensubtitles:77" }],
      ["remember", { language: "es", format: "srt" }],
    ]);
  });

  it("stops before storing or adding once aborted mid-download (PLAY-SUBGET-02)", async () => {
    const [entry] = buildSubtitleEntries({ candidates: [candidate({ language: "es", fileId: 77 })], existingTracks: [], uiLanguage: "en", labels });
    const controller = new AbortController();
    const calls: string[] = [];
    const store = storeFetchedSubtitle(
      entry!,
      () => {},
      {
        download: async () => (controller.abort(), calls.push("download"), { format: "srt", content: "1\n" }),
        upload: async () => (calls.push("upload"), "obj/key"),
        addTrack: async () => void calls.push("addTrack"),
        rememberChoice: async () => void calls.push("remember"),
      },
      controller.signal
    );
    await expect(store).rejects.toThrow();
    expect(calls).toEqual(["download"]);
  });
});

describe("a fetched subtitle reads as named in every track list (PLAY-SUBGET-17)", () => {
  it("keeps the entry's name instead of a language-dash-descriptor", () => {
    expect(formatTrackDisplayLabel("es", "Spanish", "en")).toBe("Spanish");
    expect(formatTrackDisplayLabel("es", "Spanish (Hearing impaired)", "en")).toBe("Spanish (Hearing impaired)");
    expect(formatTrackDisplayLabel("es", "Spanish 2", "en")).toBe("Spanish 2");
    expect(formatTrackDisplayLabel("fr", "French — Director's cut", "en")).toBe("French — Director's cut");
    expect(formatTrackDisplayLabel("en", "English SDH", "en")).toBe("English - SDH");
  });
});
