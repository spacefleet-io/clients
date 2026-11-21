# -*- coding: utf-8 -*-
"""Packed chunk lists (LIB-FMT-11): Python port of packages/library-db-definition/src/chunkLists.ts.

One format's or audio track's whole list of chunks is one `media_chunk_lists` row and one JSON object in op stream 4,
instead of one row per chunk. The byte layout is the contract of `test-vectors/chunk-lists.json` (tests/test_chunk_lists.py
runs every vector):
  - `sizes`: one unsigned LEB128 varint per chunk holding `sizeBytes + 1`; 0 = unknown (None).
  - `starts`: None when no chunk has a start. Else one varint per chunk: 0 for no start, else
    `zigzag(ms - previousMs) + 1` with `ms` the start rounded to whole ms and `previousMs` the previous chunk that HAD one.
  - key mode 0: key texts joined by "\\n"; 1: 16 raw UUID bytes per chunk under `media/<placementId>/`;
    2: one 16-byte seed, key i = `media/<placementId>/` + UUID text of HMAC-SHA256(seed, "chunk:" || u32be(i))[:16].
A list that does not decode raises ChunkListFormatError: it is never skipped (LIB-OPS-01).
"""
import base64
import binascii
import hashlib
import hmac
import re
import struct

KEY_MODE_TEXTS = 0
KEY_MODE_UUID_BYTES = 1
KEY_MODE_SEED = 2
OWNER_KIND_FORMAT = 1
OWNER_KIND_AUDIO_TRACK = 2
SEED_BYTES = 16

_UUID_TEXT = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_MEDIA_KEY = re.compile(r"^media/([^/]+)/([^/]+)$")
_MAX_SAFE = 2 ** 53 - 1


class ChunkListFormatError(ValueError):
    """A stored or received chunk list that does not decode: corrupt bytes or a writer bug."""

    def __init__(self, message):
        super(ChunkListFormatError, self).__init__("CHUNK_LIST_FORMAT: %s" % message)


# ---------------------------------------------------------------------------- varints

def _push_varint(out, value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > _MAX_SAFE:
        raise ChunkListFormatError("varint out of range: %r" % (value,))
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)


def _read_varints(data, count, field):
    values = []
    offset = 0
    size = len(data)
    for i in range(count):
        value = 0
        shift = 0
        while True:
            if offset >= size:
                raise ChunkListFormatError("%s: %d of %d values, bytes ran out" % (field, i, count))
            byte = data[offset]
            offset += 1
            value |= (byte & 0x7F) << shift
            if byte < 0x80:
                break
            shift += 7
            if shift > 56:
                raise ChunkListFormatError("%s: varint %d too long" % (field, i))
        values.append(value)
    if offset != size:
        raise ChunkListFormatError("%s: %d bytes left after %d values" % (field, size - offset, count))
    return values


def _zigzag(n):
    return n * 2 if n >= 0 else -n * 2 - 1


def _unzigzag(z):
    return z // 2 if z % 2 == 0 else -(z + 1) // 2


def _js_round(x):
    """Math.round: halves round up (toward +infinity)."""
    import math
    return int(math.floor(x + 0.5))


def encode_sizes(sizes):
    out = bytearray()
    for size in sizes:
        _push_varint(out, 0 if size is None else _as_int(size) + 1)
    return bytes(out)


def decode_sizes(data, count):
    return [None if v == 0 else v - 1 for v in _read_varints(data, count, "sizes")]


def encode_starts(starts):
    if all(start is None for start in starts):
        return None
    out = bytearray()
    previous_ms = 0
    for start in starts:
        if start is None:
            out.append(0)
            continue
        if isinstance(start, bool) or not isinstance(start, (int, float)) or start != start or start in (float("inf"), float("-inf")):
            raise ChunkListFormatError("start not finite: %r" % (start,))
        ms = _js_round(start * 1000)
        _push_varint(out, _zigzag(ms - previous_ms) + 1)
        previous_ms = ms
    return bytes(out)


def decode_starts(data, count):
    if data is None:
        return [None] * count
    previous_ms = 0
    out = []
    for v in _read_varints(data, count, "starts"):
        if v == 0:
            out.append(None)
            continue
        previous_ms += _unzigzag(v - 1)
        out.append(_seconds(previous_ms))
    return out


