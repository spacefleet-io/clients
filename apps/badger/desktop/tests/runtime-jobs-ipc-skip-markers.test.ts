/**
 * @bugfix @regression-proof (Chris 2026-10-28, "Lodgers has no TIDB data? more
 * likely an error"): the import modal fetched service markers per episode
 * and put them on each source (`skipMarkers`, `showSkipCache`), but the main
 * process `sf-runtime-jobs-submit-sources` handler rebuilt every source from a
 * fixed field list that did not include them. The runtime then defaulted both
 * and the commit wrote no marker, so TV/mobile never showed "Skip intro".
 *
 * Drives the real main-process IPC handler with electron + runtime-client
 * mocked, and asserts on the exact command payload sent to the runtime.
 */
// @req PLAY-NEXT-02[badger-desktop] @req META-SKIP-03[badger-desktop]
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BadgerIngestSubmitSourceItem } from "@space/runtime-contracts/badger/ingest";
import { registerRuntimeJobsIpc, setRuntimeJobsBackendToken } from "../src/main/runtimeJobsIpc";

const P = "[runtime-jobs-ipc-skip-markers]";

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  sent: [] as Array<{ payload: Record<string, unknown> }>,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      state.handlers.set(channel, fn);
    },
  },
}));

vi.mock("@space/runtime-client/session", () => ({
  createRuntimeSession: () => ({ getToken: async () => "session-token" }),
}));

vi.mock("@space/runtime-client/command", () => ({
  createRuntimeCommandClient: () => ({
    sendCommand: async (_contract: unknown, payload: Record<string, unknown>) => {
      console.info(`[runtime-jobs-ipc-skip-markers]:sendCommand payload=${JSON.stringify(payload)}`);
      state.sent.push({ payload });
      return { submitted: [], addedJobIds: [] };
    },
  }),
}));

const dumpSent = (label: string) => {
  console.error(`=== ${P}:${label} sent commands ===\n${JSON.stringify(state.sent, null, 2)}\n=== end ===`);
};

const intro = {
  type: "intro" as const,
  startSeconds: 0,
  endSeconds: 46,
  source: "metadata",
  confidence: null,
};

const showSkipCache = {
  provider: "metadata-v1",
  showCatalogId: 901668,
  fetchedAt: "2026-10-28T00:00:00.000Z",
  coverage: [{ seasonNumber: 1, episodeNumber: 1, status: "hit" as const, markerTypes: ["intro" as const] }],
  markersByEpisode: { "1:1": [intro] },
};

const submit = async (sources: Array<Record<string, unknown>>): Promise<BadgerIngestSubmitSourceItem[]> => {
  const fn = state.handlers.get("sf-runtime-jobs-submit-sources");
  if (!fn) console.error(`${P} missing handler; registered=${[...state.handlers.keys()].join(",")}`);
  expect(fn).toBeTypeOf("function");
  await (fn as Handler)({}, { userId: "u1", sources });
  const call = state.sent.find((s) => Array.isArray(s.payload.sources));
  if (!call) dumpSent("submit-missing");
  return (call?.payload.sources ?? []) as BadgerIngestSubmitSourceItem[];
};

beforeAll(() => {
  registerRuntimeJobsIpc({ runtimeBaseUrl: "http://127.0.0.1:3020", getFallbackCopy: async () => false });
  setRuntimeJobsBackendToken("backend-token");
  console.info(`${P}:setup handlers=${[...state.handlers.keys()].join(",")}`);
});

beforeEach(() => {
  state.sent.length = 0;
});

describe("submit-sources forwards the service markers fetched at import", () => {
  it("skipMarkers and showSkipCache reach the runtime submit command", async () => {
    const rendererSource = {
      filename: "/videos/Lodgers - S01E01.mkv",
      sizeMb: 700,
      desiredFormats: [],
      hints: { mediaId: "media-lodgers", season: 1, episode: 1, matchedTitle: "Lodgers" },
      skipMarkers: [intro],
      showSkipCache,
    };
    const [forwarded] = await submit([rendererSource]);
    console.info(`${P}:renderer keys=${Object.keys(rendererSource).join(",")}`);
    console.info(`${P}:forwarded keys=${Object.keys(forwarded ?? {}).join(",")}`);
    if (!forwarded?.skipMarkers) dumpSent("markers-dropped");
    expect(forwarded?.skipMarkers).toEqual([intro]);
    expect(forwarded?.showSkipCache).toEqual(showSkipCache);
  });

  it("an empty skipMarkers array (fetched, no data) is kept, distinct from not fetched", async () => {
    const [fetchedEmpty, notFetched] = await submit([
      { filename: "/videos/Lodgers - S01E02.mkv", hints: { season: 1, episode: 2 }, skipMarkers: [] },
      { filename: "/videos/Orchard (2017).mkv" },
    ]);
    console.info(`${P}:empty=${JSON.stringify(fetchedEmpty)} movie=${JSON.stringify(notFetched)}`);
    expect(fetchedEmpty?.skipMarkers).toEqual([]);
    expect(notFetched).not.toHaveProperty("skipMarkers");
    expect(notFetched).not.toHaveProperty("showSkipCache");
  });

  it("still strips empty override arrays, and a computer whose copies switch is off asks for no copies", async () => {
    const [s] = await submit([
      {
        filename: "/videos/Lodgers - S01E03.mkv",
        desiredFormats: ["480p", "720p"],
        audioOverrides: [],
        subtitleOverrides: [{ index: 2, language: "fr", label: "Français" }],
        skipMarkers: [intro],
      },
    ]);
    console.info(`${P}:ladder=${JSON.stringify(s)}`);
    // INGS-FALLBK-01 / ACCT-SQUAD-03 (#1752): with "This computer makes copies" off (getFallbackCopy → false above),
    // the computer makes none of the automatic copies, so it stores only the original.
    expect(s?.desiredFormats).toEqual([]);
    expect(s?.audioOverrides).toBeUndefined();
    expect(s?.subtitleOverrides).toEqual([{ index: 2, language: "fr", label: "Français" }]);
    expect(s?.sizeMb).toBeNull();
  });
});
