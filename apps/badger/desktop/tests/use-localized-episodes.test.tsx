// @vitest-environment jsdom
/**
 * @req LIB-LANG-01
 * @bugfix german-episode-synopsis-under-english-ui
 *
 * Episode names + synopses follow the device UI language, else English, through the desktop adapter over the shared
 * `useLocalizedEpisodes` hook: a Map keyed by `${season}:${episode}`, empty while loading / signed out (render sites
 * show the stored text), kept per (show, language), asked again when the UI language flips.
 */
import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { localizedEpisodes, type EpisodeText, type LocalizedEpisodeMap } from "@space/metadata-client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { getLocalizedEpisodesMock } = vi.hoisted(() => ({ getLocalizedEpisodesMock: vi.fn() }));
let uiLanguage = "fr";
let authToken: string | null = "tok";

vi.mock("@/lib/metadata", () => ({ getLocalizedEpisodes: getLocalizedEpisodesMock }));
vi.mock("@/auth", () => ({ useAuth: () => ({ token: authToken }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: uiLanguage } }) }));

import { useLocalizedEpisodes } from "@/lib/useLocalizedEpisodes";

type ShowInput = {
  id: string;
  type: "movie" | "tv";
  catalogId: number | null;
  episodes?: { seasonNumber: number; episodeNumber: number }[];
} | null;

let container: HTMLDivElement;
let root: Root;
let lastValue: LocalizedEpisodeMap = new Map();

function Harness({ show }: { show: ShowInput }) {
  lastValue = useLocalizedEpisodes(show);
  return null;
}

const renderHarness = async (show: ShowInput) => {
  await act(async () => {
    root.render(<Harness show={show} />);
  });
};

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};

const snapshot = (label: string) => {
  console.error(`=== [use-localized-episodes:${label}] uiLanguage=${uiLanguage} authToken=${JSON.stringify(authToken)}`);
  console.error(`lastValue=${JSON.stringify([...lastValue.entries()])}`);
  console.error(`calls=${JSON.stringify(getLocalizedEpisodesMock.mock.calls)}`);
};

const check = (label: string, assert: () => void) => {
  try {
    assert();
  } catch (err) {
    snapshot(label);
    throw err;
  }
};

const ep = (episodeNumber: number, name: string | null, overview: string | null): EpisodeText => ({
  seasonNumber: 1,
  episodeNumber,
  name,
  overview,
});

const tvShow = (): NonNullable<ShowInput> => ({ id: "show1", type: "tv", catalogId: 100 });

