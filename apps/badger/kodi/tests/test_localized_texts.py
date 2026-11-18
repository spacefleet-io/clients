"""@req LIB-LANG-01 @req LIB-LANG-02 Kodi shows synopses and episode texts in its interface language, kept in the library.

@test-id kodi-localized-texts
@level unit

Why: Chris 2026-11-08 / 2026-11-16: every Badger app shows a title's synopsis and its episodes' names and synopses in
the interface language (English when that language has none, the stored text as the last resort), and the details
answer is asked once per title and language, by the first device, then kept in the library as a synced
`localized_text_v1:` row every device reads. Before this, Kodi exported and listed the stored synopses only.

Runs against a throw-away data dir (SB_DATA_DIR); no Kodi, no network. The row format is checked against vectors the
TypeScript reference generates (tests/gen_localized_text_vectors.ts), so Kodi reads and writes the rows the other apps
do."""
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import _dev_signer as dev
import _path  # noqa: F401
import core
import export
import images
import library
import localized_texts as lt
from metadata import MetadataRequestError, MetadataUnavailableError, NoTicketError

TAG = "kodi-localized-texts"
VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "localized_text_vectors.json")


def details(overview, episodes=()):
    return {"item": {"overview": overview, "episodes": [
        {"seasonNumber": s, "episodeNumber": e, "name": n, "overview": o} for s, e, n, o in episodes]}}


class Metadata(object):
    """The metadata service: counts `details` lookups and answers from `answers[(type, id, language)]`."""

    def __init__(self, answers=None, error=None):
        self.answers = answers or {}
        self.error = error
        self.calls = []

    def lookup(self, body):
        self.calls.append((body["op"], body["type"], body["id"], body["language"]))
        if self.error is not None:
            raise self.error
        return self.answers.get((body["type"], body["id"], body["language"]), details(None))


class Lib(object):
    """The library as the texts read it: titles, episodes, synced settings; `write_op` records the synced ops."""

    def __init__(self, media=(), episodes=None):
        self.media = list(media)
        self.eps = episodes or {}
        self.settings = {}
        self.ops = []

    def list_media(self, media_type):
        return [m for m in self.media if m["type"] == media_type]

    def get_media(self, media_id):
        return next((m for m in self.media if m["id"] == media_id), None)

    def episodes(self, media_id, season=None):
        return list(self.eps.get(media_id, []))

    def setting_value(self, key):
        return self.settings.get(key)

    def write_op(self, api, key, op_type, payload):
        self.ops.append((op_type, payload))
        self.settings[payload["key"]] = payload["value"]
        return True


class Ctx(object):
    def __init__(self, lib, metadata):
        self.lib = lib
        self.metadata = metadata
        self.api = object()
        self.key = b"k" * 32


def ep(media_id, season, episode, title, overview):
    return {"id": "%s-%d-%d" % (media_id, season, episode), "media_id": media_id, "season_number": season,
            "episode_number": episode, "title": title, "overview": overview, "still_path": None, "air_date": None}


