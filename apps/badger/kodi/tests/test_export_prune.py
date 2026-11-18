"""@req INTG-DEL-01 deleting one episode must also remove its exported .strm/.nfo/thumb: the show folder stays, so the
stale-folder sweep never sees it and Kodi would re-add the episode on its next library scan."""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _path  # noqa: E402,F401
import export


class PruneEpisodeFilesTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.season = os.path.join(self.root, "Season 01")
        os.makedirs(self.season)
        for name in ("S01E01 - Pilot", "S01E03 - Bag"):
            for ext in (".strm", ".nfo", "-thumb.jpg"):
                open(os.path.join(self.season, name + ext), "w").close()
        open(os.path.join(self.root, "tvshow.nfo"), "w").close()

    def test_removes_only_the_deleted_episode(self):
        stats = {"removed": 0}
        export._prune_episode_files(self.root, {("Season 01", "S01E01 - Pilot")}, stats)
        self.assertEqual(sorted(os.listdir(self.season)), ["S01E01 - Pilot-thumb.jpg", "S01E01 - Pilot.nfo", "S01E01 - Pilot.strm"])
        self.assertTrue(os.path.exists(os.path.join(self.root, "tvshow.nfo")))
        self.assertEqual(stats["removed"], 3)

    def test_drops_an_emptied_season_folder(self):
        export._prune_episode_files(self.root, set(), {"removed": 0})
        self.assertFalse(os.path.exists(self.season))


if __name__ == "__main__":
    unittest.main()