beforeEach(() => {
  localizedEpisodes.clear();
  getLocalizedEpisodesMock.mockReset();
  uiLanguage = "fr";
  authToken = "tok";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  lastValue = new Map();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useLocalizedEpisodes (desktop adapter)", () => {
  it("returns empty while loading, then the localized map", async () => {
    const pendingFetch = Promise.withResolvers<EpisodeText[]>();
    getLocalizedEpisodesMock.mockReturnValue(pendingFetch.promise);
    await renderHarness(tvShow());
    console.info(`[use-localized-episodes:loading] size=${lastValue.size} calls=${JSON.stringify(getLocalizedEpisodesMock.mock.calls)}`);
    check("loading", () => {
      expect(lastValue.size).toBe(0);
      // The 4th argument is the library's episode keys (LIB-LANG-02); this fixture carries none.
      expect(getLocalizedEpisodesMock).toHaveBeenCalledWith("tok", 100, "fr", undefined);
    });
    await act(async () => pendingFetch.resolve([ep(1, "Le Début", "Tout commence.")]));
    await flush();
    console.info(`[use-localized-episodes:loaded] ${JSON.stringify([...lastValue])}`);
    check("loaded", () => expect(lastValue.get("1:1")).toEqual({ name: "Le Début", overview: "Tout commence." }));
  });

  it("takes a synopsis missing in the UI language from English", async () => {
    uiLanguage = "en";
    getLocalizedEpisodesMock.mockResolvedValue([ep(1, "Pilot", "In English.")]);
    await renderHarness(tvShow());
    await flush();
    check("en", () => expect(lastValue.get("1:1")?.overview).toBe("In English."));

    localizedEpisodes.clear();
    getLocalizedEpisodesMock.mockReset();
    uiLanguage = "fr";
    getLocalizedEpisodesMock.mockImplementation(async (_token: string, _id: number, language: string) =>
      language === "fr" ? [ep(1, "Pilote", null)] : [ep(1, "Pilot", "In English.")]
    );
    await renderHarness({ ...tvShow(), id: "show1-rematch" });
    await flush();
    console.info(`[use-localized-episodes:fallback] langs=${JSON.stringify(getLocalizedEpisodesMock.mock.calls.map((c) => c[2]))} value=${JSON.stringify([...lastValue])}`);
    check("fallback", () => {
      expect(lastValue.get("1:1")).toEqual({ name: "Pilote", overview: "In English." });
      expect(getLocalizedEpisodesMock.mock.calls.map((c) => c[2])).toEqual(["fr", "en"]);
    });
  });

  it("keeps the answer per show and language: a remount asks nothing", async () => {
    getLocalizedEpisodesMock.mockResolvedValue([ep(1, "Le Début", "Tout commence.")]);
    await renderHarness(tvShow());
    await flush();
    await act(() => root.unmount());
    root = createRoot(container);
    await renderHarness(tvShow());
    await flush();
    check("remount", () => {
      expect(getLocalizedEpisodesMock).toHaveBeenCalledTimes(1);
      expect(lastValue.get("1:1")?.name).toBe("Le Début");
    });
  });

  it("asks again when the UI language changes", async () => {
    getLocalizedEpisodesMock.mockImplementation(async (_token: string, _id: number, language: string) => [
      ep(1, language === "fr" ? "Le Début" : "The Beginning", language === "fr" ? "Tout commence." : "It begins."),
    ]);
    await renderHarness(tvShow());
    await flush();
    uiLanguage = "en";
    await renderHarness(tvShow());
    await flush();
    check("lang-flip", () => {
      expect(getLocalizedEpisodesMock.mock.calls.map((c) => c[2])).toEqual(["fr", "en"]);
      expect(lastValue.get("1:1")?.name).toBe("The Beginning");
    });
  });

  it("asks nothing signed out, or for a movie", async () => {
    authToken = null;
    await renderHarness(tvShow());
    await flush();
    authToken = "tok";
    await renderHarness({ id: "movie1", type: "movie", catalogId: 5 });
    await flush();
    check("guards", () => {
      expect(getLocalizedEpisodesMock).not.toHaveBeenCalled();
      expect(lastValue.size).toBe(0);
    });
  });

  it("LIB-LANG-02: an episode added while the app runs asks once, live and on the next display, then nothing", async () => {
    getLocalizedEpisodesMock.mockImplementation(async (_token: string, _id: number, _language: string, keys?: string[]) =>
      (keys ?? []).map((key) => ep(Number(key.split(":")[1]), `Épisode ${key}`, "Texte."))
    );
    const show = (count: number) => ({
      ...tvShow(),
      episodes: Array.from({ length: count }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1 })),
    });
    await renderHarness(show(2));
    await flush();
    // A sync rewrites the same episodes: no lookup.
    await renderHarness(show(2));
    await flush();
    check("before", () => expect(getLocalizedEpisodesMock).toHaveBeenCalledTimes(1));

    // Episode 3 arrives mid-session while the page is open: one more lookup, carrying it.
    await renderHarness(show(3));
    await flush();
    check("live", () => {
      expect(getLocalizedEpisodesMock).toHaveBeenCalledTimes(2);
      expect(getLocalizedEpisodesMock.mock.calls[1]?.[3]).toEqual(["1:1", "1:2", "1:3"]);
      expect(lastValue.get("1:3")?.name).toBe("Épisode 1:3");
    });

    // Then flat: reopening the show asks nothing.
    await act(() => root.unmount());
    root = createRoot(container);
    await renderHarness(show(3));
    await flush();
    check("after", () => expect(getLocalizedEpisodesMock).toHaveBeenCalledTimes(2));
  });

  it("LIB-LANG-02: an episode added while the page is closed asks once on the next display", async () => {
    getLocalizedEpisodesMock.mockImplementation(async (_token: string, _id: number, _language: string, keys?: string[]) =>
      (keys ?? []).map((key) => ep(Number(key.split(":")[1]), `Épisode ${key}`, "Texte."))
    );
    await renderHarness({ ...tvShow(), episodes: [{ seasonNumber: 1, episodeNumber: 1 }] });
    await flush();
    await act(() => root.unmount());
    root = createRoot(container);
    await renderHarness({ ...tvShow(), episodes: [{ seasonNumber: 1, episodeNumber: 1 }, { seasonNumber: 1, episodeNumber: 2 }] });
    await flush();
    check("reopen", () => {
      expect(getLocalizedEpisodesMock).toHaveBeenCalledTimes(2);
      expect(lastValue.get("1:2")?.name).toBe("Épisode 1:2");
    });
  });
});
