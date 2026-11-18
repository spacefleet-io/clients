import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPersistedRoute,
  clearLastAuthenticatedRoute,
  isAuthenticatedShellBootstrapPath,
  isPersistableAuthenticatedRoute,
  persistLastAuthenticatedRoute,
  readLastAuthenticatedRoute,
  resolveInitialAuthenticatedRoute,
  isInitialRestorePending,
  shouldRestoreLastAuthenticatedRoute,
} from "../src/renderer/src/lib/routePersistence";

describe("route persistence", () => {
  const localStorageMap = new Map<string, string>();

  // Dump the in-memory localStorage rows so a persist/restore assertion
  // failure is diagnosable offline. Wrapped in try/catch so the dump can't
  // mask the real assertion failure.
  const dumpRouteSnapshot = (label: string, ctx: Record<string, unknown> = {}) => {
    try {
      console.error(`=== [route-persistence:${label}] snapshot ===`);
      console.error(`localStorage rows:\n${JSON.stringify([...localStorageMap.entries()], null, 2)}`);
      if (Object.keys(ctx).length > 0) {
        console.error(`context: ${JSON.stringify(ctx)}`);
      }
    } catch (err) {
      console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  beforeEach(() => {
    localStorageMap.clear();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => localStorageMap.get(String(key)) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageMap.set(String(key), String(value));
      }),
      removeItem: vi.fn((key: string) => {
        localStorageMap.delete(String(key));
      }),
      clear: vi.fn(() => localStorageMap.clear()),
    });
    console.info("[route-persistence:setup] stubbed localStorage with in-memory map, cleared rows");
  });

  it("persists only meaningful authenticated routes", () => {
    console.info("[route-persistence:meaningful] persisting /media-library?tab=movie then /login (should be ignored)");
    persistLastAuthenticatedRoute("/media-library", "?tab=movie");
    const afterFirst = readLastAuthenticatedRoute();
    if (afterFirst !== "/media-library?tab=movie") dumpRouteSnapshot("meaningful-first-persist", { afterFirst });
    expect(afterFirst).toBe("/media-library?tab=movie");

    persistLastAuthenticatedRoute("/login", "");
    const afterLogin = readLastAuthenticatedRoute();
    if (afterLogin !== "/media-library?tab=movie") dumpRouteSnapshot("meaningful-login-ignored", { afterLogin });
    expect(afterLogin).toBe("/media-library?tab=movie");
  });

  it("@bugfix @req LIB-DETAIL-05 never stores an open trailer, so a relaunch does not reopen it", () => {
    persistLastAuthenticatedRoute("/media/les-choristes", "?trailer=yt-choristes");
    const film = readLastAuthenticatedRoute();
    persistLastAuthenticatedRoute("/media/show-1", "?episode=s1e2&trailer=yt-show");
    const episode = readLastAuthenticatedRoute();
    console.info("[route-persistence:trailer] stored", { film, episode });
    expect(film).toBe("/media/les-choristes");
    expect(episode).toBe("/media/show-1?episode=s1e2");
  });

  it("identifies which routes are safe to persist", () => {
    expect(isPersistableAuthenticatedRoute("/home")).toBe(true);
    expect(isPersistableAuthenticatedRoute("/media-library")).toBe(true);
    expect(isPersistableAuthenticatedRoute("/settings/profile")).toBe(true);
    expect(isPersistableAuthenticatedRoute("/onboarding/key")).toBe(false);
    expect(isPersistableAuthenticatedRoute("/login")).toBe(false);
  });

  it("recognizes bootstrap shell paths before the authenticated route is restored", () => {
    expect(isAuthenticatedShellBootstrapPath("/")).toBe(true);
    expect(isAuthenticatedShellBootstrapPath("/index.html")).toBe(true);
    expect(isAuthenticatedShellBootstrapPath("/home/user/dev/spacefleet/apps/badger/desktop/out/renderer/index.html")).toBe(true);
    expect(isAuthenticatedShellBootstrapPath("/home")).toBe(false);
  });

  it("restores a stored route only for authenticated recreated shells", () => {
    expect(
      shouldRestoreLastAuthenticatedRoute({
        isAuthenticated: true,
        loading: false,
        pathname: "/home",
        search: "",
        storedRoute: "/media-library?tab=movie",
      })
    ).toBe(true);

    expect(
      shouldRestoreLastAuthenticatedRoute({
        isAuthenticated: true,
        loading: false,
        pathname: "/media-library",
        search: "?tab=movie",
        storedRoute: "/media-library?tab=movie",
      })
    ).toBe(false);

    expect(
      shouldRestoreLastAuthenticatedRoute({
        isAuthenticated: false,
        loading: false,
        pathname: "/home",
        search: "",
        storedRoute: "/media-library?tab=movie",
      })
    ).toBe(false);
  });

  it("[@bugfix][@regression-proof] resolves the initial stored route before the authenticated shell falls back to /home", () => {
    console.info("[route-persistence:resolve-initial] case 1 — pathname=/home should resolve to stored route");
    const fromHome = resolveInitialAuthenticatedRoute({
      isAuthenticated: true,
      loading: false,
      pathname: "/home",
      search: "",
      storedRoute: "/media-library?tab=movie&media=abc",
    });
    if (fromHome !== "/media-library?tab=movie&media=abc") {
      dumpRouteSnapshot("resolve-initial-from-home", { fromHome });
    }
    expect(fromHome).toBe("/media-library?tab=movie&media=abc");

    console.info("[route-persistence:resolve-initial] case 2 — already on stored route should resolve null");
    const alreadyThere = resolveInitialAuthenticatedRoute({
      isAuthenticated: true,
      loading: false,
      pathname: "/media-library",
      search: "?tab=movie&media=abc",
      storedRoute: "/media-library?tab=movie&media=abc",
    });
    if (alreadyThere !== null) dumpRouteSnapshot("resolve-initial-already-there", { alreadyThere });
    expect(alreadyThere).toBeNull();

    console.info("[route-persistence:resolve-initial] case 3 — bootstrap index.html should resolve to stored route");
    const fromBootstrap = resolveInitialAuthenticatedRoute({
      isAuthenticated: true,
      loading: false,
      pathname: "/home/user/dev/spacefleet/apps/badger/desktop/out/renderer/index.html",
      search: "",
      storedRoute: "/media-library?tab=movie&media=abc",
    });
    if (fromBootstrap !== "/media-library?tab=movie&media=abc") {
      dumpRouteSnapshot("resolve-initial-from-bootstrap", { fromBootstrap });
    }
    expect(fromBootstrap).toBe("/media-library?tab=movie&media=abc");
  });

  // Mirrors AuthenticatedApp: every render evaluates the gate against the
  // stored route, the first non-loading render handles the initial route, and
  // the persist effect writes the location whenever the gate is not pending.
  const createShell = () => {
    const shell = { handled: false, restoreFrom: { current: null as string | null } };
    return (label: string, pathname: string, search = "") => {
      const storedBefore = readLastAuthenticatedRoute();
      const restoreRoute = resolveInitialAuthenticatedRoute({
        isAuthenticated: true,
        loading: false,
        pathname,
        search,
        storedRoute: storedBefore,
      });
      const pending = isInitialRestorePending(shell.restoreFrom, shell.handled, restoreRoute, { pathname, search });
      const gate = { pending, restoreFrom: shell.restoreFrom.current };
      shell.handled = true;
      if (!gate.pending) persistLastAuthenticatedRoute(pathname, search);
      const storedAfter = readLastAuthenticatedRoute();
      console.info(
        `[route-persistence:shell] ${label} location=${pathname}${search} storedBefore=${storedBefore} ` +
          `gate=${JSON.stringify(gate)} storedAfter=${storedAfter}`,
      );
      return { gate, storedAfter };
    };
  };

  it("@bugfix @regression-proof closing the restored media dialog persists the bare Dashboard, so a relaunch does not reopen it", () => {
    localStorage.setItem("sf_last_authenticated_route", "/home?media=abc");
    const render = createShell();

    const boot = render("cold boot lands on the default Dashboard", "/home");
    if (!boot.gate.pending) dumpRouteSnapshot("restore-not-pending-on-boot", { boot });
    expect(boot.gate.pending, "the boot location must not overwrite the route being restored").toBe(true);
    expect(boot.storedAfter).toBe("/home?media=abc");

    const restored = render("restore landed on the media dialog", "/home", "?media=abc");
    expect(restored.gate.pending).toBe(false);
    expect(restored.storedAfter).toBe("/home?media=abc");

    const closed = render("user closed the media dialog", "/home");
    if (closed.storedAfter !== "/home") dumpRouteSnapshot("dialog-close-not-persisted", { closed });
    expect(closed.gate.pending, "a later return to the bare Dashboard is not a pending restore").toBe(false);
    expect(closed.storedAfter, "the next relaunch must open the bare Dashboard").toBe("/home");
  });

  it("@bugfix @regression-proof navigating back to the Dashboard after the restore persists /home", () => {
    localStorage.setItem("sf_last_authenticated_route", "/settings");
    const render = createShell();

    expect(render("cold boot lands on the default Dashboard", "/home").gate.pending).toBe(true);
    expect(render("restore landed on settings", "/settings").storedAfter).toBe("/settings");

    const home = render("user clicked Home", "/home");
    if (home.storedAfter !== "/home") dumpRouteSnapshot("home-not-persisted", { home });
    expect(home.storedAfter).toBe("/home");
  });

  it("persists the boot route when there is nothing to restore", () => {
    const render = createShell();
    const boot = render("first launch", "/home");
    expect(boot.gate).toEqual({ pending: false, restoreFrom: null });
    expect(boot.storedAfter).toBe("/home");
  });

  it("can clear the stored route", () => {
    localStorage.setItem("sf_last_authenticated_route", "/media-library?tab=movie");
    clearLastAuthenticatedRoute();
    expect(readLastAuthenticatedRoute()).toBeNull();
  });

  it("builds persisted routes with query strings intact", () => {
    expect(buildPersistedRoute("/media-library", "?tab=movie&media=abc")).toBe("/media-library?tab=movie&media=abc");
  });
});
