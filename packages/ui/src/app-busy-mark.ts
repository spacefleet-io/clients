import { useEffect } from "react";

/**
 * `<html data-app-busy>` is set while the app processes media (Badger's
 * ingest and transcode jobs). The backdrop stops the sky's shooting stars under
 * it (UX-SKY-01): every animated sky frame is restyled and recomposited, which
 * on software compositing costs the frames the job progress needs (#2461).
 */
export const APP_BUSY_ATTRIBUTE = "data-app-busy";

let activeMarks = 0;

/** Marks the document as busy while `active`; several marks may overlap. */
export const useAppBusyMark = (active: boolean): void => {
  useEffect(() => {
    if (!active) return;
    activeMarks += 1;
    document.documentElement.setAttribute(APP_BUSY_ATTRIBUTE, "");
    return () => {
      activeMarks -= 1;
      if (activeMarks === 0) document.documentElement.removeAttribute(APP_BUSY_ATTRIBUTE);
    };
  }, [active]);
};
