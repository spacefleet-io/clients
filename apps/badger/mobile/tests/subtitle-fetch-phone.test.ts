/**
 * @test-id BADGER-MOBILE-SUBGET-001
 * @level unit
 * @why "Get subtitles" on the phone: the search goes through the metadata service by catalog id only, the picked file is
 *   downloaded there, stored in the vault, added as a fetched track naming its file ("fetched:<fileId>") and
 *   remembered as the title's subtitle; the player then lists the new track after the session's own ones and loads it
 *   like any library subtitle. "Try another version" (PLAY-SUBGET-07, #2502) runs the same search again, stores the
 *   next file of the same entry under the same name, drops the old track, and the player puts it in the old row.
 */
import { describe, expect, it } from "vitest";
import type { MediaDetails } from "@space/shared/libraryTypes";
import {
  ADDED_SUBTITLE_FILE_SOURCE,
  fetchedSubtitleSource,
  UnreadableSubtitleFileError,
  type SubtitleFetchCandidate,
  type SubtitleFetchEntry,
} from "@space/shared/subtitleFetch";
import { createSubtitleFetchFlow, tryAnotherSubtitleVersion, type SubtitleFetchFlowState, type SubtitleVersionStep } from "@space/shared/subtitleFetchFlow";
import { subtitlePickPatch } from "@space/shared/trackPrefs";
import type { SubtitleTrack } from "@space/mobile-mpv-playback";
import {
  storeSubtitleFilePhone,
  subtitleFetchPhoneInput,
  subtitleTryAnotherPhoneInput,
  type FetchedSubtitleTrack,
} from "../src/lib/subtitleFetchStore";
import { fetchedSubtitleToPlayerTrack, replacePlayerSubtitle, withFetchedSubtitles } from "../src/lib/playback/fetchedSubtitles";

const log = (label: string, value: unknown) => console.info(`BADGER-MOBILE-SUBGET ${label}: ${JSON.stringify(value)}`);

const sintel = {
  id: "media-sintel",
  type: "movie",
  catalogId: 45745,
  episodes: [],
  files: [{ filename: "Sintel (2010) [1080p].mkv", season: null, episode: null }],
  subtitleTracks: [{ episodeId: null, language: "en", label: "English", source: "srt" }],
} as unknown as MediaDetails;

const setup = () => {
  const calls: unknown[] = [];
  const added: FetchedSubtitleTrack[] = [];
  const input = subtitleFetchPhoneInput({
    media: sintel,
    episodeId: null,
    uiLanguage: "en",
    client: {
      subtitles: async (request) => (calls.push(["search", request]), { results: [] }) as never,
      subtitleFile: async (fileId) => (calls.push(["download", fileId]), { format: "srt", content: "1\n" }) as never,
      search: async (type, query) => (calls.push(["titleSearch", type, query]), { results: [], page: 1, totalPages: 0 }),
    },
    actions: {
      uploadSubtitleContent: async (mediaId, episodeId, content, format) => (calls.push(["upload", mediaId, episodeId, content, format]), "obj/fr.srt"),
      addSubtitleTrack: async (track) => (calls.push(["addTrack", track]), "sub-new"),
      setTrackPrefs: async (mediaId, patch) => void calls.push(["prefs", mediaId, patch]),
    },
    onTrackAdded: (track) => added.push(track),
  });
  return { input, calls, added };
};

