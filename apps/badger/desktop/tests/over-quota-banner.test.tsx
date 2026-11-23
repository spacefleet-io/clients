// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountAccess, AccountOverQuota } from "@space/shared/accountAccess";
import type { AccountOverQuotaTitles } from "@space/shared/api";
import { OverQuotaBanner, REMOVED_SEEN_KEY } from "../src/renderer/src/components/OverQuotaBanner";
// The titles dialog is a lazy chunk of the banner. Loaded cold inside a test, its module graph transform counted
// against the 10 s waits below: on a loaded runner (run 47404, suite 401 s against ~220 s) the dialog rendered only
// after the wait gave up. Imported here, it loads at collection and the banner's `lazy()` resolves from the cache.
import "../src/renderer/src/components/OverQuotaTitlesDialog";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  user: null as { id: string; access?: AccountAccess } | null,
  titles: null as unknown,
  media: [] as Array<{ id: string }>,
  details: {} as Record<string, unknown>,
  offline: [] as Array<{ scope: unknown; title: string }>,
}));

vi.mock("@/auth", () => ({
  useAuth: () => ({ user: state.user, token: "tok" }),
}));

vi.mock("@/api", () => ({
  getAccountOverQuotaTitles: vi.fn(async () => state.titles),
}));

vi.mock("@/lib/libraryContext", () => {
  const fetchMediaDetails = async (id: string) => state.details[id] ?? null;
  return {
    useLibraryData: () => ({ media: state.media }),
    useLibraryActions: () => ({ fetchMediaDetails }),
  };
});

vi.mock("@/lib/useClientConfig", () => ({ useClientConfig: () => ({}) }));

vi.mock("@/components/OfflineDownloadConfirmDialog", () => ({
  default: ({ scope, details }: { scope: unknown; details: { title: string } }) => {
    state.offline.push({ scope, title: details.title });
    return <div data-testid="offline-confirm">{details.title}</div>;
  },
}));

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const GB = 1024 ** 3;

const accessWith = (overQuota: AccountOverQuota | null): AccountAccess => ({
  state: "paid",
  paidUntil: iso(20),
  billingPeriod: "monthly",
  wipeAt: null,
  qosTier: "paid",
  overQuota,
});

const timeline = (phase: "grace" | "frozen", deleting = false): AccountOverQuota => ({
  phase,
  since: iso(phase === "grace" ? -5 : -35),
  graceUntil: iso(phase === "grace" ? 25 : -5),
  deletionAt: iso(phase === "grace" ? 55 : 25),
  deleting,
});

const titlesOf = (overrides: Partial<AccountOverQuotaTitles>): AccountOverQuotaTitles => ({
  overQuota: null as unknown as AccountOverQuotaTitles["overQuota"],
  usedBytes: 120 * GB,
  limitBytes: 100 * GB,
  excessBytes: 20 * GB,
  atRisk: [],
  remainingOverBytes: 0,
  removed: [],
  ...overrides,
});

const format = (placementId: string, fileId: string | null) => ({
  fileId,
  initKey: `media/${placementId}/init.mp4`,
  chunks: [{ key: `media/${placementId}/chunk-0.m4s` }],
});

const movie = {
  id: "m1",
  title: "Arrival",
  type: "movie",
  episodes: [],
  files: [],
  formats: [format("pl-movie", null)],
  audioTracks: [],
  subtitleTracks: [],
};

const show = {
  id: "s1",
  title: "Severance",
  type: "tv",
  episodes: [{ id: "ep-2-3", seasonNumber: 2, episodeNumber: 3 }],
  files: [{ id: "f1", season: 2, episode: 3 }],
  formats: [format("pl-episode", "f1")],
  audioTracks: [],
  subtitleTracks: [],
};

