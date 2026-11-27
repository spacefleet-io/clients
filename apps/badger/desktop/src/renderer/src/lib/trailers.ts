import { useEffect, useRef } from "react";
import { TitleDetails } from "@/api";
import { rendererLogger } from "@/logger";

const trailerLog = rendererLogger.child({ scope: "trailer" });

export const selectTrailersByLanguage = (
  details: Pick<TitleDetails, "trailers" | "originalLanguage">,
  extraLanguages: string[]
) => {
  const original = details.originalLanguage?.trim();
  const extras = extraLanguages.map((lang) => lang.trim()).filter(Boolean);
  if (!original && extras.length === 0) {
    return details.trailers;
  }
  const official = details.trailers.filter((trailer) => trailer.official);
  const candidates = official.length > 0 ? official : details.trailers;
  const allowed = new Set<string>();
  if (original) allowed.add(original);
  extras.forEach((lang) => allowed.add(lang));

  const filtered = candidates.filter((trailer) => allowed.has(trailer.language));
  return filtered.length > 0 ? filtered : candidates;
};

/**
 * `onOpenAutoFocus` for a dialog that embeds the trailer player (an iframe): focus the dialog itself, never the
 * player. Radix focuses the first tabbable element on open, and here that is the iframe, so keyboard focus moved
 * into the embedded page and Escape went to it instead of to the dialog, which then stayed open (#2296).
 */
export const keepTrailerDialogFocus = (event: Event) => {
  event.preventDefault();
  (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
};

/**
 * Closes the open trailer on an Escape pressed while keyboard focus is inside the embedded player (the user clicked
 * Play in it). The key then goes to the player's cross-origin page and never reaches the dialog, so main forwards
 * every Escape of the window (`escapeKeyForward.ts`). An Escape with focus in the app's own document is left to the
 * dialog's handler, so the trailer closes once.
 */
export const useCloseTrailerOnPlayerEscape = (open: boolean, close: () => void) => {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    let closed = false;
    return window.sf?.onEscapeKey?.(() => {
      const focused = document.activeElement;
      const inPlayer = focused?.tagName === "IFRAME" && Boolean(focused.closest('[role="dialog"]'));
      trailerLog.info(`[trailer] Escape forwarded by main: focus=${focused?.tagName ?? "none"} inPlayer=${inPlayer} closed=${closed}`);
      if (!inPlayer || closed) return;
      closed = true;
      closeRef.current();
    });
  }, [open]);
};
