"""@req META-ART-01 @req META-ART-02 Kodi shows artwork from the user's vault only.

@test-id kodi-art-vault-only
@level unit

Why: Chris 2026-11-16: pictures are fetched from the metadata service at import and refresh, stored in the user's
vault, and every app pulls them from there; display reads a local decrypted cache first, the vault on a miss, and the
metadata service never while browsing. The cache is bounded by bytes, kept across restarts and cleared on sign-out.
Before this, every Kodi listing (and the library export) asked the metadata service for each provider path (`image`
op, one ticket each): the "Slow responses" alert on the service.

Runs against a throw-away data dir (SB_DATA_DIR); no Kodi, no network."""
import glob
import os
import tempfile
import unittest

import _dev_signer as dev
import _path  # noqa: F401
import crypto
import images

KEY = bytes(range(32))
PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 24
LIB = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin.video.spacebadger"))


class NoMetadata(object):
    """The metadata service: any use while showing artwork is the bug."""

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        self.calls.append(name)
        raise AssertionError("artwork display must not use the metadata service: %s" % name)


class Vault(object):
    """The user's storage: encrypted objects stored like the desktop does (base64 text of a library envelope)."""

    def __init__(self):
        self.objects = {}
        self.downloads = []

    def put(self, key, data):
        self.objects[key] = crypto.envelope_encrypt_b64(KEY, data).encode("utf-8")

    def download(self, key, purpose="playback"):
        self.downloads.append((key, purpose))
        return self.objects[key]


class Ctx(object):
    def __init__(self):
        self.metadata = NoMetadata()
        self.api = Vault()
        self.key = KEY


