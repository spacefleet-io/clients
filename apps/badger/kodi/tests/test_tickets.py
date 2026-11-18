"""@req META-ANON-02 the ticket reserve: private store, take removes before use, refill only from the schedule, 402/429/401
handling; @req META-ANON-03 tickets of another key or with a bad signature are dropped.
@req META-ANON-05 a ticket the service did not spend goes back into the store (only a well-formed ticket of the pinned key, once).

A fake issuer blind-signs with the dev key (pure Python); no network, no Kodi."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

import _dev_signer as dev
import _path  # noqa: F401
import privacypass as pp
import tickets

SIGNER = dev.dev_key()
KEY_ID = pp.PINNED_KEY.key_id
OTHER_KEY = dev.PrivateKey.from_pem(bytes.fromhex(dev.load_vector("rfc9578-a2.json")["vectors"][0]["skI"]).decode())
FAST_TARGET = dict(target=12, low_water=6, batch_size=5)


def mint(count):
    """`count` valid tickets (base64url), made the same way a refill makes them."""
    blinded, pending = pp.create_ticket_requests(count)
    signed = [pp.b64url_encode(SIGNER.blind_sign(pp.b64url_decode(b))) for b in blinded]
    return pp.finish_tickets(pending, signed, response_key_id=KEY_ID)[0]


class FakeIssuer(object):
    """Plays POST /metadata/tickets. `script` entries (status, headers, body-or-None) are consumed before normal service."""

    def __init__(self, script=None, key=SIGNER, key_id=KEY_ID):
        self.script = list(script or [])
        self.requests = []
        self.key, self.key_id = key, key_id

    def __call__(self, method, url, headers, data, timeout):
        self.requests.append((method, url, dict(headers), json.loads(data.decode())))
        if self.script:
            step = self.script.pop(0)
            if isinstance(step, Exception):
                raise step
            status, response_headers, body = step
            return status, response_headers, json.dumps(body).encode() if body is not None else b""
        blinded = self.requests[-1][3]["blinded"]
        assert len(blinded) <= 100
        signed = [pp.b64url_encode(self.key.blind_sign(pp.b64url_decode(b))) for b in blinded]
        return 200, {}, json.dumps({"signed": signed, "keyId": self.key_id}).encode()


class DevStackIssuer(FakeIssuer):
    """A dev stack's API: it answers under `key_id` and signs with the dev key, echoing a value blinded for another
    key's modulus (which the dev key cannot sign)."""

    def __call__(self, method, url, headers, data, timeout):
        self.requests.append((method, url, dict(headers), json.loads(data.decode())))
        signed = []
        for b in self.requests[-1][3]["blinded"]:
            try:
                signed.append(pp.b64url_encode(self.key.blind_sign(pp.b64url_decode(b))))
            except AssertionError:  # the value is not below the dev modulus
                signed.append(b)
        return 200, {}, json.dumps({"signed": signed, "keyId": self.key_id}).encode()


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, tickets.RESERVE_FILE)
        self.store = tickets.TicketStore(self.path)


