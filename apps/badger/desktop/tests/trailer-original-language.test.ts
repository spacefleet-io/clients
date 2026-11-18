/**
 * @req LIB-LANG-02
 * @test-id DESKTOP-TRAILER-LANG-001..004
 * @level unit
 * @bugfix trailer-language-change-asks-details
 *
 * Why: after a trailer-language change, opening the trailers of a title stored before its original language was
 * kept asked the metadata service for the title's full details answer, every time and for every such title, only to
 * read that one field. The kept texts (LIB-LANG-02) come from that same answer: the original language is read there,
 * and asked only when no kept answer names it, once per title and language (the answer is then kept).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const LOG = "[trailer-original-language]";

const { getMetadataDetailsMock } = vi.hoisted(() => ({ getMetadataDetailsMock: vi.fn() }));
vi.mock("@/api", () => ({
  searchMetadata: vi.fn(),
  getMetadataDetails: getMetadataDetailsMock,
  getMetadataTrailers: vi.fn(),
}));

import { getLocalizedOverview, setDesktopTextsLibrary, trailerOriginalLanguage } from "@/lib/metadata";

const memoryLibrary = () => {
  const rows = new Map<string, { value: string }>();
  return {
    rows,
    getSetting: vi.fn(async (key: string) => rows.get(key) ?? null),
    setSetting: vi.fn(async (key: string, value: string) => void rows.set(key, { value })),
  };
};

const answer = (language: string) => ({
  item: { id: 603, type: "movie", title: "The Matrix", overview: `Synopsis (${language}).`, originalLanguage: "en", genres: [], episodes: [] },
});

beforeEach(() => {
  getMetadataDetailsMock.mockReset();
  getMetadataDetailsMock.mockImplementation(async (_token: string, type: string, id: number, language: string) => {
    console.info(`${LOG} details ${type}:${id}:${language}`);
    return answer(language);
  });
});

describe("a trailer refresh reads the title's original language without a new details lookup (LIB-LANG-02)", () => {
  it("DESKTOP-TRAILER-LANG-001: the stored original language asks nothing", async () => {
    setDesktopTextsLibrary(memoryLibrary() as never);
    expect(await trailerOriginalLanguage("tok", { type: "movie", tmdbId: 603, originalLanguage: "ja" }, "fr")).toBe("ja");
    expect(getMetadataDetailsMock).not.toHaveBeenCalled();
  });

  it("DESKTOP-TRAILER-LANG-002: a title with none reads it from the texts the detail page kept", async () => {
    const library = memoryLibrary();
    setDesktopTextsLibrary(library as never);
    // The detail page showed the synopsis in French: one lookup, kept in the library with the original language.
    await getLocalizedOverview("tok", "movie", 603, "fr");
    expect(getMetadataDetailsMock).toHaveBeenCalledTimes(1);
    console.info(`${LOG} kept rows=${JSON.stringify([...library.rows])}`);

    // A later session (another device) with only the library row: the trailer refresh asks nothing.
    setDesktopTextsLibrary(null);
    setDesktopTextsLibrary(library as never);
    expect(await trailerOriginalLanguage("tok", { type: "movie", tmdbId: 603, originalLanguage: null }, "fr")).toBe("en");
    expect(getMetadataDetailsMock).toHaveBeenCalledTimes(1);
  });

  it("DESKTOP-TRAILER-LANG-003: with no kept answer naming it, asks once per title and language and keeps the answer", async () => {
    const library = memoryLibrary();
    setDesktopTextsLibrary(library as never);
    const title = { type: "movie" as const, tmdbId: 604, originalLanguage: null };
    expect(await trailerOriginalLanguage("tok", title, "de")).toBe("en");
    expect(await trailerOriginalLanguage("tok", title, "de")).toBe("en");
    console.info(`${LOG} calls=${JSON.stringify(getMetadataDetailsMock.mock.calls)}`);
    expect(getMetadataDetailsMock).toHaveBeenCalledTimes(1);
    expect(getMetadataDetailsMock.mock.calls[0]?.[3]).toBe("de");
    // The answer is kept as that language's texts, so the detail page reads it too.
    expect(await getLocalizedOverview("tok", "movie", 604, "de")).toBe("Synopsis (de).");
    expect(getMetadataDetailsMock).toHaveBeenCalledTimes(1);
  });

  it("DESKTOP-TRAILER-LANG-004: a row kept before the original language was stored asks once, then reads the refreshed row", async () => {
    const library = memoryLibrary();
    library.rows.set("localized_text_v1:movie:605:fr", {
      value: JSON.stringify({ v: 1, overview: "Ancien.", episodes: [], absent: [], fetchedAt: "2026-11-16T00:00:00.000Z" }),
    });
    setDesktopTextsLibrary(library as never);
    const title = { type: "movie" as const, tmdbId: 605, originalLanguage: null };
    expect(await trailerOriginalLanguage("tok", title, "fr")).toBe("en");
    expect(await trailerOriginalLanguage("tok", title, "fr")).toBe("en");
    expect(getMetadataDetailsMock).toHaveBeenCalledTimes(1);
  });
});
