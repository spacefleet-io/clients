import type { ReactNode } from "react";
import { BrowserRouter } from "react-router-dom";

/**
 * The packaged renderer is loaded with `win.loadFile()`, so the document
 * itself is a `file:` URL and the router's pathname starts with the document's
 * own path. Route matching only ever works because the router rewrites that
 * path to `/login`, `/home`, ... via pushState.
 *
 * On Windows the document lives on a drive (`file:///C:/.../index.html`) and
 * the browser resolves `/login` against it to `file:///C:/login`, i.e. the
 * pathname `/C:/login`, which no route matches: the auth guard then redirects
 * to `/login` again, forever. Treating the drive segment as the router
 * basename makes `/login` mean `/C:/login` on every drive, with no OS check:
 * the basename is derived from the URL shape alone, and is empty for POSIX
 * file URLs, UNC file URLs and http(s) (dev server).
 */
const FILE_URL_DRIVE_SEGMENT = /^\/[A-Za-z]:(?=\/|$)/;

export const resolveRouterBasename = (location: { protocol: string; pathname: string }): string => {
  if (location.protocol !== "file:") return "";
  return FILE_URL_DRIVE_SEGMENT.exec(location.pathname)?.[0] ?? "";
};

/** `win` is a test seam; production always uses the real `window`. */
export function AppRouter({ children, win }: { children: ReactNode; win?: Window }) {
  return (
    <BrowserRouter window={win} basename={resolveRouterBasename((win ?? window).location)}>
      {children}
    </BrowserRouter>
  );
}
