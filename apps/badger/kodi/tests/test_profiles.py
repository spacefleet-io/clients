"""The add-on follows one account and one profile, chosen while pairing (INTG-PROF-01, ACCT-SQUAD-02).

@req INTG-PROF-01  pairing does not finish until a profile is picked when the account has several; a single
                   profile is used without asking; never asked again; changeable later, keeping the media
@req ACCT-SQUAD-02 the chosen profile's viewing data only: main profile = the library's own storage,
                   any other profile = `p:<pid>:` keys (resume, track choices, watched/progress)
@req STOR-BW-11[badger-kodi] every playback tunnel session names the followed profile (`profileId`, the main
                   profile's real id too); other purposes carry none

Each test prints phase markers prefixed with its id.
"""
import json
import os
import shutil
import sqlite3
import tempfile
import unittest

_DATA = tempfile.mkdtemp(prefix="sb-kodi-profiles-")
os.environ["SB_DATA_DIR"] = _DATA

import _path  # noqa: F401,E402
import core  # noqa: E402
import api as api_mod  # noqa: E402
import export  # noqa: E402
import kodi_rpc  # noqa: E402
import library  # noqa: E402
import pairing  # noqa: E402
import profiles  # noqa: E402
import progress as prog  # noqa: E402
import syncer  # noqa: E402
import tracks  # noqa: E402
from compat import set_prop  # noqa: E402

TEST_ID = "KODI-PROFILES-001"

MAIN = {"id": "pmain", "name": "Chris", "avatar": 0, "createdAt": "2026-10-01T00:00:00.000Z", "isMain": True}
KIDS = {"id": "pkids", "name": "Kids", "avatar": 2, "createdAt": "2026-10-02T00:00:00.000Z", "isMain": False}
SAM = {"id": "psam", "name": "Sam", "avatar": 3, "createdAt": "2026-10-03T00:00:00.000Z", "isMain": False}


def phase(msg, *args):
    print("[%s] %s" % (TEST_ID, msg % args if args else msg))


class Chooser(object):
    """Stands in for Kodi's select dialog; records every question."""

    def __init__(self, answer):
        self.answer = answer
        self.asked = []

    def __call__(self, names, preselect=-1):
        self.asked.append((list(names), preselect))
        phase("chooser asked %s (preselect %s) -> %s", names, preselect, self.answer)
        return self.answer


class FakeProfilesApi(object):
    def __init__(self, listed):
        self.listed = listed
        self.calls = 0

    def profiles(self):
        self.calls += 1
        if isinstance(self.listed, Exception):
            raise self.listed
        return [dict(p) for p in self.listed]


class Pick(unittest.TestCase):
    def test_single_profile_is_used_without_asking(self):
        chooser = Chooser(0)
        picked = profiles.pick([MAIN], chooser)
        phase("single -> %s", picked)
        self.assertEqual(picked["id"], "pmain")
        self.assertEqual(chooser.asked, [])

    def test_several_profiles_ask_oldest_first(self):
        chooser = Chooser(1)
        picked = profiles.pick([SAM, KIDS, MAIN], chooser)
        self.assertEqual(chooser.asked[0][0], ["Chris", "Kids", "Sam"])
        self.assertEqual(picked["id"], "pkids")

    def test_cancel_picks_nothing(self):
        self.assertIsNone(profiles.pick([MAIN, KIDS], Chooser(-1)))
        self.assertIsNone(profiles.pick([MAIN, KIDS], None))  # no screen to ask on (background service)

    def test_no_profile_is_an_error(self):
        with self.assertRaises(profiles.ProfileError):
            profiles.pick([], Chooser(0))

    def test_key_prefix_follows_the_mobile_convention(self):
        self.assertEqual(profiles.key_prefix(MAIN), "")
        self.assertEqual(profiles.key_prefix(KIDS), "p:pkids:")
        # a pick also ends any pause (INTG-PROF-01: deleted profile / not yet picked)
        self.assertEqual(profiles.state_for(KIDS), {"profileId": "pkids", "profileName": "Kids", "profilePrefix": "p:pkids:", "profileNeeded": None})


