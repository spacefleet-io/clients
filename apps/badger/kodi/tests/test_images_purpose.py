"""STOR-BW-09: artwork is library data: it opens a `library` session, so it keeps flowing while the silo is saturated
(an `export` session gets zero bytes there, a `playback` session is refused for a free user)."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _path  # noqa: E402,F401
import images


class FakeApi:
    def __init__(self):
        self.downloads = []

    def download(self, key, purpose="playback"):
        self.downloads.append((key, purpose))
        return b"payload"


class FakeCtx:
    def __init__(self):
        self.api = FakeApi()
        self.key = "key"


class ArtworkPurposeTest(unittest.TestCase):
    def test_asset_artwork_downloads_with_purpose_library(self):
        ctx = FakeCtx()
        with mock.patch.object(images, "cached_path", return_value=None), \
                mock.patch.object(images.crypto, "envelope_decrypt_b64", return_value=b"png"), \
                mock.patch.object(images, "_store", return_value="/art/x.png"):
            path = images.fetch(ctx, "poster", "asset:image/png::library/assets/poster-1")
        self.assertEqual(path, "/art/x.png")
        self.assertEqual(ctx.api.downloads, [("library/assets/poster-1", "library")])


if __name__ == "__main__":
    unittest.main()
