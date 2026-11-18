# -*- coding: utf-8 -*-
"""Anonymous metadata lookups (META-RELAY-01, META-RELAY-02, META-ANON-01): straight to the metadata service with one
ticket per request, never through the Badger API.

Port of `packages/metadata-client/src/client.ts` + `metadataUrl.ts`. A lookup is

    POST <metadata url>/lookup
    Authorization: PrivateToken token="<base64url ticket>"
    Content-Type: application/json
    User-Agent: <one fixed generic value>

with a JSON body `{"op": "search"|"details"|"videos"|"image", ...}`. No cookie jar, no bearer token, no
session, no device id, no app-scope header, and redirects are never followed (a redirect would carry the ticket to
another origin). One ticket is spent per attempt, also when the request fails on the network or the service answers 429 or
503. The client never refills the reserve: an empty reserve raises NoTicketError and the caller skips the lookup.

This add-on asks the metadata service for no picture: artwork shows from the user's vault only (images.py, META-ART-02).
"""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

import privacypass

DEFAULT_METADATA_URL = "https://metadata.spacefleet.io"
GENERIC_USER_AGENT = "Mozilla/5.0"
LOOKUP_TIMEOUT = 30
MAX_TICKET_RETRIES = 2  # after a 401 the next ticket is tried, at most this many times


class MetadataError(Exception):
    """Base class; messages never carry a ticket, a title, an id or an address."""


class NoTicketError(MetadataError):
    """The reserve is empty. The refill belongs to the schedule; skip the lookup."""


class TicketRejectedError(MetadataError):
    """401 on the first try and on every retry."""


class MetadataUnavailableError(MetadataError):
    """429/503 or no answer at all (`status` None). `retry_after` seconds when the service said so; `code` is the
    service's `error` code (`rate_limited`, `ticket_store_unavailable`, `upstream_capacity`) when the answer had one."""

    def __init__(self, status, retry_after=None, code=None):
        super().__init__("metadata service unavailable (%s)" % (status or "no answer"))
        self.status = status
        self.retry_after = retry_after
        self.code = code


class MetadataRequestError(MetadataError):
    def __init__(self, status, message=None):
        super().__init__(message or "metadata request failed (HTTP %s)" % status)
        self.status = status


# Host name of the production API (REL-CD-09, REL-CD-15).
_PRODUCTION_API_HOST = "api.spacefleet.io"
# Every dev-stack profile and lane runs its metadata service two ports above its API (3000/3002, 3100/3102, lanes).
_METADATA_PORT_OFFSET = 2
_DEV_METADATA_PORT = 3002
_API_URL_PATTERN = re.compile(r"^(https?)://(\[[^\]\s]+\]|[^/:?#\s]+)(?::(\d{1,5}))?(?:[/?#]|$)", re.IGNORECASE)


def metadata_url_for_api(api_url):
    """The metadata service of the API that issues the tickets (META-ANON-08), like `metadataUrlForApi` in
    packages/metadata-client: the production API (or none, or not an http(s) URL) gives production; an API with a
    port gives the same host two ports up; an `api.<domain>` host gives `metadata.<domain>`; any other host gives
    port 3002 on that host. Never the build flavour."""
    match = _API_URL_PATTERN.match((api_url or "").strip())
    if not match:
        return DEFAULT_METADATA_URL
    scheme, host, port = match.group(1).lower(), match.group(2).lower(), match.group(3)
    if host == _PRODUCTION_API_HOST:
        return DEFAULT_METADATA_URL
    if port:
        return "%s://%s:%d" % (scheme, host, int(port) + _METADATA_PORT_OFFSET)
    if host.startswith("api."):
        return "%s://metadata.%s" % (scheme, host[len("api."):])
    return "%s://%s:%d" % (scheme, host, _DEV_METADATA_PORT)


def resolve_metadata_url(override=None, api_url=None, environ=None):
    """Base URL without a trailing slash. An explicit setting wins, then the METADATA_URL environment variable, then the
    metadata service of the API the tickets come from (`metadata_url_for_api`). Raises ValueError for non-http(s)."""
    environ = os.environ if environ is None else environ
    chosen = next((v.strip() for v in (override, environ.get("METADATA_URL")) if v and v.strip()), None)
    if chosen is None:
        chosen = metadata_url_for_api(api_url)
    parts = urllib.parse.urlsplit(chosen)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("the metadata URL must start with http:// or https://")
    return chosen.rstrip("/")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)  # no cookie processor: nothing is stored or sent back


def post_json(url, headers, data, timeout=LOOKUP_TIMEOUT):
    """(status, response_headers_lowercased, body_bytes); never raises on an HTTP status, never follows a redirect."""
    request = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with _opener.open(request, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as err:
        try:
            body = err.read()
        except Exception:  # noqa: BLE001
            body = b""
        return err.code, {k.lower(): v for k, v in (err.headers or {}).items()}, body


# The two refusals the service sends before it has taken the ticket (META-ANON-05): 429 `rate_limited` and
# 503 `ticket_store_unavailable`. A 503 `upstream_capacity` comes after the ticket was spent.
UNSPENT_REFUSALS = {429: "rate_limited", 503: "ticket_store_unavailable"}


def _refusal_code(raw):
    """The `error` code of a refusal's JSON body, or None when there is none or it cannot be read."""
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, AttributeError):
        return None
    code = parsed.get("error") if isinstance(parsed, dict) else None
    return code if isinstance(code, str) else None


class MetadataClient(object):
    """`take()` returns a base64url ticket or None (TicketReserve.take); `put(ticket)` (optional) gives back a ticket
    the service did not spend (META-ANON-05); `url()` the metadata base URL."""

    def __init__(self, take, url, post=post_json, put=None):
        self._take = take
        self._put = put
        self._url = url
        self._post = post

    def lookup(self, body):
        payload = json.dumps(body).encode("utf-8")
        url = self._url() + "/lookup"
        rejected = 0
        while True:
            ticket = self._take()
            if ticket is None:
                raise NoTicketError("no ticket in the reserve")
            headers = {
                "Authorization": privacypass.private_token_authorization(ticket),
                "Content-Type": "application/json",
                "User-Agent": GENERIC_USER_AGENT,
            }
            try:
                status, response_headers, raw = self._post(url, headers, payload, LOOKUP_TIMEOUT)
            except Exception:  # noqa: BLE001 - transport failure: the ticket is spent by its attempt
                raise MetadataUnavailableError(None)
            if status == 401:
                rejected += 1
                if rejected > MAX_TICKET_RETRIES:
                    raise TicketRejectedError("the service refused every ticket tried")
                continue
            if status in (429, 503):
                retry_after = response_headers.get("retry-after", "")
                code = _refusal_code(raw)
                # Unknown or unreadable means spent: a spent ticket put back would only be refused later.
                if code is not None and code == UNSPENT_REFUSALS[status] and self._put is not None:
                    try:
                        self._put(ticket)
                    except Exception:  # noqa: BLE001 - the ticket is lost, as before; the answer below is what matters
                        pass
                raise MetadataUnavailableError(status, int(retry_after) if retry_after.strip().isdigit() else None, code)
            if status < 200 or status >= 300:
                raise MetadataRequestError(status)
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except ValueError:
                raise MetadataRequestError(status, "unreadable metadata answer")
            if not isinstance(parsed, dict):
                raise MetadataRequestError(status, "unreadable metadata answer")
            return parsed
