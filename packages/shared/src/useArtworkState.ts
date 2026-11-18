import { useCallback, useEffect, useReducer } from "react";
import {
  ARTWORK_LOAD_TIMEOUT_MS,
  artworkAwaitsSource,
  artworkReducer,
  artworkStateFor,
  type ArtworkSource,
  type ArtworkState,
} from "./artworkImage";

/**
 * A tile's look for its picture (UX-WAIT-03), the same hook for React DOM and React Native: feeds the app's
 * `ArtworkSource` into `artworkReducer`, runs the stall clock while the picture is still being fetched (one timer per
 * waiting tile, none once it has an address), and hands back the image view's load and error handlers.
 * A tile showing another title must remount (key it by the artwork path): a new title starts over at `loading`.
 */
export const useArtworkState = (
  source: ArtworkSource,
  timeoutMs: number = ARTWORK_LOAD_TIMEOUT_MS,
): { state: ArtworkState; onLoad: (url: string) => void; onError: (url: string) => void } => {
  const [state, dispatch] = useReducer(artworkReducer, source, artworkStateFor);
  const url = source.kind === "url" ? source.url : null;

  useEffect(() => {
    dispatch({ type: "source", source: url !== null ? { kind: "url", url } : source.kind === "none" ? { kind: "none" } : { kind: "pending" } });
  }, [source.kind, url]);

  const awaiting = artworkAwaitsSource(state);
  useEffect(() => {
    if (!awaiting) return undefined;
    const timer = setTimeout(() => dispatch({ type: "timeout" }), timeoutMs);
    return () => clearTimeout(timer);
  }, [awaiting, timeoutMs]);

  const onLoad = useCallback((loaded: string) => dispatch({ type: "load", url: loaded }), []);
  const onError = useCallback((failed: string) => dispatch({ type: "error", url: failed }), []);
  return { state, onLoad, onError };
};
