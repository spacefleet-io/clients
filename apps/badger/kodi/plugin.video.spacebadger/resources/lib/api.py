# -*- coding: utf-8 -*-
"""Badger API + storage tunnel client (urllib only, Python 3.8+).

Covers: login, /auth/me, library meta/snapshot/ops, op POST (with hash headers), storage placement
(rendezvous for non-media keys, per-media resolve), tunnel session + session.start + fast-path download
(sha256 verified) and POST /storage/delete. Metadata lookups are NOT here: they go straight to the metadata service
with an anonymous ticket (metadata.py), never through this client or its session.
"""
import hashlib
import json
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.request

from compat import CLIENT_TYPE, CLIENT_VERSION, log

APP_SCOPE = "badger"
SESSION_TTL_SECONDS = 8 * 60  # gateway TTL is 10 min; refresh early
HTTP_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 120


class ApiError(Exception):
    def __init__(self, status, body=None, message=None):
        self.status = status
        self.body = body if isinstance(body, dict) else {}
        self.code = self.body.get("error") if self.body else None
        super().__init__(message or "HTTP %s %s" % (status, self.code or ""))


class UnauthorizedError(ApiError):
    """401: the device token was revoked or expired (ACCT-DEV-01: wipe key + cache)."""


class UnpaidError(ApiError):
    """402 subscription_unpaid (ACCT-UNPAID-03). wipe_at is an ISO timestamp or None."""

    @property
    def wipe_at(self):
        return self.body.get("wipeAt") if self.body else None


class PlaybackUnavailableError(ApiError):
    """503 from a saturated silo (STOR-BW-07, STOR-BW-08). `traffic` is that silo's report (see parse_traffic) or None."""

    @property
    def traffic(self):
        return parse_traffic(self.body.get("traffic")) if self.body else None


class PlaybackRefusedError(PlaybackUnavailableError):
    """503 free_playback_refused: the silo is saturated and this free viewer may not start playback (also while it stays stopped)."""


class PlaybackStoppedError(PlaybackUnavailableError):
    """503 playback_stopped: this free viewer was cut at saturation; no resume, the user presses play again once the silo lifted."""


class TwoFactorRequired(ApiError):
    @property
    def method(self):
        return self.body.get("method") if self.body else None


def http_request(method, url, headers=None, data=None, timeout=HTTP_TIMEOUT):
    """Returns (status, response_headers_lowercased, body_bytes). Never raises on HTTP status."""
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as err:
        body = b""
        try:
            body = err.read()
        except Exception:  # noqa: BLE001
            pass
        return err.code, {k.lower(): v for k, v in (err.headers or {}).items()}, body


def _json_or_empty(body):
    try:
        parsed = json.loads(body.decode("utf-8")) if body else {}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    except Exception:  # noqa: BLE001
        return {}


def _raise_for(status, body):
    parsed = _json_or_empty(body)
    if status == 401:
        raise UnauthorizedError(status, parsed)
    if status == 402:
        raise UnpaidError(status, parsed)
    if status == 503 and parsed.get("error") == "free_playback_refused":
        raise PlaybackRefusedError(status, parsed)
    if status == 503 and parsed.get("error") == "playback_stopped":
        raise PlaybackStoppedError(status, parsed)
    raise ApiError(status, parsed)


def parse_traffic(value):
    """A silo's traffic report `{state, playbackBufferSeconds, saturated, qualityCap, playbackStopped}`, or None when malformed.
    `saturated`, `qualityCap` and `playbackStopped` describe that one silo only."""
    if not isinstance(value, dict):
        return None
    buffer_seconds = value.get("playbackBufferSeconds")
    if value.get("state") not in ("normal", "high") or value.get("qualityCap") not in (None, "480p", "1080p"):
        return None
    if not isinstance(value.get("saturated"), bool) or not isinstance(value.get("playbackStopped"), bool):
        return None
    if buffer_seconds is not None and (isinstance(buffer_seconds, bool) or not isinstance(buffer_seconds, (int, float))):
        return None
    return {
        "state": value["state"],
        "playbackBufferSeconds": buffer_seconds,
        "saturated": value["saturated"],
        "qualityCap": value["qualityCap"],
        "playbackStopped": value["playbackStopped"],
    }


# --------------------------------------------------------------------------------------------
# placement (pure, unit-tested)
# --------------------------------------------------------------------------------------------
_FNV_OFFSET = 0xCBF29CE484222325
_FNV_PRIME = 0x100000001B3
_MASK = 0xFFFFFFFFFFFFFFFF
_PLACEMENT_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def fnv1a64(text):
    h = _FNV_OFFSET
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * _FNV_PRIME) & _MASK
    return h


def parse_shard_id(key):
    parts = key.strip().split("/", 2)
    if len(parts) >= 2 and parts[0] == "shards" and parts[1].strip():
        return parts[1].strip()
    return None


