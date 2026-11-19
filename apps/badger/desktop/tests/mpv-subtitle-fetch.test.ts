// @req PLAY-SUBGET-02[badger-desktop]
// @req PLAY-SUBGET-24[badger-desktop]
// @req PLAY-SUBGET-23[badger-desktop]
import { describe, expect, it, vi } from "vitest";
import {
  UnreadableSubtitleFileError,
  type SubtitleFetchCandidate,
  type SubtitleFetchEntry,
  type SubtitleFetchTarget,
  type SubtitleTitleMatch,
} from "@space/shared/subtitleFetch";
import type { SubtitleFetchView } from "@space/mpv-protocol";
import {
  createMpvSubtitleFetch,
  parseSubtitleFetchMessage,
  type MpvSubtitleFetchDeps,
} from "../src/renderer/src/lib/mpvSubtitleFetch";

const target: SubtitleFetchTarget = {
  request: { type: "movie", id: 603 },
  libraryFileName: "Sandglass (2021) [1080p].mkv",
  existingTracks: [],
};

const candidate = (fileId: number, language: string): SubtitleFetchCandidate => ({
  fileId,
  language,
  hearingImpaired: false,
  foreignPartsOnly: false,
  release: "Sandglass (2021) 1080p",
  fileName: "Sandglass (2021) [1080p].srt",
  downloadCount: 100,
  ready: false,
});

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const setup = (overrides: Partial<MpvSubtitleFetchDeps> = {}) => {
  const views: SubtitleFetchView[] = [];
  const deps: MpvSubtitleFetchDeps = {
    uiLanguage: "en",
    target,
    search: vi.fn(async () => ({ reachable: true, subtitles: [candidate(1, "fr"), candidate(2, "de")] })),
    store: vi.fn(async (_entry: SubtitleFetchEntry, report: (stage: "downloading" | "saving") => void, _signal: AbortSignal) => {
      report("downloading");
      report("saving");
    }),
    show: (view) => views.push(view),
    onAdded: vi.fn(),
    onCancelled: vi.fn(),
    wait: async () => {},
    ...overrides,
  };
  return { deps, views, flow: createMpvSubtitleFetch(deps) };
};

const panels = (views: SubtitleFetchView[]) => views.flatMap((view) => ("panel" in view ? [view.panel] : []));
const lastList = (views: SubtitleFetchView[]) => {
  const lists = views.flatMap((view) => ("list" in view ? [view.list] : []));
  return lists[lists.length - 1];
};

describe("parseSubtitleFetchMessage", () => {
  it("reads open, version, cancel and pick from sf-subtitle-fetch only", () => {
    expect(parseSubtitleFetchMessage({ type: "script_message", name: "sf-subtitle-fetch", args: ["open"] })).toEqual({ action: "open" });
    expect(parseSubtitleFetchMessage({ type: "script_message", name: "sf-subtitle-fetch", args: ["version"] })).toEqual({ action: "version" });
    expect(parseSubtitleFetchMessage({ type: "script_message", name: "sf-subtitle-fetch", args: ["cancel"] })).toEqual({ action: "cancel" });
    expect(parseSubtitleFetchMessage({ type: "script_message", name: "sf-subtitle-fetch", args: ["pick", "k1"] })).toEqual({ action: "pick", key: "k1" });
    expect(parseSubtitleFetchMessage({ type: "script_message", name: "sf-subtitle-fetch", args: ["pick"] })).toBeNull();
    expect(parseSubtitleFetchMessage({ type: "script_message", name: "sf-select-pick", args: ["open"] })).toBeNull();
    expect(parseSubtitleFetchMessage(null)).toBeNull();
  });

  it("reads title <text> and add-file", () => {
    expect(parseSubtitleFetchMessage({ type: "script_message", name: "sf-subtitle-fetch", args: ["title", "Alien"] })).toEqual({
      action: "title",
      text: "Alien",
    });
    expect(parseSubtitleFetchMessage({ type: "script_message", name: "sf-subtitle-fetch", args: ["title"] })).toEqual({ action: "title", text: "" });
    expect(parseSubtitleFetchMessage({ type: "script_message", name: "sf-subtitle-fetch", args: ["add-file"] })).toEqual({ action: "add-file" });
  });
});

