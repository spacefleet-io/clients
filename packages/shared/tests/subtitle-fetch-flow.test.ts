/**
 * @req PLAY-SUBGET-02[badger-mobile]
 * @req PLAY-SUBGET-05[badger-mobile]
 * @req PLAY-SUBGET-12[badger-mobile]
 * @req PLAY-SUBGET-18[badger-mobile]
 * @req PLAY-SUBGET-25[badger-mobile,badger-tv]
 *
 * The steps of "Get subtitles" shared by the web UI's `SubtitleFetchFlow` and the phone's sheet and player overlay
 * (`useSubtitleFetchFlow` → `createSubtitleFetchFlow`).
 */
import { describe, expect, it } from "vitest";
import type { SubtitleFetchCandidate } from "../src/subtitleFetch";
import {
  createSubtitleFetchFlow,
  subtitleFetchEntryPickable,
  subtitleFetchProgressLine,
  type SubtitleFetchFlowInput,
  type SubtitleFetchFlowState,
} from "../src/subtitleFetchFlow";
import { subtitleFetchCopy } from "../src/subtitleFetch";

const candidate = (over: Partial<SubtitleFetchCandidate>): SubtitleFetchCandidate => ({
  fileId: 1,
  language: "fr",
  release: "Sintel (2010) 1080p",
  fileName: "Sintel (2010) [1080p].srt",
  hearingImpaired: false,
  foreignPartsOnly: false,
  downloadCount: 10,
  ready: true,
  ...over,
});

const flowWith = (over: Partial<SubtitleFetchFlowInput>) => {
  const states: SubtitleFetchFlowState[] = [];
  const input: SubtitleFetchFlowInput = {
    uiLanguage: "en",
    libraryFileName: "Sintel (2010) [1080p].mkv",
    existingTracks: [],
    search: async () => ({ reachable: true, subtitles: [candidate({}), candidate({ fileId: 2, language: "de" })] }),
    store: async () => {},
    ...over,
  };
  const flow = createSubtitleFetchFlow(() => input, (state) => {
    states.push(state);
    console.log("[subtitle-fetch-flow] state", JSON.stringify({ step: state.step, ...("stage" in state ? { stage: state.stage } : {}) }));
  });
  return { flow, states, steps: () => states.map((s) => ("stage" in s ? `${s.step}:${s.stage}` : s.step)) };
};