def parse_media_placement_id(key):
    parts = key.strip().split("/", 2)
    if len(parts) == 3 and parts[0] == "media" and parts[2] and _PLACEMENT_ID.match(parts[1]):
        return parts[1]
    return None


def pick_placement_shard(policy, key):
    key = key.strip()
    if not key:
        return None
    # A pinned key names its silo: it resolves there unless the shard is disabled (a `provisioning` silo,
    # STOR-GATEWAY-13, is listed only so keys already on it stay readable).
    pinned = parse_shard_id(key)
    if pinned:
        for shard in policy.get("shards", []):
            if shard["id"] == pinned and shard.get("status") != "disabled":
                return shard
    active = [s for s in policy.get("shards", []) if (s.get("status") or "active") == "active"]
    if not active:
        return None
    best, best_score = None, -1
    for shard in active:
        raw = fnv1a64("%s|%s|%s|%s" % (policy["seed"], policy["epoch"], key, shard["id"]))
        weight = shard.get("weight")
        try:
            weight = max(1, int(weight))
        except (TypeError, ValueError):
            weight = 1
        score = raw * weight
        if best is None or score > best_score:
            best, best_score = shard, score
    return best


def sharded_object_key(shard_id, key):
    key = key.strip().lstrip("/")
    return key if key.startswith("shards/") else "shards/%s/%s" % (shard_id, key)


def next_state_hash(prev_state_hash, op_id, encrypted_payload):
    payload_hash = hashlib.sha256(encrypted_payload).hexdigest()
    return hashlib.sha256(("%s|%s|%s" % (prev_state_hash or "root", op_id, payload_hash)).encode("utf-8")).hexdigest()


GATEWAY_PROBE_TIMEOUT = 2.5


def _probe_health(url, timeout):
    status, _h, _b = http_request("GET", url + "/health", {}, None, timeout)
    return status < 500


def first_healthy_gateway(candidates, timeout=GATEWAY_PROBE_TIMEOUT, probe=_probe_health):
    """Probe every candidate's /health at once; the first healthy answer wins. None when none answers healthy within
    `timeout` (the per-probe timeout the serial loop used, now the bound for the whole set). Late probes finish on
    their daemon threads and are ignored."""
    if not candidates:
        return None
    answers = queue.Queue()

    def run(url):
        try:
            ok = probe(url, timeout)
        except Exception as exc:  # noqa: BLE001 - an unreachable candidate is just not healthy
            log("gateway probe %s failed: %s" % (url, exc), "debug")
            ok = False
        answers.put((url, ok))

    for url in candidates:
        threading.Thread(target=run, args=(url,), name="sb-gw-probe", daemon=True).start()
    deadline = time.monotonic() + timeout
    for _ in candidates:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            url, ok = answers.get(timeout=remaining)
        except queue.Empty:
            break
        if ok:
            return url
    return None


