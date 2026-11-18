"""Signing out of the Kodi addon asks first whether the library key was saved.

@req ACCT-DEV-03[badger-kodi]  holding the key (or a key file that cannot be checked), Sign out asks the saved-key question
with Cancel focused and signs out only on "I saved it, sign out"; Cancel changes nothing; with no key the plain yes/no stays
"""
import os
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import _path  # noqa: F401

TMP = tempfile.mkdtemp(prefix="sb-kodi-signout-")
os.environ["SB_DATA_DIR"] = TMP
os.environ["SB_SETTINGS_JSON"] = "{}"

import core  # noqa: E402
import router  # noqa: E402

LANG = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin.video.spacebadger", "resources", "language")
)
IDS = (30160, 30161, 30162, 30163)


def log(msg):
    sys.stderr.write("[kodi-signout-key] %s\n" % msg)
    sys.stderr.flush()


def po_entries(path):
    text = open(path, encoding="utf-8").read()
    out = {}
    for ctx, msgid, msgstr in re.findall(r'msgctxt "#(\d+)"\nmsgid "((?:[^"\\]|\\.)*)"\nmsgstr "((?:[^"\\]|\\.)*)"', text):
        out[int(ctx)] = (msgid, msgstr)
    return out


class SignOutFlow(unittest.TestCase):
    """action_signout end to end with the dialogs, the API call and the wipe mocked."""

    def run_signout(self, holds, answer):
        calls = []

        def fake_yes_no(title, message, yes="Yes", no="No", default_no=False):
            calls.append({"title": title, "message": message, "yes": yes, "no": no, "default_no": default_no})
            log("yes_no shown: %r" % calls[-1])
            return answer

        ctx = mock.MagicMock()
        with mock.patch.object(router, "yes_no", fake_yes_no), mock.patch.object(
            router.core, "holds_library_key", return_value=holds
        ), mock.patch.object(router.core, "Context", return_value=ctx) as context, mock.patch.object(
            router.core, "wipe_everything"
        ) as wipe, mock.patch.object(router, "set_prop") as set_prop, mock.patch.object(router, "notify") as notify:
            router.action_signout()
        state = {
            "dialogs": calls,
            "context": context.call_count,
            "logout": ctx.api.logout.call_count,
            "wipe": wipe.call_args_list,
            "props": [c.args for c in set_prop.call_args_list],
            "notify": notify.call_count,
        }
        log("holds=%s answer=%s -> %r" % (holds, answer, state))
        return state

    def test_key_held_cancel_changes_nothing(self):
        state = self.run_signout(holds=True, answer=False)
        self.assertEqual(len(state["dialogs"]), 1)
        dialog = state["dialogs"][0]
        self.assertEqual(dialog["title"], "Have you saved your media library key?")
        self.assertIn("type the key", dialog["message"])
        self.assertIn("QR code", dialog["message"])
        self.assertEqual(dialog["no"], "Cancel")
        self.assertEqual(dialog["yes"], "I saved it, sign out")
        self.assertTrue(dialog["default_no"], "Cancel must be the focused choice")
        self.assertEqual((state["context"], state["logout"], state["wipe"], state["props"], state["notify"]), (0, 0, [], [], 0))

    def test_key_held_confirm_signs_out(self):
        state = self.run_signout(holds=True, answer=True)
        self.assertEqual(len(state["dialogs"]), 1)
        self.assertEqual(state["logout"], 1)
        self.assertEqual([c.args for c in state["wipe"]], [("user sign-out",)])
        self.assertIn(("access", "signedout"), state["props"])
        self.assertEqual(state["notify"], 1)

    def test_no_key_keeps_the_plain_question(self):
        state = self.run_signout(holds=False, answer=True)
        self.assertEqual(len(state["dialogs"]), 1)
        dialog = state["dialogs"][0]
        self.assertEqual(dialog["title"], "Badger")
        self.assertNotIn("saved", dialog["message"])
        self.assertFalse(dialog["default_no"])
        self.assertEqual(state["logout"], 1)
        self.assertEqual(len(state["wipe"]), 1)

    def test_no_key_answer_no_changes_nothing(self):
        state = self.run_signout(holds=False, answer=False)
        self.assertEqual((state["logout"], state["wipe"]), (0, []))


