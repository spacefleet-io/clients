#!/usr/bin/env python3
"""Build the Badger Kodi add-on zip and the Kodi repository that serves it (auto-updates).

  python3 build.py plugin [--out DIR] [--version X.Y.Z]
      -> DIR/plugin.video.spacebadger-<version>.zip

  python3 build.py repo --base-url URL [--out DIR] [--layout tree|flat] [--version X.Y.Z]
      Publishable Kodi repository. URL is where DIR will be served (no trailing slash needed); it is baked into the
      repository add-on's addon.xml (committed repository.spacebadger/addon.xml only holds the placeholder @BASE_URL@).
      layout tree (default):
        DIR/addons.xml  DIR/addons.xml.md5  DIR/repository.spacebadger.zip (latest alias)
        DIR/addons/<id>/<id>-<ver>.zip  DIR/addons/<id>/icon.png  DIR/addons/<id>/<asset path of the icon>
      layout flat (release attachments, a server maps them to the tree above):
        addons.xml  addons.xml.md5  repository.spacebadger-<ver>.zip  plugin.video.spacebadger-<ver>.zip  <id>-icon.png

--version overrides the add-on version inside the built plugin zip / addons.xml only (dry runs and update tests);
releases bump <addon version> in plugin.video.spacebadger/addon.xml instead.

Crypto fallback binaries (resources/lib/vendor/<platform>/) are part of the plugin tree and ship in the zip; they are
packaging only (INTG-KODI-01). Zips are deterministic: sorted entries, fixed timestamps and modes, no bytecode.
"""
import argparse
import hashlib
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ID = "plugin.video.spacebadger"
REPO_ID = "repository.spacebadger"
PLUGIN_DIR = os.path.join(HERE, PLUGIN_ID)
REPO_DIR = os.path.join(HERE, REPO_ID)
SKIP_DIRS = {"__pycache__"}
SKIP_SUFFIXES = (".pyc", ".pyo")
ZIP_TIME = (2024, 1, 1, 0, 0, 0)
BASE_PLACEHOLDER = "@BASE_URL@"
XML_DECL = re.compile(r"^\s*<\?xml[^>]*\?>\s*")
ADDON_TAG = re.compile(r"<addon\b[^>]*>")


def read_text(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def addon_attr(xml, attr):
    match = re.search(r'\s%s="([^"]*)"' % attr, ADDON_TAG.search(xml).group(0))
    if not match:
        raise SystemExit("addon.xml has no <addon %s=...>" % attr)
    return match.group(1)


def set_version(xml, version):
    tag = ADDON_TAG.search(xml).group(0)
    return xml.replace(tag, re.sub(r'(\sversion=")[^"]*(")', r"\g<1>%s\g<2>" % version, tag, count=1), 1)


def addon_version():
    return addon_attr(read_text(os.path.join(PLUGIN_DIR, "addon.xml")), "version")


def plugin_addon_xml(version=None):
    xml = read_text(os.path.join(PLUGIN_DIR, "addon.xml"))
    return set_version(xml, version) if version else xml


def repo_addon_xml(base_url):
    xml = read_text(os.path.join(REPO_DIR, "addon.xml"))
    if BASE_PLACEHOLDER not in xml:
        raise SystemExit("repository.spacebadger/addon.xml lost its %s placeholder" % BASE_PLACEHOLDER)
    return xml.replace(BASE_PLACEHOLDER, base_url.rstrip("/"))


def icon_relpath(xml):
    match = re.search(r"<icon>([^<]+)</icon>", xml)
    return match.group(1).strip() if match else "icon.png"


def collect(src, prefix, overrides=None):
    """[(arcname, bytes)] for a directory tree, sorted, minus bytecode. overrides: {relative path: bytes}."""
    overrides = dict(overrides or {})
    entries = {}
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name.endswith(SKIP_SUFFIXES):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, src).replace(os.sep, "/")
            if rel in overrides:
                entries[rel] = overrides.pop(rel)
            else:
                with open(path, "rb") as fh:
                    entries[rel] = fh.read()
    entries.update(overrides)
    return [("%s/%s" % (prefix, rel), entries[rel]) for rel in sorted(entries)]