describe("subtitleFetchPhoneInput", () => {
  /** @req PLAY-SUBGET-03[badger-mobile] @req PLAY-SUBGET-14[badger-mobile] */
  it("searches the metadata service by catalog id only, ranking against the film's file", async () => {
    const { input, calls } = setup();
    expect(input?.libraryFileName).toBe("Sintel (2010) [1080p].mkv");
    expect(input?.existingTracks).toEqual([{ language: "en", label: "English", source: "srt" }]);
    await input!.search();
    expect(calls).toEqual([["search", { type: "movie", id: 45745 }]]);
  });

  it("is null for a show without a catalog id when no episode is playing (nothing to search by)", () => {
    const input = subtitleFetchPhoneInput({
      media: { ...sintel, type: "tv", catalogId: null } as MediaDetails,
      episodeId: null,
      uiLanguage: "en",
      client: { subtitles: async () => ({}) as never, subtitleFile: async () => ({}) as never, search: async () => ({}) as never },
      actions: { uploadSubtitleContent: async () => "", addSubtitleTrack: async () => "", setTrackPrefs: async () => {} },
    });
    expect(input).toBeNull();
  });

  /** @req PLAY-SUBGET-19[badger-mobile] @req PLAY-SUBGET-07[badger-mobile] */
  it("downloads, stores in the vault, adds a track naming its file, hands it to the player and remembers it", async () => {
    const { input, calls, added } = setup();
    const entry = { language: "fr", trackName: "French", best: { fileId: 9 } } as unknown as SubtitleFetchEntry;
    const stages: string[] = [];
    await input!.store(entry, (stage) => stages.push(stage), new AbortController().signal);
    log("store calls", calls);
    expect(stages).toEqual(["downloading", "saving"]);
    expect(fetchedSubtitleSource(9)).toBe("fetched:9");
    expect(calls.slice(0, 3)).toEqual([
      ["download", 9],
      ["upload", "media-sintel", null, "1\n", "srt"],
      ["addTrack", { mediaId: "media-sintel", episodeId: null, language: "fr", label: "French", objectKey: "obj/fr.srt", format: "srt", source: "fetched:9" }],
    ]);
    const patch = subtitlePickPatch({ language: "fr", format: "srt" });
    expect(patch).not.toBeNull();
    expect(calls[3]).toEqual(["prefs", "media-sintel", patch]);
    expect(added).toEqual([{ id: "sub-new", language: "fr", label: "French", objectKey: "obj/fr.srt", format: "srt", source: "fetched:9" }]);
  });
});

describe("Get more subtitles for a title without a catalog id (PLAY-SUBGET-24)", () => {
  const untitled = { ...sintel, title: "Sintel", catalogId: null } as unknown as MediaDetails;
  const setupTitle = (results: Array<{ id: number; title: string; year: string | null }>) => {
    const calls: unknown[] = [];
    const input = subtitleFetchPhoneInput({
      media: untitled,
      episodeId: null,
      uiLanguage: "en",
      client: {
        subtitles: async (request) => (calls.push(["search", request]), { reachable: true, subtitles: [] }) as never,
        subtitleFile: async () => ({}) as never,
        search: async (type, query) => (calls.push(["titleSearch", type, query]), { results, page: 1, totalPages: 1 }) as never,
      },
      actions: { uploadSubtitleContent: async () => "", addSubtitleTrack: async () => "", setTrackPrefs: async () => {} },
    });
    const states: SubtitleFetchFlowState[] = [];
    const flow = createSubtitleFetchFlow(() => input!, (state) => states.push(state));
    return { input, calls, states, flow };
  };

  /** @req PLAY-SUBGET-24[badger-mobile,badger-tv] @req PLAY-SUBGET-14[badger-mobile,badger-tv] */
  it("starts with the title step, then searches subtitles by the picked match's catalog id only", async () => {
    const { input, calls, states, flow } = setupTitle([
      { id: 45745, title: "Sintel", year: "2010" },
      { id: 1, title: "Sintel Remake", year: null },
    ]);
    expect(input?.findTitle?.query).toBe("Sintel");
    expect(input?.libraryFileName).toBe("Sintel (2010) [1080p].mkv");
    await flow.start();
    log("title step states", states);
    expect(states.at(-1)).toEqual({
      step: "title",
      query: "Sintel",
      matches: [
        { catalogId: 45745, title: "Sintel", year: "2010" },
        { catalogId: 1, title: "Sintel Remake", year: null },
      ],
    });
    await flow.search({ catalogId: 45745, title: "Sintel", year: "2010" });
    log("title search calls", calls);
    expect(calls).toEqual([
      ["titleSearch", "movie", "Sintel"],
      ["search", { type: "movie", id: 45745 }],
    ]);
    // The file name is never sent anywhere (PLAY-SUBGET-14).
    expect(JSON.stringify(calls)).not.toContain("1080p");
    expect(states.at(-1)?.step).toBe("none");
  });

  /** @req PLAY-SUBGET-24[badger-mobile,badger-tv] */
  it("a title the user types is looked up instead; nothing found keeps the title step with no matches", async () => {
    const { calls, states, flow } = setupTitle([]);
    await flow.findTitle("  Big Buck Bunny ");
    log("typed title states", states);
    expect(calls).toEqual([["titleSearch", "movie", "Big Buck Bunny"]]);
    expect(states.at(-1)).toEqual({ step: "title", query: "Big Buck Bunny", matches: [] });
  });
});

