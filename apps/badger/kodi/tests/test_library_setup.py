"""@req INTG-KODI-02 library setup drives Kodi's own Set content screens (fake screen, no Kodi needed)."""
import unittest

import _path  # noqa: F401
import library_setup as ls

STRINGS = {ls.STR_MOVIES: "Movies", ls.STR_TVSHOWS: "TV shows", ls.STR_NONE: "None", ls.STR_SET_CONTENT: "Set content", ls.STR_CHANGE_CONTENT: "Change content"}


class FakeGui(object):
    """A tiny model of Kodi: a Videos list, a context menu, the Set content screen with two select dialogs."""

    def __init__(self, rows=("..", "[movies]", "[tvshows]"), menu=("Play", "Set content", "Info")):
        self.window = "videos"
        self.rows, self.row = list(rows), 0
        self.menu, self.menu_row = list(menu), 0
        self.picker, self.picker_row, self.picker_for = None, 0, None
        self.settings_row = 0
        self.chosen = {}
        self.clicked = []
        self.commands = []
        self.saved = None

    # ----- GUI surface used by library_setup
    def builtin(self, command):
        self.commands.append(command)
        if command.startswith("ActivateWindow"):
            self.window = "videos"
        elif command == "Action(Down)":
            self._move(1)
        elif command == "Action(ContextMenu)" and self.window == "videos":
            self.window, self.menu_row = "contextmenu", 0
        elif command == "Action(Select)":
            self._select()
        elif command.startswith("SendClick("):
            self._click(int(command[10:-1]))
        elif command == "Action(Back)":
            self.window = "videos"
            self.picker = None

    def _move(self, step):
        if self.picker:
            self.picker_row = (self.picker_row + step) % len(self.picker)
        elif self.window == "contextmenu":
            self.menu_row = (self.menu_row + step) % len(self.menu)
        elif self.window == "contentsettings":
            self.settings_row += step
        else:
            self.row = (self.row + step) % len(self.rows)

    def _select(self):
        if self.picker:
            self.chosen[self.picker_for] = self.picker[self.picker_row]
            self.picker = None
        elif self.window == "contextmenu":
            self.window = "contentsettings"
            self.settings_row = 0
        elif self.window == "contentsettings":
            if self.settings_row == 0:
                self.picker_for, self.picker = "content", ["Movies", "TV shows", "None"]
            else:
                self.picker_for, self.picker = "scraper", ["Local information only", "The Movie Database"]
            self.picker_row = 0

    def _click(self, control):
        if self.window == "contentsettings" and control == ls.CTRL_OK:
            self.saved = dict(self.chosen, folder=self.rows[self.row])
            self.window = "yesnodialog"
        elif self.window == "yesnodialog" and control == ls.CTRL_YES:
            self.window = "videos"

    def visible(self, condition):
        if condition == "Window.IsActive(selectdialog)":
            return self.picker is not None
        if condition == "!Window.IsActive(selectdialog)":
            return self.picker is None
        if condition == "!Window.IsActive(contentsettings) + !Window.IsActive(yesnodialog)":
            return self.window not in ("contentsettings", "yesnodialog")
        if condition.startswith("Window.IsActive(") and condition.endswith(")") and "|" not in condition:
            return self.window == condition[16:-1] and self.picker is None or (self.window == "contentsettings" and condition == "Window.IsActive(contentsettings)")
        if condition == "Library.IsScanningVideo":
            return False
        return False

    def info(self, label):
        if label == "Container.NumItems":
            return str(len(self.rows))
        if label == "System.CurrentControl":
            if self.picker:
                return self.picker[self.picker_row]
            if self.window == "contextmenu":
                return self.menu[self.menu_row]
            return self.rows[self.row]
        return ""

    def sleep(self, ms):
        pass

    def addon_name(self, addon_id):
        return "Local information only"

    def string(self, string_id):
        return STRINGS[string_id]


class LibrarySetup(unittest.TestCase):
    def test_norm_strips_folder_brackets(self):
        self.assertEqual(ls._norm("[Movies]"), "movies")
        self.assertEqual(ls._norm("  TV   shows "), "tv shows")

    def test_move_to_label_finds_bracketed_folder_and_wraps(self):
        gui = FakeGui()
        ls.move_to_label(gui, "tvshows")
        self.assertEqual(gui.row, 2)
        ls.move_to_label(gui, "..")
        self.assertEqual(gui.row, 0)

    def test_move_to_label_gives_up_with_a_clear_error(self):
        with self.assertRaises(ls.SetupError):
            ls.move_to_label(FakeGui(), "nowhere", limit=5)

    def test_assign_content_walks_set_content_screen(self):
        gui = FakeGui()
        ls.assign_content(gui, "movies", "Movies", "Local information only")
        self.assertEqual(gui.saved, {"content": "Movies", "scraper": "Local information only", "folder": "[movies]"})
        self.assertEqual(gui.window, "videos")

    def test_assign_content_uses_change_content_when_already_set(self):
        gui = FakeGui(menu=("Play", "Change content"))
        ls.assign_content(gui, "tvshows", "TV shows", "Local information only")
        self.assertEqual(gui.saved["content"], "TV shows")

    def test_assign_content_reports_missing_menu_entry(self):
        gui = FakeGui(menu=("Play", "Info"))
        with self.assertRaises(ls.SetupError):
            ls.assign_content(gui, "movies", "Movies", None)

    def test_kinds_to_set(self):
        keys = ["movies/A (2000)/A (2000).strm", "tvshows/S/Season 1/S - S01E01.strm"]
        self.assertEqual(ls.kinds_to_set(keys, {"movies": False, "tvshows": False}), ["movies", "tvshows"])
        self.assertEqual(ls.kinds_to_set(keys, {"movies": True, "tvshows": False}), ["tvshows"])
        self.assertEqual(ls.kinds_to_set(keys, {"movies": True, "tvshows": True}), [])
        self.assertEqual(ls.kinds_to_set(["movies/x"], {"movies": False, "tvshows": False}), ["movies"])
        self.assertEqual(ls.kinds_to_set([], {}), [])


if __name__ == "__main__":
    unittest.main()
