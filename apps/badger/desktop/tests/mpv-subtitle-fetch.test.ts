// @req PLAY-SUBGET-02[badger-desktop]
// @req PLAY-SUBGET-24[badger-desktop]
import { describe, expect, it, vi } from "vitest";
import type { SubtitleFetchCandidate, SubtitleFetchEntry, SubtitleFetchTarget } from "@space/shared/subtitleFetch";
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
});

describe("createMpvSubtitleFetch", () => {
  it("no TMDB target: shows the unavailable message", async () => {
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
          { language: "de", label: "German", source: "opensubtitles:7" },
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
