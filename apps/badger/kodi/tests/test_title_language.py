"""How titles appear for the followed profile (ACCT-PROF-03).

@req ACCT-PROF-03[badger-kodi] the followed profile's `titleLanguage` (its `profile_settings_v1` row, `p:<pid>:` for
                   a non-main profile) picks the shown title: "original" shows the original set of the title's
                   `title_variants_v1:<media id>` row, with its pictures only once copied (a catalog path keeps the
                   row's picture); "app", unset, a missing or unreadable row show the library row as stored

Each test prints phase markers prefixed with its id.
"""
import json
import os
import shutil
import sqlite3
import tempfile
import unittest

import _path  # noqa: F401
import library  # noqa: E402

TEST_ID = "KODI-TITLE-LANG-001"

SCHEMA = (
    "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
    """CREATE TABLE media_items (id TEXT PRIMARY KEY, type TEXT, title TEXT, updated_at TEXT, has_files INTEGER,
       progress_pct REAL, last_watched_at TEXT, total_episodes INTEGER, poster_path TEXT, backdrop_path TEXT)""",
    "CREATE TABLE media_external_ids (id TEXT PRIMARY KEY, media_id TEXT, media_type TEXT, source TEXT, external_id TEXT)",
)


def phase(msg, *args):
    print("[%s] %s" % (TEST_ID, msg % args if args else msg))


def variants(original):
    return json.dumps({"v": 1, "rowLanguage": "en", "rowTitle": "Hate", "original": original, "fetchedAt": "2026-11-16T00:00:00.000Z"})


def settings(option):
    return json.dumps({"titleLanguage": option, "fieldUpdatedAt": {"titleLanguage": "2026-11-16T00:00:00.000Z"},
                       "updatedAt": "2026-11-16T00:00:00.000Z"})