def write_zip(path, entries):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for arc, data in entries:
            info = zipfile.ZipInfo(arc, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            info.create_system = 3
            zf.writestr(info, data, compresslevel=9)


def plugin_entries(version=None):
    overrides = {"addon.xml": plugin_addon_xml(version).encode("utf-8")}
    return collect(PLUGIN_DIR, PLUGIN_ID, overrides)


def repo_entries(base_url):
    xml = repo_addon_xml(base_url).encode("utf-8")
    with open(os.path.join(PLUGIN_DIR, "resources", "icon.png"), "rb") as fh:
        icon = fh.read()
    return collect(REPO_DIR, REPO_ID, {"addon.xml": xml, "icon.png": icon})


def strip_decl(xml):
    return XML_DECL.sub("", xml).strip()


def build_plugin(out_dir, version=None):
    version = version or addon_version()
    path = os.path.join(out_dir, "%s-%s.zip" % (PLUGIN_ID, version))
    write_zip(path, plugin_entries(version))
    return path


def build_repo(out_dir, base_url, layout="tree", version=None):
    if not re.match(r"^https?://", base_url):
        raise SystemExit("--base-url must start with http:// or https:// (got %r)" % base_url)
    base_url = base_url.rstrip("/")
    plugin_xml = plugin_addon_xml(version)
    repo_xml = repo_addon_xml(base_url)
    plugin_version = addon_attr(plugin_xml, "version")
    repo_version = addon_attr(repo_xml, "version")
    addons_xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<addons>\n%s\n%s\n</addons>\n'
                  % (strip_decl(repo_xml), strip_decl(plugin_xml)))
    md5 = hashlib.md5(addons_xml.encode("utf-8")).hexdigest()
    os.makedirs(out_dir, exist_ok=True)

    def put(rel, data):
        path = os.path.join(out_dir, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    with open(os.path.join(PLUGIN_DIR, "resources", "icon.png"), "rb") as fh:
        icon = fh.read()
    written = [put("addons.xml", addons_xml.encode("utf-8")), put("addons.xml.md5", md5.encode("ascii"))]
    plugin_zip, repo_zip = "%s-%s.zip" % (PLUGIN_ID, plugin_version), "%s-%s.zip" % (REPO_ID, repo_version)
    if layout == "tree":
        # Kodi (zip="true" datadir) fetches <datadir>/<id>/<id>-<version>.zip and the artwork at <datadir>/<id>/<asset path>
        for addon_id, name, entries, xml in ((PLUGIN_ID, plugin_zip, plugin_entries(plugin_version), plugin_xml),
                                             (REPO_ID, repo_zip, None, repo_xml)):
            target = os.path.join(out_dir, "addons", addon_id, name)
            write_zip(target, entries if entries is not None else repo_entries(base_url))
            written.append(target)
            written.append(put("addons/%s/addon.xml" % addon_id, xml.encode("utf-8")))
            for rel in {"icon.png", icon_relpath(xml)}:
                written.append(put("addons/%s/%s" % (addon_id, rel), icon))
        alias = os.path.join(out_dir, "%s.zip" % REPO_ID)
        shutil.copyfile(os.path.join(out_dir, "addons", REPO_ID, repo_zip), alias)
        written.append(alias)
    elif layout == "flat":
        for name, entries in ((plugin_zip, plugin_entries(plugin_version)), (repo_zip, repo_entries(base_url))):
            target = os.path.join(out_dir, name)
            write_zip(target, entries)
            written.append(target)
        for addon_id in (PLUGIN_ID, REPO_ID):
            written.append(put("%s-icon.png" % addon_id, icon))
    else:
        raise SystemExit("unknown --layout %r" % layout)
    return written


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p_plugin = sub.add_parser("plugin", help="build the single plugin zip")
    p_repo = sub.add_parser("repo", help="build a publishable Kodi repository")
    for p in (p_plugin, p_repo):
        p.add_argument("--out", default=os.path.join(HERE, "dist"))
        p.add_argument("--version", help="override the plugin version (dry runs / update tests)")
    p_repo.add_argument("--base-url", required=True, help="public URL the --out directory is served at")
    p_repo.add_argument("--layout", choices=("tree", "flat"), default="tree")
    args = parser.parse_args(argv)
    if args.command == "plugin":
        print(build_plugin(args.out, args.version))
    else:
        for path in build_repo(args.out, args.base_url, args.layout, args.version):
            print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