class PairingFinish(unittest.TestCase):
    def _run(self, listed, answer):
        stored, revoked = [], []
        paired = {"token": "tok", "key": b"k" * 32, "email": "a@b.c", "profiles": listed}
        chooser = Chooser(answer)
        result = pairing.finish_pairing(paired, chooser, store=lambda p, prof: stored.append((p, prof)),
                                        revoke=lambda p: revoked.append(p))
        phase("finish_pairing(%d profiles, answer %s) -> %s stored=%d revoked=%d", len(listed), answer,
              result and result["id"], len(stored), len(revoked))
        return result, stored, revoked, chooser

    def test_single_profile_account_pairs_without_a_question(self):
        result, stored, revoked, chooser = self._run([MAIN], 0)
        self.assertEqual(result["id"], "pmain")
        self.assertEqual(chooser.asked, [])
        self.assertEqual(stored[0][1]["id"], "pmain")
        self.assertEqual(revoked, [])

    def test_several_profiles_pairing_finishes_only_after_the_pick(self):
        result, stored, revoked, chooser = self._run([MAIN, KIDS], 1)
        self.assertEqual(len(chooser.asked), 1)
        self.assertEqual(stored[0][1]["id"], "pkids")
        self.assertEqual(revoked, [])

    def test_cancelled_pick_stores_nothing_and_drops_the_session(self):
        result, stored, revoked, _ = self._run([MAIN, KIDS], -1)
        self.assertIsNone(result)
        self.assertEqual(stored, [])
        self.assertEqual(len(revoked), 1)

    def test_complete_fetches_the_account_profiles_with_the_new_token(self):
        import api as api_module
        seen = []
        original = api_module.ApiClient.profiles
        api_module.ApiClient.profiles = lambda self: seen.append(self.token) or [dict(MAIN), dict(KIDS)]
        original_meta = api_module.ApiClient.library_meta
        api_module.ApiClient.library_meta = lambda self: {}
        session = pairing.PairingSession(type("A", (), {"base_url": "http://fake"})(), "Kodi")
        session.request_id = "req"
        sealed = pairing.seal_library_key(session.public, "req", b"\x01" * 32)
        try:
            result = session.complete({"status": "approved", "token": "tok2", "sealedKey": sealed, "user": {"email": "x@y.z"}})
        finally:
            api_module.ApiClient.profiles = original
            api_module.ApiClient.library_meta = original_meta
        phase("complete -> profiles %s via token %s", [p["id"] for p in result["profiles"]], seen)
        self.assertEqual(seen, ["tok2"])
        self.assertEqual([p["id"] for p in result["profiles"]], ["pmain", "pkids"])


class ManualSignIn(unittest.TestCase):
    """Settings email/password sign-in (the advanced path) finishes like pairing: a profile is picked first."""

    def setUp(self):
        path = os.path.join(_DATA, core.STATE_FILE)
        if os.path.exists(path):
            os.remove(path)
        self.logged_out = []
        self._orig = (api_mod.ApiClient.login, api_mod.ApiClient.profiles, api_mod.ApiClient.logout)
        test = self

        def login(self, email, password, two_factor_code=None, device_name=None):
            self.token = "tok-manual"

        api_mod.ApiClient.login = login
        api_mod.ApiClient.logout = lambda self: test.logged_out.append(self.token)
        os.environ["SB_SETTINGS_JSON"] = json.dumps({"email": "a@b.c", "password": "pw", "api_url": "http://api.test"})

    def tearDown(self):
        api_mod.ApiClient.login, api_mod.ApiClient.profiles, api_mod.ApiClient.logout = self._orig
        os.environ.pop("SB_SETTINGS_JSON", None)

    def _sign_in(self, listed, answer):
        api_mod.ApiClient.profiles = lambda self: [dict(p) for p in listed]
        chooser = Chooser(answer)
        status = core.apply_settings_credentials(choose=chooser)
        state = core.load_state()
        phase("manual sign-in (%d profiles, answer %s) -> %r token=%s profile=%s logged_out=%s", len(listed), answer,
              status, state.get("token"), state.get("profileId"), self.logged_out)
        return status, state, chooser

    def test_single_profile_signs_in_without_a_question(self):
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.manual-one"
        status, state, chooser = self._sign_in([MAIN], 0)
        self.assertEqual(chooser.asked, [])
        self.assertEqual((state["token"], state["profileId"], state["profilePrefix"]), ("tok-manual", "pmain", ""))

    def test_several_profiles_sign_in_stores_the_picked_one(self):
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.manual-pick"
        status, state, chooser = self._sign_in([MAIN, KIDS], 1)
        self.assertEqual(len(chooser.asked), 1)
        self.assertEqual((state["token"], state["profileId"], state["profilePrefix"]), ("tok-manual", "pkids", "p:pkids:"))

    def test_cancelled_pick_keeps_no_session(self):
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.manual-cancel"
        status, state, _ = self._sign_in([MAIN, KIDS], -1)
        self.assertIsNone(state.get("token"))
        self.assertEqual(self.logged_out, ["tok-manual"])
        self.assertIn("not finished", status)


