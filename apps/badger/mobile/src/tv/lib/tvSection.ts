/**
 * The TV top bar's sections (UX-TV-09). The shell notes which one is open, so a page opened from it (a title page) can
 * name it on its on-screen Back button ("Back to Library") and `goBack()` lands on that same section: the shell stays
 * mounted under the page with its tab unchanged.
 */
export type TvSectionId = "home" | "library" | "playlists" | "search" | "settings";

let current: TvSectionId = "home";

export const setCurrentTvSection = (section: TvSectionId): void => {
  current = section;
};

export const currentTvSection = (): TvSectionId => current;

const requestListeners = new Set<(section: TvSectionId) => void>();

/**
 * Ask the shell to open a section: a page above it (the title page shows the top bar too) calls this, then goes back, and
 * the shell under it is already on that section.
 */
export const requestTvSection = (section: TvSectionId): void => {
  current = section;
  for (const listener of requestListeners) listener(section);
};

/** The shell listens for `requestTvSection`; returns the unsubscribe. */
export const subscribeTvSectionRequest = (listener: (section: TvSectionId) => void): (() => void) => {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
};

/** Translation key of the title page's Back button for the section it returns to. */
export const tvBackLabelKey = (section: TvSectionId): string => {
  switch (section) {
    case "library":
      return "tvShell.details.backToLibrary";
    case "playlists":
      return "tvShell.details.backToPlaylists";
    case "search":
      return "tvShell.details.backToSearch";
    default:
      return "tvShell.details.backToHome";
  }
};