describe("createMpvSubtitleFetch", () => {
  it("no catalog target: shows the unavailable message", async () => {
    const { deps, views, flow } = setup({ target: null });
    flow.handle({ action: "open" });
    await flush();
    expect(deps.search).not.toHaveBeenCalled();
    expect(panels(views)).toEqual([expect.stringContaining("Something went wrong")]);
  });

  it("nothing found vs provider unreachable vs search error", async () => {
    const none = setup({ search: async () => ({ reachable: true, subtitles: [] }) });
    none.flow.handle({ action: "open" });
    await flush();
    expect(panels(none.views)).toEqual(["Looking for subtitles…", "No subtitles found for this one."]);

    const down = setup({ search: async () => ({ reachable: false, subtitles: [] }) });
    down.flow.handle({ action: "open" });
    await flush();
    expect(panels(down.views)[1]).toContain("Something went wrong");

    const thrown = setup({ search: async () => Promise.reject(new Error("boom")) });
    thrown.flow.handle({ action: "open" });
    await flush();
    expect(panels(thrown.views)[1]).toContain("Something went wrong");
  });

  it("lists languages, then a pick downloads, saves, shows added, closes and reports the entry", async () => {
    const { deps, views, flow } = setup();
    flow.handle({ action: "open" });
    await flush();
    const list = lastList(views);
    expect(list.prompt).toBe("Pick a language");
    expect(list.items.map((item) => item.label)).toEqual(expect.arrayContaining(["French", "German"]));
    const french = list.items.find((item) => item.label === "French")!;
    flow.handle({ action: "pick", key: french.key });
    await flush();
    expect(deps.store).toHaveBeenCalledTimes(1);
    expect(panels(views).slice(1)).toEqual(["Getting French subtitles", "Downloading", "Saving to your media library", expect.stringMatching(/ added$/)]);
    expect(views.slice(-5, -1).every((view) => "panel" in view && view.dismissable)).toBe(true);
    expect(views[views.length - 1]).toEqual({ close: true });
    expect(deps.onAdded).toHaveBeenCalledWith(expect.objectContaining({ key: french.key, language: "fr" }));
    expect(deps.onCancelled).not.toHaveBeenCalled();
  });

  it("never downloads a subtitle the title already has, fetched or come with the file (PLAY-SUBGET-24)", async () => {
    const { deps, views, flow } = setup({
      target: {
        ...target,
        existingTracks: [
          { language: "fr", label: "French", source: "upload" },
          { language: "de", label: "German", source: "fetched:7" },
        ],
      },
    });
    flow.handle({ action: "open" });
    await flush();
    const list = lastList(views);
    const labels = list.items.map((item) => item.label);
    console.info("[PLAY-SUBGET-24] desktop list", JSON.stringify(labels));
    expect(labels.every((label) => label.endsWith("Already in your media library"))).toBe(true);
    for (const item of list.items) flow.handle({ action: "pick", key: item.key });
    await flush();
    expect(deps.store).not.toHaveBeenCalled();
    expect(lastList(views)).toEqual(list);
  });

  it("a failed store shows a dismissable retry message", async () => {
    const { deps, views, flow } = setup({ store: async () => Promise.reject(new Error("upload")) });
    flow.handle({ action: "open" });
    await flush();
    flow.handle({ action: "pick", key: lastList(views).items[0].key });
    await flush();
    expect(views[views.length - 1]).toEqual({ panel: expect.stringMatching(/^Couldn't add .+\. Try again\.$/), dismissable: true });
    expect(deps.onAdded).not.toHaveBeenCalled();
  });

  it("cancel closes and resumes; a late search answer is dropped", async () => {
    const pending = Promise.withResolvers<{ reachable: boolean; subtitles: SubtitleFetchCandidate[] }>();
    const { deps, views, flow } = setup({ search: () => pending.promise });
    flow.handle({ action: "open" });
    flow.handle({ action: "cancel" });
    pending.resolve({ reachable: true, subtitles: [candidate(1, "fr")] });
    await flush();
    expect(views).toEqual([{ panel: "Looking for subtitles…", dismissable: true }, { close: true }]);
    expect(deps.onCancelled).toHaveBeenCalledTimes(1);
  });

  it("Escape while downloading or saving aborts the store, adds nothing and resumes", async () => {
    let signal: AbortSignal | undefined;
    const pending = Promise.withResolvers<void>();
    const { deps, views, flow } = setup({
      store: (_entry, _report, abort) => {
        signal = abort;
        return pending.promise;
      },
    });
    flow.handle({ action: "open" });
    await flush();
    flow.handle({ action: "pick", key: lastList(views).items[0].key });
    await flush();
    flow.handle({ action: "cancel" });
    expect(signal?.aborted).toBe(true);
    expect(deps.onCancelled).toHaveBeenCalledTimes(1);
    expect(views[views.length - 1]).toEqual({ close: true });
    pending.resolve();
    await flush();
    expect(deps.onAdded).not.toHaveBeenCalled();
    expect(views[views.length - 1]).toEqual({ close: true });
  });

  it("Escape on the added panel only skips the wait", async () => {
    const hold = Promise.withResolvers<void>();
    const { deps, views, flow } = setup({ wait: () => hold.promise });
    flow.handle({ action: "open" });
    await flush();
    flow.handle({ action: "pick", key: lastList(views).items[0].key });
    await flush();
    expect(deps.onAdded).not.toHaveBeenCalled();
    flow.handle({ action: "cancel" });
    await flush();
    expect(deps.onAdded).toHaveBeenCalledTimes(1);
    expect(deps.onCancelled).not.toHaveBeenCalled();
    expect(views[views.length - 1]).toEqual({ close: true });
  });
});

// @req PLAY-SUBGET-07[badger-desktop]
describe("createMpvSubtitleFetch: Try another version", () => {
  type Outcome = "replaced" | "none-left" | "unavailable" | "failed";
  const runner = (outcome: Outcome, steps: ("looking" | "downloading" | "saving")[] = ["looking"]) =>
    vi.fn(async (report: (step: Outcome | "looking" | "downloading" | "saving") => void, _signal: AbortSignal) => {
      for (const step of steps) report(step);
      report(outcome);
      return outcome;
    });

  it("replaced: looking, downloading, saving, replaced; then closes and the player switches it on", async () => {
    const run = runner("replaced", ["looking", "downloading", "saving"]);
    const onReplaced = vi.fn();
    const { deps, views, flow } = setup({ tryAnother: { name: "Spanish", run }, onReplaced });
    flow.handle({ action: "version" });
    await flush();
    console.info("[mpv-subtitle-fetch:version] views", JSON.stringify(views));
    expect(panels(views)).toEqual([
      "Looking for another version…",
      "Downloading",
      "Saving to your media library",
      "Spanish replaced with another version",
    ]);
    expect(views[views.length - 1]).toEqual({ close: true });
    expect(onReplaced).toHaveBeenCalledTimes(1);
    expect(deps.onCancelled).not.toHaveBeenCalled();
    expect(deps.search).not.toHaveBeenCalled();
  });

  it("none left: the line stays until Escape, which closes and resumes", async () => {
    const onReplaced = vi.fn();
    const { deps, views, flow } = setup({ tryAnother: { name: "Spanish", run: runner("none-left") }, onReplaced });
    flow.handle({ action: "version" });
    await flush();
    expect(views[views.length - 1]).toEqual({ panel: "No other version of Spanish left", dismissable: true });
    expect(deps.onCancelled).not.toHaveBeenCalled();
    flow.handle({ action: "cancel" });
    expect(views[views.length - 1]).toEqual({ close: true });
    expect(deps.onCancelled).toHaveBeenCalledTimes(1);
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("a failed replace says so and keeps the old subtitle", async () => {
    const onReplaced = vi.fn();
    const { views, flow } = setup({ tryAnother: { name: "Spanish", run: runner("failed") }, onReplaced });
    flow.handle({ action: "version" });
    await flush();
    expect(views[views.length - 1]).toEqual({ panel: "Couldn't replace Spanish. Try again.", dismissable: true });
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("Escape while it runs aborts it: nothing replaced, playback resumes", async () => {
    let signal: AbortSignal | undefined;
    const pending = Promise.withResolvers<null>();
    const onReplaced = vi.fn();
    const { deps, views, flow } = setup({
      tryAnother: {
        name: "Spanish",
        run: (report, abort) => {
          signal = abort;
          report("looking");
          return pending.promise;
        },
      },
      onReplaced,
    });
    flow.handle({ action: "version" });
    flow.handle({ action: "cancel" });
    expect(signal?.aborted).toBe(true);
    pending.resolve(null);
    await flush();
    expect(views).toEqual([{ panel: "Looking for another version…", dismissable: true }, { close: true }]);
    expect(deps.onCancelled).toHaveBeenCalledTimes(1);
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("without a fetched subtitle on, version does nothing", async () => {
    const { deps, views, flow } = setup();
    flow.handle({ action: "version" });
    await flush();
    expect(views).toEqual([]);
    expect(deps.onCancelled).not.toHaveBeenCalled();
  });
});

// @req PLAY-SUBGET-24[badger-desktop]
describe("createMpvSubtitleFetch: no catalog id, the title step first", () => {
  const alien: SubtitleTitleMatch = { catalogId: 348, title: "Alien", year: "1979" };
  const byTitle = (find: (query: string) => Promise<SubtitleTitleMatch[]>, overrides: Partial<MpvSubtitleFetchDeps> = {}) =>
    setup({
      target: null,
      findTitle: { query: "Alien", find: vi.fn(find) },
      // Only the picked match's catalog id goes to the search, never the file name (PLAY-SUBGET-14).
      targetFor: (match) => ({ ...target, request: { type: "movie", id: match.catalogId } }),
      ...overrides,
    });

  it("asks for the title prefilled with the one the app shows, lists the matches, then searches the picked one by catalog id", async () => {
    const { deps, views, flow } = byTitle(async () => [alien]);
    flow.handle({ action: "open" });
    await flush();
    expect(views).toEqual([{ title: { prompt: "Which film or show is this?", field: "Title", query: "Alien" } }]);
    expect(deps.search).not.toHaveBeenCalled();

    flow.handle({ action: "title", text: " Alien " });
    await flush();
    expect(deps.findTitle!.find).toHaveBeenCalledWith("Alien");
    expect(panels(views)).toEqual(["Looking for “Alien”…"]);
    const titles = lastList(views);
    expect(titles.items).toEqual([{ key: "title:348", label: "Alien (1979)" }]);

    flow.handle({ action: "pick", key: "title:348" });
    await flush();
    expect(deps.search).toHaveBeenCalledWith({ type: "movie", id: 348 });
    expect(lastList(views).prompt).toBe("Pick a language");
  });

  it("nothing found for the typed title asks again, saying so", async () => {
    const { views, flow } = byTitle(async () => []);
    flow.handle({ action: "open" });
    flow.handle({ action: "title", text: "Alien" });
    await flush();
    expect(views[views.length - 1]).toEqual({
      title: { prompt: "Nothing found for “Alien”. Check the title and try again.", field: "Title", query: "Alien" },
    });
  });

  it("no subtitle for the picked title offers Search another title, which asks for the title again", async () => {
    const { views, flow } = byTitle(async () => [alien], { search: vi.fn(async () => ({ reachable: true, subtitles: [] })) });
    flow.handle({ action: "open" });
    flow.handle({ action: "title", text: "Alien" });
    await flush();
    flow.handle({ action: "pick", key: "title:348" });
    await flush();
    const other = lastList(views);
    expect(other).toEqual({ prompt: "No subtitles found for this one.", items: [{ key: "other-title", label: "Search another title" }] });
    flow.handle({ action: "pick", key: "other-title" });
    await flush();
    expect(views[views.length - 1]).toEqual({ title: { prompt: "Which film or show is this?", field: "Title", query: "Alien" } });
  });
});

// @req PLAY-SUBGET-23[badger-desktop]
describe("createMpvSubtitleFetch: Add a subtitle file…", () => {
  const file = { name: "Home video.srt", content: "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n" };

  it("stores the picked file, says it's added, closes and reports it so the player switches it on", async () => {
    const stored = { language: "fr", label: "French", format: "srt", source: "added-file" } as const;
    const store = vi.fn(async () => stored);
    const { deps, views, flow } = setup({ addFile: { pick: async () => file, store }, onFileAdded: vi.fn() });
    flow.handle({ action: "add-file" });
    await flush();
    expect(store).toHaveBeenCalledWith(file);
    expect(panels(views)).toEqual(["Adding the subtitle file…", "French added"]);
    expect(views[0]).toEqual({ panel: "Adding the subtitle file…", dismissable: false });
    expect(views[views.length - 1]).toEqual({ close: true });
    expect(deps.onFileAdded).toHaveBeenCalledWith(expect.objectContaining({ source: "added-file", label: "French" }));
    expect(deps.search).not.toHaveBeenCalled();
  });

  it("an unreadable file says so and adds nothing", async () => {
    const { deps, views, flow } = setup({
      addFile: { pick: async () => ({ name: "notes.txt", content: "hello" }), store: async () => Promise.reject(new UnreadableSubtitleFileError("notes.txt")) },
      onFileAdded: vi.fn(),
    });
    flow.handle({ action: "add-file" });
    await flush();
    expect(panels(views)).toEqual(["Adding the subtitle file…", "This file isn't a subtitle we can read"]);
    expect(deps.onFileAdded).not.toHaveBeenCalled();
  });

  it("cancelling the file picker shows nothing and resumes", async () => {
    const store = vi.fn();
    const { deps, views, flow } = setup({ addFile: { pick: async () => null, store }, onFileAdded: vi.fn() });
    flow.handle({ action: "add-file" });
    await flush();
    expect(views).toEqual([]);
    expect(store).not.toHaveBeenCalled();
    expect(deps.onCancelled).toHaveBeenCalledTimes(1);
  });
});
