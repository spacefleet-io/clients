"""ACCT-STREAM-01..04 in the Kodi addon: the play handler asks the API for the profile's place, at the limit asks
"Already playing on <device>. Play here instead?", the service heartbeats every 20 s, stops with "Playing on <device>
now" when another device takes the place, and gives the place back on stop. The texts are the shared ones."""
import os
import re
import unittest

import _path  # noqa: F401
import stream_slot
from api import ApiError

T = "[kodi-stream]"
STRINGS_TS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "packages", "stream-slots",
                          "src", "strings.ts")


class FakeApi(object):
    """POST /playback/streams with a limit of 1 for the profile; `other` is a device already playing."""

    def __init__(self, other=None, down=False):
        self.calls = []
        self.other = other
        self.down = down
        self.mine = None
        self.next_id = 1
        self.taken_by = None

    def request_json(self, method, path, body=None, expect=(200,), timeout=None):
        self.calls.append((method, path, body))
        if self.down:
            raise OSError("connection refused")
        if method == "POST" and path == "/playback/streams":
            if self.other and not body.get("takeover"):
                return {"error": "stream_limit", "limit": 1, "playingOn": [dict(self.other, streamId="other", startedAt="2026-11-11T10:00:00Z")]}
            self.other = None
            self.mine = "stream-%d" % self.next_id
            self.next_id += 1
            return {"streamId": self.mine, "profileId": body.get("profileId"), "heartbeatIntervalSeconds": 20, "expiresInSeconds": 60}
        if method == "POST" and path.endswith("/heartbeat"):
            stream_id = path.split("/")[3]
            if self.taken_by:
                return {"error": "stream_taken_over", "byDeviceName": self.taken_by.get("deviceName"), "byDeviceType": self.taken_by.get("deviceType")}
            return {"ok": True} if stream_id == self.mine else {"error": "stream_ended"}
        if method == "DELETE":
            if path.split("/")[-1] == self.mine:
                self.mine = None
            return {}
        raise ApiError(404, {"error": "not_found"})


def dump(phase, api, extra=""):
    print("%s phase: %s calls=%s mine=%s %s" % (T, phase, api.calls, api.mine, extra))


class Asker(object):
    def __init__(self, answer):
        self.answer = answer
        self.asked = []

    def __call__(self, question, play_here, cancel):
        self.asked.append((question, play_here, cancel))
        return self.answer


class StartAndKeep(unittest.TestCase):
    def test_play_takes_the_place_heartbeats_every_20s_and_gives_it_back(self):
        """@req ACCT-STREAM-01[badger-kodi] @req ACCT-STREAM-04[badger-kodi]"""
        api = FakeApi()
        ask = Asker(True)
        outcome = stream_slot.acquire(api, "profile-main", "en", ask)
        holder = stream_slot.Holder(lambda: api, "profile-main", outcome[1], "en", now=1000.0)
        due = [holder.due(t) for t in (1001.0, 1019.9, 1020.0, 1021.0, 1040.0)]
        message = holder.beat()
        holder.release()
        dump("play, heartbeat, stop", api, "outcome=%s due=%s message=%s" % (outcome, due, message))
        self.assertEqual(outcome, ("play", "stream-1"))
        self.assertEqual(ask.asked, [])
        self.assertEqual(api.calls[0], ("POST", "/playback/streams", {"app": "badger", "kind": "play", "takeover": False, "profileId": "profile-main"}))
        self.assertEqual(due, [False, False, True, False, True])
        self.assertIsNone(message)
        self.assertEqual(api.calls[1], ("POST", "/playback/streams/stream-1/heartbeat", {}))
        self.assertEqual(api.calls[-1], ("DELETE", "/playback/streams/stream-1", None))
        self.assertIsNone(api.mine)

    def test_every_kodi_playback_is_a_play_never_a_cast_or_a_download(self):
        """@req ACCT-STREAM-03[badger-kodi] Kodi has no cast receiver and no downloads: each start is kind "play"."""
        api = FakeApi(other={"deviceName": "Kitchen phone", "deviceType": "mobile"})
        stream_slot.acquire(api, None, "en", Asker(True))
        kinds = [body.get("kind") for method, path, body in api.calls if path == "/playback/streams"]
        dump("kinds", api, "kinds=%s" % kinds)
        self.assertEqual(kinds, ["play", "play"])
        self.assertTrue(all("profileId" not in body for _m, _p, body in api.calls))

    def test_api_unreachable_plays_without_a_place(self):
        """@req ACCT-STREAM-01[badger-kodi] (ACCT-STREAM-05 option A, as the shared gate)"""
        api = FakeApi(down=True)
        outcome = stream_slot.acquire(api, "p", "en", Asker(False))
        dump("down", api, "outcome=%s" % (outcome,))
        self.assertEqual(outcome, ("play", None))


