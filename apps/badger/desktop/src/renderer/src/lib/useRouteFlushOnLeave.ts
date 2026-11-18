import { useEffect } from "react";
import { AUTH_TOKEN_KEY } from "../../../shared/sessionKeys";
import { persistLastAuthenticatedRoute } from "./routePersistence";

/**
 * Flushes the current route to the last-route store when the page is going away (`pagehide`,
 * `beforeunload`) and when the shell leaves a location, so the route a user was on is the one a
 * relaunch reopens.
 *
 * Nothing is flushed once the session is gone. Logout removes the token, then clears the stored
 * route, then signs the user out; RequireAuth unmounts the whole shell in that signed-out commit
 * without rendering it again, so this hook never sees `signedIn: false` and its unmount cleanup
 * would write the route straight back, to localStorage and to main's session.json, and the next
 * user to sign in on this machine would land on the previous user's page (#25). The stored token,
 * not a prop, is therefore what says whether the session is still alive.
 */
export const useRouteFlushOnLeave = ({
  signedIn,
  pathname,
  search,
  restorePending,
}: {
  signedIn: boolean;
  pathname: string;
  search: string;
  restorePending: boolean;
}): void => {
  useEffect(() => {
    if (!signedIn || restorePending) return;
    const persistCurrentRoute = () => {
      if (localStorage.getItem(AUTH_TOKEN_KEY) === null) return;
      persistLastAuthenticatedRoute(pathname, search);
    };
    window.addEventListener("pagehide", persistCurrentRoute);
    window.addEventListener("beforeunload", persistCurrentRoute);
    return () => {
      persistCurrentRoute();
      window.removeEventListener("pagehide", persistCurrentRoute);
      window.removeEventListener("beforeunload", persistCurrentRoute);
    };
  }, [signedIn, pathname, search, restorePending]);
};