class TicketStoreTest(StoreCase):
    def test_empty_store_returns_nothing(self):
        dev.phase("tickets", "empty store")
        self.assertIsNone(self.store.take())
        self.assertEqual(self.store.count(), 0)

    def test_take_removes_the_ticket_from_disk_before_returning_it(self):
        dev.phase("tickets", "take persists the removal first")
        held = mint(3)
        self.store.append(held)
        ticket = self.store.take()
        self.assertEqual(ticket, held[-1])
        with open(self.path) as fh:
            self.assertNotIn(ticket, json.load(fh)["tokens"])
        self.assertEqual(tickets.TicketStore(self.path).count(), 2)  # a fresh process sees it gone

    def test_put_gives_back_a_ticket_once_and_only_a_valid_one(self):
        dev.phase("tickets", "put-back")
        held = mint(3)
        self.store.append(held)
        ticket = self.store.take()
        self.assertEqual(self.store.count(), 2)
        self.store.put("not-a-ticket")
        self.store.put("A" * 472)
        self.store.put(None)
        self.assertEqual(self.store.count(), 2)
        self.store.put(ticket)
        self.store.put(ticket)
        self.assertEqual(self.store.count(), 3)
        self.assertEqual(tickets.TicketStore(self.path).take(), ticket)  # a fresh process sees it, and it is handed out first

    def test_put_never_raises_when_the_write_fails(self):
        held = mint(2)
        self.store.append(held)
        ticket = self.store.take()
        original = tickets._write_private_atomic

        def boom(path, text):
            raise OSError("disk full")

        tickets._write_private_atomic = boom
        try:
            self.store.put(ticket)
        finally:
            tickets._write_private_atomic = original
        self.assertEqual(self.store.count(), 1)

    def test_failed_write_hands_out_nothing(self):
        held = mint(2)
        self.store.append(held)
        original = tickets._write_private_atomic

        def boom(path, text):
            raise OSError("disk full")

        tickets._write_private_atomic = boom
        try:
            with self.assertRaises(OSError):
                self.store.take()
        finally:
            tickets._write_private_atomic = original
        self.assertEqual(self.store.count(), 2)

    def test_file_is_one_json_blob_private_and_atomic(self):
        self.store.append(mint(2))
        with open(self.path) as fh:
            blob = json.load(fh)
        self.assertEqual(set(blob), {"v", "tokens"})
        self.assertEqual(blob["v"], 1)
        if os.name == "posix":
            self.assertEqual(os.stat(self.path).st_mode & 0o077, 0)
        self.assertEqual([n for n in os.listdir(self.tmp.name) if n.endswith(".tmp")], [])

    def test_last_ticket_removes_the_file(self):
        self.store.append(mint(1))
        self.assertIsNotNone(self.store.take())
        self.assertFalse(os.path.exists(self.path))

    def test_corrupt_or_foreign_blobs_count_as_empty(self):
        for text in ("not json", "[]", '{"v": 2, "tokens": ["x"]}', '{"v": 1, "tokens": "x"}', '{"v": 1, "tokens": ["short", 5]}'):
            with open(self.path, "w") as fh:
                fh.write(text)
            self.assertEqual(tickets.TicketStore(self.path).count(), 0, text)

    def test_tickets_of_another_key_id_are_dropped_at_the_first_read(self):
        dev.phase("tickets", "key rotation drops stored tickets of another key id (META-ANON-03)")
        good = mint(2)
        raw = bytearray(pp.b64url_decode(good[0]))
        raw[66] ^= 0xFF  # another token_key_id
        foreign = pp.b64url_encode(bytes(raw))
        with open(self.path, "w") as fh:
            json.dump({"v": 1, "tokens": [foreign, good[1]]}, fh)
        store = tickets.TicketStore(self.path)
        self.assertEqual(store.count(), 1)
        self.assertEqual(store.take(), good[1])

    def test_concurrent_processes_never_hand_out_the_same_ticket(self):
        dev.phase("tickets", "4 processes + a refill race for one reserve")
        held = mint(40)
        self.store.append(held)
        code = (
            "import sys; sys.path.insert(0, %r); import tickets\n"
            "s = tickets.TicketStore(%r)\n"
            "while True:\n"
            "    t = s.take()\n"
            "    if t is None: break\n"
            "    print(t)\n"
        ) % (_path.LIB, self.path)
        procs = [subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, universal_newlines=True) for _ in range(4)]
        extra = mint(5)
        self.store.append(extra)  # the refill's append runs while the takers drain the file
        taken = []
        for proc in procs:
            out, _ = proc.communicate(timeout=60)
            self.assertEqual(proc.returncode, 0)
            taken += out.split()
        taken += [t for t in iter(self.store.take, None)]
        self.assertEqual(len(taken), 45)
        self.assertEqual(sorted(taken), sorted(held + extra))