class AtTheLimit(unittest.TestCase):
    def test_the_question_names_the_other_device_and_play_here_takes_over(self):
        """@req ACCT-STREAM-02[badger-kodi]"""
        api = FakeApi(other={"deviceName": "Kitchen phone", "deviceType": "mobile"})
        ask = Asker(True)
        outcome = stream_slot.acquire(api, "p", "en", ask)
        dump("play here", api, "asked=%s outcome=%s" % (ask.asked, outcome))
        self.assertEqual(ask.asked, [("Already playing on Kitchen phone. Play here instead?", "Play here", "Cancel")])
        self.assertEqual(outcome, ("play", "stream-1"))
        self.assertEqual([body["takeover"] for _m, _p, body in api.calls], [False, True])

    def test_cancel_changes_nothing(self):
        """@req ACCT-STREAM-02[badger-kodi]"""
        api = FakeApi(other={"deviceName": None, "deviceType": "tv"})
        ask = Asker(False)
        outcome = stream_slot.acquire(api, "p", "fr_FR", ask)
        dump("cancel", api, "asked=%s outcome=%s" % (ask.asked, outcome))
        self.assertEqual(ask.asked, [(u"Déjà en lecture sur une TV. Lire ici à la place ?", "Lire ici", "Annuler")])
        self.assertEqual(outcome, ("cancel", None))
        self.assertEqual(len(api.calls), 1)
        self.assertIsNotNone(api.other)

    def test_another_device_playing_here_stops_kodi_with_its_name(self):
        """@req ACCT-STREAM-02[badger-kodi]"""
        api = FakeApi()
        _outcome, stream_id = stream_slot.acquire(api, "p", "de", Asker(True))
        holder = stream_slot.Holder(lambda: api, "p", stream_id, "de", now=0.0)
        api.taken_by = {"deviceName": "Office laptop", "deviceType": "desktop"}
        message = holder.beat()
        dump("taken over", api, "message=%s" % message)
        self.assertEqual(message, "Wird jetzt auf Office laptop abgespielt")

    def test_a_stream_the_server_ended_is_taken_again_without_taking_over(self):
        """@req ACCT-STREAM-04[badger-kodi]"""
        api = FakeApi()
        holder = stream_slot.Holder(lambda: api, "p", "expired-stream", "en", now=0.0)
        message = holder.beat()
        dump("ended", api, "message=%s stream=%s" % (message, holder.stream_id))
        self.assertIsNone(message)
        self.assertEqual(holder.stream_id, "stream-1")
        self.assertEqual(api.calls[-1][2]["takeover"], False)

        api2 = FakeApi(other={"deviceName": "Bedroom TV", "deviceType": "tv"})
        holder2 = stream_slot.Holder(lambda: api2, "p", "expired-stream", "en", now=0.0)
        message2 = holder2.beat()
        dump("ended, place taken meanwhile", api2, "message=%s" % message2)
        self.assertEqual(message2, "Playing on Bedroom TV now")


class SharedTexts(unittest.TestCase):
    def test_texts_match_packages_stream_slots(self):
        """@req ACCT-STREAM-02[badger-kodi] the prompt texts are the shared package's, word for word."""
        with open(STRINGS_TS, encoding="utf-8") as f:
            source = f.read()
        strings_block = source.split("STREAM_SLOT_STRINGS")[1].split("};")[0]
        shared = {}
        for lang, body in re.findall(r"\n  (\w\w): \{(.*?)\n  \}", strings_block, re.S):
            shared[lang] = dict(re.findall(r'(\w+): "([^"]*)"', body))
        labels_block = source.split("DEVICE_LABELS")[1].split("};")[0]
        labels = {lang: dict(re.findall(r'(\w+): "([^"]*)"', body)) for lang, body in re.findall(r"\n  (\w\w): \{(.*?)\}", labels_block)}
        print("%s shared strings=%s labels=%s" % (T, shared, labels))
        self.assertEqual(sorted(shared), ["de", "en", "es", "fr", "nl"])
        self.assertEqual(shared, stream_slot.STRINGS)
        self.assertEqual(labels, stream_slot.DEVICE_LABELS)


if __name__ == "__main__":
    unittest.main()