class Ensure(unittest.TestCase):
    def _ensure(self, state, listed):
        saved = []
        api = FakeProfilesApi(listed)
        ok, message = profiles.ensure(api, state, lambda **c: saved.append(c))
        phase("ensure(state=%s) -> %s %r saved=%s", state, ok, message, saved)
        return ok, message, saved

    def test_session_from_before_profiles_on_a_multi_profile_account_waits_for_a_pick(self):
        # @req INTG-PROF-01: with several profiles the person always picks; an install paired before profiles
        # existed never silently follows one of them.
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.legacy-multi"
        ok, message, saved = self._ensure({}, [KIDS, dict(MAIN), SAM])
        self.assertFalse(ok)
        self.assertEqual(message, profiles.CHOOSE_MESSAGE)
        self.assertEqual(saved, [{profiles.NEEDS_KEY: profiles.CHOOSE_MESSAGE}])

    def test_followed_profile_deleted_elsewhere_pauses_and_never_switches(self):
        # @req INTG-PROF-01: Kids deleted on the phone -> Kodi stops, never moves to Chris (the oldest remaining).
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.deleted"
        ok, message, saved = self._ensure(profiles.state_for(KIDS), [MAIN, SAM])
        self.assertFalse(ok)
        self.assertIn("Kids was deleted", message)
        self.assertEqual(saved, [{profiles.NEEDS_KEY: message}])
        self.assertNotIn("profileId", saved[0])

    def test_paused_state_makes_no_request_until_a_pick(self):
        # @req INTG-PROF-01: no retry hammering: once paused, ensure answers from state.json alone.
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.no-hammer"
        state = dict(profiles.state_for(KIDS), **{profiles.NEEDS_KEY: profiles.gone_message("Kids")})
        api = FakeProfilesApi([MAIN, SAM])
        ok, message = profiles.ensure(api, state, lambda **c: self.fail("saved %s" % c))
        phase("paused ensure -> %s %r calls=%d", ok, message, api.calls)
        self.assertFalse(ok)
        self.assertEqual(api.calls, 0)

    def test_api_refusals_for_a_gone_profile_are_recognised(self):
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.refusal"
        self.assertTrue(profiles.is_gone_error(api_mod.ApiError(403, {"error": "profile_not_owned"})))
        self.assertTrue(profiles.is_gone_error(api_mod.ApiError(400, {"error": "profile_required"})))
        self.assertFalse(profiles.is_gone_error(api_mod.ApiError(403, {"error": "forbidden"})))
        self.assertFalse(profiles.is_gone_error(OSError("offline")))
        saved = []
        message = profiles.mark_gone(profiles.state_for(KIDS), lambda **c: saved.append(c))
        self.assertEqual(saved, [{profiles.NEEDS_KEY: message}])
        self.assertIn("Kids was deleted", message)
        self.assertEqual(profiles.mark_gone({}, lambda **c: None), profiles.CHOOSE_MESSAGE)

    def test_session_from_before_profiles_and_one_profile_takes_it(self):
        ok, _, saved = self._ensure({}, [MAIN])
        self.assertTrue(ok)
        self.assertEqual(saved, [profiles.state_for(MAIN)])

    def test_stored_profile_is_never_asked_again_and_follows_a_main_change(self):
        promoted = dict(KIDS, isMain=True)  # the main profile was deleted elsewhere: Kids is the oldest now
        ok, _, saved = self._ensure(profiles.state_for(KIDS), [promoted, SAM])
        self.assertTrue(ok)
        self.assertEqual(saved, [{"profileId": "pkids", "profileName": "Kids", "profilePrefix": ""}])

    def test_unchanged_profile_saves_nothing(self):
        ok, _, saved = self._ensure(profiles.state_for(KIDS), [MAIN, KIDS])
        self.assertTrue(ok)
        self.assertEqual(saved, [])

    def test_offline_keeps_the_stored_profile(self):
        ok, _, saved = self._ensure(profiles.state_for(KIDS), OSError("offline"))
        self.assertTrue(ok)
        self.assertEqual(saved, [])
        ok, _, _ = self._ensure({}, OSError("offline"))
        self.assertFalse(ok)