class TitleLanguage(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="sb-kodi-title-language-")
        conn = sqlite3.connect(os.path.join(self.dir, library.DB_NAME))
        for sql in SCHEMA:
            conn.execute(sql)
        media = [
            ("m1", "Hate", "vault/poster-en.jpg", "vault/backdrop-en.jpg"),
            ("m2", "Amelie", "vault/amelie-en.jpg", "vault/amelie-bd-en.jpg"),
            ("m3", "Battle of Gods", "vault/dbz.jpg", None),
            ("m4", "Broken", "vault/broken.jpg", None),
        ]
        for mid, title, poster, backdrop in media:
            conn.execute("INSERT INTO media_items VALUES (?,'movie',?,'t',1,0,NULL,NULL,?,?)", (mid, title, poster, backdrop))
        rows = [
            ("title_variants_v1:m1", variants({"language": "fr", "title": "La Haine", "posterPath": "vault/poster-fr.jpg",
                                               "backdropPath": "/catalogBackdrop.jpg"})),
            ("title_variants_v1:m2", variants({"language": "fr", "title": "Le Fabuleux Destin d'Amelie Poulain",
                                               "posterPath": "/catalogPoster.jpg", "backdropPath": None})),
            # Non-Latin original: the pass keeps no original set, the account-language row is shown either way.
            ("title_variants_v1:m3", variants(None)),
            ("title_variants_v1:m4", "{not json"),
            ("p:pkids:profile_settings_v1", settings("original")),
        ]
        conn.executemany("INSERT INTO app_settings VALUES (?, ?, 'x')", rows)
        conn.commit()
        conn.close()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def set_main(self, value):
        conn = sqlite3.connect(os.path.join(self.dir, library.DB_NAME))
        conn.execute("INSERT OR REPLACE INTO app_settings VALUES ('profile_settings_v1', ?, 'x')", (value,))
        conn.commit()
        conn.close()

    def shown(self, prefix):
        s = library.LibraryStore(self.dir, prefix=prefix)
        by_id = dict((m["id"], (m["title"], m["poster_path"], m["backdrop_path"])) for m in s.list_media("movie"))
        phase("prefix %r option %s -> %s", prefix, s.title_language(), by_id)
        return s, by_id

    def test_unset_option_shows_the_library_row(self):
        s, by_id = self.shown("")
        self.assertEqual(s.title_language(), "app")
        self.assertEqual(by_id["m1"], ("Hate", "vault/poster-en.jpg", "vault/backdrop-en.jpg"))
        self.assertEqual(s.get_media("m1")["title"], "Hate")

    def test_app_option_shows_the_library_row(self):
        self.set_main(settings("app"))
        _, by_id = self.shown("")
        self.assertEqual(by_id["m1"][0], "Hate")
        self.assertEqual(by_id["m2"][0], "Amelie")

    def test_original_option_shows_the_original_set_once_copied(self):
        self.set_main(settings("original"))
        s, by_id = self.shown("")
        # Copied original poster replaces the row's; the catalog backdrop is not copied yet, the row's stays.
        self.assertEqual(by_id["m1"], ("La Haine", "vault/poster-fr.jpg", "vault/backdrop-en.jpg"))
        self.assertEqual(by_id["m2"], ("Le Fabuleux Destin d'Amelie Poulain", "vault/amelie-en.jpg", "vault/amelie-bd-en.jpg"))
        # No original set (non-Latin original) and an unreadable row keep the row.
        self.assertEqual(by_id["m3"][0], "Battle of Gods")
        self.assertEqual(by_id["m4"][0], "Broken")
        self.assertEqual(s.get_media("m1")["title"], "La Haine")
        self.assertEqual(s.get_media("m1")["poster_path"], "vault/poster-fr.jpg")
        self.assertEqual([m["title"] for m in s.list_media("movie")],
                         ["Battle of Gods", "Broken", "La Haine", "Le Fabuleux Destin d'Amelie Poulain"])

    def test_each_profile_reads_its_own_option(self):
        _, kids = self.shown("p:pkids:")
        self.assertEqual(kids["m1"][0], "La Haine")
        _, main = self.shown("")
        self.assertEqual(main["m1"][0], "Hate")  # the main profile never answered
        _, sam = self.shown("p:psam:")
        self.assertEqual(sam["m1"][0], "Hate")

    def test_blank_or_malformed_settings_read_as_app(self):
        for raw in ("", "{oops", json.dumps({"titleLanguage": "original"}), settings("klingon")):
            self.set_main(raw)
            self.assertEqual(library.profile_title_language(raw), "app")
            self.assertEqual(self.shown("")[1]["m1"][0], "Hate")

    def test_variant_row_parsing_matches_the_shared_rules(self):
        self.assertIsNone(library.parse_title_variants(""))
        self.assertIsNone(library.parse_title_variants(json.dumps({"v": 2, "rowLanguage": "en", "rowTitle": "x"})))
        self.assertIsNone(library.parse_title_variants(json.dumps({"v": 1, "rowLanguage": " ", "rowTitle": "x"})))
        blank_title = library.parse_title_variants(variants({"language": "fr", "title": "  ", "posterPath": "a"}))
        self.assertIsNone(blank_title["original"])
        blank_poster = library.parse_title_variants(variants({"language": "fr", "title": "T", "posterPath": " "}))
        self.assertIsNone(blank_poster["original"]["posterPath"])

    def test_an_original_set_in_non_latin_letters_is_never_shown(self):
        # @bugfix @regression-proof Chris 2026-11-18: Bardock (catalog id 39323) showed its Japanese title under
        # "Original version"; whichever app wrote a non-Latin original set, the row's own set shows.
        row = {"title": "Dragon Ball Z - Le Père de Son Gokû", "poster_path": "asset:fr::k", "backdrop_path": "asset:b::k"}
        japanese = library.parse_title_variants(json.dumps({
            "v": 1, "rowLanguage": "fr", "rowTitle": row["title"], "fetchedAt": "",
            "original": {"language": "ja", "title": "ドラゴンボールZ たったひとりの最終決戦〜フリーザに挑んだZ戦士 孫悟空の父〜",
                         "posterPath": "asset:ja::k", "backdropPath": "asset:b::k"}}))
        shown = library.apply_title_variants(dict(row), japanese)
        phase("Bardock shown: %r", shown)
        self.assertEqual(shown, row)
        latin = library.parse_title_variants(variants({"language": "sr", "title": "Ko to tamo peva", "posterPath": None,
                                                        "backdropPath": None}))
        self.assertEqual(library.apply_title_variants(dict(row), latin)["title"], "Ko to tamo peva")
        self.assertTrue(library.is_latin_script_text("Le Fabuleux Destin d'Amélie Poulain 2"))
        for text in ("君の名は。", "기생충", "Летят журавли", "Ζορμπάς", "ฉลาดเกมส์โกง", "שבוע"):
            self.assertFalse(library.is_latin_script_text(text), text)


if __name__ == "__main__":
    unittest.main()
