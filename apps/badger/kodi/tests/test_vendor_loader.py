"""Vendored pycryptodomex fallback (INTG-KODI-01: no separate program; the vendored .so/.pyd files are packaging only,
loaded in-process by Python as a per-CPU fallback when no system libcrypto/Cryptodome works).

@req INTG-KODI-01  AES-GCM comes from system libcrypto or an in-process pycryptodomex copy for the CPU type
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

import _path  # noqa: F401
import vendor_loader

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.normpath(os.path.join(HERE, "..", "plugin.video.spacebadger", "resources", "lib"))
VENDOR = os.path.join(LIB, "vendor")
VECTORS = os.path.join(HERE, "vectors.json")
CHECK = os.path.join(HERE, "vendor_check.py")
EXPECTED_PLATFORMS = {"linux-x86_64", "linux-aarch64", "linux-armv7l", "windows-amd64", "macos-universal"}


def _tool():
    spec = importlib.util.spec_from_file_location("vendor_wheels", os.path.join(HERE, "..", "tools", "vendor_wheels.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run(args, env_extra=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("SB_") and k != "PYTHONPATH"}
    env.update(env_extra or {})
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run([sys.executable, "-S", "-B"] + args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=120)


class PlatformKey(unittest.TestCase):
    CASES = [
        (("Linux", "x86_64", 2 ** 63 - 1), "linux-x86_64"),
        (("Linux", "AMD64", 2 ** 63 - 1), "linux-x86_64"),
        (("Linux", "aarch64", 2 ** 63 - 1), "linux-aarch64"),
        (("Linux", "arm64", 2 ** 63 - 1), "linux-aarch64"),
        (("Linux", "armv7l", 2 ** 31 - 1), "linux-armv7l"),
        (("Linux", "armv6l", 2 ** 31 - 1), "linux-armv7l"),
        (("Linux", "armhf", 2 ** 31 - 1), "linux-armv7l"),
        (("Linux", "armv8l", 2 ** 31 - 1), "linux-armv7l"),
        # OSMC/LibreELEC Pi: 64-bit kernel, 32-bit Kodi/Python userland (what chrisflix reports)
        (("Linux", "aarch64", 2 ** 31 - 1), "linux-armv7l"),
        (("Linux", "x86_64", 2 ** 31 - 1), "linux-i686"),
        (("Linux", "i686", 2 ** 31 - 1), "linux-i686"),
        (("Windows", "AMD64", 2 ** 63 - 1), "windows-amd64"),
        (("Windows", "x86", 2 ** 31 - 1), "windows-i686"),
        (("Windows", "ARM64", 2 ** 63 - 1), "windows-arm64"),
        (("Darwin", "arm64", 2 ** 63 - 1), "macos-universal"),
        (("Darwin", "x86_64", 2 ** 63 - 1), "macos-universal"),
    ]

    def test_normalisation(self):
        for args, expected in self.CASES:
            self.assertEqual(vendor_loader.platform_key(*args), expected, args)

    def test_defaults_come_from_this_machine(self):
        self.assertRegex(vendor_loader.platform_key(), r"^[a-z]+-[a-z0-9_]+$|^macos-universal$")


class ManifestIntegrity(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(VENDOR, "MANIFEST.json"), encoding="utf-8") as fh:
            self.manifest = json.load(fh)

    def test_all_platforms_present_and_pinned(self):
        self.assertEqual(set(self.manifest["platforms"]), EXPECTED_PLATFORMS)
        self.assertEqual({d for d in os.listdir(VENDOR) if os.path.isdir(os.path.join(VENDOR, d))}, EXPECTED_PLATFORMS)
        for key, entry in self.manifest["platforms"].items():
            self.assertRegex(entry["wheel_sha256"], r"^[0-9a-f]{64}$", key)
            self.assertTrue(entry["wheel"].startswith("pycryptodomex-%s-" % self.manifest["version"]), key)
            self.assertIn("abi3", entry["wheel"])

    def test_tree_digests_match_manifest(self):
        tool = _tool()
        for key, entry in self.manifest["platforms"].items():
            self.assertEqual(tool.tree_digest(os.path.join(VENDOR, key)), entry["tree_sha256"], key)

    def test_wheel_pins_in_tool_match_manifest(self):
        tool = _tool()
        for key, (name, sha, _source) in tool.PLATFORMS.items():
            self.assertEqual(self.manifest["platforms"][key]["wheel"], name)
            self.assertEqual(self.manifest["platforms"][key]["wheel_sha256"], sha)

    def test_license_texts_shipped(self):
        for name in ("LICENSE.rst", "AUTHORS.rst"):
            self.assertTrue(os.path.getsize(os.path.join(VENDOR, name)) > 100, name)

    def test_each_platform_has_compiled_aes_and_no_tests(self):
        for key in EXPECTED_PLATFORMS:
            root = os.path.join(VENDOR, key, "Cryptodome")
            self.assertFalse(os.path.exists(os.path.join(root, "SelfTest")), key)
            aes = [f for f in os.listdir(os.path.join(root, "Cipher")) if f.startswith("_raw_aes.")]
            self.assertTrue(aes, key)
            self.assertTrue(any(f.endswith((".so", ".pyd")) for f in aes), key)


class VendoredCryptodomeWorks(unittest.TestCase):
    def test_forced_fallback_uses_vendored_copy_and_passes_vectors(self):
        key = vendor_loader.platform_key()
        if not os.path.isdir(os.path.join(VENDOR, key, "Cryptodome")):
            self.skipTest("no vendored Cryptodome for %s" % key)
        proc = _run([CHECK, LIB, VECTORS], {"SB_FORCE_CRYPTODOME": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(report["ok"])
        self.assertEqual(report["backend"], "Cryptodome")
        self.assertEqual(report["loader"]["source"], "vendored")
        self.assertEqual(report["cryptodome_version"], "3.24.2")
        self.assertIn("vendored Cryptodome imported OK", proc.stderr)

    def test_force_file_in_data_dir_skips_libcrypto(self):
        key = vendor_loader.platform_key()
        if not os.path.isdir(os.path.join(VENDOR, key, "Cryptodome")):
            self.skipTest("no vendored Cryptodome for %s" % key)
        with tempfile.TemporaryDirectory() as data:
            open(os.path.join(data, "force_cryptodome"), "w").close()
            code = ("import sys; sys.path.insert(0, %r); import crypto, vendor_loader;"
                    "print(crypto.backend_name(), vendor_loader.last_status()['source'])" % LIB)
            proc = _run(["-c", code], {"SB_DATA_DIR": data})
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout.split(), ["Cryptodome", "vendored"])

    def test_without_force_system_libcrypto_wins_when_present(self):
        code = ("import sys; sys.path.insert(0, %r); import crypto; print(crypto.backend_name())" % LIB)
        with tempfile.TemporaryDirectory() as data:
            proc = _run(["-c", code], {"SB_DATA_DIR": data})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(proc.stdout.strip(), ("libcrypto", "Cryptodome"))


class PrepareContract(unittest.TestCase):
    def test_force_requested_env_and_file(self):
        saved = os.environ.pop(vendor_loader.FORCE_ENV, None)
        try:
            with tempfile.TemporaryDirectory() as data:
                self.assertFalse(vendor_loader.force_requested(data))
                open(os.path.join(data, vendor_loader.FORCE_FILE), "w").close()
                self.assertTrue(vendor_loader.force_requested(data))
            with tempfile.TemporaryDirectory() as data:
                for value, expected in (("1", True), ("true", True), ("0", False), ("", False)):
                    os.environ[vendor_loader.FORCE_ENV] = value
                    self.assertEqual(vendor_loader.force_requested(data), expected, value)
        finally:
            os.environ.pop(vendor_loader.FORCE_ENV, None)
            if saved is not None:
                os.environ[vendor_loader.FORCE_ENV] = saved

    def test_prepare_never_raises_and_reports_missing_platform(self):
        code = ("import sys; sys.path.insert(0, %r); import vendor_loader;"
                "s = vendor_loader.prepare(vendor_dir='/nonexistent', key='plan9-m68k');"
                "print(s['ok'], s['source'], bool(s['error']), '/nonexistent' in ''.join(sys.path))" % LIB)
        proc = _run(["-c", code])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.split(), ["False", "none", "True", "False"])
        self.assertIn("no vendored Cryptodome for platform plan9-m68k", proc.stderr)

    def test_system_cryptodome_is_preferred_over_vendored(self):
        with tempfile.TemporaryDirectory() as site:
            pkg = os.path.join(site, "Cryptodome", "Cipher")
            os.makedirs(pkg)
            for path in (os.path.join(site, "Cryptodome", "__init__.py"), os.path.join(pkg, "__init__.py"),
                         os.path.join(pkg, "AES.py")):
                open(path, "w").close()
            code = ("import sys; sys.path.insert(0, %r); sys.path.insert(0, %r); import vendor_loader;"
                    "s = vendor_loader.prepare(); print(s['source'], any('vendor' in p and 'Cryptodome' not in p and p.endswith(s['platform']) for p in sys.path))"
                    % (LIB, site))
            proc = _run(["-c", code])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.split(), ["system", "False"])


if __name__ == "__main__":
    unittest.main()