SCHEMA = (
    "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
    """CREATE TABLE media_items (id TEXT PRIMARY KEY, type TEXT, title TEXT, updated_at TEXT, has_files INTEGER,
       progress_pct REAL, last_watched_at TEXT, total_episodes INTEGER)""",
    "CREATE TABLE media_external_ids (id TEXT PRIMARY KEY, media_id TEXT, media_type TEXT, source TEXT, external_id TEXT)",
)


class ScopedStore(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="sb-kodi-profiles-store-")
        conn = sqlite3.connect(os.path.join(self.dir, library.DB_NAME))
        for sql in SCHEMA:
            conn.execute(sql)
        conn.execute("INSERT INTO media_items VALUES ('m1','movie','Main watched',?,1,100,'2026-10-05T00:00:00.000Z',NULL)", ("t",))
        conn.execute("INSERT INTO media_items VALUES ('m2','movie','Kids started',?,1,0,NULL,NULL)", ("t",))
        rows = [
            ("episode_resume_v1:e1", json.dumps({"progressPct": 80, "updatedAt": "a"})),
            ("track_prefs_v1:m1", json.dumps({"audioLanguage": "fr", "subtitle": None, "updatedAt": "a"})),
            ("p:pkids:episode_resume_v1:e1", json.dumps({"progressPct": 10, "updatedAt": "b"})),
            ("p:pkids:track_prefs_v1:m1", json.dumps({"audioLanguage": "en", "subtitle": "off", "updatedAt": "b"})),
            ("p:pkids:media_progress_v1:m2", json.dumps({"progressPct": 40, "lastWatchedAt": "2026-10-06T00:00:00.000Z", "updatedAt": "c"})),
        ]
        conn.executemany("INSERT INTO app_settings VALUES (?, ?, 'x')", rows)
        conn.commit()
        conn.close()
        self.written = []

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def store(self, prefix):
        s = library.LibraryStore(self.dir, prefix=prefix)
        s.flush_pending = lambda api, key: True  # no upload in this test
        original = s.write_op

        def write_op(api, key, op_type, payload):
            self.written.append((op_type, payload))
            phase("write_op %s %s", op_type, payload)
            return original(api, key, op_type, payload)
        s.write_op = write_op
        return s

    def test_main_profile_reads_the_library_storage(self):
        s = self.store("")
        self.assertEqual(s.episode_resume("e1")["progressPct"], 80)
        self.assertEqual(s.track_prefs("m1")["audioLanguage"], "fr")
        self.assertEqual(s.get_media("m1")["progress_pct"], 100)
        self.assertEqual(s.get_media("m2")["progress_pct"], 0)

    def test_other_profile_reads_its_own_keys_and_never_main_ones(self):
        s = self.store("p:pkids:")
        self.assertEqual(s.episode_resume("e1")["progressPct"], 10)
        self.assertEqual(s.track_prefs("m1")["audioLanguage"], "en")
        self.assertIsNone(s.track_prefs("m2"))
        by_id = dict((m["id"], m) for m in s.list_media("movie"))
        phase("kids list: %s", dict((k, (v["progress_pct"], v["last_watched_at"])) for k, v in by_id.items()))
        self.assertEqual(by_id["m1"]["progress_pct"], 0)  # main watched it; Kids did not
        self.assertIsNone(by_id["m1"]["last_watched_at"])
        self.assertEqual(by_id["m2"]["progress_pct"], 40)
        self.assertEqual(s.get_media("m2")["last_watched_at"], "2026-10-06T00:00:00.000Z")

    def test_other_profile_writes_prefixed_settings(self):
        s = self.store("p:pkids:")
        s.write_progress(None, None, "m1", 55.5, "2026-10-07T00:00:00.000Z", "2026-10-07T00:00:00.000Z")
        s.write_track_prefs(None, None, "m2", audio="de")
        s.write_op(None, None, "setting.set", prog.episode_resume_setting("e2", 33, "2026-10-07T00:00:00.000Z", prefix=s.prefix))
        kinds = [(t, p.get("key")) for t, p in self.written]
        self.assertEqual(kinds, [("setting.set", "p:pkids:media_progress_v1:m1"), ("setting.set", "p:pkids:track_prefs_v1:m2"),
                                 ("setting.set", "p:pkids:episode_resume_v1:e2")])
        self.assertEqual(json.loads(self.written[0][1]["value"]),
                         {"progressPct": 55.5, "lastWatchedAt": "2026-10-07T00:00:00.000Z", "updatedAt": "2026-10-07T00:00:00.000Z"})
        self.assertEqual(s.get_media("m1")["progress_pct"], 55.5)
        self.assertEqual(self.store("").get_media("m1")["progress_pct"], 100)  # main untouched

    def test_main_profile_writes_media_progress(self):
        s = self.store("")
        s.write_progress(None, None, "m2", 20, "2026-10-07T00:00:00.000Z", "2026-10-07T00:00:00.000Z")
        self.assertEqual(self.written[0][0], "media.progress")
        self.assertEqual(self.written[0][1]["mediaId"], "m2")
        self.assertEqual(tracks.key_for("m1"), "track_prefs_v1:m1")
        self.assertEqual(prog.episode_resume_setting("e2", 1, "t")["key"], "episode_resume_v1:e2")

    def test_push_watch_state_mirrors_the_chosen_profile_into_kodi(self):
        calls = []
        originals = (export.load_index, export.kodi_items, kodi_rpc.call)
        export.load_index = lambda: {"movies/a.strm": {"mediaId": "m1"}, "movies/b.strm": {"mediaId": "m2"}}
        export.kodi_items = lambda: {"movies/a.strm": {"kind": "movie", "movieid": 1}, "movies/b.strm": {"kind": "movie", "movieid": 2}}
        kodi_rpc.call = lambda method, params=None, quiet=False: calls.append((method, params))
        try:
            ctx = type("Ctx", (), {})()
            ctx.lib = self.store("p:pkids:")
            ctx.lib.playable_unit = lambda media_id, episode_id=None: {"formats": [{"duration_seconds": 1000}]}
            export.push_watch_state(ctx)
        finally:
            export.load_index, export.kodi_items, kodi_rpc.call = originals
        by_movie = dict((p["movieid"], p) for _, p in calls)
        phase("pushed %s", by_movie)
        self.assertEqual(by_movie[1]["playcount"], 0)  # main's 100% does not leak into Kids
        self.assertEqual(by_movie[2]["resume"]["position"], 400.0)


