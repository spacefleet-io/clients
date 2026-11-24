import { useEffect } from "react";

/**
 * `<html data-app-playback>` is set while anything plays (a video in mpv, a
 * trailer, music). The backdrop flies no shooting star under it (UX-SKY-01),
 * and the desktop update modal waits for it to clear (REL-UPD-08).
 */
export const APP_PLAYBACK_ATTRIBUTE = "data-app-playback";

let activeMarks = 0;

/** Marks the document as playing while `active`; several players may overlap. */
export const useAppPlaybackMark = (active: boolean): void => {
  useEffect(() => {
    if (!active) return;
    activeMarks += 1;
    document.documentElement.setAttribute(APP_PLAYBACK_ATTRIBUTE, "");
    return () => {
      activeMarks -= 1;
      if (activeMarks === 0) document.documentElement.removeAttribute(APP_PLAYBACK_ATTRIBUTE);
    };
  }, [active]);
};
