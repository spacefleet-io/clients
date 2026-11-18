"""build.py: plugin zip and Kodi repository output.

@req INTG-DIST-01  the add-on installs from our own Kodi repository and Kodi updates it by itself
@req INTG-KODI-01  vendored crypto fallback binaries are packaging only and ship inside the plugin zip
"""
import hashlib
import os
import re
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..")))
import build  # noqa: E402

BASE = "https://api.example.test/integrations/kodi"


class PluginZip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_plugin_zip_layout_and_determinism(self):
        first = build.build_plugin(os.path.join(self.tmp.name, "a"))
        second = build.build_plugin(os.path.join(self.tmp.name, "b"))
        self.assertEqual(os.path.basename(first), "plugin.video.spacebadger-%s.zip" % build.addon_version())
        with open(first, "rb") as a, open(second, "rb") as b:
            self.assertEqual(a.read(), b.read())
        with zipfile.ZipFile(first) as zf:
            names = zf.namelist()
            self.assertEqual(names, sorted(names))
            self.assertTrue(all(n.startswith("plugin.video.spacebadger/") for n in names))
            self.assertIn("plugin.video.spacebadger/addon.xml", names)
            self.assertFalse([n for n in names if "__pycache__" in n or n.endswith((".pyc", ".pyo"))])
            self.assertTrue(all(i.date_time == build.ZIP_TIME for i in zf.infolist()))
            for key in ("linux-armv7l", "linux-aarch64", "linux-x86_64", "windows-amd64", "macos-universal"):
                self.assertIn("plugin.video.spacebadger/resources/lib/vendor/%s/Cryptodome/Cipher/AES.py" % key, names)
            self.assertIn("plugin.video.spacebadger/resources/lib/vendor/MANIFEST.json", names)

    def test_version_override_only_touches_the_built_zip(self):
        path = build.build_plugin(self.tmp.name, "9.9.9")
        self.assertTrue(path.endswith("plugin.video.spacebadger-9.9.9.zip"))
        with zipfile.ZipFile(path) as zf:
            xml = zf.read("plugin.video.spacebadger/addon.xml").decode()
        self.assertEqual(build.addon_attr(xml, "version"), "9.9.9")
        self.assertNotEqual(build.addon_version(), "9.9.9")


class Repository(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = self.tmp.name

    def path(self, *parts):
        return os.path.join(self.out, *parts)

    def test_tree_layout(self):
        build.build_repo(self.out, BASE + "/", "tree")
        plugin_ver, repo_ver = build.addon_version(), "1.0.0"
        for rel in ("addons.xml", "addons.xml.md5", "repository.spacebadger.zip",
                    "addons/plugin.video.spacebadger/plugin.video.spacebadger-%s.zip" % plugin_ver,
                    "addons/plugin.video.spacebadger/icon.png", "addons/plugin.video.spacebadger/resources/icon.png",
                    "addons/repository.spacebadger/repository.spacebadger-%s.zip" % repo_ver,
                    "addons/repository.spacebadger/icon.png"):
            self.assertTrue(os.path.isfile(self.path(*rel.split("/"))), rel)
        with open(self.path("repository.spacebadger.zip"), "rb") as a, \
                open(self.path("addons", "repository.spacebadger", "repository.spacebadger-%s.zip" % repo_ver), "rb") as b:
            self.assertEqual(a.read(), b.read())

    def test_addons_xml_and_checksum(self):
        build.build_repo(self.out, BASE, "tree")
        with open(self.path("addons.xml"), "rb") as fh:
            data = fh.read()
        with open(self.path("addons.xml.md5")) as fh:
            self.assertEqual(fh.read(), hashlib.md5(data).hexdigest())
        root = ET.fromstring(data)
        ids = [a.get("id") for a in root.findall("addon")]
        self.assertEqual(ids, ["repository.spacebadger", "plugin.video.spacebadger"])
        self.assertEqual(data.count(b"<?xml"), 1)

    def test_base_url_baked_in_repo_addon(self):
        build.build_repo(self.out, BASE + "/", "tree")
        with zipfile.ZipFile(self.path("repository.spacebadger.zip")) as zf:
            self.assertEqual(sorted(zf.namelist()), ["repository.spacebadger/addon.xml", "repository.spacebadger/icon.png"])
            xml = zf.read("repository.spacebadger/addon.xml").decode()
        self.assertNotIn("@BASE_URL@", xml)
        directory = ET.fromstring(xml).find("./extension[@point='xbmc.addon.repository']/dir")
        self.assertEqual(directory.find("info").text, BASE + "/addons.xml")
        self.assertEqual(directory.find("info").get("compressed"), "false")
        self.assertEqual(directory.find("checksum").text, BASE + "/addons.xml.md5")
        self.assertEqual(directory.find("datadir").text, BASE + "/addons/")
        self.assertEqual(directory.find("datadir").get("zip"), "true")

    def test_committed_repo_addon_keeps_placeholder_not_a_hardcoded_url(self):
        with open(os.path.join(build.REPO_DIR, "addon.xml"), encoding="utf-8") as fh:
            xml = fh.read()
        self.assertEqual(len(re.findall(r"@BASE_URL@", xml)), 3)
        self.assertNotRegex(xml, r"https?://[^<\"]*addons")

    def test_flat_layout_uses_release_attachment_names(self):
        build.build_repo(self.out, BASE, "flat", version="0.2.0")
        self.assertEqual(sorted(os.listdir(self.out)), sorted([
            "addons.xml", "addons.xml.md5", "repository.spacebadger-1.0.0.zip",
            "plugin.video.spacebadger-0.2.0.zip", "plugin.video.spacebadger-icon.png", "repository.spacebadger-icon.png"]))
        with open(self.path("addons.xml"), encoding="utf-8") as fh:
            self.assertIn('id="plugin.video.spacebadger" name="Badger" version="0.2.0"', fh.read())

    def test_rejects_non_http_base_url(self):
        with self.assertRaises(SystemExit):
            build.build_repo(self.out, "ftp://x", "tree")

    def test_cli_entry_points(self):
        self.assertEqual(build.main(["plugin", "--out", self.out]), 0)
        self.assertEqual(build.main(["repo", "--base-url", BASE, "--out", os.path.join(self.out, "r")]), 0)
        self.assertTrue(os.path.isfile(os.path.join(self.out, "r", "addons.xml")))


if __name__ == "__main__":
    unittest.main()
