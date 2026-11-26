// @vitest-environment jsdom
/**
 * UX-TOP-01: the desktop top bar has Home, Library and Playlists in the middle; its right side is Search, "+" (add
 * media from any page), jobs, notifications, settings and the current profile's avatar, whose menu (UX-TOP-02, the
 * shared `ProfileMenu`) lists the profiles, then Add profile, Manage profiles and Sign out.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const openIngestion = vi.fn();
const requestSignOut = vi.fn();
// Hoisted: the profile store mock below builds the store (and captures this) when TopNav's import runs.
const listProfiles = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("@/auth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
// Mutable so a test can put the library in its first sync (UX-NOTICE-02: the "Syncing" sign sits in the top bar).
const shell = vi.hoisted(() => ({ loading: false, datasetStatus: { core: true, playback: true } }));
vi.mock("@/lib/libraryContext", () => ({
  useLibraryShell: () => ({
    mediaCount: 3,
    loading: shell.loading,
    error: null,
    datasetStatus: shell.datasetStatus,
    writeBlockedReason: null,
  }),
  useLibraryData: () => ({
    media: [
      { id: "m-cartographer", type: "movie", title: "Cartographer", year: "2001", posterPath: null },
      { id: "m-speed", type: "movie", title: "Speed", year: "1994", posterPath: null },
    ],
  }),
  useLibraryActions: () => ({
    getMediaDetails: (id: string) => (id === "m-speed" ? { cast: [{ name: "Keanu Reeves" }] } : null),
  }),
}));
vi.mock("@/lib/ingestionContext", () => ({ useIngestion: () => ({ openIngestion }) }));
vi.mock("@/components/TopNavNotificationsButton", () => ({ default: () => <span data-testid="notifications" /> }));
vi.mock("@/components/TopNavJobsSidebar", () => ({ default: () => <span data-testid="jobs" /> }));
vi.mock("@/components/DesktopOfflineIndicator", () => ({
  DesktopOfflineIndicator: () => <span data-testid="desktop-offline-indicator" />,
}));
vi.mock("@/components/UnpaidAccessSign", () => ({ UnpaidAccessSign: () => null }));
vi.mock("@/components/OverQuotaSign", () => ({ OverQuotaSign: () => null }));
vi.mock("@/components/SignOutKeyCheck", () => ({ useSignOutWithKeyCheck: () => ({ requestSignOut, dialog: null }) }));
vi.mock("@/logger", () => {
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => logger };
  return { rendererLogger: logger };
});
// The shared store itself, on an in-memory storage, with only the list call answered: the menu reads and switches it.
vi.mock("@/lib/profileStore", async () => {
  const { createProfileStore } = await import("@space/shared/profileStore");
  const memory = new Map<string, string>();
  const unused = () => Promise.reject(new Error("not used by the top bar"));
  return {
    profileStore: createProfileStore({
      storage: {
        getItem: async (key) => memory.get(key) ?? null,
        setItem: async (key, value) => void memory.set(key, value),
        removeItem: async (key) => void memory.delete(key),
      },
      api: { list: listProfiles, create: unused, update: unused, remove: unused },
      applyScope: () => undefined,
      log: () => undefined,
    }),
  };
});

import { profileStore } from "@/lib/profileStore";

import TopNav from "../src/renderer/src/components/TopNav";
// TopNav lazy-loads the narrow-window menu on its first open. Loaded here, its `import()` resolves from the module
// cache: the first open no longer waits on transforming the module, which a loaded CI runner took over 1 s to do.
import "../src/renderer/src/components/TopNavMobileMenu";

let container: HTMLDivElement;
let root: Root;

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const mount = async () => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/home"]}>
        <TopNav />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
  });
};

const CHRIS = { id: "p-chris", name: "Chris", avatar: 5, avatarId: "badger", isMain: true, createdAt: "2026-10-01T00:00:00.000Z" };
const LEO = { id: "p-leo", name: "Léo", avatar: 1, avatarId: "fox", isMain: false, createdAt: "2026-10-02T00:00:00.000Z" };

const signIn = async (profiles: (typeof CHRIS)[]) => {
  listProfiles.mockResolvedValue({ profiles, maxProfiles: 5 });
  await act(async () => {
    await profileStore.startSession({ userId: "user-1", token: "tok", askEveryStart: false });
    await profileStore.selectProfile(CHRIS.id);
  });
};

const openMenu = async () => {
  await act(async () => byTestId("profile-menu")!.click());
  expect(byTestId("profile-menu-list")).not.toBeNull();
};

beforeEach(async () => {
  openIngestion.mockReset();
  requestSignOut.mockReset();
  shell.loading = false;
  shell.datasetStatus = { core: true, playback: true };
  await signIn([CHRIS]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await mount();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("desktop top bar actions", () => {
  // @req UX-TOP-01[badger-desktop]
  // @req UX-SEARCH-01[badger-desktop]
  // @req UX-TOP-02[badger-desktop]
  it("offers Search, +, Settings and the profile's avatar at the right, and no separate Sign out button", async () => {
    const order = ["top-nav-search", "top-nav-add-media", "jobs", "notifications", "top-nav-settings", "profile-menu"].map((id) => byTestId(id));
    if (order.some((el) => !el)) console.error("[top-nav-actions] missing", container.innerHTML.slice(0, 2000));
    expect(order.every(Boolean)).toBe(true);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(byTestId("top-nav-sign-out")).toBeNull();
    expect(byTestId("profile-menu")!.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("badger");
    await act(async () => byTestId("top-nav-add-media")!.click());
    expect(openIngestion).toHaveBeenCalledTimes(1);

    // UX-SEARCH-01: Search opens the palette over the page (no navigation); a typo still finds the title, Enter opens it.
    await act(async () => byTestId("top-nav-search")!.click());
    expect(byTestId("where")!.textContent).toBe("/home");
    const input = document.querySelector<HTMLInputElement>('[data-testid="search-palette-input"]');
    expect(input).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "cartografer");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const results = [...document.querySelectorAll('[data-testid="search-palette-result"]')].map((r) => r.textContent);
    console.info("[top-nav-actions] palette results", JSON.stringify(results));
    expect(results[0]).toContain("Cartographer");
    await act(async () => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(byTestId("where")!.textContent).toBe("/media/m-cartographer");
    expect(document.querySelector('[data-testid="search-palette"]')).toBeNull();

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })));
    expect(document.querySelector('[data-testid="search-palette-input"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLElement>('[data-testid="search-palette-input"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[data-testid="search-palette"]')).toBeNull();

    await act(async () => byTestId("top-nav-settings")!.click());
    expect(byTestId("where")!.textContent).toBe("/settings");
  });

  // @req UX-TOP-01[badger-desktop]
  // @req UX-TOP-02[badger-desktop]
  it("with one profile the avatar menu still shows, with Add profile, Manage profiles and Sign out", async () => {
    await openMenu();
    const items = [...byTestId("profile-menu-list")!.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid"));
    console.info("[top-nav-actions] single-profile menu", JSON.stringify(items));
    expect(items.filter((id) => id?.startsWith("profile-menu-") && !id.includes("-avatar"))).toEqual(
      expect.arrayContaining([`profile-menu-${CHRIS.id}`, "profile-menu-add", "profile-menu-manage", "profile-menu-sign-out"]),
    );
    expect(byTestId(`profile-menu-${CHRIS.id}`)!.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("profile-menu-sign-out")!.textContent).toBe("nav.signOut");

    await act(async () => byTestId("profile-menu-add")!.click());
    expect(byTestId("profile-menu-list")).toBeNull();
    expect(byTestId("where")!.textContent).toBe("/settings?section=profiles&add=1");

    await openMenu();
    await act(async () => byTestId("profile-menu-manage")!.click());
    expect(byTestId("where")!.textContent).toBe("/settings?section=profiles");

    await openMenu();
    await act(async () => byTestId("profile-menu-sign-out")!.click());
    expect(requestSignOut).toHaveBeenCalledTimes(1);
  });

  // @req UX-TOP-01[badger-desktop]
  // @req ACCT-PROF-05[badger-desktop]
  it("with several profiles the menu lists each with its avatar, the current one ticked, and a pick switches at once", async () => {
    await signIn([CHRIS, LEO]);
    await openMenu();
    const rows = [...byTestId("profile-menu-list")!.querySelectorAll('[role="menuitemradio"]')].map((el) => ({
      id: el.getAttribute("data-testid"),
      checked: el.getAttribute("aria-checked"),
      avatar: el.querySelector("[data-avatar]")?.getAttribute("data-avatar"),
      name: el.textContent,
    }));
    console.info("[top-nav-actions] multi-profile menu", JSON.stringify(rows));
    expect(rows).toEqual([
      { id: `profile-menu-${CHRIS.id}`, checked: "true", avatar: "badger", name: expect.stringContaining("Chris") },
      { id: `profile-menu-${LEO.id}`, checked: "false", avatar: "fox", name: expect.stringContaining("Léo") },
    ]);
    await act(async () => byTestId(`profile-menu-${LEO.id}`)!.click());
    expect(byTestId("profile-menu-list")).toBeNull();
    expect(profileStore.getSnapshot().activeId).toBe(LEO.id);
    expect(byTestId("profile-menu")!.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("fox");
  });

  // @req UX-TOP-01[badger-desktop]
  it("puts Playlists beside Home and Library, as a main tab", async () => {
    const nav = container.querySelector("header nav");
    const labels = Array.from(nav?.querySelectorAll("a, div") ?? []).map((el) => el.textContent?.trim()).filter(Boolean);
    console.info("[top-nav-actions] main tabs:", labels);
    expect(labels).toEqual(["nav.dashboard", "nav.library", "nav.playlists"]);
    await act(async () => byTestId("top-nav-playlists")!.click());
    expect(byTestId("where")!.textContent).toBe("/playlists");
  });

  // @req UX-TOP-01[badger-desktop]
  // @req ACCT-PROF-05[badger-desktop]
  it("a narrow window's menu ends with the same profile entries as the avatar menu: profiles, Add, Manage, Sign out", async () => {
    await signIn([CHRIS, LEO]);
    const openSheet = async () => {
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="nav.openMenu"]')!.click());
      // The sheet is lazy-loaded on the first open.
      await vi.waitFor(() => expect(document.querySelector('[data-testid="top-nav-mobile-profiles"]')).not.toBeNull());
    };
    const sheetItem = (id: string) => document.querySelector<HTMLElement>(`[data-testid="top-nav-mobile-profile-${id}"]`);
    await openSheet();
    const entries = [...document.querySelectorAll('[data-testid="top-nav-mobile-profiles"] [role^="menuitem"]')].map((el) => ({
      id: el.getAttribute("data-testid"),
      checked: el.getAttribute("aria-checked"),
      avatar: el.querySelector("[data-avatar]")?.getAttribute("data-avatar") ?? null,
    }));
    console.info("[top-nav-actions] narrow sheet profile entries", JSON.stringify(entries));
    expect(entries).toEqual([
      { id: `top-nav-mobile-profile-${CHRIS.id}`, checked: "true", avatar: "badger" },
      { id: `top-nav-mobile-profile-${LEO.id}`, checked: "false", avatar: "fox" },
      { id: "top-nav-mobile-profile-add", checked: null, avatar: null },
      { id: "top-nav-mobile-profile-manage", checked: null, avatar: null },
      { id: "top-nav-mobile-profile-sign-out", checked: null, avatar: null },
    ]);
    expect(sheetItem("sign-out")!.textContent).toBe("nav.signOut");

    await act(async () => sheetItem(LEO.id)!.click());
    expect(profileStore.getSnapshot().activeId).toBe(LEO.id);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="top-nav-mobile-profiles"]')).toBeNull());

    await openSheet();
    await act(async () => sheetItem("add")!.click());
    expect(byTestId("where")!.textContent).toBe("/settings?section=profiles&add=1");

    await openSheet();
    await act(async () => sheetItem("manage")!.click());
    expect(byTestId("where")!.textContent).toBe("/settings?section=profiles");

    await openSheet();
    await act(async () => sheetItem("sign-out")!.click());
    expect(requestSignOut).toHaveBeenCalledTimes(1);
  });

  // @req UX-NOTICE-02[badger-desktop]
  it("the offline chip sits in the top bar beside the Badger name, not in a bar under it", () => {
    const header = container.querySelector("header");
    const indicator = byTestId("desktop-offline-indicator");
    console.info("[top-nav-actions] offline chip parent:", indicator?.parentElement?.outerHTML.slice(0, 400));
    expect(indicator).not.toBeNull();
    expect(header!.contains(indicator)).toBe(true);
    // One chip only: it is visible at every window width, not repeated in the narrow-window menu row.
    expect(container.querySelectorAll('[data-testid="desktop-offline-indicator"]')).toHaveLength(1);
  });

  // @req UX-NOTICE-02[badger-desktop]
  it("the first sync says 'Syncing' with a small sign in the top bar; nothing is added under the bar", async () => {
    const after = () => {
      const header = container.querySelector("header")!;
      // The fixed header is followed by its own height spacer; anything else between it and the page pushes the page.
      const siblings: string[] = [];
      for (let el = header.nextElementSibling; el; el = el.nextElementSibling) siblings.push(el.outerHTML.slice(0, 120));
      return siblings;
    };
    const idle = after();
    shell.loading = true;
    shell.datasetStatus = { core: false, playback: false };
    // TopNav is memo'd with no props: a fresh root reads the new library state.
    act(() => root.unmount());
    root = createRoot(container);
    await mount();
    const sign = byTestId("desktop-sync-indicator");
    console.info("[top-nav-actions] syncing", JSON.stringify({ sign: sign?.outerHTML, idle, syncing: after() }));
    expect(sign).not.toBeNull();
    expect(container.querySelector("header")!.contains(sign)).toBe(true);
    expect(sign!.textContent).toBe("library.syncing");
    expect(after()).toEqual(idle);
  });
});
