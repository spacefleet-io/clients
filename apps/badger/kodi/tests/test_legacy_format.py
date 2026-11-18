"""A library written by an older app still loads in the add-on.

@req META-SRC-09[badger-kodi] old catalog ids still read; new writes use the neutral source only

An op of op stream v1-v2 carries the catalog ids under the old keys, and a snapshot taken before the apps' source
migration keeps the catalog id rows under the old source. Both read as today's `catalogId`, and the add-on writes the
neutral source only.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _path  # noqa: E402,F401
import details as D  # noqa: E402
import legacy_format  # noqa: E402
import ops_sql  # noqa: E402
import test_details as td  # noqa: E402  (schema + fixtures; module import, so its tests do not run twice)


def legacy_movie():
    """The movie fixture as an app of op stream v1-v2 wrote it."""
    details = td.movie_fixture()
    catalog_id = details.pop("catalogId")
    details[legacy_format.LEGACY_CATALOG_ID_KEY] = catalog_id
    details[legacy_format.LEGACY_EXTERNAL_IDS_KEY] = {legacy_format.LEGACY_CATALOG_ID_SOURCE: catalog_id, "other": "x1"}
    for member in details["cast"]:
        member[legacy_format.LEGACY_CATALOG_ID_KEY] = member.pop("catalogId")
    return details


class LegacyFormat(unittest.TestCase):
    def tearDown(self):
        while td._OPEN:
            td._OPEN.pop().close()

    def test_an_old_op_replays_as_the_current_details(self):
        old = legacy_movie()
        conn = td.make_db([old])
        sources = sorted({row[0] for row in conn.execute("SELECT source FROM media_external_ids")})
        people_sources = sorted({row[0] for row in conn.execute("SELECT source FROM people_external_ids")})
        print("[legacy-format] sources", sources, people_sources)
        self.assertEqual(sources, [ops_sql.CATALOG_ID_SOURCE])
        self.assertEqual(people_sources, [ops_sql.CATALOG_ID_SOURCE])
        self.assertEqual(D.build_media_details(conn, old["id"]), td.movie_fixture())

    def test_an_old_op_with_the_id_only_among_other_sites_ids(self):
        old = legacy_movie()
        del old[legacy_format.LEGACY_CATALOG_ID_KEY]
        conn = td.make_db([old])
        self.assertEqual(D.build_media_details(conn, old["id"])["catalogId"], td.movie_fixture()["catalogId"])

    def test_a_snapshot_before_the_source_migration_still_reads(self):
        current = td.movie_fixture()
        conn = td.make_db([current])
        conn.execute("UPDATE media_external_ids SET source = ?", (legacy_format.LEGACY_CATALOG_ID_SOURCE,))
        conn.execute("UPDATE people_external_ids SET source = ?", (legacy_format.LEGACY_CATALOG_ID_SOURCE,))
        built = D.build_media_details(conn, current["id"])
        print("[legacy-format] old-source read", built["catalogId"], [m["catalogId"] for m in built["cast"]])
        self.assertEqual(built, current)


if __name__ == "__main__":
    unittest.main()
