// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-EMPTY-TAB-001
 * @req UX-LIBTAB-01[badger-desktop]
 * @why Chris, 2026-11-16: "when a user's library is empty we decided that the library page couldn't be opened [...]
 *   also the button should be greyed out so it doesn't look like a bug". The top bar's Library is a greyed-out,
 *   aria-disabled item while the library holds no title (a click goes nowhere), and the Library page route sends a link
 *   that still lands on it (Add media, a toast, a restored route) to Home. The first title makes Library a link that
 *   opens the page, with no restart. Chris, 2026-11-16: "if library is greyed out when empty, then the playlist menu
 *   should also be greyed out and unaccissible": Playlists follows Library in the top bar, the narrow window's menu
 *   and on its route.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const LOG = "[BADGER-DESKTOP-EMPTY-TAB-001]";
// The library shell as the provider gives it: a change (the first title synced) re-renders whoever reads it.
const shell = vi.hoisted(() => ({ mediaCount: 0, loading: false, error: null as string | null, version: 0, listeners: new Set<() => void>() }));
const setMediaCount = (count: number) => {
  shell.mediaCount = count;
  shell.version += 1;
  for (const listener of shell.listeners) listener();
};

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("@/auth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/lib/libraryContext", async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import("react")>("react");
  return {
    useLibraryShell: () => {
      useSyncExternalStore(
        (listener) => {
          shell.listeners.add(listener);
          return () => shell.listeners.delete(listener);
        },
        () => shell.version,
      );
      return {
        mediaCount: shell.mediaCount,
        loading: shell.loading,
        error: shell.error,
        datasetStatus: { core: true, playback: true },
        writeBlockedReason: null,
      };
    },
    useLibraryData: () => ({ media: [] }),
    useLibraryActions: () => ({ getMediaDetails: () => null }),
  };
});
vi.mock("@/lib/ingestionContext", () => ({ useIngestion: () => ({ openIngestion: () => undefined }) }));
vi.mock("@/components/TopNavNotificationsButton", () => ({ default: () => <span data-testid="notifications" /> }));
vi.mock("@/components/TopNavJobsSidebar", () => ({ default: () => <span data-testid="jobs" /> }));
vi.mock("@/components/DesktopOfflineIndicator", () => ({ DesktopOfflineIndicator: () => null }));
vi.mock("@/components/UnpaidAccessSign", () => ({ UnpaidAccessSign: () => null }));
vi.mock("@/components/OverQuotaSign", () => ({ OverQuotaSign: () => null }));
vi.mock("@/components/SignOutKeyCheck", () => ({ useSignOutWithKeyCheck: () => ({ requestSignOut: () => undefined, dialog: null }) }));

import TopNav from "../src/renderer/src/components/TopNav";
import { RequireLibraryMedia } from "../src/renderer/src/components/RequireLibraryMedia";

let container: HTMLDivElement;
let root: Root;

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const where = () => byTestId("where")?.textContent ?? null;

// The two pages an empty library closes: their top-bar item, route and page marker (UX-LIBTAB-01).
const PAGES = [
  { name: "Library", testId: "top-nav-library", path: "/media-library", page: "library-page", label: "nav.library" },
  { name: "Playlists", testId: "top-nav-playlists", path: "/playlists", page: "playlists-page", label: "nav.playlists" },
] as const;

const app = (start: string) => (
  <MemoryRouter initialEntries={[start]}>
    <TopNav />
    <Routes>
      {PAGES.map(({ path, page }) => (
        <Route
          key={path}
          path={path}
          element={
            <RequireLibraryMedia>
              <output data-testid={page} />
            </RequireLibraryMedia>
          }
        />
      ))}
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>
);
const render = async (start: string) => {
  await act(async () => root.render(app(start)));
};
const navItem = (testId: string) => {
  const item = byTestId(testId);
  const seen = {
    tag: item?.tagName ?? null,
    ariaDisabled: item?.getAttribute("aria-disabled") ?? null,
    greyed: item?.className.includes("opacity-50") ?? null,
    href: item?.getAttribute("href") ?? null,
  };
  console.info(LOG, testId, JSON.stringify(seen));
  return { item, seen };
};
/** Opens the narrow window's menu (a sheet in a portal) and reads its entry for `label`. */
const narrowMenuEntry = async (label: string) => {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="nav.openMenu"]');
  await act(async () => trigger!.click());
  const sheet = await vi.waitFor(() => {
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain(label);
    return dialog!;
  });
  const entry = [...sheet.querySelectorAll<HTMLElement>("a, button")].find((el) => el.textContent?.trim() === label) ?? null;
  const seen = { tag: entry?.tagName ?? null, disabled: entry?.hasAttribute("disabled") ?? null, href: entry?.getAttribute("href") ?? null };
  console.info(LOG, "narrow menu", label, JSON.stringify(seen));
  return seen;
};

beforeEach(() => {
  shell.mediaCount = 0;
  shell.loading = false;
  shell.error = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe.each(PAGES)("BADGER-DESKTOP-EMPTY-TAB-001 the desktop's $name of an empty library", ({ testId, path, page, label }) => {
  it("is a greyed-out, aria-disabled item with no link; a click stays on Home", async () => {
    await render("/home");
    const { item, seen } = navItem(testId);
    expect(seen).toEqual({ tag: "DIV", ariaDisabled: "true", greyed: true, href: null });
    await act(async () => item!.click());
    expect(where()).toBe("/home");
  });

  it("is a disabled entry with no link in the narrow window's menu", async () => {
    await render("/home");
    expect(await narrowMenuEntry(label)).toEqual({ tag: "BUTTON", disabled: true, href: null });
  });

  it("a link that lands on the page goes to Home", async () => {
    await render(path);
    console.info(LOG, "landed", where());
    expect(byTestId(page)).toBeNull();
    expect(where()).toBe("/home");
  });

  it("while the library loads, the page opens as before (not known empty)", async () => {
    shell.loading = true;
    await render(path);
    expect(byTestId(page)).not.toBeNull();
  });

  it("the first title makes it a link that opens the page, with no restart", async () => {
    await render("/home");
    expect(navItem(testId).seen.tag).toBe("DIV");
    await act(async () => setMediaCount(1));
    const { item, seen } = navItem(testId);
    expect(seen).toEqual({ tag: "A", ariaDisabled: null, greyed: false, href: path });
    await act(async () => item!.click());
    expect(byTestId(page)).not.toBeNull();
  });

  it("the first title turns its narrow-menu entry into a link", async () => {
    shell.mediaCount = 1;
    await render("/home");
    expect(await narrowMenuEntry(label)).toEqual({ tag: "A", disabled: false, href: path });
  });
});
