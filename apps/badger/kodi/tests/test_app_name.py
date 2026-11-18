"""The add-on is called Badger wherever Kodi shows its name.

@req PLAT-SUITE-02[badger-kodi]  the app is called Badger everywhere a person reads its name; SpaceBadger survives only in domain
names and in identifiers nobody reads as the product name (addon ids, skin file names, the `[SpaceBadger]` log prefix,
HTTP header and user-agent tokens)
"""
import ast
import glob
import os
import re
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
KODI = os.path.normpath(os.path.join(HERE, ".."))
PLUGIN = os.path.join(KODI, "plugin.video.spacebadger")
REPOSITORY = os.path.join(KODI, "repository.spacebadger")

# "SpaceBadger" standing alone as a word: not part of an identifier (SpaceBadgerPair.xml), a dotted or bracketed
# token ([SpaceBadger], X-SpaceBadger-Preflight, SpaceBadger-Kodi/0.1) or a domain (spacebadger.io is lower case).
PRODUCT_NAME = re.compile(r"(?<![\w.\[\-])SpaceBadger(?![\w/\-\]])")


def product_name_hits(text):
    return [m.group(0) for m in PRODUCT_NAME.finditer(text)]


def addon_texts(path):
    root = ET.parse(path).getroot()
    texts = [root.get("name"), root.get("provider-name")]
    for ext in root.iter("extension"):
        texts.append(ext.get("name"))
        for tag in ("summary", "description", "disclaimer"):
            texts.extend(el.text for el in ext.iter(tag))
    return root, [t for t in texts if t]


def docstring_nodes(tree):
    nodes = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                nodes.add(id(first.value))
    return nodes


class AddonName(unittest.TestCase):
    def test_plugin_addon_xml_says_badger(self):
        root, texts = addon_texts(os.path.join(PLUGIN, "addon.xml"))
        print("plugin addon.xml texts:", texts)
        self.assertEqual(root.get("id"), "plugin.video.spacebadger")  # the id is not a name people read
        self.assertEqual(root.get("name"), "Badger")
        self.assertEqual(root.get("provider-name"), "Badger")
        for text in texts:
            self.assertEqual(product_name_hits(text), [], text)

    def test_repository_addon_xml_says_badger(self):
        root, texts = addon_texts(os.path.join(REPOSITORY, "addon.xml"))
        print("repository addon.xml texts:", texts)
        self.assertEqual(root.get("id"), "repository.spacebadger")
        self.assertEqual(root.get("name"), "Badger repository")
        for text in texts:
            self.assertEqual(product_name_hits(text), [], text)

    def test_language_strings_say_badger(self):
        path = os.path.join(PLUGIN, "resources", "language", "resource.language.en_gb", "strings.po")
        with open(path, encoding="utf-8") as fh:
            lines = [line for line in fh if line.startswith(("msgid", "msgstr"))]
        print("strings.po: %d msgid/msgstr lines checked" % len(lines))
        self.assertTrue(lines)
        for line in lines:
            self.assertEqual(product_name_hits(line), [], line)

    def test_settings_and_skins_say_badger(self):
        paths = [os.path.join(PLUGIN, "resources", "settings.xml")]
        paths += glob.glob(os.path.join(PLUGIN, "resources", "skins", "**", "*.xml"), recursive=True)
        print("xml checked:", [os.path.relpath(p, KODI) for p in paths])
        for path in paths:
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(product_name_hits(fh.read()), [], path)

    def test_python_strings_say_badger(self):
        """Dialog titles, notifications, list labels: every string literal that is not a docstring."""
        paths = glob.glob(os.path.join(PLUGIN, "*.py")) + glob.glob(os.path.join(PLUGIN, "resources", "lib", "*.py"))
        self.assertTrue(paths)
        offenders = []
        for path in paths:
            with open(path, encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), path)
            docstrings = docstring_nodes(tree)
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
                    if product_name_hits(node.value):
                        offenders.append("%s:%d %r" % (os.path.relpath(path, KODI), node.lineno, node.value))
        print("python files checked: %d, offenders: %s" % (len(paths), offenders))
        self.assertEqual(offenders, [])

    def test_pattern_keeps_identifiers_and_catches_names(self):
        for kept in ("[SpaceBadger] sync", "X-SpaceBadger-Preflight", "SpaceBadger-Kodi/0.1", "SpaceBadgerPair.xml",
                     "SpaceBadgerLocal/0.1", "https://spacebadger.io"):
            self.assertEqual(product_name_hits(kept), [], kept)
        for caught in ("SpaceBadger", "Delete from SpaceBadger...", "SpaceBadger: subscription unpaid", "SpaceBadger's"):
            self.assertEqual(product_name_hits(caught), ["SpaceBadger"], caught)


if __name__ == "__main__":
    unittest.main()
