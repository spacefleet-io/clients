import { LAST_AUTHENTICATED_ROUTE_KEY as LAST_ROUTE_KEY } from "../../../shared/sessionKeys";
import { persistSessionToMain } from "./sessionMirror";

const AUTHENTICATED_ROUTE_PREFIXES = [
  "/home",
  "/media-library",
  "/media",
  "/settings",
  "/playlists",
  "/account",
];

export const buildPersistedRoute = (pathname: string, search = "") => `${pathname}${search}`;

export const isAuthenticatedShellBootstrapPath = (pathname: string) =>
  pathname === "/" || pathname === "" || pathname === "/index.html" || pathname.endsWith("/index.html");

export const isPersistableAuthenticatedRoute = (pathname: string) =>
  !isAuthenticatedShellBootstrapPath(pathname) &&
  AUTHENTICATED_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}?`)
  );

export const persistLastAuthenticatedRoute = (pathname: string, search = "") => {
  if (!isPersistableAuthenticatedRoute(pathname)) return;
  // An open trailer is never stored: a relaunch must not reopen it by itself (LIB-DETAIL-05). Only a search that
  // carries one is rewritten, so every other stored route stays byte-identical to the location it came from.
  const params = new URLSearchParams(search);
  if (params.has("trailer")) {
    params.delete("trailer");
    const query = params.toString();
    search = query ? `?${query}` : "";
  }
  localStorage.setItem(LAST_ROUTE_KEY, buildPersistedRoute(pathname, search));
  // #25: Chromium commits localStorage lazily, so a kill right after a navigation loses the
  // route; main's fsynced copy (an unchanged route is a no-op there) survives it.
  void persistSessionToMain();
};

export const readLastAuthenticatedRoute = () => {
  const value = localStorage.getItem(LAST_ROUTE_KEY)?.trim();
  if (!value) return null;
  return value;
};

export const clearLastAuthenticatedRoute = () => {
  localStorage.removeItem(LAST_ROUTE_KEY);
  void persistSessionToMain();
};

export const shouldRestoreLastAuthenticatedRoute = ({
  isAuthenticated,
  loading,
  pathname,
  search,
  storedRoute,
}: {
  isAuthenticated: boolean;
  loading: boolean;
  pathname: string;
  search: string;
  storedRoute: string | null;
}) => {
  if (loading || !isAuthenticated || !storedRoute) return false;
  if (!isPersistableAuthenticatedRoute(pathname)) {
    return isAuthenticatedShellBootstrapPath(pathname);
  }
  return buildPersistedRoute(pathname, search) !== storedRoute && pathname === "/home" && !search;
};

export const resolveInitialAuthenticatedRoute = ({
  isAuthenticated,
  loading,
  pathname,
  search,
  storedRoute,
}: {
  isAuthenticated: boolean;
  loading: boolean;
  pathname: string;
  search: string;
  storedRoute: string | null;
}) =>
  shouldRestoreLastAuthenticatedRoute({
    isAuthenticated,
    loading,
    pathname,
    search,
    storedRoute,
  })
    ? storedRoute
    : null;

/**
 * Decides, on every shell render, whether persisting the current location
 * must wait for the one-time restore of the stored route.
 *
 * Before the shell handles its initial route, it waits whenever a restore is
 * due (`restoreRoute`, from resolveInitialAuthenticatedRoute). Once handled, it
 * waits only while the location is still the route the shell restored FROM
 * (its <Navigate> has not landed yet); the first location change ends the
 * wait for good. `restoreFrom` carries that route across renders (a React
 * ref). Re-deriving the restore decision from the stored route on later
 * renders made every return to the bare Dashboard look like a fresh boot, so
 * it was never persisted and a relaunch reopened the last media dialog over
 * the Dashboard.
 */
export const isInitialRestorePending = (
  restoreFrom: { current: string | null },
  initialRouteHandled: boolean,
  restoreRoute: string | null,
  { pathname, search }: { pathname: string; search: string },
): boolean => {
  const currentRoute = buildPersistedRoute(pathname, search);
  const pending = initialRouteHandled
    ? currentRoute === restoreFrom.current
    : restoreRoute !== null && currentRoute !== restoreRoute;
  restoreFrom.current = pending ? currentRoute : null;
  return pending;
};