def _seconds(ms):
    """ms / 1000 as JSON numbers carry it: a whole second stays an int (TS `previousMs / 1000`)."""
    return ms // 1000 if ms % 1000 == 0 else ms / 1000.0


def _as_int(value):
    if isinstance(value, float) and value == int(value):
        return int(value)
    return value


# ---------------------------------------------------------------------------- keys

def _uuid_text(raw):
    h = binascii.hexlify(bytes(raw)).decode("ascii")
    return "%s-%s-%s-%s-%s" % (h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])


def seed_chunk_key(seed, placement_id, index):
    """Key of chunk `index` of a key-mode-2 list."""
    if len(seed) != SEED_BYTES:
        raise ChunkListFormatError("seed must be 16 bytes, got %d" % len(seed))
    if index < 0 or index > 0xFFFFFFFF:
        raise ChunkListFormatError("chunk index out of range: %r" % (index,))
    digest = hmac.new(bytes(seed), b"chunk:" + struct.pack(">I", index), hashlib.sha256).digest()
    return "media/%s/%s" % (placement_id, _uuid_text(digest[:16]))


def chunk_list_keys(packed):
    mode, data, count, placement = packed["keyMode"], packed["keyData"], packed["count"], packed["placementId"]
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise ChunkListFormatError("bad count %r" % (count,))
    if mode == KEY_MODE_TEXTS:
        if count == 0:
            if data:
                raise ChunkListFormatError("key texts present for an empty list")
            return []
        try:
            keys = bytes(data).decode("utf-8").split("\n")
        except UnicodeDecodeError as exc:
            raise ChunkListFormatError("key texts are not UTF-8: %s" % exc)
        if len(keys) != count:
            raise ChunkListFormatError("key texts: %d keys for count %d" % (len(keys), count))
        return keys
    if mode == KEY_MODE_UUID_BYTES:
        if len(data) != count * 16:
            raise ChunkListFormatError("uuid bytes: %d bytes for count %d" % (len(data), count))
        return ["media/%s/%s" % (placement, _uuid_text(data[i * 16:i * 16 + 16])) for i in range(count)]
    if mode == KEY_MODE_SEED:
        return [seed_chunk_key(data, placement, i) for i in range(count)]
    raise ChunkListFormatError("unknown key mode %r" % (mode,))


# ---------------------------------------------------------------------------- pack / unpack

def pack_chunk_list(chunks):
    """Packs explicit keys (conversion of old rows, v3->v4 translation). `chunks`: [{key, sizeBytes, startSeconds}].
    Key mode 1 when every key is `media/<one placement>/<lowercase uuid>` (round-trips byte for byte), else mode 0."""
    sizes = encode_sizes([c.get("sizeBytes") for c in chunks])
    starts = encode_starts([c.get("startSeconds") for c in chunks])
    placements = set()
    all_uuid = len(chunks) > 0
    for chunk in chunks:
        match = _MEDIA_KEY.match(chunk["key"])
        placements.add(match.group(1) if match else "")
        if not match or not _UUID_TEXT.match(match.group(2)):
            all_uuid = False
    placement = next(iter(placements)) if len(placements) == 1 else ""
    if all_uuid and placement:
        key_data = b"".join(binascii.unhexlify(c["key"][c["key"].rfind("/") + 1:].replace("-", "")) for c in chunks)
        return {"placementId": placement, "keyMode": KEY_MODE_UUID_BYTES, "keyData": key_data, "count": len(chunks),
                "sizes": sizes, "starts": starts}
    for chunk in chunks:
        if "\n" in chunk["key"]:
            raise ChunkListFormatError("chunk key contains a line break: %r" % chunk["key"])
    return {"placementId": placement, "keyMode": KEY_MODE_TEXTS,
            "keyData": "\n".join(c["key"] for c in chunks).encode("utf-8"), "count": len(chunks),
            "sizes": sizes, "starts": starts}


