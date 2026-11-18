#!/usr/bin/env python3
"""(Re)generate plugin.video.spacebadger/resources/lib/vendor/ from official pycryptodomex wheels.

  python3 tools/vendor_wheels.py [--cache DIR]

For every platform in PLATFORMS the wheel is downloaded (PyPI, except linux-armv7l which PyPI does not publish and
which comes from piwheels.org), its sha256 is checked against the pin below, and only the ``Cryptodome`` modules the
addon needs (plus everything they import, found by scanning the sources) are extracted to ``vendor/<platform>/Cryptodome/``.
Tests, ``.pyi`` stubs and unused ciphers/hashes are dropped. ``vendor/MANIFEST.json`` records wheel name, wheel sha256,
source URL, license and a tree digest of what was extracted (checked by tests/test_vendor_loader.py).

The vendored binaries are *packaging only* (INTG-KODI-01): they are the unmodified upstream extension modules of
pycryptodomex, loaded in-process by Python as a fallback when the system has no usable libcrypto. The addon never starts
a separate program.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "..", "plugin.video.spacebadger", "resources", "lib", "vendor")
VERSION = "3.24.2"
PIWHEELS = "https://www.piwheels.org/simple/pycryptodomex/"

# platform key (see vendor_loader.platform_key) -> (wheel file name, sha256, source)
PLATFORMS = {
    "linux-x86_64": (
        "pycryptodomex-3.24.2-cp37-abi3-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
        "e340408a601003f235b50117cd16f87b2a5b4760765aafe93340eeaadeb0414d", "pypi"),
    "linux-aarch64": (
        "pycryptodomex-3.24.2-cp37-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.whl",
        "97dc6ea02ec1ed55dca0fbc98758ac23d0ca8ce9d7ea32d538c2851e23b8b27f", "pypi"),
    "linux-armv7l": (
        "pycryptodomex-3.24.2-cp37-abi3-linux_armv7l.whl",
        "7b4b144cdeaa5c27bcd05e0171df191227789f036dbbfc1e55a55aa633dabe44", "piwheels"),
    "windows-amd64": (
        "pycryptodomex-3.24.2-cp37-abi3-win_amd64.whl",
        "6e912e3a21061bf8f4ce89223cb46f5e98a6b32420d08d770605891a2be266c6", "pypi"),
    "macos-universal": (
        "pycryptodomex-3.24.2-cp37-abi3-macosx_10_9_universal2.whl",
        "18a41772bae7b876d84c768bdec6afb95c3d16da50200956ddcc5fccd2d84549", "pypi"),
}

# Modules the addon uses (crypto.py): AES-GCM, SHA-256/HMAC/HKDF, X25519 (ECC + Protocol.DH), randomness.
ROOTS = (
    "Cryptodome.Cipher.AES",
    "Cryptodome.Hash.SHA256",
    "Cryptodome.Hash.HMAC",
    "Cryptodome.Protocol.KDF",
    "Cryptodome.Protocol.DH",
    "Cryptodome.PublicKey.ECC",
    "Cryptodome.Random",
    "Cryptodome.Util.Padding",
)
LICENSE_FILES = ("LICENSE.rst", "AUTHORS.rst")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(root):
    """sha256 over 'relative/path\\0file-sha256\\n' for every file under root, sorted. Matches vendor_loader users/tests."""
    digest = hashlib.sha256()
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for name in sorted(files):
            if name.endswith((".pyc", ".pyo")):
                continue
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            digest.update(rel.encode() + b"\0" + sha256_file(path).encode() + b"\n")
    return digest.hexdigest()


def fetch(name, source, cache):
    path = os.path.join(cache, name)
    if not os.path.isfile(path):
        if source == "piwheels":
            url = PIWHEELS + name
        else:
            meta = json.load(urllib.request.urlopen("https://pypi.org/pypi/pycryptodomex/%s/json" % VERSION))
            url = next(f["url"] for f in meta["urls"] if f["filename"] == name)
        print("download", url)
        urllib.request.urlretrieve(url, path)
    return path


def _module_files(names, module):
    """Archive members implementing `module` ('Cryptodome.Hash.SHA256'): .py plus any compiled sibling."""
    rel = module.replace(".", "/")
    found = set()
    if rel + "/__init__.py" in names:
        found.add(rel + "/__init__.py")
    directory, _, stem = rel.rpartition("/")
    for n in names:
        d, _, f = n.rpartition("/")
        if d == directory and f.split(".")[0] == stem and not f.endswith(".pyi") and f != "__init__.py":
            found.add(n)
    return found


def closure(names, read_text):
    """All archive members reachable from ROOTS by import statements / raw-lib name strings."""
    keep, seen, queue = set(), set(), list(ROOTS)
    while queue:
        module = queue.pop()
        if module in seen:
            continue
        seen.add(module)
        members = _module_files(names, module)
        if not members:
            continue
        keep |= members
        parts = module.split(".")
        for i in range(1, len(parts)):  # parent packages
            queue.append(".".join(parts[:i]))
        for member in members:
            if not member.endswith(".py"):
                continue
            text = read_text(member)
            for token in re.findall(r"Cryptodome(?:\.\w+)+", text):
                queue.append(token)
                # `Cryptodome.Util.number.foo` -> also try the prefixes
                bits = token.split(".")
                for i in range(2, len(bits)):
                    queue.append(".".join(bits[:i]))
            for src, imported in re.findall(r"from\s+(Cryptodome[\w.]*)\s+import\s+\(?([^\n#]+)", text):
                for ident in re.findall(r"\w+", imported):
                    queue.append(src + "." + ident)
            # relative imports: `from ._IntegerBase import X`, `from . import y`
            pkg = module.split(".") if member.endswith("/__init__.py") else module.split(".")[:-1]
            for dots, src, imported in re.findall(r"from\s+(\.+)(\w*)\s+import\s+\(?([^\n#]+)", text):
                base = ".".join(pkg[:len(pkg) - (len(dots) - 1)])
                target = base + "." + src if src else base
                queue.append(target)
                for ident in re.findall(r"\w+", imported):
                    queue.append(target + "." + ident)
    return keep


def extract(wheel_path, dest):
    with zipfile.ZipFile(wheel_path) as zf:
        names = {n for n in zf.namelist() if n.startswith("Cryptodome/") and not n.endswith("/")}
        keep = closure(names, lambda n: zf.read(n).decode("utf-8", "replace"))
        for n in sorted(keep):
            target = os.path.join(dest, n)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(zf.read(n))
        licences = {}
        for n in zf.namelist():
            base = n.rsplit("/", 1)[-1]
            if ".dist-info/" in n and base in LICENSE_FILES:
                licences[base] = zf.read(n)
    return sorted(keep), licences


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", default=os.path.join(os.path.expanduser("~"), ".cache", "sb-vendor-wheels"))
    args = parser.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    vendor = os.path.normpath(VENDOR)
    if os.path.isdir(vendor):
        shutil.rmtree(vendor)
    os.makedirs(vendor)
    manifest = {
        "package": "pycryptodomex",
        "version": VERSION,
        "license": "BSD-2-Clause AND Unlicense (public domain parts); see LICENSE.rst and AUTHORS.rst here",
        "note": "Unmodified upstream extension modules, packaging only (INTG-KODI-01). Regenerate with tools/vendor_wheels.py.",
        "platforms": {},
    }
    licences = {}
    for key, (name, expected, source) in PLATFORMS.items():
        wheel = fetch(name, source, args.cache)
        actual = sha256_file(wheel)
        if actual != expected:
            sys.exit("sha256 mismatch for %s: %s != pinned %s" % (name, actual, expected))
        files, lic = extract(wheel, os.path.join(vendor, key))
        licences.update(lic)
        manifest["platforms"][key] = {
            "wheel": name,
            "wheel_sha256": actual,
            "source": (PIWHEELS + name) if source == "piwheels" else "https://pypi.org/project/pycryptodomex/%s/#files" % VERSION,
            "files": len(files),
            "tree_sha256": tree_digest(os.path.join(vendor, key)),
        }
        print(key, len(files), "files")
    for base, data in licences.items():
        with open(os.path.join(vendor, base), "wb") as fh:
            fh.write(data)
    with open(os.path.join(vendor, "MANIFEST.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")


if __name__ == "__main__":
    main()
