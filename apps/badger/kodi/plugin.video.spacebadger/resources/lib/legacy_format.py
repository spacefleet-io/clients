# -*- coding: utf-8 -*-
"""META-SRC-09: the names older apps wrote into the library, read here and nowhere else.

Port of packages/library-db-definition/src/legacyFormat.ts:
- Op stream v1-v2: a ``media.upsert`` carried the title's catalog id as ``details.tmdbId`` (or only under
  ``details.externalIds.tmdb``, beside other sites' ids the library no longer keeps) and each cast member's as
  ``tmdbId``. From v3 they are ``catalogId``; ``catalog_id`` reads both, so a library's old ops still replay.
- Local rows: ``media_external_ids`` / ``people_external_ids`` stored the catalog id under the source ``tmdb``. The
  apps' migration renames it to ``catalog``; a snapshot written before it still holds the old source, which the readers
  accept (``ops_sql.CATALOG_ID_SOURCES``).

Delete once the oldest supported app writes op stream v3 and every library ran the source migration.
"""

# The source name of the catalog id in the external-id tables of older libraries.
LEGACY_CATALOG_ID_SOURCE = "tmdb"

# The key op streams v1-v2 used for a title's or a cast member's catalog id.
LEGACY_CATALOG_ID_KEY = "tmdbId"

# The op streams v1-v2 map of a title's ids on other sites, the catalog id under LEGACY_CATALOG_ID_SOURCE.
LEGACY_EXTERNAL_IDS_KEY = "externalIds"


def catalog_id(entry):
    """The catalog id of a ``media.upsert``'s details or one of its cast members, new key or old; None when absent."""
    value = entry.get("catalogId")
    if value is None:
        value = entry.get(LEGACY_CATALOG_ID_KEY)
    if value is None:
        from_external_ids = (entry.get(LEGACY_EXTERNAL_IDS_KEY) or {}).get(LEGACY_CATALOG_ID_SOURCE)
        if isinstance(from_external_ids, (int, float)) and not isinstance(from_external_ids, bool):
            value = from_external_ids
    return value


def neutral_media_details(details):
    """neutralMediaDetails (legacyFormat.ts): a ``media.upsert``'s details with any v1-v2 catalog keys (``tmdbId``,
    ``externalIds``, a cast or crew member's ``tmdbId``) turned into ``catalogId``. Current details come back as is."""
    def legacy_person(member):
        return isinstance(member, dict) and LEGACY_CATALOG_ID_KEY in member

    if not (LEGACY_CATALOG_ID_KEY in details or LEGACY_EXTERNAL_IDS_KEY in details
            or any(legacy_person(m) for m in details.get("cast") or [])
            or any(legacy_person(m) for m in details.get("crew") or [])):
        return details

    def person(member):
        out = dict((k, v) for k, v in member.items() if k != LEGACY_CATALOG_ID_KEY)
        value = member.get("catalogId")
        out["catalogId"] = value if value is not None else member.get(LEGACY_CATALOG_ID_KEY)
        return out

    out = dict((k, v) for k, v in details.items() if k not in (LEGACY_CATALOG_ID_KEY, LEGACY_EXTERNAL_IDS_KEY))
    out["catalogId"] = catalog_id(details)
    out["cast"] = [person(m) for m in details.get("cast") or []]
    if isinstance(details.get("crew"), list):
        out["crew"] = [person(m) for m in details["crew"]]
    return out
