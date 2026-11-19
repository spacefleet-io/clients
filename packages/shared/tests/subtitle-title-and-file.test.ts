/**
 * @req PLAY-SUBGET-14[badger-desktop,badger-web-player,badger-mobile]
 * @req PLAY-SUBGET-23[badger-desktop,badger-web-player,badger-mobile]
 * @req PLAY-SUBGET-24[badger-desktop,badger-web-player,badger-mobile]
 *
 * A title with no catalog id still gets "Get more subtitles…": the user picks the film or show by title first, then the
 * usual catalog-id search runs. "Add a subtitle file…" stores a readable .srt/.ass/.ssa/.vtt like a fetched subtitle.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ADDED_SUBTITLE_FILE_SOURCE,
  isRemovableSubtitleSource,
  readableSubtitleText,
  storeSubtitleFile,
  subtitleFetchNeedsTitle,
  subtitleFetchTarget,
  subtitleFileFormat,
  subtitleTitleMatchLabel,
  subtitleTitleMatches,
  UnreadableSubtitleFileError,
  type StoreSubtitleFileDeps,
  type SubtitleFetchCandidate,
  type SubtitleTitleMatch,
} from "../src/subtitleFetch";
import { createSubtitleFetchFlow, type SubtitleFetchFlowInput, type SubtitleFetchFlowState } from "../src/subtitleFetchFlow";

const SRT = "1\n00:00:01,000 --> 00:00:03,000\nOù est le Hobbit ? Nous devons partir avant la nuit.\n";

const movie = {
  type: "movie",
  title: "The Fellowship",
  catalogId: null as number | null,
  episodes: [] as Array<{ id: string; seasonNumber: number; episodeNumber: number }>,
  files: [{ filename: "fellowship (2001).mkv", season: null, episode: null }],
  subtitleTracks: [] as Array<{ episodeId: string | null; language: string; label: string; source: string }>,
};

const show = {
  ...movie,
  type: "tv",
  title: "The Brigade",
  episodes: [{ id: "ep-s3e4", seasonNumber: 3, episodeNumber: 4 }],
  files: [{ filename: "The.Brigade.S03E04.mkv", season: 3, episode: 4 }],
};

describe("a title with no catalog id is searched by the film or show the user picks (PLAY-SUBGET-24, -14)", () => {
  it("asks for the title the app shows, never the file name, only when there is no catalog id", () => {
    expect(subtitleFetchNeedsTitle(movie, null)).toEqual({ type: "movie", query: "The Fellowship" });
    expect(subtitleFetchNeedsTitle(show, "ep-s3e4")).toEqual({ type: "tv", query: "The Brigade" });
    expect(subtitleFetchNeedsTitle(show, null)).toBeNull();
    expect(subtitleFetchNeedsTitle({ ...movie, catalogId: 120 }, null)).toBeNull();
  });

  it("searches the picked match by its catalog id, season and episode only", () => {
    expect(subtitleFetchTarget(movie, null)).toBeNull();
    expect(subtitleFetchTarget(movie, null, 120)?.request).toEqual({ type: "movie", id: 120 });
    expect(subtitleFetchTarget(show, "ep-s3e4", 900104)?.request).toEqual({ type: "tv", id: 900104, season: 3, episode: 4 });
  });

  it("turns the title lookup into at most 8 matches labelled with their year", () => {
    const results = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `Alien ${i}`, year: i === 0 ? "1979" : null }));
    const matches = subtitleTitleMatches(results);
    expect(matches).toHaveLength(8);
    expect(subtitleTitleMatchLabel(matches[0]!)).toBe("Alien 0 (1979)");
    expect(subtitleTitleMatchLabel(matches[1]!)).toBe("Alien 1");
  });

  const candidate: SubtitleFetchCandidate = {
    fileId: 7,
    language: "fr",
    release: "Fellowship 2001",
    fileName: "Fellowship.srt",
    hearingImpaired: false,
    foreignPartsOnly: false,
    downloadCount: 5,
    ready: true,
  };

  const flowWith = (find: (query: string) => Promise<SubtitleTitleMatch[]>) => {
    const states: SubtitleFetchFlowState[] = [];
    const searched: Array<SubtitleTitleMatch | undefined> = [];
    const input: SubtitleFetchFlowInput = {
      uiLanguage: "en",
      existingTracks: [],
      findTitle: { query: "The Fellowship", find },
      search: async (match) => {
        searched.push(match);
        return { reachable: true, subtitles: [candidate] };
      },
      store: async () => {},
    };
    const flow = createSubtitleFetchFlow(() => input, (state) => states.push(state));
    return { flow, states, searched };
  };

  it("starts with the title lookup, then searches subtitles for the picked match", async () => {
    const match = { catalogId: 120, title: "The Fellowship of the Ring", year: "2001" };
    const queries: string[] = [];
    const { flow, states, searched } = flowWith(async (query) => {
      queries.push(query);
      return [match];
    });
    await flow.start();
    console.log("[PLAY-SUBGET-24] title steps", JSON.stringify(states));
    expect(queries).toEqual(["The Fellowship"]);
    expect(states).toEqual([
      { step: "title", query: "The Fellowship", matches: null },
      { step: "title", query: "The Fellowship", matches: [match] },
    ]);
    expect(searched).toEqual([]);
    await flow.search(match);
    expect(searched).toEqual([match]);
    expect(states.map((state) => state.step).slice(2)).toEqual(["looking", "list"]);
  });

  it("says nothing was found, lets the user type another title, and ignores a slower earlier lookup", async () => {
    const slow = Promise.withResolvers<SubtitleTitleMatch[]>();
    const { flow, states } = flowWith((query) => (query === "Fellowshp" ? slow.promise : Promise.resolve([])));
    const first = flow.findTitle("Fellowshp");
    await flow.findTitle("  Fellowship  ");
    slow.resolve([{ catalogId: 1, title: "Wrong", year: null }]);
    await first;
    expect(states.at(-1)).toEqual({ step: "title", query: "Fellowship", matches: [] });
    await flow.findTitle("   ");
    expect(states.at(-1)).toEqual({ step: "title", query: "", matches: [] });
  });

  it("shows the 'working on it' message when the title lookup is unavailable", async () => {
    const { flow, states } = flowWith(() => Promise.reject(new Error("metadata_unavailable")));
    await flow.start();
    expect(states.at(-1)).toEqual({ step: "unavailable" });
  });
});

describe("Add a subtitle file… (PLAY-SUBGET-23)", () => {
  const deps = (over: Partial<StoreSubtitleFileDeps> = {}) => {
    const calls = {
      upload: vi.fn(async (_content: string, _format: string) => "obj-1"),
      addTrack: vi.fn(async (_track: { language: string; label: string; objectKey: string; format: string; source: string }) => {}),
      rememberChoice: vi.fn(async (_choice: { language: string; format: string }) => {}),
    };
    const value: StoreSubtitleFileDeps = {
      uiLanguage: "en",
      takenLabels: [],
      detectLanguage: async () => "fr",
      ...calls,
      ...over,
    };
    return { value, calls };
  };

  it("accepts .srt, .ass, .ssa and .vtt only, and only when the text reads as subtitles", () => {
    expect(["a.srt", "b.ASS", "c.ssa", "d.vtt", "e.sub", "f.txt"].map(subtitleFileFormat)).toEqual([
      "srt",
      "ass",
      "ssa",
      "vtt",
      null,
      null,
    ]);
    expect(readableSubtitleText(SRT, "srt")).toBe(true);
    expect(readableSubtitleText("WEBVTT\n\n00:01.000 --> 00:03.000\nHi\n", "vtt")).toBe(true);
    expect(readableSubtitleText("[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hi\n", "ass")).toBe(true);
    expect(readableSubtitleText("just some notes", "srt")).toBe(false);
  });

  it("stores the file under its language in the app's language, as an added file, and remembers it", async () => {
    const { value, calls } = deps({ uiLanguage: "fr", takenLabels: ["Français"] });
    const stored = await storeSubtitleFile({ name: "fellowship.fr.srt", content: SRT }, value);
    console.log("[PLAY-SUBGET-23] stored", JSON.stringify(stored));
    expect(stored).toEqual({ language: "fr", label: "Français 2", format: "srt", source: ADDED_SUBTITLE_FILE_SOURCE });
    expect(calls.upload).toHaveBeenCalledWith(SRT, "srt");
    expect(calls.addTrack).toHaveBeenCalledWith({ ...stored, objectKey: "obj-1" });
    expect(calls.rememberChoice).toHaveBeenCalledWith({ language: "fr", format: "srt" });
  });

  it("names a file whose language can't be told by its file name", async () => {
    const { value } = deps({ detectLanguage: async () => null });
    const stored = await storeSubtitleFile({ name: "/home/me/Fellowship commentary.srt", content: SRT }, value);
    expect(stored).toMatchObject({ language: "und", label: "Fellowship commentary" });
  });

  it("refuses a file that isn't a subtitle and stores nothing", async () => {
    const { value, calls } = deps();
    await expect(storeSubtitleFile({ name: "notes.srt", content: "not a subtitle" }, value)).rejects.toBeInstanceOf(
      UnreadableSubtitleFileError
    );
    await expect(storeSubtitleFile({ name: "movie.mkv", content: SRT }, value)).rejects.toBeInstanceOf(
      UnreadableSubtitleFileError
    );
    expect(calls.upload).not.toHaveBeenCalled();
    expect(calls.addTrack).not.toHaveBeenCalled();
  });

  it("an added file can be removed like a fetched subtitle; subtitles that came with the video can't", () => {
    expect(isRemovableSubtitleSource(ADDED_SUBTITLE_FILE_SOURCE)).toBe(true);
    expect(isRemovableSubtitleSource("fetched:7")).toBe(true);
    expect(isRemovableSubtitleSource("upload")).toBe(false);
    expect(isRemovableSubtitleSource("srt")).toBe(false);
  });
});