# --------------------------------------------------------------------------------------------
# client
# --------------------------------------------------------------------------------------------
class ApiClient(object):
    def __init__(self, base_url, token=None):
        self.base_url = (base_url or "").rstrip("/")
        self.token = token
        self._lock = threading.RLock()
        self._policy = None
        self._media_placements = {}  # placementId -> (shard dict, fetched_at)
        self._gateway_by_shard = {}  # shardId -> reachable base url
        self._sessions = {}  # (gateway, shardId, prefix, purpose, profileId) -> (sessionId, created_at)
        self.profile_id = None  # followed profile (INTG-PROF-01), named on every playback session (STOR-BW-11)

    # ---- plumbing
    def _headers(self, json_body=False, extra=None):
        headers = {"x-space-app": APP_SCOPE, "accept": "application/json", "user-agent": "SpaceBadger-Kodi/%s" % CLIENT_VERSION}
        if self.token:
            headers["authorization"] = "Bearer %s" % self.token
        if json_body:
            headers["content-type"] = "application/json"
        if extra:
            headers.update(extra)
        return headers

    def json_headers(self):
        """The app's usual headers for an authenticated JSON call (used by the ticket refill, META-ANON-02)."""
        return self._headers(json_body=True)

    def request_json(self, method, path, body=None, expect=(200,), timeout=HTTP_TIMEOUT):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        status, _h, raw = http_request(method, self.base_url + path, self._headers(json_body=body is not None), data, timeout)
        log("api %s %s -> %s (%d bytes)" % (method, path.split("?")[0], status, len(raw)), "debug")
        if status not in expect:
            _raise_for(status, raw)
        return _json_or_empty(raw)

    # ---- auth
    def login(self, email, password, two_factor_code=None, device_name=None):
        body = {"email": email, "password": password, "clientType": CLIENT_TYPE, "deviceType": "kodi"}
        if device_name:
            body["deviceName"] = device_name[:80]
        if two_factor_code:
            body["twoFactorCode"] = two_factor_code
        status, _h, raw = http_request(
            "POST", self.base_url + "/auth/login", self._headers(json_body=True), json.dumps(body).encode("utf-8")
        )
        parsed = _json_or_empty(raw)
        if status == 200 and parsed.get("token"):
            self.token = parsed["token"]
            log("login ok for %s" % email)
            return parsed
        if status == 401 and parsed.get("error") == "two_factor_required":
            raise TwoFactorRequired(status, parsed)
        raise ApiError(status, parsed)

    def logout(self):
        try:
            self.request_json("POST", "/auth/logout", {}, expect=(200, 204, 401))
        except Exception as exc:  # noqa: BLE001
            log("logout failed (ignored): %s" % exc, "warning")

    def me(self):
        """GET /auth/me. Raises UnauthorizedError on 401. Returns {'state','wipeAt','paidUntil','email',...}."""
        parsed = self.request_json("GET", "/auth/me")
        access = parsed.get("access") or (parsed.get("user") or {}).get("access") or {}
        user = parsed.get("user") or {}
        return {
            "state": access.get("state") or "free",
            "wipeAt": access.get("wipeAt"),
            "paidUntil": access.get("paidUntil"),
            "email": user.get("email"),
            "userId": user.get("id"),
            "isAdmin": bool(user.get("isAdmin")),
        }

    def profiles(self):
        """GET /profiles: the account's profiles, oldest first ({id, name, avatar, createdAt, isMain})."""
        listed = self.request_json("GET", "/profiles").get("profiles") or []
        log("profiles: %d on the account (main %s)" % (len(listed), next((p.get("id") for p in listed if p.get("isMain")), None)))
        return listed

    # ---- library
    def library_meta(self):
        return self.request_json("GET", "/library/db/meta")

    def library_ops(self, since):
        return self.request_json("GET", "/library/db/ops?since=%d" % int(since))

    def post_op(self, encrypted, op_id, base_version, prev_state_hash, next_hash):
        headers = self._headers(extra={
            "content-type": "application/octet-stream",
            "x-library-base-version": str(int(base_version)),
            # Every op is written compressed (storage format v2, LIB-FMT-07).
            "x-library-storage-format-version": "2",
            "x-library-op-id": op_id,
        })
        # Without a known head (no local state hash) both lineage headers are omitted and the server derives
        # the next hash from its own head; the base version still rejects a stale writer.
        if prev_state_hash:
            headers["x-library-prev-state-hash"] = prev_state_hash
        if next_hash:
            headers["x-library-next-state-hash"] = next_hash
        status, _h, raw = http_request("POST", self.base_url + "/library/db/ops", headers, encrypted)
        log("api POST /library/db/ops op=%s base=%s -> %s" % (op_id, base_version, status))
        if status != 200:
            _raise_for(status, raw)
        return _json_or_empty(raw)

    # ---- storage placement
    def policy(self, refresh=False):
        with self._lock:
            if self._policy is None or refresh:
                self._policy = self.request_json("GET", "/storage/placement").get("policy") or {}
                log("storage policy epoch=%s shards=%s" % (self._policy.get("epoch"), [s.get("id") for s in self._policy.get("shards", [])]))
            return self._policy

    def media_placement(self, placement_id):
        with self._lock:
            hit = self._media_placements.get(placement_id)
            if hit and time.time() - hit[1] < 300:
                return hit[0]
        parsed = self.request_json("POST", "/storage/placement/media/resolve", {"placementIds": [placement_id]})
        shard = None
        for entry in parsed.get("placements", []):
            if entry.get("placementId") == placement_id:
                shard = entry.get("shard")
        if not shard:
            raise ApiError(503, {"error": "storage_placement_unavailable"}, "no shard for placement %s" % placement_id)
        with self._lock:
            self._media_placements[placement_id] = (shard, time.time())
        return shard

    def _reachable_gateway(self, shard):
        """Pick a gateway base URL from shard.addresses[] (+ gatewayUrl) that answers /health."""
        shard_id = shard.get("id")
        with self._lock:
            cached = self._gateway_by_shard.get(shard_id)
        if cached:
            return cached
        candidates = []
        for url in list(shard.get("addresses") or []) + [shard.get("gatewayUrl")]:
            if url and url.rstrip("/") not in candidates:
                candidates.append(url.rstrip("/"))
        url = first_healthy_gateway(candidates)
        if url:
            log("gateway for shard %s -> %s" % (shard_id, url))
            with self._lock:
                self._gateway_by_shard[shard_id] = url
            return url
        raise ApiError(503, {"error": "no_reachable_gateway"}, "no reachable gateway for shard %s (%s)" % (shard_id, candidates))

    def _drop_gateway(self, shard_id):
        with self._lock:
            self._gateway_by_shard.pop(shard_id, None)
            for key in [k for k in self._sessions if k[1] == shard_id]:
                self._sessions.pop(key, None)

    def route_for(self, key):
        """-> (shard, session_prefix, send_key) for a storage object key."""
        placement_id = parse_media_placement_id(key)
        if placement_id:
            shard = self.media_placement(placement_id)
            return shard, "media/%s" % placement_id, key
        policy = self.policy()
        shard = pick_placement_shard(policy, key)
        if not shard:
            raise ApiError(503, {"error": "storage_placement_unavailable"}, "no shard for key %s" % key)
        return shard, "shards/%s" % shard["id"], sharded_object_key(shard["id"], key)

    # ---- tunnel
    def _session(self, gateway, shard, prefix, purpose):
        ident = (gateway, shard["id"], prefix, purpose, self.profile_id)
        with self._lock:
            hit = self._sessions.get(ident)
            if hit and time.time() - hit[1] < SESSION_TTL_SECONDS:
                return hit[0]
        headers = self._headers(json_body=True)
        body = {"shardId": shard["id"], "objectKeyPrefix": prefix, "purpose": purpose}
        if purpose == "playback" and self.profile_id:
            body["profileId"] = self.profile_id
        policy = self._policy
        if policy and policy.get("epoch") is not None and prefix.startswith("shards/"):
            body["placementEpoch"] = policy["epoch"]
        status, _h, raw = http_request("POST", gateway + "/storage/tunnel/session", headers, json.dumps(body).encode("utf-8"))
        if status != 200:
            _raise_for(status, raw)
        session_id = _json_or_empty(raw).get("sessionId")
        start = {
            "sessionId": session_id,
            "frame": {
                "kind": "session.start",
                "sessionId": session_id,
                "token": self.token,
                "clientType": CLIENT_TYPE,
                "clientVersion": CLIENT_VERSION,
            },
        }
        status, _h, raw = http_request("POST", gateway + "/storage/tunnel/frame", headers, json.dumps(start).encode("utf-8"))
        if status != 200:
            _raise_for(status, raw)
        log("tunnel session %s purpose=%s prefix=%s gw=%s" % (session_id, purpose, prefix, gateway))
        with self._lock:
            self._sessions[ident] = (session_id, time.time())
        return session_id

    def refresh_traffic(self, key):
        """The report of the silo holding `key` (GET /storage/traffic on its own gateway), or None when it is malformed."""
        shard, _prefix, _send_key = self.route_for(key)
        gateway = self._reachable_gateway(shard)
        status, _h, raw = http_request("GET", gateway + "/storage/traffic", self._headers(), None)
        if status != 200:
            _raise_for(status, raw)
        return parse_traffic(_json_or_empty(raw).get("traffic"))

    def download(self, key, purpose="playback"):
        """Fetch one object through the gateway fast path; sha256 header verified. Returns bytes."""
        last_error = None
        for attempt in range(3):
            shard, prefix, send_key = self.route_for(key)
            try:
                gateway = self._reachable_gateway(shard)
                session_id = self._session(gateway, shard, prefix, purpose)
                body = json.dumps({"sessionId": session_id, "objectKey": send_key, "rangeStart": 0, "rangeEnd": None}).encode("utf-8")
                status, headers, raw = http_request(
                    "POST", gateway + "/storage/tunnel/download", self._headers(json_body=True), body, DOWNLOAD_TIMEOUT
                )
                if status == 200:
                    expected = headers.get("x-storage-tunnel-sha256")
                    if expected and hashlib.sha256(raw).hexdigest() != expected:
                        raise ApiError(502, {"error": "download_checksum_mismatch"}, "checksum mismatch for %s" % key)
                    return raw
                parsed = _json_or_empty(raw)
                if status in (400, 404) and parsed.get("error") in ("invalid_session", "session_not_started"):
                    # expired session: forget and retry
                    with self._lock:
                        self._sessions.pop((gateway, shard["id"], prefix, purpose, self.profile_id), None)
                    last_error = ApiError(status, parsed)
                    continue
                _raise_for(status, raw)
            except (urllib.error.URLError, OSError) as exc:
                log("download %s attempt %d network error: %s" % (key, attempt + 1, exc), "warning")
                self._drop_gateway(shard["id"])
                last_error = exc
                time.sleep(0.2)
        if isinstance(last_error, Exception):
            raise last_error
        raise ApiError(502, {}, "download failed for %s" % key)

    def delete_objects(self, keys):
        keys = [k for k in dict.fromkeys(keys) if k]
        if not keys:
            return {"deleted": 0, "reclaimedBytes": 0}
        return self.request_json("POST", "/storage/delete", {"keys": keys})
