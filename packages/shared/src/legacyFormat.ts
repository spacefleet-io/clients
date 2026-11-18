/**
 * META-SRC-09: the one place the shared code still reads names that apps released before the neutral format wrote
 * into a user's library. New writes never use them. Delete this module (and its callers' fallbacks) once the oldest
 * supported Badger writes the neutral format and every library has been rewritten since.
 */

/** The `source` a fetched subtitle track carried before `fetched` (alone, or `<this>:<fileId>`). */
export const LEGACY_FETCHED_SUBTITLE_SOURCE = "opensubtitles";
