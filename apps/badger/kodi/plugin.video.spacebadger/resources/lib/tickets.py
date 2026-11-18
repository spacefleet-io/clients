# -*- coding: utf-8 -*-
"""The anonymous ticket reserve (META-ANON-02, META-ANON-03): a private on-disk store, a refill against
`POST /metadata/tickets`, and the schedule that drives it from the add-on service.

Port of `packages/metadata-client/src/reserve.ts` (README "Kodi port notes"). The rules it keeps:

- One JSON file `{"v": 1, "tokens": [...]}` in the add-on data dir, replaced atomically (temp file + fsync + rename). The
  service (refill) and every plugin invocation (take) are separate Kodi processes, so every read-modify-write holds
  one cross-process lock (a lock file) on top of an in-process mutex.
- take() persists the removal BEFORE it returns the ticket; a failed write hands out nothing; an empty reserve returns
  None and the caller skips metadata. take() never refills.
- Refill runs only from the service schedule (start, then about every 6 h +-30%), never from a lookup, an upload or
  a UI action. Below the low-water mark it tops the reserve up to the target in batches of up to 100.
- Anything that does not verify against the pinned key (wrong key id, bad signature) is dropped; stored tickets of
  another key id are dropped at the first read (key rotation).
- Nothing here logs a ticket, a nonce or a blinded value; only counts and statuses leave this module.
"""
import contextlib
import json
import math
import os
import random
import re
import threading
import time
from email.utils import parsedate_to_datetime

import privacypass
from api import http_request
from compat import log

try:  # POSIX (Linux, macOS, Android, OSMC/LibreELEC)
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None
try:  # pragma: no cover - Windows
    import msvcrt
except ImportError:
    msvcrt = None

RESERVE_FILE = "tickets.json"
LOCK_SUFFIX = ".lock"
TARGET = 600
LOW_WATER = 300
BATCH_SIZE = 100
INTERVAL_SECONDS = 6 * 3600
JITTER = 0.3
BACKOFF_BASE_SECONDS = 300
MAX_RETRY_AFTER_SECONDS = 365 * 24 * 3600
HTTP_TIMEOUT = 30

_TOKEN_CHARS = (privacypass.TOKEN_LENGTH * 4 + 2) // 3
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{%d}$" % _TOKEN_CHARS)


# ------------------------------------------------------------------ store
def _lock_fd(fd):
    if fcntl is not None:
        fcntl.flock(fd, fcntl.LOCK_EX)
    elif msvcrt is not None:  # pragma: no cover - Windows
        while True:
            try:
                msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
                return
            except OSError:
                time.sleep(0.05)


def _unlock_fd(fd):
    if fcntl is not None:
        fcntl.flock(fd, fcntl.LOCK_UN)
    elif msvcrt is not None:  # pragma: no cover - Windows
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)


def _write_private_atomic(path, text):
    """Temp file next to the target (0600 where the platform has modes), fsync, then rename over it."""
    tmp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


