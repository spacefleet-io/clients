import { useCallback } from "react";
import { type Location, useLocation, useNavigate, useSearchParams } from "react-router-dom";

/**
 * What the detail page keeps in each of its own history entries: how many entries it pushed on top of the one it was
 * opened on, and whether that one was the first entry of the app (a restored route, nothing behind it).
 */
type MediaDetailHistoryState = {
  mediaDetailDepth: number;
  mediaDetailOpenedFirst: boolean;
};

const readMediaDetailHistory = (location: Location): MediaDetailHistoryState => {
  const state = location.state as Partial<MediaDetailHistoryState> | null;
  if (state && typeof state.mediaDetailDepth === "number") {
    return { mediaDetailDepth: state.mediaDetailDepth, mediaDetailOpenedFirst: Boolean(state.mediaDetailOpenedFirst) };
  }
  return { mediaDetailDepth: 0, mediaDetailOpenedFirst: location.key === "default" };
};

/**
 * The URL side of the detail page (`/media/:id`, LIB-DETAIL-01): the open trailer in `?trailer=` and the back link.
 *
 * Opening a trailer pushes an entry, so Back closes it; closing it replaces the entry, so no `?trailer=` entry is left
 * behind for Back or the back link to land on. The back link skips every entry the page pushed and returns to where the
 * page was opened from (LIB-DETAIL-05). It used to go back one entry, which after Trailer → close was the `?trailer=`
 * entry, so "← Library" reopened the trailer (2026-11-12).
 */
export function useMediaDetailHistory() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const setTrailerParam = useCallback(
    (key: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (key) next.set("trailer", key);
      else next.delete("trailer");
      const history = readMediaDetailHistory(location);
      const state: MediaDetailHistoryState = {
        ...history,
        mediaDetailDepth: key ? history.mediaDetailDepth + 1 : history.mediaDetailDepth,
      };
      // eslint-disable-next-line no-console -- intentional [media-detail-history] diagnostic (keep-diagnostic-logs)
      console.info("[media-detail-history] trailer param", { key, replace: !key, ...state });
      setSearchParams(next, { replace: !key, state });
    },
    [location, searchParams, setSearchParams]
  );

  const back = useCallback(() => {
    const history = readMediaDetailHistory(location);
    // eslint-disable-next-line no-console -- intentional [media-detail-history] diagnostic (keep-diagnostic-logs)
    console.info("[media-detail-history] back link", history);
    if (history.mediaDetailOpenedFirst) navigate("/media-library");
    else navigate(-(history.mediaDetailDepth + 1));
  }, [location, navigate]);

  return { searchParams, setTrailerParam, back };
}
