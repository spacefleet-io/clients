// @vitest-environment jsdom
/**
 * @level integration (the real hook in a real React tree; jsdom localStorage; main's session store stubbed)
 * @bugfix @regression-proof
 *
 * #25 follow-up: logout clears the last authenticated route, but the shell's unmount cleanup flush
 * (`persistCurrentRoute()`) wrote it straight back, to localStorage and, through the session mirror,
 * to main's session.json. The next user to sign in on the machine then landed on the previous
 * user's page (or media dialog).
 *
 * In the app the shell never renders signed-out: RequireAuth swaps it for a <Navigate> in the commit
 * that sets the user to null, so the shell is unmounted with its last (signed-in) props. The tree
 * below mirrors that: `Guard` renders the shell only while signed in.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLastAuthenticatedRoute,
  readLastAuthenticatedRoute,
  resolveInitialAuthenticatedRoute,
} from "../src/renderer/src/lib/routePersistence";
import { useRouteFlushOnLeave } from "../src/renderer/src/lib/useRouteFlushOnLeave";
import { AUTH_TOKEN_KEY, LAST_AUTHENTICATED_ROUTE_KEY } from "../src/shared/sessionKeys";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type GuardProps = { signedIn: boolean; pathname: string; search?: string };

const Shell = ({ pathname, search = "" }: { pathname: string; search?: string }) => {
  useRouteFlushOnLeave({ signedIn: true, pathname, search, restorePending: false });
  return null;
};

/** RequireAuthGuard: signed out -> the children are gone, never re-rendered with a signed-out prop. */
const Guard = ({ signedIn, pathname, search }: GuardProps) =>
  signedIn ? React.createElement(Shell, { pathname, search }) : null;

describe("logout does not bring the previous user's route back (#25)", () => {
  let container: HTMLDivElement;
  let root: Root;
  /** The route key main's session.json would hold after each mirror call (null = absent). */
  const mirrored: Array<string | null> = [];

  const render = async (props: GuardProps) => {
    await act(async () => {
      root.render(React.createElement(Guard, props));
    });
  };

  /** auth.tsx logout(): token removed, route cleared, then setUser(null) (the guard drops the shell). */
  const logout = async (props: Omit<GuardProps, "signedIn">) => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    clearLastAuthenticatedRoute();
    await render({ ...props, signedIn: false });
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(AUTH_TOKEN_KEY, "tok_live_9f2c1d7a");
    mirrored.length = 0;
    Object.defineProperty(window, "sf", {
      configurable: true,
      value: {
        session: {
          snapshot: {},
          replace: (entries: Record<string, string>) => {
            mirrored.push(entries[LAST_AUTHENTICATED_ROUTE_KEY] ?? null);
            return Promise.resolve();
          },
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const dump = (label: string) =>
    console.info(
      `[logout-clears-route:${label}] localStorage=${JSON.stringify(localStorage.getItem(LAST_AUTHENTICATED_ROUTE_KEY))} mirrored=${JSON.stringify(mirrored)}`,
    );

  it("logout leaves no route in localStorage or in main's copy", async () => {
    await render({ signedIn: true, pathname: "/home", search: "?media=abc" });
    await render({ signedIn: true, pathname: "/media-library", search: "?tab=movie" });
    expect(readLastAuthenticatedRoute(), "leaving /home flushed it while signed in").toBe("/home?media=abc");

    await logout({ pathname: "/media-library", search: "?tab=movie" });
    dump("logout");

    expect(readLastAuthenticatedRoute()).toBeNull();
    expect(mirrored.at(-1), "main's session.json must not hold a route after logout").toBeNull();
  });

  it("the next user signing in finds no route to restore", async () => {
    await render({ signedIn: true, pathname: "/settings", search: "?section=video" });
    await logout({ pathname: "/settings", search: "?section=video" });
    dump("next-user");

    const restore = resolveInitialAuthenticatedRoute({
      isAuthenticated: true,
      loading: false,
      pathname: "/home",
      search: "",
      storedRoute: readLastAuthenticatedRoute(),
    });
    expect(restore).toBeNull();
  });

  it("a page closing between the logout's route clear and the shell unmounting writes nothing back", async () => {
    await render({ signedIn: true, pathname: "/account" });
    localStorage.removeItem(AUTH_TOKEN_KEY);
    clearLastAuthenticatedRoute();

    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("beforeunload"));
    dump("close-mid-logout");

    expect(readLastAuthenticatedRoute()).toBeNull();
  });

  it("while signed in, leaving a location, pagehide and unmounting still flush the route", async () => {
    await render({ signedIn: true, pathname: "/playlists" });
    await render({ signedIn: true, pathname: "/account" });
    expect(readLastAuthenticatedRoute(), "leaving a location flushes it").toBe("/playlists");

    localStorage.removeItem(LAST_AUTHENTICATED_ROUTE_KEY);
    window.dispatchEvent(new Event("pagehide"));
    expect(readLastAuthenticatedRoute(), "pagehide flushes the current route").toBe("/account");

    localStorage.removeItem(LAST_AUTHENTICATED_ROUTE_KEY);
    await act(async () => root.unmount());
    expect(readLastAuthenticatedRoute(), "unmounting while the session is alive flushes the current route").toBe("/account");
    root = createRoot(container);
  });
});