class TicketStore(object):
    """The persisted reserve. Tokens are base64url strings of the 354-byte token."""

    def __init__(self, path, pinned=privacypass.PINNED_KEYS):
        self.path = path
        self._pinned_key_ids = frozenset(privacypass.load_pinned_key(key)[1] for key in pinned)
        self._mutex = threading.Lock()
        self._key_checked = False

    @contextlib.contextmanager
    def _locked(self):
        with self._mutex:
            fd = os.open(self.path + LOCK_SUFFIX, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                _lock_fd(fd)
                try:
                    yield
                finally:
                    _unlock_fd(fd)
            finally:
                os.close(fd)

    def _held_key_id_matches(self, token):
        try:
            return privacypass.token_key_id(privacypass.b64url_decode(token)) in self._pinned_key_ids
        except ValueError:
            return False

    def _write(self, tokens):
        if tokens:
            _write_private_atomic(self.path, json.dumps({"v": 1, "tokens": tokens}))
        else:
            with contextlib.suppress(FileNotFoundError):
                os.remove(self.path)

    def _read(self):
        """Must run inside _locked. A corrupt file counts as empty. The first read of an instance drops tickets
        that do not carry the pinned key id."""
        try:
            with open(self.path, encoding="utf-8") as fh:
                blob = json.load(fh)
            tokens = blob["tokens"] if isinstance(blob, dict) and blob.get("v") == 1 and isinstance(blob.get("tokens"), list) else []
        except (OSError, ValueError, KeyError):
            tokens = []
        tokens = [t for t in tokens if isinstance(t, str) and _TOKEN_RE.match(t)]
        if not self._key_checked:
            kept = [t for t in tokens if self._held_key_id_matches(t)]
            if len(kept) != len(tokens):
                tokens = kept
                self._write(tokens)
            self._key_checked = True
        return tokens

    def count(self):
        with self._locked():
            return len(self._read())

    def take(self):
        """Removes one ticket from the file and returns it, or None when empty. The new file is written before
        the ticket is returned, so a crash afterwards never reuses it and a failed write hands out nothing."""
        with self._locked():
            tokens = self._read()
            if not tokens:
                return None
            ticket = tokens.pop()
            self._write(tokens)
            return ticket

    def put(self, ticket):
        """Gives back a ticket the service did not spend (META-ANON-05); the next `take()` returns it first. Ignored when
        it is not a well-formed ticket of the pinned key or is already held. Never raises: a failed write loses the
        ticket, as before."""
        if not isinstance(ticket, str) or not _TOKEN_RE.match(ticket) or not self._held_key_id_matches(ticket):
            return
        try:
            with self._locked():
                tokens = self._read()
                if ticket not in tokens:
                    tokens.append(ticket)
                    self._write(tokens)
        except Exception:  # noqa: BLE001 - the caller is already reporting the service's answer
            pass

    def append(self, added, still_valid=None):
        """Adds tickets and returns how many are held. `still_valid` is checked inside the store lock, right before the
        write: when it says False (the session ended while the batch was in flight) nothing is written and None is
        returned, so a sign-out that cleared the reserve is never refilled behind its back."""
        with self._locked():
            if still_valid is not None and not still_valid():
                return None
            tokens = self._read()
            tokens.extend(added)
            self._write(tokens)
            return len(tokens)

    def clear(self):
        with self._locked():
            self._write([])
            self._key_checked = False


# ------------------------------------------------------------------ refill
class RefillResult(object):
    """status: ok | skipped | unpaid | rate_limited | signed_out | network_error | server_error | rejected | stopped | error.
    Counts only; never a ticket value."""

    def __init__(self, status="ok", added=0, dropped=0, count=0, retry_after=None):
        self.status = status
        self.added = added
        self.dropped = dropped
        self.count = count
        self.retry_after = retry_after

    def __repr__(self):
        return "RefillResult(%s added=%d dropped=%d held=%d)" % (self.status, self.added, self.dropped, self.count)


def parse_retry_after(value, now):
    """Seconds from a Retry-After header (delta-seconds or HTTP-date), capped at one year; None when unreadable."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return min(int(value), MAX_RETRY_AFTER_SECONDS)
    try:
        when = parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError):
        return None
    return min(max(0, math.ceil(when - now)), MAX_RETRY_AFTER_SECONDS)


class TicketReserve(object):
    """Store + refill. `get_auth()` returns `(api_base_url, headers)` for the signed-in session (the app's usual API
    headers incl. `authorization: Bearer ...`) or None when signed out."""

    def __init__(self, store, get_auth, pinned=privacypass.PINNED_KEYS, http=http_request, rand=None, now=time.time,
                 random_bytes=os.urandom, target=TARGET, low_water=LOW_WATER, batch_size=BATCH_SIZE,
                 interval=INTERVAL_SECONDS, jitter=JITTER, backoff_base=BACKOFF_BASE_SECONDS):
        if not 1 <= batch_size <= privacypass.MAX_TICKETS_PER_REQUEST:
            raise ValueError("batch_size must be 1..%d" % privacypass.MAX_TICKETS_PER_REQUEST)
        self.store = store
        self._get_auth = get_auth
        if not pinned:
            raise ValueError("pinned must hold at least one key")
        self._keys = tuple(pinned)
        # The key the next batch is blinded for: the first trusted key until an answer names another trusted one.
        self._active = self._keys[0]
        self._http = http
        self._rand = rand or random.SystemRandom().random
        self._now = now
        self._random_bytes = random_bytes
        self.target, self.low_water, self.batch_size = target, low_water, batch_size
        self.interval, self.jitter, self.backoff_base = interval, jitter, backoff_base
        self._failures = 0
        self._run = threading.Lock()  # one refill at a time

    def take(self):
        return self.store.take()

    def put(self, ticket):
        return self.store.put(ticket)

    def count(self):
        return self.store.count()

    def refill(self, force=False, should_continue=lambda: True):
        """Tops the reserve up to the target, only below the low-water mark unless `force`. Never raises on server or
        network trouble (it is a status); a local failure (disk) is returned as status `error`."""
        with self._run:
            try:
                return self._refill(force, should_continue)
            except Exception:  # noqa: BLE001 - the schedule must survive a local failure; the type is not a secret
                return RefillResult("error", count=self._safe_count())

    def _safe_count(self):
        try:
            return self.store.count()
        except Exception:  # noqa: BLE001
            return 0

    def _refill(self, force, should_continue):
        held = self.store.count()
        result = RefillResult(count=held)

        def finish(status, retry_after=None):
            result.status, result.count, result.retry_after = status, held, retry_after
            return result

        if held >= self.target or (not force and held >= self.low_water):
            return finish("skipped")
        switched = False
        while held < self.target:
            if not should_continue():
                return finish("stopped")
            auth = self._get_auth()
            if not auth:
                return finish("signed_out")
            base_url, headers = auth
            batch_key = self._active
            blinded, pending = privacypass.create_ticket_requests(
                min(self.batch_size, self.target - held), batch_key, self._random_bytes)
            body = json.dumps({"blinded": blinded}).encode("utf-8")
            try:
                status, response_headers, raw = self._http("POST", base_url.rstrip("/") + "/metadata/tickets", headers, body, HTTP_TIMEOUT)
            except Exception:  # noqa: BLE001 - any transport failure (URLError, timeout, bad URL) backs off
                return finish("network_error")
            if status == 401:
                return finish("signed_out")
            if status == 402:
                return finish("unpaid")
            if status == 429:
                return finish("rate_limited", parse_retry_after(response_headers.get("retry-after"), self._now()))
            if status < 200 or status >= 300:
                return finish("server_error")
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except ValueError:
                return finish("server_error")
            if not isinstance(parsed, dict):
                return finish("server_error")
            # Fail closed: an answer without a string keyId drops the whole batch, like one naming another key.
            if not isinstance(parsed.get("keyId"), str):
                result.dropped += len(pending)
                return finish("rejected")
            # Only with more than one trusted key (a dev run, META-ANON-07): the server signs with another key of the list,
            # so this batch was blinded for the wrong modulus. Drop it and blind the rest for that key, once per refill so
            # a server alternating key ids cannot loop. The answer only picks among the embedded keys, never adds one.
            answered = next((key for key in self._keys if key.key_id.lower() == parsed["keyId"].lower()), None)
            if answered is not None and answered is not batch_key and not switched:
                result.dropped += len(pending)
                self._active, switched = answered, True
                continue
            tokens, dropped = privacypass.finish_tickets(pending, parsed.get("signed"), batch_key, parsed["keyId"])
            result.dropped += dropped
            if not tokens:
                return finish("rejected")
            stored = self.store.append(tokens, should_continue)
            if stored is None:
                return finish("stopped")
            held = stored
            result.added += len(tokens)
        return finish("ok")

    # ---- schedule
    def _jittered(self):
        return max(1.0, self.interval * (1 + self.jitter * (2 * self._rand() - 1)))

    def next_delay(self, result):
        """Seconds until the next scheduled tick after `result`."""
        if result.status in ("network_error", "server_error", "error"):
            self._failures += 1
            return min(self.backoff_base * 2 ** min(self._failures - 1, 30), self.interval)
        self._failures = 0
        if result.status == "rate_limited":
            return max(self._jittered(), result.retry_after or 0)
        return self._jittered()


class RefillScheduler(object):
    """Drives a reserve from the service loop. `poll()` is cheap and non-blocking: call it every service tick.
    A refill runs on its own thread, at service start (when signed in) and then about every 6 h; a 401 stops the schedule
    until the user signs in again (a different session). `aborted()` (Kodi shutting down) and a changed or ended
    session both stop a refill in flight before its tickets are stored."""

    def __init__(self, reserve, session, now=time.time, spawn=None, aborted=lambda: False):
        self._reserve = reserve
        self._session = session  # () -> opaque id of the signed-in session (kept in memory only), or None
        self._aborted = aborted
        self._now = now
        self._spawn = spawn or self._spawn_thread
        self._lock = threading.RLock()
        self._thread = None
        self._armed = False
        self._due = 0.0
        self._dead = None
        self.last_result = None

    @staticmethod
    def _spawn_thread(work):
        thread = threading.Thread(target=work, name="sb-tickets", daemon=True)
        thread.start()
        return thread

    def poll(self):
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            session = self._session()
            if not session:
                self._armed, self._dead = False, None
                return
            if session == self._dead:
                return
            now = self._now()
            if not self._armed:
                self._armed, self._due = True, now  # service start or fresh sign-in: low-water check at once
            if now < self._due:
                return
            self._thread = self._spawn(lambda: self._tick(session))

    def _tick(self, session):
        result = self._reserve.refill(should_continue=lambda: not self._aborted() and self._session() == session)
        if result.status != "skipped":
            log("ticket refill: %r" % result, "debug")  # counts and a status, never a ticket
        with self._lock:
            self.last_result = result
            if result.status == "signed_out":
                self._armed, self._dead = False, session
            else:
                self._due = self._now() + self._reserve.next_delay(result)
