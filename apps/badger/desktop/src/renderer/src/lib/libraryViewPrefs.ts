import { useCallback, useState } from "react";
import {
  patchLibraryTabPrefs,
  sanitizeLibraryViewPrefs,
  type LibraryTab,
  type LibraryTabPrefs,
  type LibraryViewPrefs,
} from "@space/shared/libraryView";

/**
 * Library view mode and sort, remembered per Movies/TV tab on this computer only. Deliberately NOT part of
 * `ClientConfig`: that config syncs to the library database, which would share one computer's view choice with every
 * other desktop and push a remote op per click.
 */
export const LIBRARY_VIEW_PREFS_KEY = "library.viewPrefs";

export type LibraryViewPrefsState = [LibraryViewPrefs, (tab: LibraryTab, patch: Partial<LibraryTabPrefs>) => void];

export const loadLibraryViewPrefs = (): LibraryViewPrefs => {
  try {
    const raw = localStorage.getItem(LIBRARY_VIEW_PREFS_KEY);
    return sanitizeLibraryViewPrefs(raw ? JSON.parse(raw) : undefined);
  } catch {
    return sanitizeLibraryViewPrefs(undefined);
  }
};

export function useLibraryViewPrefs(): LibraryViewPrefsState {
  const [prefs, setPrefs] = useState(loadLibraryViewPrefs);
  const updatePrefs = useCallback((tab: LibraryTab, patch: Partial<LibraryTabPrefs>) => {
    setPrefs((current) => {
      const next = patchLibraryTabPrefs(current, tab, patch);
      try {
        localStorage.setItem(LIBRARY_VIEW_PREFS_KEY, JSON.stringify(next));
      } catch {
        // Storage full or blocked: the choice still applies until the screen is left.
      }
      return next;
    });
  }, []);
  return [prefs, updatePrefs];
}
