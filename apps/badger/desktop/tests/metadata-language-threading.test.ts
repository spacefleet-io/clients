import { describe, it, expect, vi, beforeEach } from "vitest";

// metadata.ts pulls getMetadataDetails (the anonymous-ticket metadata-service lookup) from @/api.
// Mock just that surface so we can assert the language argument is threaded
// through; the other named imports are types (erased) or unused here.
const { getMetadataDetailsMock } = vi.hoisted(() => ({ getMetadataDetailsMock: vi.fn() }));
vi.mock("@/api", () => ({
  getMetadataDetails: getMetadataDetailsMock,
  searchMetadata: vi.fn(),
  getMetadataTrailers: vi.fn(),
}));

import {
  getTitleDetails,
  getLocalizedOverview,
  getTitleDetailsForLibrary,
} from "@/lib/metadata";

// On assertion failure, dump the metadata-lookup mock calls and any captured
// URLs — the whole point of these tests is "what language was threaded
// where", so the call args / URLs ARE the diagnostic. Wrapped so a dump
// failure can't mask the real assertion failure.
const dumpThreadingSnapshot = (
  label: string,
  ctx: { urls?: string[]; observed?: unknown },
) => {
  try {
    console.error(`=== [metadata-language-threading:${label}] snapshot ===`);
    console.error(
      `getMetadataDetails calls (${getMetadataDetailsMock.mock.calls.length}):\n${JSON.stringify(getMetadataDetailsMock.mock.calls, null, 2)}`,
    );
    if (ctx.urls) {
      console.error(`captured fetch URLs (${ctx.urls.length}):\n${JSON.stringify(ctx.urls, null, 2)}`);
    }
    if (ctx.observed !== undefined) {
      console.error(`observed: ${JSON.stringify(ctx.observed)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("getTitleDetails language threading (Phase 0)", () => {
  beforeEach(() => {
    getMetadataDetailsMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("forwards the requested language to the metadata service", async () => {
    console.info(`[metadata-language-threading:proxy-fr] getTitleDetails(movie, 123, lang=fr)`);
    getMetadataDetailsMock.mockResolvedValue({ item: { id: 1, type: "movie", title: "X", genres: [] } });
    await getTitleDetails("tok", "movie", 123, "fr");
    const lastCall = getMetadataDetailsMock.mock.calls.at(-1);
    if (JSON.stringify(lastCall) !== JSON.stringify(["tok", "movie", 123, "fr"])) {
      dumpThreadingSnapshot("proxy-fr", {});
    }
    expect(getMetadataDetailsMock).toHaveBeenCalledWith("tok", "movie", 123, "fr");
  });

  it("defaults to en when no language is supplied (back-compat)", async () => {
    console.info(`[metadata-language-threading:proxy-default-en] getTitleDetails(movie, 123, no lang)`);
    getMetadataDetailsMock.mockResolvedValue({ item: { id: 1, type: "movie", title: "X", genres: [] } });
    await getTitleDetails("tok", "movie", 123);
    const lastCall = getMetadataDetailsMock.mock.calls.at(-1);
    if (JSON.stringify(lastCall) !== JSON.stringify(["tok", "movie", 123, "en"])) {
      dumpThreadingSnapshot("proxy-default-en", {});
    }
    expect(getMetadataDetailsMock).toHaveBeenCalledWith("tok", "movie", 123, "en");
  });
});

describe("getLocalizedOverview (Phase 1 description overlay source)", () => {
  beforeEach(() => {
    getMetadataDetailsMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("requests the overview in the given language and returns it", async () => {
    console.info(`[metadata-language-threading:overview-proxy-fr] getLocalizedOverview(movie, 7, lang=fr)`);
    getMetadataDetailsMock.mockResolvedValue({ item: { overview: "Synopsis en français" } });
    const overview = await getLocalizedOverview("tok", "movie", 7, "fr");
    const lastCall = getMetadataDetailsMock.mock.calls.at(-1);
    // The token is unused by getMetadataDetails (tickets authenticate), so the library-backed texts source passes "".
    if (JSON.stringify(lastCall) !== JSON.stringify(["", "movie", 7, "fr"]) || overview !== "Synopsis en français") {
      dumpThreadingSnapshot("overview-proxy-fr", { observed: overview });
    }
    expect(getMetadataDetailsMock).toHaveBeenCalledWith("", "movie", 7, "fr");
    expect(overview).toBe("Synopsis en français");
  });

  it("returns null when the metadata service has no overview (so the caller keeps its fallback)", async () => {
    console.info(`[metadata-language-threading:overview-empty] empty overview should yield null`);
    getMetadataDetailsMock.mockResolvedValue({ item: { overview: "" } });
    // A different title: the texts source keeps answers for the session (LIB-LANG-02), so movie 7 is already known.
    const overview = await getLocalizedOverview("tok", "movie", 8, "fr");
    if (overview !== null) {
      dumpThreadingSnapshot("overview-empty", { observed: overview });
    }
    expect(overview).toBeNull();
  });
});

// @req ACCT-PROF-03[badger-desktop]
describe("getTitleDetailsForLibrary (a new import stores the account-language set)", () => {
  beforeEach(() => {
    getMetadataDetailsMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("stores the title, poster and backdrop in the account's language, in one lookup, whatever the original language", async () => {
    console.info(`[metadata-language-threading:account-fr] originalLanguage=it, accountLanguage=fr → one fr lookup`);
    getMetadataDetailsMock.mockImplementation(async (_t: string, _ty: string, _id: number, lang: string) => ({
      item: { id: 1, type: "movie", title: `T-${lang}`, originalLanguage: "it", posterPath: `/p-${lang}`, backdropPath: `/b-${lang}`, genres: [] },
    }));
    const details = await getTitleDetailsForLibrary("tok", "movie", 1, { accountLanguage: "fr" });
    const langs = getMetadataDetailsMock.mock.calls.map((c) => c[3]);
    console.info(`[metadata-language-threading:account-fr] lang sequence=${JSON.stringify(langs)} title=${details.title}`);
    if (details.title !== "T-fr") dumpThreadingSnapshot("account-fr", { observed: { langs, title: details.title } });
    expect(langs).toEqual(["fr"]);
    expect(details.title).toBe("T-fr");
    expect(details.posterPath).toBe("/p-fr");
  });

  it("an English account stores the English set (La Haine → Hate)", async () => {
    console.info(`[metadata-language-threading:account-en] originalLanguage=fr, accountLanguage=en → one en lookup`);
    getMetadataDetailsMock.mockImplementation(async (_t: string, _ty: string, _id: number, lang: string) => ({
      item: { id: 1, type: "movie", title: lang === "fr" ? "La Haine" : "Hate", originalLanguage: "fr", posterPath: `/p-${lang}`, backdropPath: null, genres: [] },
    }));
    const details = await getTitleDetailsForLibrary("tok", "movie", 1, { accountLanguage: "en" });
    const langs = getMetadataDetailsMock.mock.calls.map((c) => c[3]);
    console.info(`[metadata-language-threading:account-en] lang sequence=${JSON.stringify(langs)} title=${details.title}`);
    expect(langs).toEqual(["en"]);
    expect(details.title).toBe("Hate");
  });

  it("an account-language answer not in Latin letters takes the English title, poster and backdrop, keeping the texts", async () => {
    console.info(`[metadata-language-threading:fallback] accountLanguage=fr, fr answer in Japanese → en title`);
    getMetadataDetailsMock.mockImplementation(async (_t: string, _ty: string, _id: number, lang: string) => ({
      item: {
        id: 1,
        type: "movie",
        title: lang === "fr" ? "ドラゴンボールZ 神と神" : "Dragon Ball Z: Battle of Gods",
        overview: `Synopsis-${lang}`,
        originalLanguage: "ja",
        posterPath: `/p-${lang}`,
        backdropPath: `/b-${lang}`,
        genres: [],
      },
    }));
    const details = await getTitleDetailsForLibrary("tok", "movie", 1, { accountLanguage: "fr" });
    const langs = getMetadataDetailsMock.mock.calls.map((c) => c[3]);
    console.info(`[metadata-language-threading:fallback] lang sequence=${JSON.stringify(langs)} title=${details.title} overview=${details.overview}`);
    if (details.title !== "Dragon Ball Z: Battle of Gods") dumpThreadingSnapshot("fallback", { observed: details });
    expect(langs).toEqual(["fr", "en"]);
    expect(details.title).toBe("Dragon Ball Z: Battle of Gods");
    expect(details.posterPath).toBe("/p-en");
    expect(details.backdropPath).toBe("/b-en");
    expect(details.overview).toBe("Synopsis-fr");
  });
});
