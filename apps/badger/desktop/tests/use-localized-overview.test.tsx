// @vitest-environment jsdom
//
// Phase 1 — descriptions follow the device UI language.
// Tests for the useLocalizedOverview hook: it shows the stored overview first,
// swaps to the live UI-language overview once fetched, falls back to stored on
// error / when there is no catalogId, and caches per (type, catalogId, language).
// LIB-LANG-01: with no synopsis in the UI language it shows the English one, never the stored German one.

import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks — the hook depends on auth (token), i18n (UI language), client config,
// and the metadata fetch. We mock the fetch entirely so config content is moot.
// ---------------------------------------------------------------------------
const { getLocalizedOverviewMock } = vi.hoisted(() => ({ getLocalizedOverviewMock: vi.fn() }));
let uiLanguage = "fr";
let authToken: string | null = "tok";

vi.mock("@/lib/metadata", () => ({ getLocalizedOverview: getLocalizedOverviewMock }));
vi.mock("@/auth", () => ({ useAuth: () => ({ token: authToken }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: uiLanguage } }) }));

import { localizedOverviews } from "@space/metadata-client";
import { useLocalizedOverview } from "@/lib/useLocalizedOverview";

let container: HTMLDivElement;
let root: Root;
let lastValue: string | null = null;

function Harness({ media }: { media: { id: string; type: "movie" | "tv"; catalogId: number | null; overview: string | null } | null }) {
  lastValue = useLocalizedOverview(media);
  return null;
}

