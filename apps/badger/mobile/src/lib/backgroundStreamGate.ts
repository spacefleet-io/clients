import type { AppStateLike } from "./foregroundSync";

export type BackgroundStreamGate = {
  /** Feed an AppState change into the gate. */
  observe: (state: AppStateLike) => void;
  isOpen: () => boolean;
};

/**
 * Keeps a live connection (the library change stream) open only while the app is on screen (#957, PERF-MOBILE-04):
 * `close` runs when the app goes to the background, `open` when it comes back. It opens at once unless the app
 * starts in the background. `inactive` (iOS, transient) and `unknown` change nothing. What the app missed meanwhile
 * comes from the foreground sync (createForegroundSyncScheduler), not from the stream.
 */
export const createBackgroundStreamGate = (
  initial: AppStateLike,
  hooks: { open: () => void; close: () => void }
): BackgroundStreamGate => {
  let open = false;
  const observe = (state: AppStateLike) => {
    if (state === "background" && open) {
      open = false;
      hooks.close();
    } else if (state === "active" && !open) {
      open = true;
      hooks.open();
    }
  };
  if (initial !== "background") {
    open = true;
    hooks.open();
  }
  return { observe, isOpen: () => open };
};
