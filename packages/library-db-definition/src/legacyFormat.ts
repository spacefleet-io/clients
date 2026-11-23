/**
 * META-SRC-09: the names older apps wrote into the library, read here and nowhere else.
 *
 * - Op stream v1–v2: a `media.upsert` carried the title's catalog id as `details.tmdbId` (plus `details.externalIds`,
 *   other sites' ids the library no longer keeps) and each cast or crew member's as `tmdbId`. From v3 they are
 *   `catalogId`; `neutralMediaDetails` reads both, so a library's old ops still replay.
 * - Local rows: `media_external_ids` / `people_external_ids` stored the catalog id under the source `tmdb`, beside
 *   other sites' ids. `catalogSourceMigrationStatements` renames the source to `catalog` and drops the other rows;
 *   the readers still accept the old source for a snapshot restored before that migration ran.
 * - Schema before the external-id tables: `media_items.tmdb_id` (`hasPreExternalIdsLayout`).
 *
 * Delete once `MIN_SUPPORTED_OP_STREAM_VERSION` is 3 or more and every supported app runs the source migration.
 */
import type { MediaCastMember, MediaCrewMember, MediaDetails } from "@space/shared/libraryTypes";
import { CATALOG_ID_SOURCE } from "./catalogId";

/** The source name of the catalog id in the external-id tables of older libraries. */
export const LEGACY_CATALOG_ID_SOURCE = "tmdb";

/** The `source` of a catalog id row, new or old. */
export const CATALOG_ID_SOURCES: readonly string[] = [CATALOG_ID_SOURCE, LEGACY_CATALOG_ID_SOURCE];

/** `source IN (…)` list matching a catalog id row, new or old. */
export const CATALOG_ID_SOURCES_SQL = CATALOG_ID_SOURCES.map((source) => `'${source}'`).join(", ");

/** The pre-external-id layout kept the catalog id in this `media_items` column. */
export const hasPreExternalIdsLayout = (mediaItemsColumns: readonly string[]) => mediaItemsColumns.includes("tmdb_id");

type LegacyPerson = { catalogId?: number | null; tmdbId?: number | null };
type LegacyDetails = MediaDetails & { tmdbId?: number | null; externalIds?: Record<string, unknown> | null };

const personCatalogId = (person: LegacyPerson): number | null => person.catalogId ?? person.tmdbId ?? null;

/**
 * A `media.upsert` payload's details in the current shape: an op written by an app of op stream v1–v2 gets its
 * catalog ids from the old keys. Current details come back unchanged.
 */
export const neutralMediaDetails = (details: MediaDetails): MediaDetails => {
  const legacy = details as LegacyDetails;
  const isLegacy =
    "tmdbId" in legacy ||
    "externalIds" in legacy ||
    (legacy.cast ?? []).some((member) => "tmdbId" in member) ||
    (legacy.crew ?? []).some((member) => "tmdbId" in member);
  if (!isLegacy) return details;
  const fromExternalIds = legacy.externalIds?.[LEGACY_CATALOG_ID_SOURCE];
  const { tmdbId: _tmdbId, externalIds: _externalIds, ...rest } = legacy;
  return {
    ...rest,
    catalogId:
      legacy.catalogId ?? legacy.tmdbId ?? (typeof fromExternalIds === "number" ? fromExternalIds : null),
    cast: (legacy.cast ?? []).map((member): MediaCastMember => {
      const { tmdbId: _id, ...person } = member as MediaCastMember & LegacyPerson;
      return { ...person, catalogId: personCatalogId(member as LegacyPerson) };
    }),
    ...(Array.isArray(legacy.crew)
      ? {
          crew: legacy.crew.map((member): MediaCrewMember => {
            const { tmdbId: _id, ...person } = member as MediaCrewMember & LegacyPerson;
            return { ...person, catalogId: personCatalogId(member as LegacyPerson) };
          }),
        }
      : {}),
  };
};

/**
 * The external-id rows of an older library in the current shape: the catalog id under `catalog`, nothing else.
 * A row the rename would duplicate is dropped with the other sites' rows.
 */
export const catalogSourceMigrationStatements = (group: "core" | "metadata"): string[] => {
  const table = group === "core" ? "media_external_ids" : "people_external_ids";
  return [
    `UPDATE OR IGNORE ${table} SET source = '${CATALOG_ID_SOURCE}' WHERE source = '${LEGACY_CATALOG_ID_SOURCE}';`,
    `DELETE FROM ${table} WHERE source <> '${CATALOG_ID_SOURCE}';`,
  ];
};