const renderHarness = async (media: Parameters<typeof Harness>[0]["media"]) => {
  await act(async () => {
    root.render(<Harness media={media} />);
  });
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const movie = (overrides: Record<string, unknown> = {}) => ({
  id: "m1",
  type: "movie" as const,
  catalogId: 42,
  overview: "STORED OVERVIEW",
  ...overrides,
});

// Dump the hook's resolved value + the mock fetch call history so an
// overview-swap / cache assertion failure is diagnosable offline. Wrapped in
// try/catch so the dump can't mask the real assertion failure.
const dumpOverviewSnapshot = (label: string) => {
  try {
    console.error(`=== [use-localized-overview:${label}] snapshot ===`);
    console.error(
      `uiLanguage=${JSON.stringify(uiLanguage)} authToken=${JSON.stringify(authToken)}`,
    );
    console.error(`lastValue (hook result)=${JSON.stringify(lastValue)}`);
    console.error(
      `getLocalizedOverview mock: calls=${getLocalizedOverviewMock.mock.calls.length}`,
    );
    console.error(
      `mock call args:\n${JSON.stringify(getLocalizedOverviewMock.mock.calls, null, 2)}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  localizedOverviews.clear();
  getLocalizedOverviewMock.mockReset();
  uiLanguage = "fr";
  authToken = "tok";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  console.info(
    `[use-localized-overview:setup] fresh root + cleared cache, uiLanguage=${uiLanguage} authToken=${JSON.stringify(authToken)}`,
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useLocalizedOverview", () => {
  it("shows the stored overview first, then swaps to the fetched UI-language overview", async () => {
    let resolveFetch: (v: string | null) => void = () => {};
    getLocalizedOverviewMock.mockImplementation(
      () => new Promise<string | null>((res) => { resolveFetch = res; })
    );

    console.info("[use-localized-overview:swap] rendering harness with pending fetch");
    await renderHarness(movie());
    // Before the fetch resolves, the stored overview is shown.
    if (lastValue !== "STORED OVERVIEW") dumpOverviewSnapshot("swap-stored-while-loading");
    expect(lastValue, "should show stored overview while loading").toBe("STORED OVERVIEW");
    if (getLocalizedOverviewMock.mock.calls.length === 0) dumpOverviewSnapshot("swap-fetch-not-called");
    expect(getLocalizedOverviewMock).toHaveBeenCalledWith("tok", "movie", 42, "fr");

    console.info("[use-localized-overview:swap] resolving fetch with localized overview");
    await act(async () => {
      resolveFetch("Synopsis en français");
      await Promise.resolve();
    });
    if (lastValue !== "Synopsis en français") dumpOverviewSnapshot("swap-no-localized-swap");
    expect(lastValue, "should swap to the localized overview").toBe("Synopsis en français");
  });

  it("keeps the stored overview when the fetch yields nothing", async () => {
    console.info("[use-localized-overview:null-fetch] fetch resolves to null → keep stored");
    getLocalizedOverviewMock.mockResolvedValue(null);
    await renderHarness(movie());
    await flush();
    if (lastValue !== "STORED OVERVIEW") dumpOverviewSnapshot("null-fetch-failure");
    expect(lastValue).toBe("STORED OVERVIEW");
  });

  it("falls back to the stored overview when the fetch throws (offline / metadata service error)", async () => {
    console.info("[use-localized-overview:throw-fetch] fetch rejects (offline) → keep stored");
    getLocalizedOverviewMock.mockRejectedValue(new Error("offline"));
    await renderHarness(movie());
    await flush();
    if (lastValue !== "STORED OVERVIEW") dumpOverviewSnapshot("throw-fetch-failure");
    expect(lastValue).toBe("STORED OVERVIEW");
  });

  it("does not fetch when the work has no catalogId", async () => {
    console.info("[use-localized-overview:no-catalog-id] rendering work with catalogId=null → must not fetch");
    await renderHarness(movie({ catalogId: null }));
    await flush();
    if (getLocalizedOverviewMock.mock.calls.length !== 0 || lastValue !== "STORED OVERVIEW") {
      dumpOverviewSnapshot("no-catalog-id-failure");
    }
    expect(getLocalizedOverviewMock).not.toHaveBeenCalled();
    expect(lastValue).toBe("STORED OVERVIEW");
  });

  it("caches per (type, catalogId, language) — re-mounting the same work does not re-fetch", async () => {
    getLocalizedOverviewMock.mockResolvedValue("Synopsis en français");

    console.info("[use-localized-overview:cache] first mount → expect exactly 1 fetch");
    await renderHarness(movie());
    await flush();
    if (getLocalizedOverviewMock.mock.calls.length !== 1) dumpOverviewSnapshot("cache-first-mount-call-count");
    expect(getLocalizedOverviewMock).toHaveBeenCalledTimes(1);

    // Re-mount the same work: the cached value is used, no second metadata lookup.
    console.info("[use-localized-overview:cache] re-mount same work → expect cache hit (still 1 fetch)");
    await act(() => root.unmount());
    root = createRoot(container);
    await renderHarness(movie());
    await flush();
    if (getLocalizedOverviewMock.mock.calls.length !== 1 || lastValue !== "Synopsis en français") {
      dumpOverviewSnapshot("cache-remount-failure");
    }
    expect(getLocalizedOverviewMock, "cache hit must avoid a second fetch").toHaveBeenCalledTimes(1);
    expect(lastValue).toBe("Synopsis en français");
  });

  /**
   * @req LIB-LANG-01
   * @bugfix german-synopsis-under-english-ui
   * @regression-proof
   * A German film added in "auto" title language stores its German synopsis. With a UI language the catalog has no synopsis
   * in, the desktop kept that German text; it now shows the English synopsis.
   */
  it("shows the English synopsis, not the stored German one, when the catalog has none in the UI language", async () => {
    getLocalizedOverviewMock.mockImplementation(async (_token: string, _type: string, _id: number, language: string) =>
      language === "en" ? "A violinist is blackmailed." : null
    );
    console.info("[use-localized-overview:fallback] uiLanguage=fr, the catalog has en only, stored overview is German");
    await renderHarness(movie({ catalogId: 28055, overview: "Ein Geiger wird erpresst." }));
    await flush();
    await flush();
    if (lastValue !== "A violinist is blackmailed.") dumpOverviewSnapshot("fallback-failure");
    expect(getLocalizedOverviewMock.mock.calls.map((call) => call[3])).toEqual(["fr", "en"]);
    expect(lastValue).toBe("A violinist is blackmailed.");
  });
});
