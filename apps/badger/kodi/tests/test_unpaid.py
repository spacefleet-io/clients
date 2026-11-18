"""@req ACCT-UNPAID-03 the unpaid notice tells the user in plain English and gives the renewal date."""
import unittest

import _path  # noqa: F401
import playback


class Unpaid(unittest.TestCase):
    def test_human_date(self):
        self.assertEqual(playback.human_date("2026-11-30T00:00:00.000Z"), "30 November 2026")
        self.assertEqual(playback.human_date("not a date"), "not a date")

    def test_message_names_the_removal_date_and_renewal(self):
        text = playback.unpaid_message("2026-11-30T00:00:00.000Z")
        self.assertIn("paused", text)
        self.assertIn("30 November 2026", text)
        self.assertIn(playback.RENEW_URL, text)
        self.assertNotIn("removed on", playback.unpaid_message(None))


if __name__ == "__main__":
    unittest.main()
