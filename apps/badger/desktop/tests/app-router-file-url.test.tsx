// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { RequireAuthGuard } from "@space/desktop-shell/guards";
import { AppRouter, resolveRouterBasename } from "../src/renderer/src/lib/AppRouter";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The packaged renderer is loaded with win.loadFile(), so `window.location`
// is a file URL. On Windows that URL carries the drive letter.
const WINDOWS_PACKAGED_URL = new URL(
  "file:///C:/Users/me/AppData/Local/Programs/Badger/resources/app.asar/out/renderer/index.html",
);
const LINUX_PACKAGED_URL = new URL("file:///tmp/.mount_spacebXYZ/resources/app.asar/out/renderer/index.html");

/** Same route shape as App.tsx: /login is public, everything else is guarded. */
const TestRoutes = () => {
  const { pathname } = useLocation();
  return (
    <>
      <div data-testid="pathname">{pathname}</div>
      <Routes>
        <Route path="/login" element={<div data-testid="login-page">login</div>} />
        <Route
          path="*"
          element={
            <RequireAuthGuard
              loading={false}
              isAuthenticated={false}
              loadingFallback={null}
              unauthenticatedRedirectTo="/login"
            >
              <div data-testid="home-page">home</div>
            </RequireAuthGuard>
          }
        />
      </Routes>
    </>
  );
};

/**
 * Minimal `Window` that resolves history URLs the way the browser does for a
 * document loaded from a file URL: `pushState(_, _, "/login")` resolves
 * against the current document URL, so on a drive it becomes
 * file:///C:/login (pathname `/C:/login`). jsdom cannot host a file origin,
 * and this is the only behavior of the packaged document the router depends on.
 */
const createFileWindow = (documentUrl: URL) => {
  let current = new URL(documentUrl.href);
  let state: unknown = null;
  const location = {
    get href() {
      return current.href;
    },
    get protocol() {
      return current.protocol;
    },
    get origin() {
      return "null";
    },
    get pathname() {
      return current.pathname;
    },
    get search() {
      return current.search;
    },
    get hash() {
      return current.hash;
    },
    assign(url: string) {
      current = new URL(url, current);
    },
  };
  const history = {
    get state() {
      return state;
    },
    get length() {
      return 1;
    },
    scrollRestoration: "auto",
    pushState(next: unknown, _title: string, url?: string) {
      state = next;
      if (url) current = new URL(url, current);
    },
    replaceState(next: unknown, _title: string, url?: string) {
      state = next;
      if (url) current = new URL(url, current);
    },
    go() {},
  };
  return {
    fileWindow: {
      location,
      history,
      addEventListener() {},
      removeEventListener() {},
      document,
    } as unknown as Window,
    currentUrl: () => current.href,
  };
};

const renderLaunch = async (documentUrl: URL) => {
  const { fileWindow, currentUrl } = createFileWindow(documentUrl);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <StrictMode>
        <AppRouter win={fileWindow}>
          <TestRoutes />
        </AppRouter>
      </StrictMode>,
    );
  });
  return { host, root, currentUrl };
};

describe("renderer router over the packaged file:// URL @bugfix @regression-proof", () => {
  let mounted: { host: HTMLDivElement; root: Root; currentUrl: () => string } | null = null;

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.host.remove();
      mounted = null;
    }
  });

  it("the Windows packaged document pathname carries the drive letter (the failing precondition)", () => {
    expect(WINDOWS_PACKAGED_URL.protocol).toBe("file:");
    expect(WINDOWS_PACKAGED_URL.pathname.startsWith("/C:/")).toBe(true);
    expect(new URL("/login", WINDOWS_PACKAGED_URL).pathname).toBe("/C:/login");
  });

  it("an unauthenticated Windows launch lands on /login instead of looping on the guard", async () => {
    mounted = await renderLaunch(WINDOWS_PACKAGED_URL);
    expect(mounted.host.querySelector('[data-testid="login-page"]')).not.toBeNull();
    expect(mounted.host.querySelector('[data-testid="home-page"]')).toBeNull();
    expect(mounted.host.querySelector('[data-testid="pathname"]')?.textContent).toBe("/login");
    expect(mounted.currentUrl()).toBe("file:///C:/login");
  });

  it("an unauthenticated Linux launch still lands on /login", async () => {
    mounted = await renderLaunch(LINUX_PACKAGED_URL);
    expect(mounted.host.querySelector('[data-testid="login-page"]')).not.toBeNull();
    expect(mounted.host.querySelector('[data-testid="pathname"]')?.textContent).toBe("/login");
    expect(mounted.currentUrl()).toBe("file:///login");
  });

  it("derives the basename from the drive of a file URL and only then", () => {
    expect(resolveRouterBasename(WINDOWS_PACKAGED_URL)).toBe("/C:");
    expect(resolveRouterBasename(new URL("file:///d:/Apps/Badger/index.html"))).toBe("/d:");
    expect(resolveRouterBasename(LINUX_PACKAGED_URL)).toBe("");
    expect(resolveRouterBasename(new URL("file://fileserver/share/Badger/index.html"))).toBe("");
    expect(resolveRouterBasename(new URL("http://localhost:5173/login"))).toBe("");
    // A dev-server route that merely looks like a drive is not a file URL.
    expect(resolveRouterBasename(new URL("http://localhost:5173/C:/login"))).toBe("");
  });

  it("App mounts the router through AppRouter, which feeds the basename to BrowserRouter", () => {
    const app = readFileSync(join(process.cwd(), "src/renderer/src/App.tsx"), "utf8");
    expect(app).toContain('from "./lib/AppRouter"');
    expect(app).not.toMatch(/<BrowserRouter[\s>]/);
    const router = readFileSync(join(process.cwd(), "src/renderer/src/lib/AppRouter.tsx"), "utf8");
    expect(router).toMatch(/<BrowserRouter[^>]*basename=\{resolveRouterBasename\(/);
    expect(app).not.toContain('href="/login"');
  });
});
