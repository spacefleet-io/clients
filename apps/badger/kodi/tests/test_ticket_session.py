"""@req META-ANON-02 the reserve follows the session: a sign-out (wipe), another account's sign-in or Kodi shutting down
never leaves a refill's tickets behind, and a refill in flight stores nothing once its session is gone.

Runs core against a throw-away data dir (SB_DATA_DIR); no Kodi, no network."""
import os
import tempfile
import unittest

import _dev_signer as dev
import _path  # noqa: F401
import tickets
from test_tickets import FAST_TARGET, FakeIssuer, mint


class SessionCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        old = os.environ.get("SB_DATA_DIR")
        os.environ["SB_DATA_DIR"] = self.tmp.name
        self.addCleanup(lambda: os.environ.__setitem__("SB_DATA_DIR", old) if old is not None else os.environ.pop("SB_DATA_DIR", None))
        import core
        self.core = core
        self.store = core.ticket_store()


class WipeAndSwitch(SessionCase):
    def test_wipe_everything_clears_the_reserve_and_keeps_the_lock_file(self):
        dev.phase("session", "wipe clears the reserve")
        self.core.save_state(token="tok-1")
        self.store.append(mint(3))
        self.assertEqual(self.store.count(), 3)
        self.core.wipe_everything("test")
        self.assertEqual(self.store.count(), 0)
        self.assertFalse(os.path.exists(self.store.path))
        self.assertTrue(os.path.exists(self.store.path + tickets.LOCK_SUFFIX))
        self.assertIsNone(self.core.ticket_session())

    def test_a_refill_in_flight_during_a_wipe_stores_nothing(self):
        dev.phase("session", "sign-out during a refill")
        self.core.save_state(token="tok-1")
        issuer = FakeIssuer()
        wiped = []

        def http(*args):
            answer = issuer(*args)
            if not wiped:  # the user is signed out while the batch is on the wire
                wiped.append(1)
                self.core.wipe_everything("test")
            return answer

        reserve = tickets.TicketReserve(self.store, lambda: ("https://api.example", {}), http=http, **FAST_TARGET)
        session = self.core.ticket_session()
        result = reserve.refill(should_continue=lambda: self.core.ticket_session() == session)
        self.assertEqual((result.status, self.store.count(), os.path.exists(self.store.path)), ("stopped", 0, False))

    def test_another_session_token_drops_the_previous_reserve(self):
        dev.phase("session", "account switch")
        self.core.save_session_state("tok-1", email="a@example.test")
        self.store.append(mint(2))
        self.core.save_session_state("tok-1", email="a@example.test")  # same session again: kept
        self.assertEqual(self.store.count(), 2)
        self.core.save_session_state("tok-2", email="b@example.test")
        self.assertEqual((self.store.count(), self.core.ticket_session()), (0, "tok-2"))

    def test_pairing_another_account_drops_the_previous_reserve(self):
        import sys
        from unittest import mock
        with mock.patch.dict(sys.modules, {"xbmc": mock.MagicMock(), "xbmcgui": mock.MagicMock()}):
            sys.modules.pop("pair_ui", None)
            self.addCleanup(sys.modules.pop, "pair_ui", None)
            import pair_ui
            self.core.save_state(token="tok-1", apiUrl="http://localhost:3000")
            self.store.append(mint(2))
            profile = {"id": "prof-kid", "name": "Kid"}
            pair_ui.store_pairing({"token": "tok-2", "email": "", "key": bytes(32), "clientType": "kodi"}, profile)
        state = self.core.load_state()
        self.assertEqual((self.store.count(), self.core.ticket_session()), (0, "tok-2"))
        self.assertEqual((state["profileId"], state["profileName"]), ("prof-kid", "Kid"))


class RefillStops(SessionCase):
    def test_store_append_checks_validity_inside_the_lock(self):
        tokens = mint(2)
        self.assertIsNone(self.store.append(tokens, lambda: False))
        self.assertEqual(self.store.count(), 0)
        self.assertEqual(self.store.append(tokens, lambda: True), 2)

    def test_scheduler_ties_the_refill_to_its_session(self):
        issuer = FakeIssuer()
        session = ["tok-1"]

        def http(*args):
            answer = issuer(*args)
            session[0] = "tok-2"  # another account signs in while the batch is in flight
            return answer

        reserve = tickets.TicketReserve(self.store, lambda: ("https://api.example", {}), http=http, **FAST_TARGET)
        sched = tickets.RefillScheduler(reserve, lambda: session[0], spawn=lambda work: work())
        sched.poll()
        self.assertEqual((sched.last_result.status, self.store.count()), ("stopped", 0))

    def test_kodi_shutting_down_stops_a_refill_before_it_stores(self):
        issuer = FakeIssuer()
        aborted = [False]

        def http(*args):
            answer = issuer(*args)
            aborted[0] = True
            return answer

        reserve = tickets.TicketReserve(self.store, lambda: ("https://api.example", {}), http=http, **FAST_TARGET)
        sched = tickets.RefillScheduler(reserve, lambda: "tok-1", spawn=lambda work: work(), aborted=lambda: aborted[0])
        sched.poll()
        self.assertEqual((sched.last_result.status, self.store.count(), len(issuer.requests)), ("stopped", 0, 1))


if __name__ == "__main__":
    unittest.main()
