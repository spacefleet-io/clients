"""Kodi takes titles, posters, backdrops, descriptions, years, seasons and episodes from the Badger library, including a
match the user fixed by hand; no title carries an id of the catalog it was matched in (META-SRC-09).

@req INTG-META-01 the plugin's directory items and the exported .nfo files carry the library rows loaded by the real
                  sync op (media.upsert): title, plot, year, poster/fanart/thumb art, season and episode
                  numbers; a hand-fixed match reaches Kodi as the new row values, never a guess from the file name
"""
import json
import os
import tempfile
import unittest
from unittest import mock

os.environ.setdefault("SB_DATA_DIR", tempfile.mkdtemp(prefix="sb-kodi-intg-meta-"))

import _path  # noqa: F401,E402
import export  # noqa: E402
import library  # noqa: E402
import ops_sql  # noqa: E402
import router  # noqa: E402
import test_details as td  # noqa: E402  (schema + library fixtures; module import, so its tests do not run twice)


def log(phase, msg, data=None):
    print("[intg-meta-01] %s: %s%s" % (phase, msg, "" if data is None else " " + json.dumps(data, sort_keys=True, default=str)))


class FakeTag(object):
    def __init__(self):
        self.info = {}

    def __getattr__(self, name):
        if not name.startswith("set"):
            raise AttributeError(name)

        def setter(*args):
            self.info[name[3:]] = args[0] if len(args) == 1 else list(args)
        return setter


class FakeListItem(object):
    def __init__(self, label=""):
        self.label = label
        self.tag = FakeTag()
        self.art = {}
        self.props = {}

    def getVideoInfoTag(self):
        return self.tag

    def setArt(self, art):
        self.art.update(art)

    def setProperty(self, key, value):
        self.props[key] = value

    def dump(self):
        return {"label": self.label, "info": self.tag.info, "art": self.art}


class FakePlugin(object):
    def __init__(self):
        self.items = []

    def setContent(self, handle, content):
        pass

    def addDirectoryItems(self, handle, items):
        self.items.extend(items)

    def endOfDirectory(self, handle):
        pass


class MemoryStore(library.LibraryStore):
    """The add-on's LibraryStore queries over an in-memory database filled by the real sync op."""

    def __init__(self, conn):
        self.prefix = ""
        self._conn = conn

    def conn(self):
        return self._conn


def fake_art(_ctx, wanted, **_kw):
    return {w: "cache/%s%s" % w for w in wanted if w[1]}


