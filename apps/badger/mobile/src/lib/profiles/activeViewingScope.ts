/**
 * The profile whose viewing state LibraryDb reads and writes right now (ACCT-SQUAD-02). Process-wide, because every
 * LibraryDb instance (cached, remote, fallback) must follow the profile picked in "Who's watching?"; LibraryDb reads
 * it at each call, so a switch applies to the next read without reopening the library.
 */
import { MAIN_VIEWING_SCOPE, type ViewingScope } from "@space/shared/profileViewing";
import { bumpLibraryRevision } from "../libraryRevision";

let current: ViewingScope = MAIN_VIEWING_SCOPE;
const listeners = new Set<(scope: ViewingScope) => void>();

export const getViewingScope = (): ViewingScope => current;

export const setViewingScope = (next: ViewingScope) => {
  if (next.prefix === current.prefix && next.profileId === current.profileId) return;
  console.info("profiles.scope", JSON.stringify({ from: current.profileId, to: next.profileId, main: next.prefix === "" }));
  current = next;
  // Every viewing-state read now answers for another profile.
  bumpLibraryRevision();
  for (const listener of [...listeners]) listener(next);
};

export const onViewingScopeChange = (listener: (scope: ViewingScope) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
