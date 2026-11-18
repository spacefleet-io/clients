"""MPV-PREV-02 (no @req tag: badger-kodi is not in that rule's applies): deleting a whole video from Kodi releases
its seek-bar preview sheets with its other objects, like the desktop's LibraryDb delete walk.

LibraryStore.collect_storage_keys(media_id) lists every storage key the media owns; it must include each
`sheets[].objectKey` of its formats' `preview_sheets`, and still work on a library that predates the column.
Each test prints phase markers prefixed with its id.
"""
import json
import shutil
import sqlite3
import tempfile
import unittest

import _path  # noqa: F401
import library

TEST_ID = "KODI-COLLECT-STORAGE-KEYS-001"


def phase(msg, *args):
    print("[%s] %s" % (TEST_ID, msg % args if args else msg))


PREVIEWS = {
    "version": 1, "intervalSeconds": 5, "pictureWidth": 160, "pictureHeight": 90, "columns": 10, "rows": 10,
    "pictureCount": 101,
    "sheets": [
        {"objectKey": "media/p/previews/sheet-000", "sizeBytes": 61000, "firstPicture": 0, "pictureCount": 100},
        {"objectKey": "media/p/previews/sheet-001", "sizeBytes": 900, "firstPicture": 100, "pictureCount": 1},
    ],
}


def schema(with_previews):
    return (
        "CREATE TABLE media_formats (id TEXT PRIMARY KEY, media_id TEXT, init_key TEXT%s)"
        % (", preview_sheets TEXT" if with_previews else ""),
        "CREATE TABLE media_format_chunks (id TEXT PRIMARY KEY, format_id TEXT, chunk_key TEXT)",
        "CREATE TABLE media_audio_tracks (id TEXT PRIMARY KEY, media_id TEXT, init_key TEXT)",
        "CREATE TABLE media_audio_chunks (id TEXT PRIMARY KEY, track_id TEXT, chunk_key TEXT)",
        "CREATE TABLE media_subtitles (id TEXT PRIMARY KEY, media_id TEXT, object_key TEXT)",
    )


class CollectStorageKeysTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="sb-collect-keys-")
        self.store = library.LibraryStore(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def build(self, with_previews):
        conn = sqlite3.connect(self.store.db_path)
        for sql in schema(with_previews):
            conn.execute(sql)
        if with_previews:
            conn.execute("INSERT INTO media_formats VALUES ('src', 'm1', 'media/p/v/init', ?)", (json.dumps(PREVIEWS),))
            conn.execute("INSERT INTO media_formats VALUES ('low', 'm1', 'media/p/f/init', NULL)")
            conn.execute("INSERT INTO media_formats VALUES ('bad', 'm1', 'media/p/b/init', 'not json')")
            conn.execute("INSERT INTO media_formats VALUES ('other', 'm2', 'media/q/v/init', ?)",
                         (json.dumps({"sheets": [{"objectKey": "media/q/previews/sheet-000"}]}),))
        else:
            conn.execute("INSERT INTO media_formats VALUES ('src', 'm1', 'media/p/v/init')")
        conn.execute("INSERT INTO media_format_chunks VALUES ('c1', 'src', 'media/p/v/c0')")
        conn.commit()
        conn.close()

    def test_a_whole_video_delete_lists_its_preview_sheets(self):
        self.build(with_previews=True)
        keys = self.store.collect_storage_keys("m1")
        phase("keys=%s", keys)
        self.assertIn("media/p/previews/sheet-000", keys)
        self.assertIn("media/p/previews/sheet-001", keys)
        self.assertIn("media/p/v/init", keys)
        self.assertIn("media/p/v/c0", keys)
        self.assertNotIn("media/q/previews/sheet-000", keys)
        self.assertEqual(len(keys), len(set(keys)))

    def test_a_library_without_the_preview_column_still_lists_the_rest(self):
        self.build(with_previews=False)
        keys = self.store.collect_storage_keys("m1")
        phase("legacy keys=%s", keys)
        self.assertEqual(sorted(keys), ["media/p/v/c0", "media/p/v/init"])


if __name__ == "__main__":
    unittest.main()