class KodiItemsCarryLibraryMetadata(unittest.TestCase):
    def setUp(self):
        self.conn = td.make_db([td.movie_fixture(), td.tv_fixture()])
        self.ctx = type("Ctx", (), {"ready": True})()
        self.ctx.lib = MemoryStore(self.conn)
        self.plugin = FakePlugin()
        for target, attr, value, create in (
            (router, "xbmcgui", type("xbmcgui", (), {"ListItem": FakeListItem}), True),
            (router, "xbmcplugin", self.plugin, True),
            (router.core, "Context", lambda: self.ctx, False),
            (router.images, "fetch_many", fake_art, False),
        ):
            patcher = mock.patch.object(target, attr, value, create=create)
            patcher.start()
            self.addCleanup(patcher.stop)

    def listed(self, fn, *args):
        self.plugin.items = []
        fn(1, *args)
        return [li.dump() for (_url, li, _folder) in self.plugin.items]

    def test_movie_show_season_and_episode_items(self):
        # @req INTG-META-01
        log("phase", "movie items")
        movies = self.listed(router.list_movies)
        log("state", "movies", movies)
        self.assertEqual(len(movies), 1)
        m = movies[0]
        self.assertEqual(m["label"], "Inception")
        self.assertEqual(m["info"]["Title"], "Inception")
        self.assertEqual(m["info"]["OriginalTitle"], "Inception (orig)")
        self.assertEqual(m["info"]["Plot"], "Overview text")
        self.assertEqual(m["info"]["Year"], 2010)
        self.assertEqual(m["info"]["MediaType"], "movie")
        self.assertNotIn("UniqueIDs", m["info"])
        self.assertEqual(m["art"], {"poster": "cache/poster/poster.jpg", "thumb": "cache/poster/poster.jpg",
                                    "fanart": "cache/backdrop/backdrop.jpg"})

        log("phase", "show items")
        shows = self.listed(router.list_shows)
        log("state", "shows", shows)
        self.assertEqual([s["info"]["Title"] for s in shows], ["Breaking Bad"])
        self.assertNotIn("UniqueIDs", shows[0]["info"])
        self.assertEqual(shows[0]["info"]["MediaType"], "tvshow")
        self.assertEqual(shows[0]["art"]["fanart"], "cache/backdrop/backdrop.jpg")

        log("phase", "season items")
        seasons = self.listed(router.list_seasons, "tv-1")
        log("state", "seasons", seasons)
        self.assertEqual([(s["info"]["Season"], s["info"]["Title"], s["info"]["TvShowTitle"]) for s in seasons],
                         [(1, "Season 1", "Breaking Bad")])
        self.assertEqual(seasons[0]["art"]["poster"], "cache/poster/s1.jpg")

        log("phase", "episode items")
        episodes = self.listed(router.list_episodes, "tv-1", 1)
        log("state", "episodes", episodes)
        # only episodes with a file are listed (S01E03 has none)
        self.assertEqual([(e["info"]["Season"], e["info"]["Episode"], e["info"]["Title"]) for e in episodes],
                         [(1, 1, "Pilot"), (1, 2, "Cat's in the Bag")])
        self.assertEqual(episodes[0]["info"]["Plot"], "o1")
        self.assertEqual(episodes[0]["info"]["FirstAired"], "2008-01-20")
        self.assertEqual(episodes[0]["art"], {"thumb": "cache/still/e1.jpg", "fanart": "cache/backdrop/backdrop.jpg"})
        self.assertNotIn("thumb", episodes[1]["art"])  # no still in the library: no invented picture

    def test_exported_nfo_files_carry_the_library_rows(self):
        # @req INTG-META-01
        movie = self.ctx.lib.get_media("movie-1")
        show = self.ctx.lib.get_media("tv-1")
        ep = self.ctx.lib.episodes("tv-1", 1)[0]
        movie_nfo, show_nfo, ep_nfo = export.movie_nfo(movie), export.tvshow_nfo(show), export.episode_nfo(show["title"], ep)
        log("state", "nfo", {"movie": movie_nfo, "show": show_nfo, "episode": ep_nfo})
        self.assertIn("<title>Inception</title>", movie_nfo)
        self.assertIn("<year>2010</year>", movie_nfo)
        self.assertIn("<plot>Overview text</plot>", movie_nfo)
        self.assertNotIn("<uniqueid", movie_nfo)
        self.assertNotIn("<uniqueid", show_nfo)
        self.assertIn("<title>Breaking Bad</title>", show_nfo)
        self.assertIn("<title>Pilot</title>", ep_nfo)
        self.assertIn("<season>1</season>", ep_nfo)
        self.assertIn("<episode>1</episode>", ep_nfo)
        self.assertIn("<aired>2008-01-20</aired>", ep_nfo)

    def test_a_hand_fixed_match_reaches_kodi(self):
        # @req INTG-META-01
        before = self.listed(router.list_movies)
        log("state", "before the fix", before)
        fixed = td.movie_fixture()
        fixed.update({"title": "Interstellar", "originalTitle": "Interstellar", "overview": "Fixed overview", "year": "2014",
                      "catalogId": 157336, "posterPath": "/fixed-poster.jpg",
                      "backdropPath": "/fixed-backdrop.jpg"})
        log("phase", "the user's fix arrives through sync as media.upsert", {"title": fixed["title"], "catalogId": fixed["catalogId"]})
        gen = td._ids()
        for sql, params in ops_sql.build_op_statements({"type": "media.upsert", "payload": {"details": fixed}}, gen):
            self.conn.execute(sql, params)
        after = self.listed(router.list_movies)
        log("state", "after the fix", after)
        self.assertEqual(len(after), 1)
        m = after[0]
        self.assertEqual(m["info"]["Title"], "Interstellar")
        self.assertEqual(m["info"]["Year"], 2014)
        self.assertEqual(m["info"]["Plot"], "Fixed overview")
        self.assertNotIn("UniqueIDs", m["info"])
        self.assertEqual(m["art"]["poster"], "cache/poster/fixed-poster.jpg")
        self.assertEqual(m["art"]["fanart"], "cache/backdrop/fixed-backdrop.jpg")
        # the file is still Inception.mkv: Kodi never re-guesses from it
        self.assertNotIn("Inception", json.dumps(m))
        nfo = export.movie_nfo(self.ctx.lib.get_media("movie-1"))
        log("state", "nfo after the fix", nfo)
        self.assertNotIn("<uniqueid", nfo)
        self.assertIn("<title>Interstellar</title>", nfo)


if __name__ == "__main__":
    unittest.main()