class RefillTest(StoreCase):
    def reserve(self, issuer, auth=("https://api.example", {"authorization": "Bearer x", "content-type": "application/json"}), **kw):
        options = dict(FAST_TARGET)
        options.update(kw)
        return tickets.TicketReserve(self.store, lambda: auth, http=issuer, **options)

    def test_refills_to_the_target_in_batches_and_every_ticket_verifies(self):
        dev.phase("tickets", "refill to target in batches")
        issuer = FakeIssuer()
        reserve = self.reserve(issuer)
        result = reserve.refill()
        self.assertEqual((result.status, result.added, result.dropped, result.count), ("ok", 12, 0, 12))
        self.assertEqual([len(r[3]["blinded"]) for r in issuer.requests], [5, 5, 2])
        method, url, headers, _ = issuer.requests[0]
        self.assertEqual((method, url), ("POST", "https://api.example/metadata/tickets"))
        self.assertEqual(headers["authorization"], "Bearer x")
        while True:
            ticket = self.store.take()
            if ticket is None:
                break
            self.assertIsNone(pp.verify_token(pp.b64url_decode(ticket)))

    def test_default_options_mirror_metadata_client(self):
        self.assertEqual((tickets.TARGET, tickets.LOW_WATER, tickets.BATCH_SIZE), (600, 300, 100))
        self.assertEqual((tickets.INTERVAL_SECONDS, tickets.JITTER, tickets.BACKOFF_BASE_SECONDS), (6 * 3600, 0.3, 300))
        reserve = tickets.TicketReserve(self.store, lambda: ("https://api.example", {}), http=FakeIssuer())
        self.assertEqual((reserve.target, reserve.low_water, reserve.batch_size), (600, 300, 100))
        issuer = FakeIssuer()  # full-size batches: 100 per request, never more (the API accepts at most 100)
        self.assertEqual(self.reserve(issuer, target=250, low_water=100, batch_size=100).refill().count, 250)
        self.assertEqual([len(r[3]["blinded"]) for r in issuer.requests], [100, 100, 50])

    def test_skips_at_or_above_the_low_water_mark_unless_forced(self):
        self.store.append(mint(7))
        issuer = FakeIssuer()
        reserve = self.reserve(issuer)
        self.assertEqual(reserve.refill().status, "skipped")
        self.assertEqual(issuer.requests, [])
        self.assertEqual(reserve.refill(force=True).count, 12)

    def test_unpaid_keeps_what_is_held(self):
        dev.phase("tickets", "402 / 429 / 401 / 5xx / network")
        self.store.append(mint(2))
        reserve = self.reserve(FakeIssuer([(402, {}, {"error": "subscription_unpaid"})]))
        result = reserve.refill()
        self.assertEqual((result.status, result.count, result.added), ("unpaid", 2, 0))
        self.assertEqual(self.store.count(), 2)

    def test_rate_limited_carries_retry_after_and_the_next_tick_honours_it(self):
        reserve = self.reserve(FakeIssuer([(429, {"retry-after": "43200"}, None)]), rand=lambda: 0.5)
        result = reserve.refill()
        self.assertEqual((result.status, result.retry_after), ("rate_limited", 43200))
        self.assertEqual(reserve.next_delay(result), 43200)  # later than the regular 6 h tick
        self.assertEqual(reserve.next_delay(tickets.RefillResult("ok")), 6 * 3600)

    def test_retry_after_http_date_and_garbage(self):
        self.assertEqual(tickets.parse_retry_after("Wed, 21 Oct 2026 07:30:00 GMT", 1792567800 - 90), 90)
        self.assertEqual(tickets.parse_retry_after("Wed, 21 Oct 2026 07:30:00 GMT", 1792567800 + 90), 0)
        self.assertIsNone(tickets.parse_retry_after("soon", 0))
        self.assertIsNone(tickets.parse_retry_after(None, 0))
        self.assertEqual(tickets.parse_retry_after("99999999999", 0), 365 * 24 * 3600)

    def test_401_or_signed_out_means_signed_out_and_no_request(self):
        reserve = self.reserve(FakeIssuer([(401, {}, None)]))
        self.assertEqual(reserve.refill().status, "signed_out")
        issuer = FakeIssuer()
        self.assertEqual(self.reserve(issuer, auth=None).refill().status, "signed_out")
        self.assertEqual(issuer.requests, [])

    def test_server_and_network_failures_back_off_exponentially(self):
        reserve = self.reserve(FakeIssuer([(500, {}, None), OSError("down"), (200, {}, None), (200, {}, [1])]))
        statuses = [reserve.refill(force=True).status for _ in range(4)]
        self.assertEqual(statuses, ["server_error", "network_error", "server_error", "server_error"])
        delays = [reserve.next_delay(tickets.RefillResult("server_error")) for _ in range(8)]
        self.assertEqual(delays[:3], [300, 600, 1200])  # 5 min, doubling per consecutive failure
        self.assertEqual(delays[-1], 6 * 3600)  # capped at the interval
        self.assertEqual(reserve.next_delay(tickets.RefillResult("ok")) > 0, True)
        self.assertEqual(reserve._failures, 0)  # a good tick resets the backoff

    def test_earlier_batches_survive_a_later_failure(self):
        issuer = FakeIssuer()
        calls = {"n": 0}

        def flaky(*args):
            calls["n"] += 1
            if calls["n"] == 2:
                return 503, {}, b""
            return issuer(*args)

        result = self.reserve(flaky).refill()
        self.assertEqual((result.status, result.added, result.count), ("server_error", 5, 5))
        self.assertEqual(self.store.count(), 5)

    def test_wrong_key_id_drops_the_whole_batch(self):
        dev.phase("tickets", "drop-on-wrong-key/keyId (META-ANON-03)")
        reserve = self.reserve(FakeIssuer(key_id="cd" * 32))
        result = reserve.refill()
        self.assertEqual((result.status, result.added, result.dropped), ("rejected", 0, 5))
        self.assertEqual(self.store.count(), 0)

    def test_a_dev_run_switches_to_the_trusted_key_the_api_answers_under_once(self):
        """@req META-ANON-07 a dev run trusts every environment's key: an answer under another trusted key drops that
        batch (blinded for the wrong key) and blinds the rest for it, at most once per refill."""
        dev.phase("tickets", "dev run: production blinded first, the dev stack answers under the dev key")
        store = tickets.TicketStore(self.path, (pp.PRODUCTION_KEY, pp.DEV_KEY))
        issuer = DevStackIssuer(key_id=pp.DEV_KEY.key_id)
        reserve = tickets.TicketReserve(store, lambda: ("https://api.example", {}), (pp.PRODUCTION_KEY, pp.DEV_KEY), http=issuer, **FAST_TARGET)
        result = reserve.refill()
        self.assertEqual((result.status, result.added, result.dropped, result.count), ("ok", 12, 5, 12))
        self.assertEqual([len(r[3]["blinded"]) for r in issuer.requests], [5, 5, 5, 2])
        while True:
            ticket = store.take()
            if ticket is None:
                break
            self.assertIsNone(pp.verify_token(pp.b64url_decode(ticket), pp.DEV_KEY))

        dev.phase("tickets", "an answer flipping key ids again is not followed a second time")
        flip = DevStackIssuer(key_id=pp.PRODUCTION_KEY.key_id)
        result = tickets.TicketReserve(store, lambda: ("https://api.example", {}), (pp.DEV_KEY, pp.PRODUCTION_KEY), http=flip, **FAST_TARGET).refill()
        self.assertEqual((result.status, result.added, result.dropped, store.count()), ("rejected", 0, 10, 0))
        self.assertEqual(len(flip.requests), 2)

    def test_a_release_run_drops_a_batch_answered_under_the_dev_key(self):
        """@req META-ANON-07 a release run trusts the production key alone: a dev stack's answer is dropped, never followed."""
        dev.phase("tickets", "release run against a dev stack")
        store = tickets.TicketStore(self.path, (pp.PRODUCTION_KEY,))
        issuer = DevStackIssuer(key_id=pp.DEV_KEY.key_id)
        result = tickets.TicketReserve(store, lambda: ("https://api.example", {}), (pp.PRODUCTION_KEY,), http=issuer, **FAST_TARGET).refill()
        self.assertEqual((result.status, result.added, result.dropped, store.count()), ("rejected", 0, 5, 0))
        self.assertEqual(len(issuer.requests), 1)
        self.assertEqual(store.put(mint(1)[0]), None)
        self.assertEqual(store.count(), 0)  # a dev-key ticket is not held either

    def test_missing_key_id_fails_closed(self):
        reserve = self.reserve(FakeIssuer([(200, {}, {"signed": ["x"]})]))
        result = reserve.refill()
        self.assertEqual((result.status, result.added, result.dropped), ("rejected", 0, 5))

    def test_signatures_from_another_key_are_dropped_even_with_the_right_key_id(self):
        reserve = self.reserve(FakeIssuer(key=OTHER_KEY))
        result = reserve.refill()
        self.assertEqual((result.status, result.added, result.dropped, self.store.count()), ("rejected", 0, 5, 0))

    def test_partly_bad_batch_keeps_the_good_tickets(self):
        def issuer(method, url, headers, data, timeout):
            blinded = json.loads(data.decode())["blinded"]
            signed = [pp.b64url_encode(SIGNER.blind_sign(pp.b64url_decode(b))) for b in blinded]
            if len(blinded) == 5:  # first batch: one garbage entry and one signed by another key
                signed[1] = "garbage"
                signed[3] = pp.b64url_encode(OTHER_KEY.blind_sign(pp.b64url_decode(blinded[3])))
            return 200, {}, json.dumps({"signed": signed, "keyId": KEY_ID}).encode()

        result = self.reserve(issuer, target=5).refill()
        # 3 good from the first batch, then the loop asks for the 2 still missing
        self.assertEqual((result.status, result.added, result.dropped, result.count), ("ok", 5, 2, 5))

    def test_unreadable_answers_are_server_errors(self):
        for body in (b"<html>", b"[]", b'"x"'):
            reserve = self.reserve(lambda *a, _b=body: (200, {}, _b))
            self.assertEqual(reserve.refill(force=True).status, "server_error", body)

    def test_stop_between_batches(self):
        reserve = self.reserve(FakeIssuer())
        flags = iter([True, True, False])  # before the first batch, right before it is stored, before the second
        result = reserve.refill(should_continue=lambda: next(flags))
        self.assertEqual((result.status, result.added), ("stopped", 5))

    def test_local_failure_is_an_error_status_not_an_exception(self):
        def bad_auth():
            raise RuntimeError("boom")

        reserve = tickets.TicketReserve(self.store, bad_auth, http=FakeIssuer(), **FAST_TARGET)
        self.assertEqual(reserve.refill().status, "error")

    def test_blinded_values_are_the_only_thing_in_the_request_body(self):
        issuer = FakeIssuer()
        self.reserve(issuer, target=3).refill()
        self.assertEqual(set(issuer.requests[0][3]), {"blinded"})
        for blinded in issuer.requests[0][3]["blinded"]:
            self.assertEqual(len(pp.b64url_decode(blinded)), 256)