class FakeLib(object):
    def __init__(self, prefix=""):
        self.prefix = prefix
        self.synced = 0
        self.wiped = 0

    def sync(self, api, key):
        self.synced += 1

    def version(self):
        return 7

    def wipe(self):
        self.wiped += 1


class FakeCtx(object):
    def __init__(self, listed, prefix=""):
        self.signed_in = True
        self.key = b"k" * 32
        self.lib = FakeLib(prefix)
        self.api = FakeProfilesApi(listed)
        self.api.me = lambda: {"state": "paid"}


class SyncAndChange(unittest.TestCase):
    def setUp(self):
        for name in (core.STATE_FILE,):
            path = os.path.join(_DATA, name)
            if os.path.exists(path):
                os.remove(path)
        os.environ["SB_SETTINGS_JSON"] = json.dumps({"auto_export": "false"})
        set_prop("access", "")

    def tearDown(self):
        os.environ.pop("SB_SETTINGS_JSON", None)

    def test_sync_of_a_session_from_before_profiles_on_a_multi_profile_account_asks_once(self):
        # @req INTG-PROF-01
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.legacy-sync"
        ctx = FakeCtx([MAIN, KIDS])
        told = []
        orig = syncer.notify
        syncer.notify = lambda *a, **k: told.append(a)
        try:
            first = syncer.run_sync(ctx)
            second = syncer.run_sync(ctx)
        finally:
            syncer.notify = orig
        phase("run_sync x2 without stored profile -> %s %s told=%s state=%s", first, second, told, core.load_state())
        self.assertFalse(first[0])
        self.assertFalse(second[0])
        self.assertEqual(ctx.lib.synced, 0)
        self.assertIsNone(core.load_state().get("profileId"))
        self.assertEqual(len(told), 1)  # told once, not at every sync
        self.assertEqual(ctx.api.calls, 1)

    def test_deleted_profile_stops_sync_and_viewing_writes_then_a_pick_resumes(self):
        # @req INTG-PROF-01: Kids followed, Kids deleted elsewhere: no sync, no viewing write, told once; after
        # picking Sam the media stays and only viewing state re-syncs.
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.deleted-sync"
        core.save_state(token="tok", **profiles.state_for(KIDS))
        ctx = FakeCtx([MAIN, SAM], prefix="p:pkids:")
        told = []
        orig = syncer.notify
        syncer.notify = lambda *a, **k: told.append(a)
        try:
            ok, message = syncer.run_sync(ctx)
            syncer.run_sync(ctx)
        finally:
            syncer.notify = orig
        phase("after delete: %s %r told=%s state=%s", ok, message, told, core.load_state())
        self.assertFalse(ok)
        self.assertEqual(ctx.lib.synced, 0)
        self.assertEqual(len(told), 1)
        self.assertEqual(core.load_state()["profileId"], "pkids")  # never switched to the oldest remaining

        store = core.Context().lib
        self.assertTrue(store.viewing_paused)
        written = []
        store.write_op = lambda api, key, op_type, payload: written.append((op_type, payload)) or True
        self.assertFalse(store.write_progress(None, None, "m1", 50, "t", "t"))
        self.assertFalse(store.write_viewing(None, None, "setting.set", {"key": "p:pkids:episode_resume_v1:e1"}))
        phase("viewing writes while paused: %s", written)
        self.assertEqual(written, [])

        pushed = []
        chosen = syncer.change_profile(ctx, Chooser(1), push=lambda c: pushed.append(c.lib.prefix))
        phase("pick after delete -> %s state=%s", chosen and chosen["id"], core.load_state())
        self.assertEqual(chosen["id"], "psam")
        self.assertFalse(profiles.paused(core.load_state()))
        self.assertFalse(core.Context().lib.viewing_paused)
        self.assertEqual(ctx.lib.wiped, 0)
        self.assertEqual(ctx.lib.synced, 1)
        self.assertEqual(pushed, ["p:psam:"])
        ok, message = syncer.run_sync(ctx)
        self.assertTrue(ok, message)

    def test_no_viewing_write_before_a_profile_is_followed(self):
        # @req INTG-PROF-01: a session from before profiles, before its first /profiles answer, writes no resume or
        # track state with the oldest profile's prefix "" (that would be a silent pick).
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.legacy-no-write"
        core.save_state(token="tok")
        store = core.Context().lib
        written = []
        store.write_op = lambda api, key, op_type, payload: written.append((op_type, payload)) or True
        store.write_progress(None, None, "m1", 50, "t", "t")
        store.write_viewing(None, None, "setting.set", {"key": "episode_resume_v1:e1"})
        phase("legacy, no profile yet: paused=%s written=%s", store.viewing_paused, written)
        self.assertTrue(store.viewing_paused)
        self.assertEqual(written, [])

    def test_a_pick_made_while_profiles_load_is_never_overwritten_or_paused(self):
        # @req INTG-PROF-01: "Change profile" picks Sam while the sync's GET /profiles (which no longer lists Kids)
        # is in flight: the pick stands, nothing is paused.
        global TEST_ID
        TEST_ID = "INTG-PROF-01.kodi.pick-race"
        core.save_state(token="tok", **profiles.state_for(KIDS))
        ctx = FakeCtx([MAIN, SAM], prefix="p:pkids:")
        listed = ctx.api.profiles

        def profiles_while_picking():
            core.save_state(**profiles.state_for(SAM))
            return listed()

        ctx.api.profiles = profiles_while_picking
        told = []
        orig = syncer.notify
        syncer.notify = lambda *a, **k: told.append(a)
        try:
            ok, message = syncer.follow_profile(ctx)
        finally:
            syncer.notify = orig
        state = core.load_state()
        phase("pick during /profiles -> %s %r told=%s state=%s", ok, message, told, state)
        self.assertEqual(state["profileId"], "psam")
        self.assertFalse(profiles.paused(state))
        self.assertTrue(ok, message)
        self.assertEqual(told, [])
        self.assertEqual(ctx.lib.prefix, "p:psam:")

    def test_sync_with_a_chosen_profile_runs_and_does_not_ask(self):
        core.save_state(**profiles.state_for(KIDS))
        ctx = FakeCtx([MAIN, KIDS], prefix="p:pkids:")
        ok, message = syncer.run_sync(ctx)
        self.assertTrue(ok, message)
        self.assertEqual(ctx.lib.synced, 1)

    def test_changing_profile_keeps_the_media_and_resyncs_viewing_state(self):
        core.save_state(token="tok", **profiles.state_for(MAIN))
        ctx = FakeCtx([MAIN, KIDS], prefix="")
        pushed = []
        chooser = Chooser(1)
        changed = syncer.change_profile(ctx, chooser, push=lambda c: pushed.append(c.lib.prefix))
        phase("change_profile -> %s pushed=%s state=%s", changed and changed["id"], pushed, core.load_state())
        self.assertEqual(changed["id"], "pkids")
        self.assertEqual(chooser.asked[0][1], 0)  # the current profile is preselected
        self.assertEqual(core.load_state()["profileId"], "pkids")
        self.assertEqual(core.load_state()["token"], "tok")
        self.assertEqual(ctx.lib.wiped, 0)
        self.assertEqual(ctx.lib.prefix, "p:pkids:")
        self.assertEqual(ctx.lib.synced, 1)
        self.assertEqual(pushed, ["p:pkids:"])

    def test_keeping_the_same_profile_changes_nothing(self):
        core.save_state(token="tok", **profiles.state_for(KIDS))
        ctx = FakeCtx([MAIN, KIDS], prefix="p:pkids:")
        pushed = []
        self.assertIsNone(syncer.change_profile(ctx, Chooser(1), push=pushed.append))
        self.assertEqual(ctx.lib.synced, 0)
        self.assertEqual(pushed, [])

    def test_a_new_sign_in_forgets_the_previous_profile(self):
        core.save_state(token="old", **profiles.state_for(KIDS))
        core.save_session_state("new", email="x@y.z")
        self.assertIsNone(core.load_state().get("profileId"))
        core.save_session_state("new2", **profiles.state_for(MAIN))
        self.assertEqual(core.load_state()["profileId"], "pmain")