describe("Add a subtitle file on the phone (PLAY-SUBGET-23)", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nBonjour\n";
  const setupFile = () => {
    const calls: unknown[] = [];
    const added: FetchedSubtitleTrack[] = [];
    const params = {
      media: sintel,
      episodeId: null,
      uiLanguage: "en",
      actions: {
        uploadSubtitleContent: async (mediaId: string, episodeId: string | null, content: string, format: string) => (
          calls.push(["upload", mediaId, episodeId, content, format]), "obj/added.srt"
        ),
        addSubtitleTrack: async (track: unknown) => (calls.push(["addTrack", track]), "sub-added"),
        setTrackPrefs: async (mediaId: string, patch: unknown) => void calls.push(["prefs", mediaId, patch]),
      },
      onTrackAdded: (track: FetchedSubtitleTrack) => added.push(track),
    };
    return { calls, added, params };
  };

  /** @req PLAY-SUBGET-23[badger-mobile] */
  it("stores the file in the vault as an added-file track named after the file, hands it to the player and remembers it", async () => {
    const { calls, added, params } = setupFile();
    const stored = await storeSubtitleFilePhone({ name: "Sintel.fr.srt", content: srt }, params);
    log("added file calls", calls);
    expect(ADDED_SUBTITLE_FILE_SOURCE).toBe("added-file");
    expect(stored).toEqual({ language: "und", label: "Sintel.fr", format: "srt", source: "added-file" });
    expect(calls.slice(0, 2)).toEqual([
      ["upload", "media-sintel", null, srt, "srt"],
      ["addTrack", { mediaId: "media-sintel", episodeId: null, language: "und", label: "Sintel.fr", objectKey: "obj/added.srt", format: "srt", source: "added-file" }],
    ]);
    expect(added).toEqual([{ id: "sub-added", language: "und", label: "Sintel.fr", objectKey: "obj/added.srt", format: "srt", source: "added-file" }]);
    // The player switches it on like a fetched one: it joins the menu after the session's own tracks.
    const menu = withFetchedSubtitles([], [fetchedSubtitleToPlayerTrack(added[0]!)]);
    log("menu after add", menu.map((track) => [track.id, track.label]));
    expect(menu.map((track) => track.id)).toEqual(["sub-added"]);
  });

  /** @req PLAY-SUBGET-23[badger-mobile] */
  it("refuses a file that isn't a subtitle it can read, and stores nothing", async () => {
    const { calls, added, params } = setupFile();
    for (const file of [
      { name: "notes.txt", content: srt },
      { name: "broken.srt", content: "just some text" },
      { name: "movie.ass", content: "" },
    ]) {
      await expect(storeSubtitleFilePhone(file, params)).rejects.toBeInstanceOf(UnreadableSubtitleFileError);
    }
    log("unreadable calls", calls);
    expect(calls).toEqual([]);
    expect(added).toEqual([]);
  });
});