MOVIE = {"id": "m1", "type": "movie", "title": "Le Film", "year": "2001", "overview": "Stored German synopsis.", "catalog_id": "550"}
SHOW = {"id": "s1", "type": "tv", "title": "The Show", "year": "2020", "overview": "Stored show synopsis.", "catalog_id": "1399"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sb-texts-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        old = os.environ.get("SB_DATA_DIR")
        os.environ["SB_DATA_DIR"] = self.tmp
        self.addCleanup(lambda: os.environ.__setitem__("SB_DATA_DIR", old) if old is not None else os.environ.pop("SB_DATA_DIR", None))
        self.sleeps = []
        self.clock = [1000.0]

    def refresh(self, ctx, language, tickets=500, **kwargs):
        stats = lt.refresh(ctx, language, count_tickets=lambda: tickets, sleep=self.sleeps.append,
                           clock=lambda: self.clock[0], now=lambda: "2026-11-16T10:00:00.000Z", **kwargs)
        dev.phase(TAG, "refresh %s: %s lookups=%d" % (language, stats, len(ctx.metadata.calls)))
        return stats


class RowFormat(unittest.TestCase):
    """Same rows as `@space/shared/localizedTexts`, from the TypeScript-generated vectors."""

    def setUp(self):
        with open(VECTORS, encoding="utf-8") as fh:
            self.vectors = json.load(fh)

    def test_keys_match_typescript(self):
        for case in self.vectors["keys"]:
            self.assertEqual(lt.key(case["type"], case["catalogId"], case["language"]), case["key"])

    def test_serialize_is_byte_identical_to_typescript(self):
        for case in self.vectors["serialize"]:
            self.assertEqual(lt.serialize(case["record"]), case["value"])
        dev.phase(TAG, "serialize: %d vectors identical" % len(self.vectors["serialize"]))

    def test_parse_matches_typescript(self):
        for case in self.vectors["parse"]:
            self.assertEqual(lt.parse(case["value"]), case["record"], case["value"])
        dev.phase(TAG, "parse: %d vectors identical" % len(self.vectors["parse"]))

    def test_language_tags(self):
        self.assertEqual(lt.language_of("fr"), "fr")
        self.assertEqual(lt.language_of("fr-FR"), "fr")
        self.assertEqual(lt.language_of("pt_BR"), "pt")
        self.assertEqual(lt.language_of("DE"), "de")
        self.assertEqual(lt.language_of(""), "en")
        self.assertEqual(lt.language_of(None), "en")
        self.assertEqual(lt.language_of("français"), "en")


class Refresh(Base):
    def test_no_row_asks_once_and_keeps_the_answer_as_a_synced_setting(self):
        dev.phase(TAG, "no row: one lookup per title, written back")
        lib = Lib([MOVIE, SHOW], {"s1": [ep("s1", 1, 1, "Pilot", "Stored"), ep("s1", 1, 2, "Two", "Stored")]})
        meta = Metadata({
            ("movie", 550, "fr"): details("Synopsis en français."),
            ("tv", 1399, "fr"): details("La série.", [(1, 1, "Pilote", "Le début."), (1, 2, "Deux", "La suite.")]),
        })
        stats = self.refresh(Ctx(lib, meta), "fr")
        self.assertEqual(meta.calls, [("details", "movie", 550, "fr"), ("details", "tv", 1399, "fr")])
        self.assertEqual((stats["asked"], stats["written"], stats["stopped"]), (2, 2, None))
        self.assertEqual([op for op, _ in lib.ops], ["setting.set", "setting.set"])
        row = lt.parse(lib.settings["localized_text_v1:tv:1399:fr"])
        self.assertEqual(row["overview"], "La série.")
        self.assertEqual(row["absent"], [])
        self.assertEqual(lib.ops[0][1]["updatedAt"], "2026-11-16T10:00:00.000Z")
        self.assertEqual(self.sleeps, [lt.LOOKUP_PAUSE_SECONDS])  # paced: one pause between the two lookups

        dev.phase(TAG, "second run: rows cover the library, nothing asked")
        stats = self.refresh(Ctx(lib, meta), "fr")
        self.assertEqual(len(meta.calls), 2)
        self.assertEqual((stats["asked"], stats["kept"]), (0, 2))

    def test_a_row_another_device_kept_is_read_and_nothing_is_asked(self):
        lib = Lib([MOVIE])
        lib.settings[lt.key("movie", 550, "fr")] = lt.serialize(
            {"overview": "Déjà gardé.", "episodes": [], "absent": [], "fetchedAt": "2026-11-15T00:00:00.000Z"})
        meta = Metadata()
        stats = self.refresh(Ctx(lib, meta), "fr")
        self.assertEqual(meta.calls, [])
        self.assertEqual(lib.ops, [])
        self.assertEqual(stats["kept"], 1)

    def test_a_new_episode_asks_again_and_an_answer_without_it_marks_it_absent(self):
        lib = Lib([SHOW], {"s1": [ep("s1", 1, 1, "Pilot", None)]})
        meta = Metadata({("tv", 1399, "fr"): details("La série.", [(1, 1, "Pilote", "Le début.")])})
        self.refresh(Ctx(lib, meta), "fr")
        dev.phase(TAG, "new episode 1:2 in the library")
        lib.eps["s1"].append(ep("s1", 1, 2, "Two", None))
        self.refresh(Ctx(lib, meta), "fr")
        self.assertEqual(len(meta.calls), 2)
        self.assertEqual(lt.parse(lib.settings[lt.key("tv", 1399, "fr")])["absent"], ["1:2"])
        dev.phase(TAG, "episode absent upstream: known, not asked again")
        self.refresh(Ctx(lib, meta), "fr")
        self.assertEqual(len(meta.calls), 2)

    def test_english_is_asked_only_where_the_language_lacks_a_text(self):
        lib = Lib([MOVIE, SHOW], {"s1": [ep("s1", 1, 1, "Pilot", None)]})
        meta = Metadata({
            ("movie", 550, "nl"): details("Nederlandse samenvatting."),
            ("tv", 1399, "nl"): details(None, [(1, 1, "Piloot", None)]),
            ("tv", 1399, "en"): details("The show.", [(1, 1, "Pilot", "The start.")]),
        })
        self.refresh(Ctx(lib, meta), "nl")
        self.assertEqual(meta.calls, [("details", "movie", 550, "nl"), ("details", "tv", 1399, "nl"), ("details", "tv", 1399, "en")])
        texts = lt.Localizer(lib, "nl")
        self.assertEqual(texts.media(SHOW)["overview"], "The show.")
        shown = texts.episode(SHOW, lib.eps["s1"][0])
        self.assertEqual((shown["title"], shown["overview"]), ("Piloot", "The start."))
        self.assertEqual(texts.media(MOVIE)["overview"], "Nederlandse samenvatting.")

    def test_ticket_floor_stops_before_any_lookup(self):
        lib = Lib([MOVIE])
        meta = Metadata()
        stats = self.refresh(Ctx(lib, meta), "fr", tickets=lt.TICKET_FLOOR)
        self.assertEqual((meta.calls, lib.ops, stats["stopped"]), ([], [], "ticket_floor"))

    def test_no_ticket_and_lookup_budget_stop_the_run(self):
        lib = Lib([MOVIE, dict(MOVIE, id="m2", catalog_id="551")])
        stats = self.refresh(Ctx(lib, Metadata(error=NoTicketError("empty"))), "fr")
        self.assertEqual((stats["stopped"], lib.ops), ("no_ticket", []))
        meta = Metadata()
        stats = self.refresh(Ctx(lib, meta), "fr", max_lookups=1)
        self.assertEqual((len(meta.calls), stats["stopped"]), (1, "budget"))

    def test_a_429_pauses_lookups_for_the_retry_after(self):
        lib = Lib([MOVIE, dict(MOVIE, id="m2", catalog_id="551")])
        meta = Metadata(error=MetadataUnavailableError(429, 120, "rate_limited"))
        stats = self.refresh(Ctx(lib, meta), "fr")
        self.assertEqual((len(meta.calls), stats["stopped"], lib.ops), (1, "paused", []))
        self.assertEqual(core.load_state()[lt.PAUSED_UNTIL_KEY], 1120.0)
        dev.phase(TAG, "within the pause: nothing asked")
        self.clock[0] = 1100.0
        meta.error = None
        meta.answers = {("movie", 550, "fr"): details("Un."), ("movie", 551, "fr"): details("Deux.")}
        stats = self.refresh(Ctx(lib, meta), "fr")
        self.assertEqual((len(meta.calls), stats["stopped"]), (1, "paused"))
        self.clock[0] = 1121.0
        self.refresh(Ctx(lib, meta), "fr")
        self.assertEqual(len(meta.calls), 3)

    def test_unreachable_service_pauses_30s_and_a_refused_title_is_skipped(self):
        lib = Lib([MOVIE])
        self.refresh(Ctx(lib, Metadata(error=MetadataUnavailableError(None))), "fr")
        self.assertEqual(core.load_state()[lt.PAUSED_UNTIL_KEY], 1000.0 + lt.PAUSE_NETWORK_SECONDS)
        self.clock[0] = 2000.0
        stats = self.refresh(Ctx(lib, Metadata(error=MetadataRequestError(404))), "fr")
        self.assertEqual((stats["failed"], stats["stopped"], lib.ops), (1, None, []))

    def test_a_failed_lookup_keeps_the_out_of_date_row(self):
        lib = Lib([SHOW], {"s1": [ep("s1", 1, 1, "Pilot", None), ep("s1", 1, 2, "Two", None)]})
        lib.settings[lt.key("tv", 1399, "fr")] = lt.serialize(
            {"overview": "Gardé.", "episodes": [{"seasonNumber": 1, "episodeNumber": 1, "name": "Pilote", "overview": None}],
             "absent": [], "fetchedAt": "x"})
        self.refresh(Ctx(lib, Metadata(error=MetadataRequestError(500))), "fr")
        self.assertEqual(lt.Localizer(lib, "fr").media(SHOW)["overview"], "Gardé.")

    def test_titles_without_a_provider_id_are_never_asked(self):
        lib = Lib([dict(MOVIE, catalog_id=None)])
        meta = Metadata()
        self.refresh(Ctx(lib, meta), "fr")
        self.assertEqual(meta.calls, [])


class Showing(Base):
    def test_stored_text_stays_without_rows(self):
        lib = Lib([MOVIE, SHOW])
        texts = lt.Localizer(lib, "fr")
        self.assertIs(texts.media(MOVIE), MOVIE)
        episode = ep("s1", 1, 1, "Pilot", "Stored")
        self.assertIs(texts.episode(SHOW, episode), episode)

    def test_export_writes_the_kept_texts_and_keeps_file_names(self):
        lib = Lib([MOVIE, SHOW], {"s1": [ep("s1", 1, 1, "Pilot", "Stored episode synopsis.")]})
        lib.episode_has_files = lambda media_id: {(1, 1): "f1"}
        lib.settings[lt.key("movie", 550, "fr")] = lt.serialize({"overview": "Synopsis <français> & co.", "episodes": [], "absent": [], "fetchedAt": "x"})
        lib.settings[lt.key("tv", 1399, "fr")] = lt.serialize({"overview": "La série.", "episodes": [
            {"seasonNumber": 1, "episodeNumber": 1, "name": "Pilote", "overview": "Le début."}], "absent": [], "fetchedAt": "x"})
        meta = Metadata()
        with mock.patch.object(images, "fetch_many", return_value={}):
            stats = export.export_library(Ctx(lib, meta), language="fr")
        dev.phase(TAG, "export: %s" % stats)
        root = os.path.join(self.tmp, core.EXPORT_DIR)
        with open(os.path.join(root, "movies", "Le Film (2001)", "Le Film (2001).nfo"), encoding="utf-8") as fh:
            self.assertIn("<plot>Synopsis &lt;français&gt; &amp; co.</plot>", fh.read())
        with open(os.path.join(root, "tvshows", "The Show (2020)", "tvshow.nfo"), encoding="utf-8") as fh:
            self.assertIn("<plot>La série.</plot>", fh.read())
        episode_nfo = os.path.join(root, "tvshows", "The Show (2020)", "Season 01", "The Show - S01E01 - Pilot.nfo")
        with open(episode_nfo, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("<title>Pilote</title>", text)
        self.assertIn("<plot>Le début.</plot>", text)
        self.assertEqual(meta.calls, [])  # showing never asks

    def test_push_sends_the_kept_texts_only_where_kodi_shows_others(self):
        lib = Lib([MOVIE, SHOW], {"s1": [ep("s1", 1, 1, "Pilot", "Stored")]})
        lib.get_episode = lambda episode_id: lib.eps["s1"][0]
        lib.episode_resume = lambda episode_id: {}
        lib.playable_unit = lambda media_id: None
        lib.settings[lt.key("movie", 550, "fr")] = lt.serialize({"overview": "Résumé.", "episodes": [], "absent": [], "fetchedAt": "x"})
        lib.settings[lt.key("tv", 1399, "fr")] = lt.serialize({"overview": "La série.", "episodes": [
            {"seasonNumber": 1, "episodeNumber": 1, "name": "Pilote", "overview": "Le début."}], "absent": [], "fetchedAt": "x"})
        index = {"movies/Le Film (2001)/Le Film (2001).strm": {"mediaId": "m1", "episodeId": None},
                 "tvshows/The Show (2020)/Season 01/x.strm": {"mediaId": "s1", "episodeId": "s1-1-1"}}
        items = {"movies/Le Film (2001)/Le Film (2001).strm": {"kind": "movie", "movieid": 7, "plot": "Résumé."},
                 "tvshows/The Show (2020)/Season 01/x.strm": {"kind": "episode", "episodeid": 9, "title": "Pilot", "plot": "Stored"}}
        sent = []
        frag = export._our_fragment()
        with mock.patch.object(export, "load_index", return_value=index), \
                mock.patch.object(export, "kodi_items", return_value=items), \
                mock.patch.object(core, "load_prefs", return_value={}), \
                mock.patch.object(export.kodi_rpc, "library_tvshows", return_value=[
                    {"tvshowid": 3, "file": "/x/%stvshows/The Show (2020)/" % frag, "plot": "Stored show synopsis."}]), \
                mock.patch.object(export.kodi_rpc, "call", side_effect=lambda method, params: sent.append((method, params))):
            export.push_watch_state(Ctx(lib, Metadata()), language="fr")
        dev.phase(TAG, "push: %s" % [m for m, _ in sent])
        by_method = {m: p for m, p in sent}
        self.assertNotIn("plot", by_method["VideoLibrary.SetMovieDetails"])  # Kodi already shows it
        self.assertEqual((by_method["VideoLibrary.SetEpisodeDetails"]["title"], by_method["VideoLibrary.SetEpisodeDetails"]["plot"]),
                         ("Pilote", "Le début."))
        self.assertEqual(by_method["VideoLibrary.SetTVShowDetails"], {"tvshowid": 3, "plot": "La série."})


class LibraryRows(unittest.TestCase):
    def test_a_setting_set_row_is_read_back_by_setting_value(self):
        tmp = tempfile.mkdtemp(prefix="sb-texts-lib-")
        self.addCleanup(shutil.rmtree, tmp, True)
        store = library.LibraryStore(tmp)
        self.addCleanup(store.close)
        c = store.conn()
        c.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)")
        value = lt.serialize({"overview": "Un résumé.", "episodes": [], "absent": [], "fetchedAt": "t"})
        store._apply_op(c, {"id": "op-1", "type": "setting.set",
                            "payload": {"key": lt.key("movie", 550, "fr"), "value": value, "updatedAt": "2026-11-16T10:00:00.000Z"}})
        self.assertEqual(store.setting_value(lt.key("movie", 550, "fr")), value)
        self.assertIsNone(store.setting_value(lt.key("movie", 550, "de")))


if __name__ == "__main__":
    unittest.main()
