/**
 * A counter that moves whenever what a screen read from the library may have changed: a local write (every local
 * mutation queues an op), remote ops or a new snapshot applied, a "last played episode" hint saved, or another
 * profile picked. A screen that read at revision N has nothing new to read while the revision is still N (#957: the
 * TV details page re-read everything each time it regained focus).
 */
let revision = 0;

export const bumpLibraryRevision = () => {
  revision += 1;
};

export const libraryRevision = () => revision;

/**
 * A second counter that moves only when another device's changes land (remote ops or a new snapshot applied), never
 * on this device's own writes. The player polls it while the playing video has no preview pictures (MPV-PREV-04):
 * the progress it saves every few seconds moves `libraryRevision` and would make it re-read the title for nothing.
 */
let syncedRevision = 0;

export const bumpSyncedLibraryRevision = () => {
  syncedRevision += 1;
};

export const syncedLibraryRevision = () => syncedRevision;
