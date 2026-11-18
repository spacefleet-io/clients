/**
 * @req LIB-LANG-02
 * @test-id DESKTOP-IMPORT-TEXTS-001..003
 * @level unit
 * @bugfix import-texts-asked-again
 *
 * Why: an import already holds the title's details answer in the account's language (the interface language,
 * UX-I18N-07; ACCT-PROF-03 stores titles in it) and, from the import preview, that same answer, yet the first detail
 * page asked the interface-language answer again. "An import ... that already fetched the title's details in that
 * language keeps that answer with no extra lookup": the import keeps the account-language answer as the kept texts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const LOG = "[import-keeps-texts]";

const { getMetadataDetailsMock } = vi.hoisted(() => ({ getMetadataDetailsMock: vi.fn() }));
vi.mock("@/api", () => ({
  searchMetadata: vi.fn(),
  getMetadataDetails: getMetadataDetailsMock,
  getMetadataTrailers: vi.fn(),
}));

import {
  getLocalizedEpisodes,
  getLocalizedOverview,
  getTmdbDetailsForLibrary,
  localizeSearchResultForLibrary,
  setDesktopTextsLibrary,
} from "@/lib/metadata";

const memoryLibrary = () => {
  const rows = new Map<string, { value: string }>();
  return {
    rows,
    getSetting: async (key: string) => rows.get(key) ?? null,
    setSetting: async (key: string, value: string) => void rows.set(key, { value }),
  };
};

/** An English-language show; every language answers its own synopsis and episode names. */
const answer = (type: string, id: number, language: string) => ({
  item: {
    id,
    type,
    title: `Title ${language}`,
    originalTitle: "Title",
    overview: `Synopsis (${language}).`,
    originalLanguage: "en",
    genres: [],
    posterPath: null,
    backdropPath: null,
    episodes: type === "tv" ? [{ seasonNumber: 1, episodeNumber: 1, name: `Pilot (${language})`, overview: `Ep (${language}).` }] : [],
  },
});

const hit = (type: "movie" | "tv", id: number) =>
  ({ id, type, title: "Title en", originalTitle: "Title", originalLanguage: "en", overview: "Synopsis (en).", posterPath: null, backdropPath: null }) as never;

beforeEach(() => {
  getMetadataDetailsMock.mockReset();
  getMetadataDetailsMock.mockImplementation(async (_token: string, type: string, id: number, language: string) => {
    console.info(`${LOG} details ${type}:${id}:${language}`);
    return answer(type, id, language);
  });
  setDesktopTextsLibrary(memoryLibrary() as never);
});

describe("an import keeps the interface-language answer it already fetched (LIB-LANG-02)", () => {
  it("DESKTOP-IMPORT-TEXTS-001: English account: the English answer is kept, the detail page asks nothing", async () => {
    await getTmdbDetailsForLibrary("tok", "tv", 701, { accountLanguage: "en" });
    expect(getMetadataDetailsMock).toHaveBeenCalledTimes(1);
    expect(await getLocalizedOverview("tok", "tv", 701, "en")).toBe("Synopsis (en).");
    expect((await getLocalizedEpisodes("tok", 701, "en", ["1:1"]))[0]?.name).toBe("Pilot (en)");
    expect(getMetadataDetailsMock).toHaveBeenCalledTimes(1);
  });

  it("DESKTOP-IMPORT-TEXTS-002: French account: the one French answer is kept", async () => {
    await getTmdbDetailsForLibrary("tok", "movie", 702, { accountLanguage: "fr" });
    console.info(`${LOG} calls=${JSON.stringify(getMetadataDetailsMock.mock.calls.map((call) => call[3]))}`);
    expect(getMetadataDetailsMock.mock.calls.map((call) => call[3])).toEqual(["fr"]);
    expect(await getLocalizedOverview("tok", "movie", 702, "fr")).toBe("Synopsis (fr).");
    expect(getMetadataDetailsMock).toHaveBeenCalledTimes(1);
  });

  it("DESKTOP-IMPORT-TEXTS-003: after a preview, the import's texts are kept and the detail page asks nothing", async () => {
    await localizeSearchResultForLibrary("tok", hit("tv", 703), { accountLanguage: "fr" });
    await getTmdbDetailsForLibrary("tok", "tv", 703, { accountLanguage: "fr" });
    console.info(`${LOG} calls=${JSON.stringify(getMetadataDetailsMock.mock.calls.map((call) => call[3]))}`);
    expect(getMetadataDetailsMock.mock.calls.map((call) => call[3])).toEqual(["fr", "fr"]);
    expect(await getLocalizedOverview("tok", "tv", 703, "fr")).toBe("Synopsis (fr).");
    expect((await getLocalizedEpisodes("tok", 703, "fr", ["1:1"]))[0]?.name).toBe("Pilot (fr)");
    expect(getMetadataDetailsMock).toHaveBeenCalledTimes(2);
  });
});
