# -*- coding: utf-8 -*-
"""Local copy of the Badger library: snapshot + ops into ONE SQLite file in the addon data dir.

Process model: the service (sync, player monitor) and short-lived plugin invocations (browse, play,
delete) all open this file. SQLite is the cross-process lock: every mutation runs inside
``BEGIN IMMEDIATE`` with a long busy timeout. Sync state (version, snapshot id, state hash, last op id)
lives in the table ``sb_state`` of the same file so it is always consistent with the content.
"""
import base64
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import unicodedata
import uuid

import crypto
import payload_codec
import profiles
import tracks
from api import ApiError, UnauthorizedError, next_state_hash
from compat import data_dir, log
from ops_sql import CATALOG_ID_SOURCES_SQL, UnknownOpTypeError, build_op_statements

DB_NAME = "library.sqlite"
PENDING_NAME = "pending_ops.json"
STORAGE_HEADER = b"\x00SBL"
STORAGE_HEADER_SIZE = 8
EPISODE_RESUME_PREFIX = "episode_resume_v1:"
# ACCT-PROF-03: the profile's settings row (`packages/shared/src/profileSettings.ts`) holds its `titleLanguage`, and
# each title's original-language set lives in a synced `title_variants_v1:<media id>` row
# (`packages/shared/src/titleLanguage.ts`), written by the apps' background pass; Kodi only reads them.
PROFILE_SETTINGS_KEY = "profile_settings_v1"
TITLE_VARIANTS_KEY_PREFIX = "title_variants_v1:"
# A catalog picture path still waiting for its copy into the user's storage (META-ART-01).
_CATALOG_PICTURE = re.compile(r"^/[^/]")


def profile_title_language(raw):
    """profileTitleLanguage: "original" when the settings row says so, else "app" (unset, blank, malformed)."""
    if not raw:
        return "app"
    try:
        record = json.loads(raw)
    except ValueError:
        return "app"
    if not isinstance(record, dict) or not isinstance(record.get("updatedAt"), str) or not record["updatedAt"]:
        return "app"
    return "original" if record.get("titleLanguage") == "original" else "app"


def _text(value):
    return value if isinstance(value, str) and value.strip() else None


def parse_title_variants(raw):
    """parseTitleVariants: {rowLanguage, rowTitle, original: {language, title, posterPath, backdropPath} or None}
    or None for a missing, deleted (""), unreadable or newer-version value."""
    if not raw:
        return None
    try:
        record = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(record, dict) or record.get("v") != 1 or not _text(record.get("rowLanguage")) \
            or not isinstance(record.get("rowTitle"), str):
        return None
    original = record.get("original") if isinstance(record.get("original"), dict) else None
    if original is not None and _text(original.get("language")) and _text(original.get("title")):
        original = {"language": original["language"], "title": original["title"],
                    "posterPath": _text(original.get("posterPath")), "backdropPath": _text(original.get("backdropPath"))}
    else:
        original = None
    return {"rowLanguage": record["rowLanguage"], "rowTitle": record["rowTitle"], "original": original}


def _copied_picture(path):
    return bool(path) and not _CATALOG_PICTURE.match(path)


def is_latin_script_text(text):
    """isLatinScriptText: every letter of `text` is a Latin letter (digits, spaces and punctuation are ignored)."""
    return all(not char.isalpha() or "LATIN" in unicodedata.name(char, "") for char in text)


def apply_title_variants(row, variants):
    """shownTitleArt for "Original version": the original title, and its pictures once copied (else the row's own).
    An original set whose title is not in Latin letters is never shown, whichever app wrote it."""
    original = variants.get("original") if variants else None
    if not original or not is_latin_script_text(original["title"]):
        return row
    row["title"] = original["title"]
    if _copied_picture(original["posterPath"]):
        row["poster_path"] = original["posterPath"]
    if _copied_picture(original["backdropPath"]):
        row["backdrop_path"] = original["backdropPath"]
    return row


class KeyMismatchError(Exception):
    """The configured library key does not decrypt meta.keyProbe."""