describe("fetched subtitles in the player menu", () => {
  /** @req PLAY-SUBGET-02[badger-mobile] */
  it("lists a fetched subtitle after the session's own, once, loaded from its stored file", () => {
    const fetched = fetchedSubtitleToPlayerTrack({
      id: "sub-new",
      language: "fr",
      label: "French",
      objectKey: "obj/fr.srt",
      format: "srt",
      source: "fetched:9",
    });
    // Text subtitles are the player's "vtt" kind, as for library rows; the source lets the menu offer another version.
    expect(fetched).toEqual({
      id: "sub-new",
      language: "fr",
      label: "French",
      isDefault: false,
      format: "vtt",
      encrypted: false,
      url: "obj/fr.srt",
      source: "fetched:9",
    });
    const base = [{ id: "sub-en", language: "en", label: "English" }] as unknown as SubtitleTrack[];
    expect(withFetchedSubtitles(base, [fetched]).map((t) => t.id)).toEqual(["sub-en", "sub-new"]);
    expect(withFetchedSubtitles([...base, fetched], [fetched]).map((t) => t.id)).toEqual(["sub-en", "sub-new"]);
    expect(withFetchedSubtitles(base, [])).toBe(base);
  });

  /** @req PLAY-SUBGET-07[badger-mobile] */
  it("puts another version in the old one's row, whether the old one came with the session or was fetched in it", () => {
    const track = (id: string, source: string) => ({ id, language: "es", label: "Spanish", source }) as unknown as SubtitleTrack;
    const base = [track("sub-en", "srt"), track("sub-es", "fetched:11")];

    // A session track replaced, then replaced again: one Spanish row, at the same index, holding the latest file.
    let state = replacePlayerSubtitle({ fetched: [], replaced: {} }, "sub-es", track("sub-es-2", "fetched:12"));
    state = replacePlayerSubtitle(state, "sub-es-2", track("sub-es-3", "fetched:13"));
    const menu = withFetchedSubtitles(base, state.fetched, state.replaced);
    log("menu after two replacements", menu.map((t) => ({ id: t.id, source: t.source })));
    expect(menu.map((t) => t.id)).toEqual(["sub-en", "sub-es-3"]);
    expect(state.replaced).toEqual({ "sub-es": track("sub-es-3", "fetched:13") });

    // A track fetched in this playback replaced: swapped in place in the fetched list.
    const fetchedState = replacePlayerSubtitle({ fetched: [track("sub-fr", "fetched:31")], replaced: {} }, "sub-fr", track("sub-fr-2", "fetched:32"));
    expect(withFetchedSubtitles(base, fetchedState.fetched, fetchedState.replaced).map((t) => t.id)).toEqual(["sub-en", "sub-es", "sub-fr-2"]);
  });
});