class VaultArtwork(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        old = os.environ.get("SB_DATA_DIR")
        os.environ["SB_DATA_DIR"] = self.tmp.name
        self.addCleanup(lambda: os.environ.__setitem__("SB_DATA_DIR", old) if old is not None else os.environ.pop("SB_DATA_DIR", None))
        self.ctx = Ctx()

    def test_a_provider_path_shows_no_picture_and_is_never_looked_up(self):
        dev.phase("kodi-art", "pending: provider paths are placeholders")
        self.assertIsNone(images.fetch(self.ctx, "poster", "/abc.jpg"))
        self.assertIsNone(images.fetch(self.ctx, "still", "/still.jpg"))
        self.assertIsNone(images.fetch(self.ctx, "poster", "https://example.test/x.jpg"))
        self.ctx.api.put("assets/one.txt", PNG)
        wanted = [("poster", "/p.jpg"), ("backdrop", "/b.jpg"), ("poster", "asset:image/png::assets/one.txt")]
        out = images.fetch_many(self.ctx, wanted)
        dev.phase("kodi-art", "seen metadata=%d downloads=%d" % (len(self.ctx.metadata.calls), len(self.ctx.api.downloads)))
        self.assertIsNone(out[("poster", "/p.jpg")])
        self.assertIsNone(out[("backdrop", "/b.jpg")])
        with open(out[("poster", "asset:image/png::assets/one.txt")], "rb") as fh:
            self.assertEqual(fh.read(), PNG)
        self.assertEqual(self.ctx.metadata.calls, [])
        self.assertEqual(self.ctx.api.downloads, [("assets/one.txt", "library")])

    def test_the_vault_copy_is_decrypted_once_and_kept_across_a_restart(self):
        dev.phase("kodi-art", "vault: cache first, storage on a miss")
        self.ctx.api.put("assets/one.txt", PNG)
        ref = "asset:image/png::assets/one.txt"
        first = images.fetch(self.ctx, "poster", ref)
        self.assertEqual(images.fetch(self.ctx, "backdrop", ref), first)  # the same picture, whatever slot shows it
        dev.phase("kodi-art", "restart: a new context over the same data dir")
        restarted = Ctx()
        self.assertEqual(images.fetch(restarted, "poster", ref), first)
        self.assertEqual(images.cached_path(ref), first)
        self.assertEqual(len(self.ctx.api.downloads), 1)
        self.assertEqual(restarted.api.downloads, [])

    def test_first_listing_survives_its_workers_creating_the_art_dir_together(self):
        """@bugfix @regression-proof Hand try 2026-11-16 (Kodi 21, lane vaht): the first export after sign-in failed
        with `[Errno 17] File exists: .../art`: fetch_many's workers each saw no art dir and each created it, and the
        losers' FileExistsError ended the export. Replayed here as the losing worker: the dir appears between the check
        and the create."""
        dev.phase("kodi-art", "race: another worker created the art dir after this one checked")
        self.ctx.api.put("assets/one.txt", PNG)
        os.makedirs(os.path.join(self.tmp.name, "art"))
        real_isdir = images.os.path.isdir
        stale = [True]  # the one check this worker made, before the winner created the dir

        def isdir(path):
            if stale and path.endswith(os.sep + "art"):
                stale.pop()
                return False
            return real_isdir(path)

        images.os.path.isdir = isdir
        self.addCleanup(setattr, images.os.path, "isdir", real_isdir)
        out = images.fetch_many(self.ctx, [("poster", "asset:image/png::assets/one.txt")])
        with open(out[("poster", "asset:image/png::assets/one.txt")], "rb") as fh:
            self.assertEqual(fh.read(), PNG)

    def test_the_cache_is_bounded_by_bytes_least_recently_shown_first(self):
        dev.phase("kodi-art", "bound: three 400 KiB pictures under a 1 MiB cap")
        old_cap = images.ART_CACHE_BYTES
        images.ART_CACHE_BYTES = 1024 * 1024
        self.addCleanup(setattr, images, "ART_CACHE_BYTES", old_cap)
        for name in ("a", "b", "c"):
            self.ctx.api.put("assets/%s.txt" % name, PNG + name.encode() * (400 * 1024))
        ref = lambda name: "asset:image/png::assets/%s.txt" % name  # noqa: E731
        path_a = images.fetch(self.ctx, "poster", ref("a"))
        path_b = images.fetch(self.ctx, "poster", ref("b"))
        os.utime(path_a, (100, 100))
        os.utime(path_b, (200, 200))
        dev.phase("kodi-art", "a shown again: b is now the least recently shown")
        self.assertEqual(images.fetch(self.ctx, "poster", ref("a")), path_a)
        images.fetch(self.ctx, "poster", ref("c"))
        total = sum(os.path.getsize(p) for p in glob.glob(os.path.join(images.art_dir(), "*")))
        dev.phase("kodi-art", "cache bytes=%d" % total)
        self.assertLessEqual(total, 1024 * 1024)
        self.assertTrue(os.path.exists(path_a))
        self.assertFalse(os.path.exists(path_b))
        self.assertEqual([k for k, _ in self.ctx.api.downloads], ["assets/a.txt", "assets/b.txt", "assets/c.txt"])

    def test_sign_out_removes_the_decrypted_cache(self):
        dev.phase("kodi-art", "sign-out wipes the cache")
        import core
        self.ctx.api.put("assets/one.txt", PNG)
        path = images.fetch(self.ctx, "poster", "asset:image/png::assets/one.txt")
        self.assertTrue(os.path.exists(path))
        core.wipe_everything("test")
        self.assertFalse(os.path.exists(path))

    def test_export_counts_only_vault_pictures_as_pending(self):
        dev.phase("kodi-art", "export: a provider path is not retried every sync, a failed vault download is")
        import export
        self.assertEqual(export.pending_art([("poster", "/p.jpg"), ("poster", "asset:image/png::assets/x.txt"), ("still", None)], {}), 1)
        self.assertEqual(export.pending_art([("poster", "asset:image/png::assets/x.txt")], {("poster", "asset:image/png::assets/x.txt"): "/art/x.png"}), 0)

    def test_no_add_on_module_asks_the_metadata_service_for_a_picture(self):
        dev.phase("kodi-art", "source scan: no image lookup left in the add-on")
        offenders = []
        for path in glob.glob(os.path.join(LIB, "**", "*.py"), recursive=True):
            if "vendor" in path.split(os.sep):
                continue
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            if "image_url" in text or '"op": "image"' in text or "'op': 'image'" in text:
                offenders.append(os.path.relpath(path, LIB))
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
