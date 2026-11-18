/**
 * META-SRC-09: the one place the desktop still reads names that Badger versions released before the neutral format
 * wrote into a user's library (skip-marker cache payloads in `media_skip_analysis`, skip-marker `source` values).
 * New writes never use them. Delete this module (and its callers' fallbacks) once the oldest supported Badger writes
 * the neutral format and every cache row has been rewritten since.
 */

/** Provider tags older skip-marker cache payloads carry (both stay valid so cached rows are not fetched again). */
export const LEGACY_SKIP_MARKER_PROVIDERS: readonly string[] = ["theintrodb-v2", "theintrodb-v3"];

/** Prefix of the `source` older service-fetched skip markers carry (`<prefix>-v2`, `<prefix>-v3`). */
export const LEGACY_SKIP_MARKER_SOURCE_PREFIX = "external:theintrodb";

/** The show cache payload's catalog id key before `showCatalogId`. */
export const LEGACY_SHOW_CATALOG_ID_KEY = "showTmdbId";

export const readLegacyShowCatalogId = (record: Record<string, unknown>): unknown => record[LEGACY_SHOW_CATALOG_ID_KEY];