describe("Try another version on the phone (PLAY-SUBGET-07)", () => {
  const candidate = (fileId: number, over: Partial<SubtitleFetchCandidate> = {}): SubtitleFetchCandidate => ({
    fileId,
    language: "es",
    hearingImpaired: false,
    foreignPartsOnly: false,
    release: "Sintel (2010) 1080p",
    fileName: "Sintel.2010.srt",
    downloadCount: 1000 - fileId,
    ready: true,
    ...over,
  });
  const spanish = { id: "sub-es", language: "es", label: "Spanish", source: "fetched:11" };

  // The library lists the fetched Spanish track with its stored file; the player only passes the track's id.
  const withSpanish = {
    ...sintel,
    subtitleTracks: [...sintel.subtitleTracks, { id: "sub-es", episodeId: null, language: "es", label: "Spanish", source: "fetched:11", objectKey: "obj/es-1.srt" }],
  } as unknown as MediaDetails;

  const run = async (subtitles: SubtitleFetchCandidate[], abortAfter?: SubtitleVersionStep, inUse: string[] = []) => {
    const calls: unknown[] = [];
    const added: FetchedSubtitleTrack[] = [];
    const input = subtitleTryAnotherPhoneInput({
      media: withSpanish,
      episodeId: null,
      uiLanguage: "en",
      track: spanish,
      client: {
        subtitles: async (request) => (calls.push(["search", request]), { reachable: true, subtitles }) as never,
        subtitleFile: async (fileId) => (calls.push(["download", fileId]), { format: "srt", content: `v${fileId}\n` }) as never,
      },
      actions: {
        uploadSubtitleContent: async (mediaId, episodeId, content, format) => (calls.push(["upload", mediaId, episodeId, content, format]), "obj/es-2.srt"),
        addSubtitleTrack: async (track) => (calls.push(["addTrack", track]), "sub-es-2"),
        removeSubtitleTrack: async (trackId) => void calls.push(["removeTrack", trackId]),
        subtitleObjectInUse: async (key) => (calls.push(["inUse", key]), inUse.includes(key)),
        deleteStoredObjects: async (keys) => void calls.push(["delete", keys]),
        setTrackPrefs: async (mediaId, patch) => void calls.push(["prefs", mediaId, patch]),
      },
      onTrackAdded: (track) => added.push(track),
    });
    expect(input).not.toBeNull();
    const steps: SubtitleVersionStep[] = [];
    const abort = new AbortController();
    const outcome = await tryAnotherSubtitleVersion(
      input!,
      (step) => {
        steps.push(step);
        if (step === abortAfter) abort.abort();
      },
      abort.signal,
    );
    log(`run (abortAfter ${abortAfter ?? "-"})`, { outcome, steps, calls, added });
    return { outcome, steps, calls, added };
  };

  /** @req PLAY-SUBGET-07[badger-mobile] */
  it("stores the next file of the same entry under the same name, drops the old track, and the player shows it in its row", async () => {
    const { outcome, steps, calls, added } = await run([candidate(12), candidate(11), candidate(31, { language: "fr" })]);
    expect(outcome).toBe("replaced");
    expect(steps).toEqual(["looking", "downloading", "saving", "replaced"]);
    expect(calls.slice(0, 5)).toEqual([
      ["search", { type: "movie", id: 45745 }],
      ["download", 12],
      ["upload", "media-sintel", null, "v12\n", "srt"],
      ["addTrack", { mediaId: "media-sintel", episodeId: null, language: "es", label: "Spanish", objectKey: "obj/es-2.srt", format: "srt", source: "fetched:12" }],
      ["removeTrack", "sub-es"],
    ]);
    // The old file is deleted once no track names it (#2502 follow-up: no leak like #2449).
    expect(calls.slice(5, 7)).toEqual([
      ["inUse", "obj/es-1.srt"],
      ["delete", ["obj/es-1.srt"]],
    ]);
    expect(calls[7]).toEqual(["prefs", "media-sintel", subtitlePickPatch({ language: "es", format: "srt" })]);
    expect(added).toEqual([{ id: "sub-es-2", language: "es", label: "Spanish", objectKey: "obj/es-2.srt", format: "srt", source: "fetched:12" }]);

    // What PlayerScreen does with it on close: the old row now holds the new track, nothing else changes.
    const base = [
      { id: "sub-en", language: "en", label: "English", source: "srt" },
      { id: "sub-es", language: "es", label: "Spanish", source: "fetched:11" },
    ] as unknown as SubtitleTrack[];
    const state = replacePlayerSubtitle({ fetched: [], replaced: {} }, "sub-es", fetchedSubtitleToPlayerTrack(added[0]!));
    const menu = withFetchedSubtitles(base, state.fetched, state.replaced);
    expect(menu.map((t) => [t.id, t.label, t.source])).toEqual([
      ["sub-en", "English", "srt"],
      ["sub-es-2", "Spanish", "fetched:12"],
    ]);
  });

  /** @req PLAY-SUBGET-07[badger-mobile] */
  it("says none is left when the track holds the last file, and changes nothing", async () => {
    const { outcome, steps, calls, added } = await run([candidate(11), candidate(31, { language: "fr" })]);
    expect(outcome).toBe("none-left");
    expect(steps).toEqual(["looking", "none-left"]);
    expect(calls).toEqual([["search", { type: "movie", id: 45745 }]]);
    expect(added).toEqual([]);
  });

  /** @req PLAY-SUBGET-07[badger-mobile] */
  it("Back while it looks cancels with nothing changed", async () => {
    const { outcome, calls, added } = await run([candidate(12), candidate(11)], "looking");
    expect(outcome).toBeNull();
    expect(calls.filter((call) => (call as string[])[0] !== "search")).toEqual([]);
    expect(added).toEqual([]);
  });

  it("is null for a title without a catalog id", () => {
    const input = subtitleTryAnotherPhoneInput({
      media: { ...sintel, catalogId: null } as MediaDetails,
      episodeId: null,
      uiLanguage: "en",
      track: spanish,
      client: { subtitles: async () => ({}) as never, subtitleFile: async () => ({}) as never },
      actions: {
        uploadSubtitleContent: async () => "",
        addSubtitleTrack: async () => "",
        removeSubtitleTrack: async () => {},
        subtitleObjectInUse: async () => true,
        deleteStoredObjects: async () => {},
        setTrackPrefs: async () => {},
      },
    });
    expect(input).toBeNull();
  });

  /** @req PLAY-SUBGET-07[badger-mobile] */
  it("keeps the old file while another track still names it", async () => {
    const { outcome, calls } = await run([candidate(12), candidate(11)], undefined, ["obj/es-1.srt"]);
    expect(outcome).toBe("replaced");
    expect(calls).toContainEqual(["inUse", "obj/es-1.srt"]);
    expect(calls.filter((call) => (call as string[])[0] === "delete")).toEqual([]);
  });
});
