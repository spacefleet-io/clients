import { useEffect, useRef } from "react";

type TrailerParamSyncArgs = {
  /** The title the page shows (`/media/:id`). */
  selectedId: string | null;
  /** The id of the loaded details, null until they load. */
  detailsId: string | null;
  /** `?trailer=` as the URL holds it now. */
  searchTrailerParam: string | null;
  activeTrailerKey: string | null;
  setActiveTrailerKey: (key: string | null) => void;
  /** Writes `?trailer=` (opening pushes, so Back closes the trailer; closing replaces, see useMediaDetailHistory). */
  setTrailerParam: (key: string | null) => void;
};

/**
 * Keeps the open trailer and the `?trailer=` param of the detail page in step. Each side writes the other only when
 * IT changed: a URL change (Back, a deep link) sets the open trailer, a local open/close writes the URL. Comparing
 * both on every change made them fight after Back onto a `?trailer=` entry: the URL side set the new key while the
 * state side, still holding the old one, wrote it back, forever ("Maximum update depth exceeded" in the trailer
 * Dialog's Portal, 2026-11-09).
 */
export function useTrailerParamSync({
  selectedId,
  detailsId,
  searchTrailerParam,
  activeTrailerKey,
  setActiveTrailerKey,
  setTrailerParam,
}: TrailerParamSyncArgs): void {
  const trailerParamRef = useRef(searchTrailerParam);
  trailerParamRef.current = searchTrailerParam;
  const lastActiveKeyRef = useRef(activeTrailerKey);

  useEffect(() => {
    if (!detailsId) return;
    if (selectedId !== detailsId) return;
    setActiveTrailerKey(searchTrailerParam || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setter is stable
  }, [detailsId, selectedId, searchTrailerParam]);

  useEffect(() => {
    const changed = lastActiveKeyRef.current !== activeTrailerKey;
    lastActiveKeyRef.current = activeTrailerKey;
    if (!changed) return;
    if (!detailsId) return;
    if (selectedId !== detailsId) return;
    if ((trailerParamRef.current ?? "") !== (activeTrailerKey ?? "")) {
      setTrailerParam(activeTrailerKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setTrailerParam changes with every URL
  }, [activeTrailerKey, detailsId, selectedId]);
}