const makeI18n = async (lng: "en" | "fr") => {
  const instance = createInstance();
  await instance.init({
    lng,
    fallbackLng: "en",
    resources: { en: { translation: en }, fr: { translation: fr } },
    interpolation: { escapeValue: false },
  });
  return instance;
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

describe("OverQuotaBanner (ACCT-OVER-01/04)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      });
    }
  };

  const render = async (lng: "en" | "fr" = "en") => {
    const i18n = await makeI18n(lng);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={["/library"]}>
            <OverQuotaBanner />
            <Routes>
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </I18nextProvider>
      );
    });
    await flush();
    return container;
  };

  const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);

  /** Waits for `id` (the dialog and the offline dialog are lazy chunks, slow to load the first time), then clicks it. */
  const click = async (id: string) => {
    await vi.waitFor(
      async () => {
        await flush();
        expect(byTestId(id), `missing ${id}`).not.toBeNull();
      },
      { timeout: 10_000, interval: 20 }
    );
    await act(async () => {
      (byTestId(id) as HTMLElement).click();
    });
    await flush();
  };

  /** Waits for the banner the fetched titles show (the removed notice exists only once `GET /account/over-quota` answered). */
  const shown = async () => {
    await vi.waitFor(
      async () => {
        await flush();
        expect(byTestId("over-quota-banner")).not.toBeNull();
      },
      { timeout: 10_000, interval: 20 }
    );
  };

  /** Waits until the dialog has named the placements (the library walk is async). */
  const named = async () => {
    await vi.waitFor(
      async () => {
        await flush();
        expect(byTestId("over-quota-dialog")).not.toBeNull();
        expect(byTestId("over-quota-loading")).toBeNull();
      },
      { timeout: 10_000, interval: 20 }
    );
  };

  const dump = (label: string) => {
    console.error(`=== [over-quota-banner:${label}] ===`);
    console.error(`user=${JSON.stringify(state.user)}`);
    console.error(`body:\n${document.body.innerHTML}`);
  };

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = "";
    state.user = null;
    state.titles = null;
    state.media = [];
    state.details = {};
    state.offline = [];
    window.localStorage.clear();
  });

  it("@req ACCT-OVER-01 shows the grace phase with its end date and the excess, and the upgrade opens the plan screen", async () => {
    const overQuota = timeline("grace");
    state.user = { id: "u1", access: accessWith(overQuota) };
    state.titles = titlesOf({ overQuota, excessBytes: 20 * GB });
    await render();
    const banner = byTestId("over-quota-banner");
    try {
      expect(banner?.getAttribute("data-phase")).toBe("grace");
      const text = byTestId("over-quota-message")?.textContent ?? "";
      expect(text).toContain("over your plan's storage");
      expect(text).toContain("20");
      expect(text).toContain(String(new Date(overQuota.graceUntil).getFullYear()));
      expect(text).toContain("playback and uploads pause");
      await click("over-quota-upgrade");
      expect(byTestId("location")?.textContent).toBe("/settings?section=account");
    } catch (err) {
      dump("grace");
      throw err;
    }
  });

  it("@req ACCT-OVER-01 shows the frozen phase with the deletion date, in French too", async () => {
    const overQuota = timeline("frozen");
    state.user = { id: "u1", access: accessWith(overQuota) };
    state.titles = titlesOf({ overQuota });
    await render("fr");
    try {
      expect(byTestId("over-quota-banner")?.getAttribute("data-phase")).toBe("frozen");
      const text = byTestId("over-quota-message")?.textContent ?? "";
      expect(text).toContain("la lecture et les envois sont suspendus");
      expect(text).toContain("les titres les plus récents seront supprimés");
      expect(byTestId("over-quota-upgrade")?.textContent).toBe("Changer de forfait");
    } catch (err) {
      dump("frozen");
      throw err;
    }
  });

  it("@req ACCT-OVER-01 says the deletion is running while it runs", async () => {
    const overQuota = timeline("frozen", true);
    state.user = { id: "u1", access: accessWith(overQuota) };
    state.titles = titlesOf({ overQuota });
    await render();
    expect(byTestId("over-quota-banner")?.getAttribute("data-phase")).toBe("deleting");
    expect(byTestId("over-quota-message")?.textContent).toContain("being deleted until it fits");
  });

  it("@req ACCT-OVER-01 @req ACCT-OVER-04 names the titles at risk from the library, each with a download button", async () => {
    const overQuota = timeline("frozen");
    state.user = { id: "u1", access: accessWith(overQuota) };
    state.media = [{ id: "s1" }, { id: "m1" }];
    state.details = { m1: movie, s1: show };
    state.titles = titlesOf({
      overQuota,
      atRisk: [
        { placementId: "pl-episode", bytes: 2 * GB, createdAt: iso(-1) },
        { placementId: "pl-movie", bytes: 8 * GB, createdAt: iso(-2) },
        { placementId: "pl-gone", bytes: 1 * GB, createdAt: iso(-3) },
      ],
      remainingOverBytes: 3 * GB,
    });
    await render();
    try {
      await click("over-quota-see-titles");
      await named();
      expect(byTestId("over-quota-dialog")).not.toBeNull();
      const atRisk = byTestId("over-quota-at-risk");
      expect(atRisk?.textContent).toContain(`Deleted on`);
      expect(atRisk?.textContent).toContain(String(new Date(overQuota.deletionAt).getFullYear()));
      expect(byTestId("over-quota-at-risk-pl-episode")?.textContent).toContain("Severance — S2E3");
      expect(byTestId("over-quota-at-risk-pl-movie")?.textContent).toContain("Arrival");
      expect(byTestId("over-quota-at-risk-pl-gone")?.textContent).toContain("Title no longer in your library");
      expect(byTestId("over-quota-download-pl-gone")).toBeNull();
      expect(byTestId("over-quota-remaining")?.textContent).toContain("still 3");
      // The rows keep the server's deletion order.
      const rows = Array.from(atRisk?.querySelectorAll('[data-testid^="over-quota-at-risk-pl-"]') ?? []).map((row) => row.getAttribute("data-testid"));
      expect(rows).toEqual(["over-quota-at-risk-pl-episode", "over-quota-at-risk-pl-movie", "over-quota-at-risk-pl-gone"]);

      await click("over-quota-download-pl-episode");
      await vi.waitFor(() => expect(byTestId("offline-confirm")?.textContent).toBe("Severance"), { timeout: 10_000 });
      expect(state.offline.at(-1)).toEqual({
        title: "Severance",
        scope: { kind: "episode", episodeId: "ep-2-3", seasonNumber: 2, episodeNumber: 3 },
      });
    } catch (err) {
      dump("at-risk");
      throw err;
    }
  });

  it("@req ACCT-OVER-01 the download of a movie at risk saves the whole movie offline", async () => {
    const overQuota = timeline("grace");
    state.user = { id: "u1", access: accessWith(overQuota) };
    state.media = [{ id: "m1" }];
    state.details = { m1: movie };
    state.titles = titlesOf({ overQuota, atRisk: [{ placementId: "pl-movie", bytes: 8 * GB, createdAt: iso(-1) }] });
    await render();
    await click("over-quota-see-titles");
    await named();
    await click("over-quota-download-pl-movie");
    await vi.waitFor(() => expect(state.offline.at(-1)).toEqual({ title: "Arrival", scope: { kind: "movie" } }), { timeout: 10_000 });
    await click("over-quota-dialog-upgrade");
    expect(byTestId("location")?.textContent).toBe("/settings?section=account");
  });

  it("@req ACCT-OVER-04 lists the removed titles under “Removed for exceeding storage” with their date", async () => {
    const overQuota = timeline("frozen");
    state.user = { id: "u1", access: accessWith(overQuota) };
    state.media = [{ id: "m1" }];
    state.details = { m1: movie };
    const deletedAt = iso(-1);
    state.titles = titlesOf({
      overQuota,
      removed: [
        { placementId: "pl-movie", bytes: 8 * GB, deletedAt },
        { placementId: "pl-deleted", bytes: 2 * GB, deletedAt: iso(-2) },
      ],
    });
    await render();
    try {
      await click("over-quota-see-titles");
      await named();
      const removed = byTestId("over-quota-removed");
      expect(removed?.textContent).toContain("Removed for exceeding storage");
      expect(byTestId("over-quota-removed-pl-movie")?.textContent).toContain("Arrival");
      expect(byTestId("over-quota-removed-pl-movie")?.textContent).toContain(`Removed on`);
      expect(byTestId("over-quota-removed-pl-movie")?.textContent).toContain(String(new Date(deletedAt).getFullYear()));
      expect(byTestId("over-quota-removed-pl-deleted")?.textContent).toContain("Title no longer in your library");
      expect(byTestId("over-quota-at-risk")).toBeNull();
    } catch (err) {
      dump("removed");
      throw err;
    }
  });

  it("@req ACCT-OVER-04 tells an account back under its plan that titles were removed, until dismissed", async () => {
    state.user = { id: "u1", access: accessWith(null) };
    const deletedAt = iso(-1);
    state.titles = titlesOf({
      excessBytes: 0,
      removed: [
        { placementId: "pl-a", bytes: GB, deletedAt },
        { placementId: "pl-b", bytes: GB, deletedAt: iso(-2) },
      ],
    });
    await render();
    await shown();
    try {
      expect(byTestId("over-quota-banner")?.getAttribute("data-phase")).toBe("removed");
      expect(byTestId("over-quota-message")?.textContent).toBe("2 titles were removed for exceeding your storage.");
      expect(byTestId("over-quota-upgrade")).toBeNull();
      await click("over-quota-dismiss");
      expect(byTestId("over-quota-banner")).toBeNull();
      expect(window.localStorage.getItem(REMOVED_SEEN_KEY)).toBe(deletedAt);
    } catch (err) {
      dump("removed-banner");
      throw err;
    }
  });

  it("@req ACCT-OVER-04 a dismissed removal stays hidden; a later removal shows again", async () => {
    state.user = { id: "u1", access: accessWith(null) };
    const older = iso(-3);
    window.localStorage.setItem(REMOVED_SEEN_KEY, older);
    state.titles = titlesOf({ excessBytes: 0, removed: [{ placementId: "pl-a", bytes: GB, deletedAt: older }] });
    await render();
    expect(byTestId("over-quota-banner")).toBeNull();
    act(() => root?.unmount());
    root = null;
    container?.remove();

    state.titles = titlesOf({
      excessBytes: 0,
      removed: [
        { placementId: "pl-b", bytes: GB, deletedAt: iso(-1) },
        { placementId: "pl-a", bytes: GB, deletedAt: older },
      ],
    });
    await render();
    await shown();
    expect(byTestId("over-quota-message")?.textContent).toBe("2 titles were removed for exceeding your storage.");
  });

  it("renders nothing for an account that fits and never lost a title", async () => {
    state.user = { id: "u1", access: accessWith(null) };
    state.titles = titlesOf({ excessBytes: 0 });
    await render();
    expect(byTestId("over-quota-banner")).toBeNull();
  });
});