class PlaybackNamesProfile(unittest.TestCase):
    """STOR-BW-11: POST /storage/tunnel/session carries the followed profile's id on playback sessions."""

    def setUp(self):
        self.bodies = []
        self._orig = api_mod.http_request

        def fake(method, url, headers=None, data=None, timeout=None):
            body = json.loads(data.decode("utf-8"))
            if url.endswith("/storage/tunnel/session"):
                self.bodies.append(body)
            phase("POST %s %s", url, body)
            return 200, {}, json.dumps({"sessionId": "s%d" % len(self.bodies), "expiresAt": "2099-01-01T00:00:00.000Z"}).encode("utf-8")

        api_mod.http_request = fake

    def tearDown(self):
        api_mod.http_request = self._orig

    def test_playback_session_body_names_the_profile(self):
        global TEST_ID
        TEST_ID = "STOR-BW-11.kodi.session"
        client = api_mod.ApiClient("http://api.test", "tok")
        client.profile_id = "pmain"
        client._session("http://gw.test", {"id": "sh1"}, "media/x/", "playback")
        client._session("http://gw.test", {"id": "sh1"}, "library/", "library")
        self.assertEqual(self.bodies[0]["profileId"], "pmain")
        self.assertNotIn("profileId", self.bodies[1])

    def test_context_and_profile_change_update_the_client(self):
        global TEST_ID
        TEST_ID = "STOR-BW-11.kodi.follow"
        core.save_state(profileId="pkids", profileName="Kids", profilePrefix="p:pkids:")
        self.assertEqual(core.Context().api.profile_id, "pkids")
        ctx = FakeCtx([MAIN, KIDS], prefix="p:pkids:")
        os.environ["SB_SETTINGS_JSON"] = json.dumps({"auto_export": "false"})
        try:
            syncer.change_profile(ctx, Chooser(0), push=lambda c: None)
        finally:
            os.environ.pop("SB_SETTINGS_JSON", None)
        phase("after change profile_id=%s", ctx.api.profile_id)
        self.assertEqual(ctx.api.profile_id, "pmain")


def setUpModule():
    # `unittest discover` imports every test module before it runs any, so SB_DATA_DIR holds whichever module was
    # imported last; point the add-on back at this module's data dir before its tests run.
    os.environ["SB_DATA_DIR"] = _DATA


def tearDownModule():
    shutil.rmtree(_DATA, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