describe("createSubtitleFetchFlow", () => {
  it("@req PLAY-SUBGET-05 looks first, then lists only the languages that exist", async () => {
    console.log("[PLAY-SUBGET-05] phase=search");
    const { flow, states, steps } = flowWith({});
    await flow.search();
    console.log("[PLAY-SUBGET-05] steps", steps());
    expect(steps()).toEqual(["looking", "list"]);
    const list = states[1];
    if (list?.step !== "list") throw new Error("no list");
    console.log("[PLAY-SUBGET-05] entries", list.entries.map((e) => e.languageTag));
    expect(list.entries.map((e) => e.languageTag).sort()).toEqual(["de", "fr"]);
  });

  it("@req PLAY-SUBGET-12 tells no subtitles apart from the service being unreachable", async () => {
    const none = flowWith({ search: async () => ({ reachable: true, subtitles: [] }) });
    await none.flow.search();
    const down = flowWith({ search: async () => ({ reachable: false, subtitles: [] }) });
    await down.flow.search();
    const rejects = flowWith({ search: async () => Promise.reject(new Error("subtitles_unavailable")) });
    await rejects.flow.search();
    console.log("[PLAY-SUBGET-12] steps", none.steps(), down.steps(), rejects.steps());
    expect(none.steps()).toEqual(["looking", "none"]);
    expect(down.steps()).toEqual(["looking", "unavailable"]);
    expect(rejects.steps()).toEqual(["looking", "unavailable"]);
  });

  it("@req PLAY-SUBGET-25 hands on the credit each search answer carries, and null when it carries none", async () => {
    const credit = { text: "Subtitles provided by", name: "Example Subtitles", url: "https://subtitles.example" };
    const run = async (search: SubtitleFetchFlowInput["search"]) => {
      const credits: unknown[] = [];
      const input: SubtitleFetchFlowInput = { uiLanguage: "en", libraryFileName: "Sintel (2010) [1080p].mkv", existingTracks: [], search, store: async () => {} };
      await createSubtitleFetchFlow(() => input, () => {}, (c) => credits.push(c)).search();
      return credits;
    };
    const sent = await run(async () => ({ reachable: true, subtitles: [candidate({})], credit }));
    const none = await run(async () => ({ reachable: true, subtitles: [candidate({})] }));
    console.log("[PLAY-SUBGET-25] credits", JSON.stringify({ sent, none }));
    expect(sent).toEqual([credit]);
    expect(none).toEqual([null]);
  });

  it("@req PLAY-SUBGET-05 says what is happening while the pick is stored, then that it was added", async () => {
    const { flow, states, steps } = flowWith({
      store: async (_entry, report) => {
        report("downloading");
        report("saving");
      },
    });
    await flow.search();
    const list = states[1];
    if (list?.step !== "list") throw new Error("no list");
    const french = list.entries.find((e) => e.languageTag === "fr")!;
    const added = await flow.pick(french, list.entries);
    console.log("[PLAY-SUBGET-05] pick steps", steps(), "added", added);
    expect(added).toBe(true);
    expect(steps().slice(2)).toEqual(["progress:getting", "progress:downloading", "progress:saving", "added"]);
    const copy = subtitleFetchCopy("en");
    expect(subtitleFetchProgressLine(copy, french, "getting")).toContain(french.name);
    expect(subtitleFetchProgressLine(copy, french, "saving")).toBe(copy.saving);
  });

  it("@req PLAY-SUBGET-05 returns to the list with a message when storing fails", async () => {
    const { flow, states, steps } = flowWith({ store: async () => Promise.reject(new Error("upload failed")) });
    await flow.search();
    const list = states[1];
    if (list?.step !== "list") throw new Error("no list");
    expect(await flow.pick(list.entries[0]!, list.entries)).toBe(false);
    console.log("[PLAY-SUBGET-05] fail steps", steps());
    expect(steps().at(-1)).toBe("failed");
  });

  it("@req PLAY-SUBGET-18 never fetches a subtitle a second time", async () => {
    let stored = 0;
    const { flow, states } = flowWith({
      existingTracks: [{ language: "fr", label: "French", source: "fetched" }],
      store: async () => {
        stored += 1;
      },
    });
    await flow.search();
    const list = states[1];
    if (list?.step !== "list") throw new Error("no list");
    const french = list.entries.find((e) => e.languageTag === "fr")!;
    console.log("[PLAY-SUBGET-18] french", JSON.stringify({ already: french.already, pickable: subtitleFetchEntryPickable(french) }));
    expect(french.already).toBe("fetched");
    expect(subtitleFetchEntryPickable(french)).toBe(false);
    expect(await flow.pick(french, list.entries)).toBe(false);
    expect(stored).toBe(0);
  });

  it("@req PLAY-SUBGET-24 never downloads a subtitle the title already has, even one that came with the file", async () => {
    let stored = 0;
    const { flow, states } = flowWith({
      existingTracks: [{ language: "fr", label: "French", source: "upload" }],
      store: async () => {
        stored += 1;
      },
    });
    await flow.search();
    const list = states[1];
    if (list?.step !== "list") throw new Error("no list");
    const french = list.entries.find((e) => e.languageTag === "fr")!;
    const german = list.entries.find((e) => e.languageTag === "de")!;
    console.log("[PLAY-SUBGET-24] french", JSON.stringify({ already: french.already, pickable: subtitleFetchEntryPickable(french) }));
    expect(french.already).toBe("file");
    expect(subtitleFetchEntryPickable(french)).toBe(false);
    expect(await flow.pick(french, list.entries)).toBe(false);
    expect(stored).toBe(0);
    // A subtitle the title doesn't have yet still downloads.
    expect(await flow.pick(german, list.entries)).toBe(true);
    expect(stored).toBe(1);
  });

  it("@req PLAY-SUBGET-02 leaving mid-way aborts the store and never says added", async () => {
    let seen: AbortSignal | null = null;
    const gate = Promise.withResolvers<void>();
    const { flow, states, steps } = flowWith({
      store: (_entry, report, signal) => {
        seen = signal;
        report("downloading");
        return gate.promise;
      },
    });
    await flow.search();
    const list = states[1];
    if (list?.step !== "list") throw new Error("no list");
    const picking = flow.pick(list.entries[0]!, list.entries);
    console.log("[PLAY-SUBGET-02] phase=dispose mid-download", steps());
    flow.dispose();
    gate.resolve();
    const added = await picking;
    console.log("[PLAY-SUBGET-02] after dispose", steps(), "aborted", (seen as AbortSignal | null)?.aborted, "added", added);
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(added).toBe(false);
    expect(steps()).not.toContain("added");
  });
});