def pack_seeded_chunk_list(placement_id, seed, sizes, starts):
    """Key mode 2 (what the uploader writes after the switch); the add-on only needs it for the vectors."""
    if len(seed) != SEED_BYTES:
        raise ChunkListFormatError("seed must be 16 bytes, got %d" % len(seed))
    if not placement_id or "/" in placement_id:
        raise ChunkListFormatError("bad placement id %r" % (placement_id,))
    if len(sizes) != len(starts):
        raise ChunkListFormatError("sizes (%d) and starts (%d) differ in length" % (len(sizes), len(starts)))
    return {"placementId": placement_id, "keyMode": KEY_MODE_SEED, "keyData": bytes(seed), "count": len(sizes),
            "sizes": encode_sizes(sizes), "starts": encode_starts(starts)}


def unpack_chunk_list(packed):
    """[{key, sizeBytes, startSeconds}] as MediaDetails carries `format.chunks` / `track.chunks`."""
    keys = chunk_list_keys(packed)
    sizes = decode_sizes(packed["sizes"], packed["count"])
    starts = decode_starts(packed["starts"], packed["count"])
    return [{"key": k, "sizeBytes": s, "startSeconds": t} for k, s, t in zip(keys, sizes, starts)]


# ---------------------------------------------------------------------------- JSON (op stream 4)

def _b64(data):
    return base64.b64encode(bytes(data)).decode("ascii")


def _unb64(text, field):
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ChunkListFormatError("%s is not base64: %s" % (field, exc))


def chunk_list_to_json(packed):
    return {"placementId": packed["placementId"], "keyMode": packed["keyMode"], "keyData": _b64(packed["keyData"]),
            "count": packed["count"], "sizes": _b64(packed["sizes"]),
            "starts": None if packed["starts"] is None else _b64(packed["starts"])}


def chunk_list_from_json(value):
    if not isinstance(value, dict):
        raise ChunkListFormatError("chunk list is not an object")
    if not isinstance(value.get("placementId"), str):
        raise ChunkListFormatError("placementId missing")
    mode = value.get("keyMode")
    if isinstance(mode, bool) or mode not in (KEY_MODE_TEXTS, KEY_MODE_UUID_BYTES, KEY_MODE_SEED):
        raise ChunkListFormatError("unknown key mode %r" % (mode,))
    count = _as_int(value.get("count"))
    if isinstance(count, bool) or not isinstance(count, int) or count < 0 or count > _MAX_SAFE:
        raise ChunkListFormatError("bad count %r" % (value.get("count"),))
    if not isinstance(value.get("keyData"), str) or not isinstance(value.get("sizes"), str):
        raise ChunkListFormatError("keyData/sizes must be base64 text")
    starts = value.get("starts")
    if starts is not None and not isinstance(starts, str):
        raise ChunkListFormatError("starts must be base64 text or null")
    packed = {"placementId": value["placementId"], "keyMode": mode, "keyData": _unb64(value["keyData"], "keyData"),
              "count": count, "sizes": _unb64(value["sizes"], "sizes"),
              "starts": None if starts is None else _unb64(starts, "starts")}
    if mode == KEY_MODE_SEED and len(packed["keyData"]) != SEED_BYTES:
        raise ChunkListFormatError("seed must be 16 bytes, got %d" % len(packed["keyData"]))
    return packed


# ---------------------------------------------------------------------------- SQLite (media_chunk_lists)

CHUNK_LISTS_DDL = """CREATE TABLE IF NOT EXISTS media_chunk_lists(
  owner_id     TEXT PRIMARY KEY,
  owner_kind   INTEGER NOT NULL,
  placement_id TEXT NOT NULL,
  key_mode     INTEGER NOT NULL,
  key_data     BLOB NOT NULL,
  count        INTEGER NOT NULL,
  sizes        BLOB NOT NULL,
  starts       BLOB,
  updated_at   TEXT NOT NULL
) WITHOUT ROWID"""

FILE_PLAYBACK_DDL = """CREATE TABLE IF NOT EXISTS media_file_playback(
  media_id   TEXT NOT NULL,
  file_id    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(media_id, file_id)
) WITHOUT ROWID"""

INSERT_SQL = ("INSERT OR REPLACE INTO media_chunk_lists (owner_id, owner_kind, placement_id, key_mode, key_data, count, "
              "sizes, starts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);")


def insert_params(owner_id, owner_kind, packed, updated_at):
    return [owner_id, owner_kind, packed["placementId"], packed["keyMode"], bytes(packed["keyData"]), packed["count"],
            bytes(packed["sizes"]), None if packed["starts"] is None else bytes(packed["starts"]), updated_at]