class HoldsLibraryKey(unittest.TestCase):
    """core.holds_library_key against a real add-on data directory."""

    def setUp(self):
        self.key = os.path.join(TMP, core.KEY_FILE)
        if os.path.lexists(self.key):
            os.remove(self.key)
        os.environ["SB_SETTINGS_JSON"] = "{}"

    def test_no_key_file(self):
        log("data dir %s: %s" % (TMP, os.listdir(TMP)))
        self.assertFalse(core.holds_library_key())

    def test_key_file_present(self):
        core.save_key("A" * 43 + "=")
        log("data dir %s: %s" % (TMP, os.listdir(TMP)))
        self.assertTrue(core.holds_library_key())

    def test_unparsable_key_file_counts_as_held(self):
        with open(self.key, "w") as fh:
            fh.write("not a key")
        self.assertTrue(core.holds_library_key())

    def test_key_file_that_cannot_be_checked_counts_as_held(self):
        with mock.patch.object(core.os, "stat", side_effect=PermissionError(13, "denied")):
            self.assertTrue(core.holds_library_key())

    def test_typed_key_waiting_in_settings_counts_as_held(self):
        os.environ["SB_SETTINGS_JSON"] = '{"library_key": "abc"}'
        self.assertTrue(core.holds_library_key())


class YesNoFocus(unittest.TestCase):
    """compat.yes_no hands Kodi the No button as default when asked, and survives a Kodi without defaultbutton."""

    def fake_gui(self, accepts_default):
        seen = []

        class Dialog:
            def yesno(self, heading, message, nolabel="", yeslabel="", **kw):
                seen.append(dict(heading=heading, nolabel=nolabel, yeslabel=yeslabel, **kw))
                log("xbmcgui.Dialog().yesno %r" % seen[-1])
                if kw and not accepts_default:
                    raise TypeError("unexpected keyword argument 'defaultbutton'")
                return False

        return mock.Mock(Dialog=Dialog, DLG_YESNO_NO_BTN=10), seen

    def test_default_no_on_kodi_20(self):
        import compat

        gui, seen = self.fake_gui(True)
        with mock.patch.object(compat, "HAVE_KODI", True), mock.patch.object(compat, "xbmcgui", gui), mock.patch.object(
            compat, "log"
        ):
            self.assertFalse(compat.yes_no("T", "M", yes="I saved it, sign out", no="Cancel", default_no=True))
        self.assertEqual(seen, [dict(heading="T", nolabel="Cancel", yeslabel="I saved it, sign out", defaultbutton=10)])

    def test_kodi_19_falls_back(self):
        import compat

        gui, seen = self.fake_gui(False)
        with mock.patch.object(compat, "HAVE_KODI", True), mock.patch.object(compat, "xbmcgui", gui), mock.patch.object(
            compat, "log"
        ):
            compat.yes_no("T", "M", default_no=True)
        self.assertEqual(len(seen), 2)
        self.assertNotIn("defaultbutton", seen[1])


class Strings(unittest.TestCase):
    """The question's strings exist in en_gb and are translated in fr, nl and de, matching the code's English."""

    def test_english_matches_the_code(self):
        en = po_entries(os.path.join(LANG, "resource.language.en_gb", "strings.po"))
        for sid, default in (
            router.SIGNOUT_KEY_TITLE,
            router.SIGNOUT_KEY_BODY,
            router.SIGNOUT_KEY_CANCEL,
            router.SIGNOUT_KEY_CONFIRM,
        ):
            self.assertEqual(en[sid][0], default.replace('"', '\\"'), sid)

    def test_translations(self):
        en = po_entries(os.path.join(LANG, "resource.language.en_gb", "strings.po"))
        for code in ("fr_fr", "nl_nl", "de_de"):
            entries = po_entries(os.path.join(LANG, "resource.language.%s" % code, "strings.po"))
            log("%s: %r" % (code, {k: v[1][:40] for k, v in entries.items()}))
            for sid in IDS:
                self.assertIn(sid, entries, "%s misses %s" % (code, sid))
                self.assertEqual(entries[sid][0], en[sid][0], "%s %s msgid differs from en_gb" % (code, sid))
                self.assertTrue(entries[sid][1], "%s %s untranslated" % (code, sid))
                self.assertNotEqual(entries[sid][1], en[sid][0], "%s %s left in English" % (code, sid))


def setUpModule():
    # `unittest discover` imports every test module before it runs any, so SB_DATA_DIR holds whichever module was
    # imported last; point the add-on back at this module's data dir before its tests run.
    os.environ["SB_DATA_DIR"] = TMP
    os.environ["SB_SETTINGS_JSON"] = "{}"


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