def now_iso():
    t = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % int((t % 1) * 1000)


def _strip_storage_header(raw):
    """The stored chunk without its v1 header, as a view (no copy)."""
    start = STORAGE_HEADER_SIZE if len(raw) >= STORAGE_HEADER_SIZE and raw[:4] == STORAGE_HEADER else 0
    return memoryview(raw)[start:]


def decode_envelope_bytes(key, raw):
    """Stored library objects are either v1 (8-byte header + raw envelope) or v0 (base64 text of the envelope)."""
    raw = bytes(raw)
    if raw[:4] == STORAGE_HEADER:
        return crypto.envelope_decrypt(key, raw[STORAGE_HEADER_SIZE:])
    try:
        return crypto.envelope_decrypt(key, raw)
    except crypto.CryptoError:
        # v0: base64 text
        return crypto.envelope_decrypt(key, base64.b64decode(raw.strip()))


class LibraryStore(object):
    def __init__(self, directory=None, prefix=""):
        self.dir = directory or data_dir()
        self.db_path = os.path.join(self.dir, DB_NAME)
        self.pending_path = os.path.join(self.dir, PENDING_NAME)
        self._tls = threading.local()
        # Viewing data of the followed profile (INTG-PROF-01): "" = the main profile's own storage, else "p:<pid>:".
        self.prefix = prefix or ""
        # INTG-PROF-01: True while no profile is followed (deleted elsewhere, or not yet picked): viewing writes are dropped.
        self.viewing_paused = False

    # ------------------------------------------------------------------ connections
    def conn(self):
        c = getattr(self._tls, "conn", None)
        if c is not None and getattr(self._tls, "path_inode", None) == self._inode():
            return c
        if c is not None:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
        c = sqlite3.connect(self.db_path, timeout=30, isolation_level=None, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA busy_timeout = 30000")
        c.execute("CREATE TABLE IF NOT EXISTS sb_state (key TEXT PRIMARY KEY, value TEXT)")
        try:
            os.chmod(self.db_path, 0o600)  # decrypted library content: keep private
        except OSError:
            pass
        self._tls.conn = c
        self._tls.path_inode = self._inode()
        return c

    def _inode(self):
        try:
            return os.stat(self.db_path).st_ino
        except OSError:
            return None

    def close(self):
        c = getattr(self._tls, "conn", None)
        if c is not None:
            c.close()
            self._tls.conn = None

    def exists(self):
        return os.path.exists(self.db_path)

    # ------------------------------------------------------------------ state
    def state(self):
        if not self.exists():
            return {}
        rows = self.conn().execute("SELECT key, value FROM sb_state").fetchall()
        out = {}
        for r in rows:
            try:
                out[r["key"]] = json.loads(r["value"])
            except (TypeError, ValueError):
                out[r["key"]] = r["value"]
        return out

    def _set_state(self, c, **kwargs):
        for k, v in kwargs.items():
            c.execute("INSERT OR REPLACE INTO sb_state (key, value) VALUES (?, ?)", (k, json.dumps(v)))

    def version(self):
        return int(self.state().get("version") or 0)

    def wipe(self):
        """ACCT-DEV-01: remove cached library, pending ops."""
        self.close()
        for name in (DB_NAME, DB_NAME + "-journal", DB_NAME + "-wal", DB_NAME + "-shm", PENDING_NAME):
            path = os.path.join(self.dir, name)
            if os.path.exists(path):
                os.remove(path)
        log("library cache wiped")

    # ------------------------------------------------------------------ snapshot
    def _download_snapshot(self, api, key, meta):
        manifest_key = meta.get("manifestKey")
        if not manifest_key:
            raise ApiError(404, {"error": "no_manifest"}, "library has no snapshot manifest")
        raw = api.download(manifest_key, "library")
        manifest = json.loads(decode_envelope_bytes(key, raw).decode("utf-8"))
        # INTG-KODI-05: the chunks go straight into one buffer, decrypt reads it in place and the inflate reads the
        # plaintext in place: at most the stored snapshot + its plaintext (+ the inflated file) live at once.
        blob = bytearray()
        for chunk in sorted(manifest.get("chunks", []), key=lambda c: c["index"]):
            data = api.download("library/chunks/%s" % chunk["hash"], "library")
            if hashlib.sha256(data).hexdigest() != chunk["hash"]:
                # chunk hashes are over the stored bytes (encrypted); a mismatch means corruption in transit
                log("snapshot chunk %s hash mismatch (continuing; GCM will authenticate)" % chunk["hash"], "warning")
            blob += _strip_storage_header(data)
            data = None
        plain = crypto.envelope_decrypt_view(key, blob)
        blob = None
        db_bytes = payload_codec.decode_payload(plain)
        plain = None
        expected = manifest.get("dbHash")
        if expected and hashlib.sha256(db_bytes).hexdigest() != expected:
            raise ApiError(502, {"error": "snapshot_hash_mismatch"}, "snapshot dbHash mismatch")
        log("snapshot %s downloaded: %d chunk(s), %d bytes" % (manifest.get("snapshotId"), len(manifest.get("chunks", [])), len(db_bytes)))
        return manifest, db_bytes

    def _install_snapshot(self, db_bytes, meta, manifest):
        self.close()
        tmp = self.db_path + ".new"
        with open(tmp, "wb") as fh:
            fh.write(db_bytes)
        for suffix in ("-journal", "-wal", "-shm"):
            if os.path.exists(self.db_path + suffix):
                os.remove(self.db_path + suffix)
        os.replace(tmp, self.db_path)
        c = self.conn()
        c.execute("BEGIN IMMEDIATE")
        self._set_state(
            c,
            version=int(meta.get("snapshotVersion") or 0),
            snapshotVersion=int(meta.get("snapshotVersion") or 0),
            snapshotId=manifest.get("snapshotId") or meta.get("snapshotId"),
            stateHash=None,
            lastOpId=None,
        )
        c.execute("COMMIT")

    # ------------------------------------------------------------------ sync
    def verify_key(self, key, meta):
        probe = meta.get("keyProbe")
        if not probe:
            return
        try:
            crypto.envelope_decrypt_b64(key, probe)
        except crypto.CryptoError as exc:
            raise KeyMismatchError("library key does not match this account's key probe") from exc

    def sync(self, api, key):
        """Bring the local library up to date. Returns a dict describing what happened."""
        meta = api.library_meta()
        if not meta.get("exists") or meta.get("bootstrapRequired"):
            log("library does not exist on the server yet (bootstrapRequired=%s)" % meta.get("bootstrapRequired"))
            return {"changed": False, "empty": True, "meta": meta}
        self.verify_key(key, meta)
        changed = False
        st = self.state()
        remote_snapshot_id = meta.get("snapshotId")
        # LIB-SYNC-06: the full snapshot is the fallback for "ops too old" (or no local copy), never for
        # "another device published a snapshot" and never for an empty op list.
        reload_snapshot = not self.exists()
        ops_resp = None
        if not reload_snapshot:
            ops_resp = self._fetch_ops(api, int(st.get("version") or 0))
            if ops_resp.get("tooOld"):
                reload_snapshot = True
        if reload_snapshot:
            manifest, db_bytes = self._download_snapshot(api, key, meta)
            self._install_snapshot(db_bytes, meta, manifest)
            db_bytes = None  # the file is written: do not hold the snapshot through the op replay
            changed = True
            ops_resp = self._fetch_ops(api, int(meta.get("snapshotVersion") or 0))
        applied = self._apply_remote_ops(api, key, ops_resp or {})
        changed = changed or applied > 0
        c = self.conn()
        c.execute("BEGIN IMMEDIATE")
        cur_version = int(self.state().get("version") or 0)
        remote_version = int(meta.get("version") or 0)
        if not reload_snapshot and not applied and cur_version < remote_version and not self._load_pending():
            # empty, non-tooOld op list: the server has nothing newer for us; adopt its version, no snapshot
            self._set_state(c, version=remote_version)
            cur_version = remote_version
        if cur_version >= remote_version:
            self._set_state(c, stateHash=meta.get("stateHash"), lastOpId=meta.get("lastOpId"))
        if not reload_snapshot:
            # another device's snapshot is not a reason to re-download: just track which one is current
            self._set_state(c, snapshotId=remote_snapshot_id, snapshotVersion=int(meta.get("snapshotVersion") or 0))
        self._set_state(c, lastSyncAt=now_iso())
        c.execute("COMMIT")
        self.flush_pending(api, key)
        log("sync done: version=%s snapshot=%s applied_ops=%d reload=%s" % (self.version(), remote_snapshot_id, applied, reload_snapshot))
        return {"changed": changed, "applied": applied, "reloaded": reload_snapshot, "meta": meta}

    def _fetch_ops(self, api, since):
        """Every op newer than `since`, as one response.

        The server pages a long tail (`hasMore`): `version` of a partial page is its last op and the next page
        starts there. A page that turns `tooOld` is returned as is so the caller falls back to the snapshot."""
        resp = api.library_ops(since)
        if resp.get("tooOld"):
            return resp
        entries = list(resp.get("ops") or [])
        while resp.get("hasMore") and resp.get("ops"):
            resp = api.library_ops(int(resp.get("version") or 0))
            if resp.get("tooOld"):
                return resp
            entries.extend(resp.get("ops") or [])
        merged = dict(resp)
        merged["ops"] = entries
        return merged

    def _op_bytes(self, api, entry):
        inline = entry.get("payloadCiphertext")
        if inline:
            return base64.b64decode(inline)
        return api.download(entry["objectKey"], "library")

    def _apply_remote_ops(self, api, key, ops_resp):
        entries = sorted(ops_resp.get("ops") or [], key=lambda e: int(e.get("version") or 0))
        if not entries:
            return 0
        decoded = []
        cur = self.version()
        for entry in entries:
            if int(entry.get("version") or 0) <= cur:
                continue
            raw = self._op_bytes(api, entry)
            try:
                op = json.loads(payload_codec.decode_payload(decode_envelope_bytes(key, raw)).decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                log("op %s could not be decrypted/parsed: %s" % (entry.get("opId"), exc), "error")
                raise
            decoded.append((entry, op))
        if not decoded:
            return 0
        c = self.conn()
        c.execute("BEGIN IMMEDIATE")
        applied = 0
        try:
            cur = int(self.state().get("version") or 0)
            for entry, op in decoded:
                version = int(entry.get("version") or 0)
                if version <= cur:
                    continue
                self._apply_op(c, op)
                cur = version
                applied += 1
                # The op list carries no state hash: forget ours so the next upload lets the server derive it.
                self._set_state(c, version=cur, lastOpId=entry.get("opId"), stateHash=None)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        return applied

    def _apply_op(self, c, op):
        try:
            statements = build_op_statements(op, lambda: str(uuid.uuid4()))
        except UnknownOpTypeError as exc:
            log("op %s: unknown type %s: skipped" % (op.get("id"), exc), "warning")
            return
        if op.get("type") == "media.upsert":
            # The core row is guarded by its updated_at (LIB-SYNC-08) but the metadata/playback tables are not:
            # an upsert older than the stored row must not rewrite formats, files or episodes either.
            details = (op.get("payload") or {}).get("details") or {}
            row = c.execute("SELECT updated_at FROM media_items WHERE id = ?", [details.get("id")]).fetchone()
            if row is not None and row["updated_at"] is not None and row["updated_at"] > (details.get("updatedAt") or ""):
                log("op %s: media.upsert of %s is older than the stored row: ignored" % (op.get("id"), details.get("id")), "debug")
                return
            # PLAY-TRACK-05: a snapshot from before OCR twins lacks the column the subtitle insert now writes.
            sub_cols = [r[1] for r in c.execute("PRAGMA table_info(media_subtitles)").fetchall()]
            if sub_cols and "derived_from_subtitle_id" not in sub_cols:
                c.execute("ALTER TABLE media_subtitles ADD COLUMN derived_from_subtitle_id TEXT")
                log("op %s: media_subtitles.derived_from_subtitle_id added" % op.get("id"), "info")
            # MPV-PREV-01: a snapshot from before seek-bar previews lacks the column the format insert now writes.
            fmt_cols = [r[1] for r in c.execute("PRAGMA table_info(media_formats)").fetchall()]
            if fmt_cols and "preview_sheets" not in fmt_cols:
                c.execute("ALTER TABLE media_formats ADD COLUMN preview_sheets TEXT")
                log("op %s: media_formats.preview_sheets added" % op.get("id"), "info")
        for sql, params in statements:
            try:
                c.execute(sql, params)
            except sqlite3.OperationalError as exc:
                # ingest/template groups may be absent from older snapshots: only tolerate missing tables there
                if "no such table" in str(exc):
                    log("op %s (%s): %s: statement skipped" % (op.get("id"), op.get("type"), exc), "warning")
                    continue
                raise

    # ------------------------------------------------------------------ local ops (writes)
    def _load_pending(self):
        if os.path.exists(self.pending_path):
            try:
                with open(self.pending_path) as fh:
                    return json.load(fh)
            except (OSError, ValueError):
                return []
        return []

    def _save_pending(self, ops):
        tmp = self.pending_path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(ops, fh)
        os.replace(tmp, self.pending_path)

    def write_op(self, api, key, op_type, payload):
        """Apply an op locally, then upload it (encrypted). Offline/failed uploads are queued and retried on sync.

        Returns True when the server accepted it, False when it was queued."""
        op = {"id": str(uuid.uuid4()), "type": op_type, "createdAt": now_iso(), "payload": payload}
        c = self.conn()
        c.execute("BEGIN IMMEDIATE")
        try:
            self._apply_op(c, op)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        pending = self._load_pending()
        pending.append(op)
        self._save_pending(pending)
        return self.flush_pending(api, key)

    # Answers that mean "your base is behind the server's head": re-read meta, catch up, retry once.
    _BASE_MISMATCH = (("version_conflict", 409), ("lineage_conflict", 409), ("invalid_state_hash", 400))

    def flush_pending(self, api, key):
        """Upload queued ops in order (LIB-STORE-05, #663).

        Each op is based on the locally stored version and state hash, so a write costs one POST and no
        GET /library/db/meta. Meta is read only when the server answers a base mismatch; the store then
        catches up on the ops it missed and retries that op once. Anything else leaves the op queued."""
        pending = self._load_pending()
        if not pending:
            return True
        remaining = list(pending)
        for op in pending:
            op_bytes = payload_codec.encode_op_payload(json.dumps(op, separators=(",", ":")).encode("utf-8"))
            encrypted = crypto.envelope_encrypt(key, op_bytes)
            for attempt in range(2):
                st = self.state()
                base = int(st.get("version") or 0)
                prev = st.get("stateHash") or None
                # No local hash (fresh snapshot install, remote ops just applied): the server derives the next
                # hash from its own head; the base version still guards against a concurrent writer.
                nxt = next_state_hash(prev, op["id"], encrypted) if prev else None
                try:
                    result = api.post_op(encrypted, op["id"], base, prev, nxt)
                except UnauthorizedError:
                    raise
                except ApiError as exc:
                    if (exc.code, exc.status) in self._BASE_MISMATCH and attempt == 0:
                        log("op %s base mismatch (%s at v%d): re-reading meta" % (op["id"], exc.code, base), "warning")
                        try:
                            self._rebase_on_server(api, key)
                        except UnauthorizedError:
                            raise
                        except Exception as rebase_exc:  # noqa: BLE001
                            log("op %s rebase failed: %s: queued" % (op["id"], rebase_exc), "warning")
                            return False
                        continue
                    log("op %s upload failed: %s: queued" % (op["id"], exc), "warning")
                    return False
                except Exception as exc:  # noqa: BLE001
                    log("op %s upload failed (network?): %s: queued" % (op["id"], exc), "warning")
                    return False
                c = self.conn()
                c.execute("BEGIN IMMEDIATE")
                self._set_state(
                    c,
                    version=int(result.get("version") or base + 1),
                    stateHash=result.get("stateHash") or nxt,
                    lastOpId=result.get("lastOpId") or op["id"],
                )
                c.execute("COMMIT")
                remaining.remove(op)
                self._save_pending(remaining)
                log("op %s (%s) uploaded: version=%s" % (op["id"], op["type"], result.get("version")))
                break
            else:
                return False
        return True

    def _rebase_on_server(self, api, key):
        """Catch up to the server head and adopt its state hash, so the retried op is based on it."""
        meta = api.library_meta()
        remote_version = int(meta.get("version") or 0)
        if remote_version > self.version():
            self._apply_remote_ops(api, key, self._fetch_ops(api, self.version()))
        if self.version() == remote_version:
            c = self.conn()
            c.execute("BEGIN IMMEDIATE")
            self._set_state(c, stateHash=meta.get("stateHash"), lastOpId=meta.get("lastOpId"))
            c.execute("COMMIT")

    # ------------------------------------------------------------------ queries
    def q(self, sql, params=()):
        return [dict(r) for r in self.conn().execute(sql, params).fetchall()]

    def q1(self, sql, params=()):
        rows = self.q(sql, params)
        return rows[0] if rows else None

    def _with_profile_progress(self, rows):
        """A non-main profile's own progress replaces the main profile's on media rows; a title it never started
        reads as not started (profileViewing.ts overlayProfileProgress)."""
        if not self.prefix or not rows:
            return rows
        key_prefix = self.prefix + profiles.MEDIA_PROGRESS_KEY_PREFIX
        own = {}
        for r in self.q("SELECT key, value FROM app_settings WHERE key >= ? AND key < ?",
                        (key_prefix, key_prefix[:-1] + ";")):
            parsed = profiles.parse_media_progress(r["value"])
            if parsed:
                own[r["key"][len(key_prefix):]] = parsed
        for row in rows:
            mine = own.get(row.get("id")) or {}
            row["progress_pct"] = mine.get("progressPct") or 0
            row["last_watched_at"] = mine.get("lastWatchedAt")
        return rows

    def title_language(self):
        """The followed profile's "How should titles appear?" answer (ACCT-PROF-03): "original" or "app" (unset)."""
        return profile_title_language(self.setting_value(self.prefix + PROFILE_SETTINGS_KEY))

    def _with_title_language(self, rows):
        """With "Original version" a title with an original set in its `title_variants_v1` row shows that title, and
        its pictures once copied into the user's storage (packages/shared/src/titleLanguage.ts shownTitleArt)."""
        if not rows or self.title_language() != "original":
            return rows
        for row in rows:
            apply_title_variants(row, parse_title_variants(self.setting_value(TITLE_VARIANTS_KEY_PREFIX + (row.get("id") or ""))))
        rows.sort(key=lambda r: (r.get("title") or "").lower())
        return rows

    def list_media(self, media_type):
        rows = self.q(
            """SELECT m.*, (SELECT external_id FROM media_external_ids e WHERE e.media_id = m.id AND e.source IN (%s) LIMIT 1) AS catalog_id
               FROM media_items m WHERE m.type = ? AND m.has_files = 1 ORDER BY m.title COLLATE NOCASE""" % CATALOG_ID_SOURCES_SQL,
            (media_type,),
        )
        return self._with_title_language(self._with_profile_progress(rows))

    def get_media(self, media_id):
        row = self.q1(
            """SELECT m.*, (SELECT external_id FROM media_external_ids e WHERE e.media_id = m.id AND e.source IN (%s) LIMIT 1) AS catalog_id
               FROM media_items m WHERE m.id = ?""" % CATALOG_ID_SOURCES_SQL,
            (media_id,),
        )
        return self._with_title_language(self._with_profile_progress([row]))[0] if row else None

    def genres(self, media_id):
        return [r["genre_id"] for r in self.q("SELECT genre_id FROM media_genres WHERE media_id = ?", (media_id,))]

    def seasons(self, media_id):
        return self.q("SELECT * FROM media_seasons WHERE media_id = ? ORDER BY season_number", (media_id,))

    def episodes(self, media_id, season=None):
        if season is None:
            return self.q("SELECT * FROM media_episodes WHERE media_id = ? ORDER BY season_number, episode_number", (media_id,))
        return self.q(
            "SELECT * FROM media_episodes WHERE media_id = ? AND season_number = ? ORDER BY episode_number", (media_id, season)
        )

    def get_episode(self, episode_id):
        return self.q1("SELECT * FROM media_episodes WHERE id = ?", (episode_id,))

    def episode_has_files(self, media_id):
        """season/episode pairs that have a media_file (playable) -> {(s, e): file_id}."""
        out = {}
        for r in self.q("SELECT id, season, episode FROM media_files WHERE media_id = ?", (media_id,)):
            if r["season"] is not None and r["episode"] is not None:
                out[(int(r["season"]), int(r["episode"]))] = r["id"]
        return out

    def playable_unit(self, media_id, episode_id=None):
        """Everything the HLS builder needs for one playable file (movie: first file; episode: matching S/E)."""
        media = self.get_media(media_id)
        if not media:
            return None
        files = self.q("SELECT * FROM media_files WHERE media_id = ? ORDER BY added_at, id", (media_id,))
        episode = None
        file_row = None
        if media["type"] == "tv" or episode_id:
            episode = self.get_episode(episode_id) if episode_id else None
            if episode:
                for f in files:
                    if f["season"] == episode["season_number"] and f["episode"] == episode["episode_number"]:
                        file_row = f
                        break
        else:
            file_row = files[0] if files else None
        if not file_row:
            return None
        formats = self.q("SELECT * FROM media_formats WHERE media_id = ? AND file_id = ? ORDER BY bitrate_kbps DESC, id", (media_id, file_row["id"]))
        for fmt in formats:
            fmt["chunks"] = self.q(
                "SELECT chunk_key, order_index, size_bytes, start_seconds FROM media_format_chunks WHERE format_id = ? ORDER BY order_index",
                (fmt["id"],),
            )
        eid = episode["id"] if episode else None
        audio = self.q(
            """SELECT * FROM media_audio_tracks WHERE media_id = ? AND (file_id = ? OR (file_id IS NULL AND (episode_id IS NULL OR episode_id = ?)))
               ORDER BY is_default DESC, created_at, id""",
            (media_id, file_row["id"], eid),
        )
        for track in audio:
            track["chunks"] = self.q(
                "SELECT chunk_key, order_index, size_bytes, start_seconds FROM media_audio_chunks WHERE track_id = ? ORDER BY order_index",
                (track["id"],),
            )
        subs = self.q(
            """SELECT * FROM media_subtitles WHERE media_id = ? AND (file_id = ? OR (file_id IS NULL AND (episode_id IS NULL OR episode_id = ?)))
               ORDER BY is_default DESC, created_at, id""",
            (media_id, file_row["id"], eid),
        )
        # OCR twins of picture subtitles (PLAY-TRACK-05) are for the Android TV only: Kodi plays the pictures.
        # `SELECT *` keeps this working on a DB without the `derived_from_subtitle_id` column.
        subs = [s for s in subs if not s.get("derived_from_subtitle_id") and s.get("source") != "ocr"]
        if eid:
            markers = self.q("SELECT * FROM media_skip_markers WHERE media_id = ? AND (episode_id = ? OR episode_id IS NULL) ORDER BY start_seconds", (media_id, eid))
        else:
            markers = self.q("SELECT * FROM media_skip_markers WHERE media_id = ? ORDER BY start_seconds", (media_id,))
        return {
            "media": media,
            "episode": episode,
            "file": file_row,
            "formats": formats,
            "audio": audio,
            "subtitles": subs,
            "markers": markers,
        }

    def media_details(self, media_id):
        """The desktop's getMediaDetails shape for one media (see details.py)."""
        import details
        return details.build_media_details(self.conn(), media_id)

    def collect_storage_keys(self, media_id):
        keys = []
        has_previews = any(r["name"] == "preview_sheets" for r in self.q("PRAGMA table_info(media_formats)"))
        for r in self.q("SELECT init_key, %s AS previews FROM media_formats WHERE media_id = ?"
                        % ("preview_sheets" if has_previews else "NULL"), (media_id,)):
            keys.append(r["init_key"])
            # Seek-bar preview sheets (MPV-PREV-02) belong to the media like its chunks.
            try:
                previews = json.loads(r["previews"]) if r["previews"] else None
            except ValueError:
                previews = None
            for sheet in (previews.get("sheets") if isinstance(previews, dict) else None) or []:
                if isinstance(sheet, dict):
                    keys.append(sheet.get("objectKey"))
        for r in self.q(
            "SELECT chunk_key FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?)", (media_id,)
        ):
            keys.append(r["chunk_key"])
        for r in self.q("SELECT init_key FROM media_audio_tracks WHERE media_id = ?", (media_id,)):
            keys.append(r["init_key"])
        for r in self.q(
            "SELECT chunk_key FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?)", (media_id,)
        ):
            keys.append(r["chunk_key"])
        for r in self.q("SELECT object_key FROM media_subtitles WHERE media_id = ?", (media_id,)):
            keys.append(r["object_key"])
        out = []
        for k in dict.fromkeys(keys):
            if not k or not isinstance(k, str):
                continue
            if k.startswith("asset:") or k.startswith("dummy_"):
                continue
            out.append(k)
        return out

    # ---- progress
    def episode_resume(self, episode_id):
        row = self.q1("SELECT value FROM app_settings WHERE key = ?", (self.prefix + EPISODE_RESUME_PREFIX + episode_id,))
        if not row or not row["value"]:
            return None
        try:
            parsed = json.loads(row["value"])
            return parsed if isinstance(parsed, dict) else None
        except ValueError:
            return None

    def all_episode_resumes(self, media_id):
        out = {}
        for ep in self.episodes(media_id):
            r = self.episode_resume(ep["id"])
            if r:
                out[ep["id"]] = r
        return out

    def write_viewing(self, api, key, op_type, payload):
        """Write one piece of the followed profile's viewing state (resume, watched, track choice). Dropped (False)
        while `viewing_paused`: with no profile followed it would land in someone else's history (INTG-PROF-01)."""
        if self.viewing_paused:
            log("viewing write dropped, no profile followed (INTG-PROF-01): %s %s" % (op_type, payload.get("key") or payload.get("mediaId")), "warning")
            return False
        return self.write_op(api, key, op_type, payload)

    def write_progress(self, api, key, media_id, progress_pct, last_watched_at, timestamp):
        """A movie's or show's progress for the followed profile: `media.progress` (main) or `setting.set` of
        `p:<pid>:media_progress_v1:<mediaId>`. True when accepted."""
        op_type, payload = profiles.progress_op(self.prefix, media_id, progress_pct, last_watched_at, timestamp)
        return self.write_viewing(api, key, op_type, payload)

    def track_prefs_key(self, media_id):
        return self.prefix + tracks.key_for(media_id)

    def setting_value(self, key):
        """One synced setting's value as stored (not profile-scoped: the caller names the whole key), or None."""
        row = self.q1("SELECT value FROM app_settings WHERE key = ?", (key,))
        return row["value"] if row else None

    def track_prefs(self, media_id):
        """The followed profile's synced track_prefs_v1 record of a movie / TV show (dict) or None (tracks.parse semantics)."""
        row = self.q1("SELECT value FROM app_settings WHERE key = ?", (self.track_prefs_key(media_id),))
        return tracks.parse(row["value"]) if row else None

    def write_track_prefs(self, api, key, media_id, audio=None, subtitle=None):
        """Read-modify-write one track_prefs_v1 record and sync it as a plain setting.set op. True when accepted."""
        stamp = now_iso()
        value = tracks.merge(self.track_prefs(media_id), audio=audio, subtitle=subtitle, updated_at=stamp)
        return self.write_viewing(api, key, "setting.set", {"key": self.track_prefs_key(media_id), "value": value, "updatedAt": stamp}), value