def _has_table(conn, name):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone() is not None


def _old_chunk_select(conn, table, owner_col):
    """SELECT list + ORDER BY for an old per-chunk table. Snapshots from before chunk sizes/start times (and trimmed
    test schemas) lack some columns: a missing one reads NULL, a missing order_index falls back to rowid order."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()}
    order = "order_index" if "order_index" in cols else "rowid"
    pick = [owner_col, "chunk_key", order] + [c if c in cols else "NULL" for c in ("size_bytes", "start_seconds")]
    return ", ".join(pick), "%s ASC, %s ASC" % (owner_col, order)


_OLD_TABLES = {OWNER_KIND_FORMAT: ("media_format_chunks", "format_id"), OWNER_KIND_AUDIO_TRACK: ("media_audio_chunks", "track_id")}
_IN_CHUNK = 500


def load_chunk_rows(conn, owner_kind, owner_ids):
    """{owner id: [{chunk_key, order_index, size_bytes, start_seconds}]} for formats (kind 1) or audio tracks (kind 2),
    from the packed rows (LIB-FMT-11) and the old per-chunk rows: a library holds one or the other per owner (old rows
    until its layout step, packed after), a packed row wins should both exist."""
    ids = [i for i in dict.fromkeys(owner_ids) if i is not None]
    out = {}
    if not ids:
        return out
    table, owner_col = _OLD_TABLES[owner_kind]
    packed_table = _has_table(conn, "media_chunk_lists")
    for i in range(0, len(ids), _IN_CHUNK):
        part = ids[i:i + _IN_CHUNK]
        marks = ",".join("?" * len(part))
        if _has_table(conn, table):
            select, order_by = _old_chunk_select(conn, table, owner_col)
            for owner, key, order, size, start in conn.execute(
                    "SELECT %s FROM %s WHERE %s IN (%s) ORDER BY %s" % (select, table, owner_col, marks, order_by), part).fetchall():
                out.setdefault(owner, []).append({"chunk_key": key, "order_index": order, "size_bytes": size, "start_seconds": start})
        if packed_table:
            for row in conn.execute("SELECT owner_id, placement_id, key_mode, key_data, count, sizes, starts FROM media_chunk_lists "
                                    "WHERE owner_kind = ? AND owner_id IN (%s)" % marks, [owner_kind] + part).fetchall():
                packed = {"placementId": row[1], "keyMode": row[2], "keyData": bytes(row[3]), "count": row[4],
                          "sizes": bytes(row[5]), "starts": None if row[6] is None else bytes(row[6])}
                out[row[0]] = [{"chunk_key": c["key"], "order_index": n, "size_bytes": c["sizeBytes"], "start_seconds": c["startSeconds"]}
                               for n, c in enumerate(unpack_chunk_list(packed))]
    return out


def convert_to_packed_layout(conn, now):
    """The layout step of LIB-FMT-11 (`convertPlaybackToPackedLayout`): every old chunk list becomes one
    `media_chunk_lists` row and the old per-chunk tables are emptied (never dropped, LIB-FMT-03). Idempotent: a library
    already packed has no old rows left. Runs inside the caller's transaction. Returns {lists, rows}."""
    conn.execute(CHUNK_LISTS_DDL)
    conn.execute(FILE_PLAYBACK_DDL)
    lists = rows = 0
    for kind, (table, owner_col) in sorted(_OLD_TABLES.items()):
        if not _has_table(conn, table):
            continue
        current, chunks = None, []

        def flush():
            conn.execute(INSERT_SQL, insert_params(current, kind, pack_chunk_list(chunks), now))

        select, order_by = _old_chunk_select(conn, table, owner_col)
        for owner, key, _order, size, start in conn.execute("SELECT %s FROM %s ORDER BY %s" % (select, table, order_by)):
            if owner != current and current is not None:
                flush()
                lists += 1
                chunks = []
            current = owner
            chunks.append({"key": key, "sizeBytes": size, "startSeconds": start})
            rows += 1
        if current is not None:
            flush()
            lists += 1
        conn.execute("DELETE FROM %s" % table)
    return {"lists": lists, "rows": rows}