class SchedulerTest(StoreCase):
    def setUp(self):
        super().setUp()
        self.clock = [1000.0]
        self.session = ["tok-1"]
        self.issuer = FakeIssuer()
        self.reserve = tickets.TicketReserve(self.store, lambda: ("https://api.example", {}), http=self.issuer, rand=lambda: 0.5, **FAST_TARGET)
        self.spawned = []

        def spawn(work):
            work()  # run inline: deterministic
            self.spawned.append(1)

            class Done(object):
                def is_alive(self):
                    return False

            return Done()

        self.sched = tickets.RefillScheduler(self.reserve, lambda: self.session[0], now=lambda: self.clock[0], spawn=spawn)

    def test_start_check_runs_at_once_when_signed_in_then_every_interval(self):
        dev.phase("tickets", "scheduler: start check, then ~6 h")
        self.sched.poll()
        self.assertEqual(self.store.count(), 12)
        self.assertEqual(len(self.spawned), 1)
        self.sched.poll()
        self.assertEqual(len(self.spawned), 1)  # nothing before the next tick
        self.clock[0] += 6 * 3600 - 1
        self.sched.poll()
        self.assertEqual(len(self.spawned), 1)
        self.clock[0] += 2
        self.sched.poll()
        self.assertEqual(len(self.spawned), 2)

    def test_next_tick_is_jittered_within_30_percent(self):
        for draw, expected in ((0.0, 0.7 * 6 * 3600), (0.5, 6 * 3600), (1.0, 1.3 * 6 * 3600)):
            r = tickets.TicketReserve(self.store, lambda: None, http=self.issuer, rand=lambda d=draw: d)
            self.assertAlmostEqual(r.next_delay(tickets.RefillResult("skipped")), expected)

    def test_does_nothing_while_signed_out_and_rearms_on_sign_in(self):
        self.session[0] = None
        self.sched.poll()
        self.assertEqual((len(self.spawned), self.issuer.requests), (0, []))
        self.session[0] = "tok-2"
        self.sched.poll()
        self.assertEqual(len(self.spawned), 1)

    def test_401_stops_the_schedule_until_another_session(self):
        self.issuer.script = [(401, {}, None)]
        self.sched.poll()
        self.assertEqual(self.sched.last_result.status, "signed_out")
        self.clock[0] += 10 * 3600
        self.sched.poll()
        self.assertEqual(len(self.spawned), 1)  # same session: no new attempt
        self.session[0] = None
        self.sched.poll()
        self.session[0] = "tok-3"
        self.sched.poll()
        self.assertEqual(len(self.spawned), 2)

    def test_unpaid_retries_at_the_next_tick(self):
        self.issuer.script = [(402, {}, {"error": "subscription_unpaid"})]
        self.sched.poll()
        self.assertEqual(self.sched.last_result.status, "unpaid")
        self.clock[0] += 6 * 3600 + 1
        self.sched.poll()
        self.assertEqual(self.sched.last_result.status, "ok")

    def test_real_thread_runs_the_refill_without_blocking_poll(self):
        started, release = threading.Event(), threading.Event()

        def slow(*args):
            started.set()
            release.wait(10)
            return self.issuer(*args)

        reserve = tickets.TicketReserve(self.store, lambda: ("https://api.example", {}), http=slow, **FAST_TARGET)
        sched = tickets.RefillScheduler(reserve, lambda: "tok")
        sched.poll()
        self.assertTrue(started.wait(10))
        sched.poll()  # a refill is running: no second thread, no blocking
        release.set()
        sched._thread.join(30)
        self.assertEqual(self.store.count(), 12)


if __name__ == "__main__":
    unittest.main()
