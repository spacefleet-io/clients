"""@req META-RELAY-01 lookups go straight to the metadata service with one ticket each; @req META-RELAY-02 a lookup carries
only the ticket (no cookie, no account or device header, generic user agent); @req META-ANON-05 a ticket the service did
not spend (429 rate_limited, 503 ticket_store_unavailable) goes back into the reserve, any other answer keeps it spent.
The add-on asks the service for no picture (META-ART-02, tests/test_vault_artwork.py); the wire is exercised with `image`
bodies as a plain example op.

A real local HTTP server plays the metadata service so the bytes on the wire are what is asserted."""
import glob
import json
import os
import re
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import _dev_signer as dev
import _path  # noqa: F401
import metadata
import privacypass as pp
import tickets

TICKET = "A" * 472


class Service(object):
    """Scripted metadata service: `script` entries are (status, headers, body) answered in order; the last one repeats."""

    def __init__(self, script):
        outer = self
        self.requests = []
        self.script = list(script)

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                outer.requests.append({"path": self.path, "headers": [(k.lower(), v) for k, v in self.headers.items()], "body": self.rfile.read(length)})
                status, headers, body = outer.script.pop(0) if len(outer.script) > 1 else outer.script[0]
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                data = json.dumps(body).encode() if body is not None else b""
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Tickets(object):
    def __init__(self, count):
        self.items = ["%s%03d" % ("T" * 469, i) for i in range(count)]
        self.taken = []

    def take(self):
        if not self.items:
            return None
        ticket = self.items.pop(0)
        self.taken.append(ticket)
        return ticket


class PutBack(object):
    """A reserve that also takes tickets back, as the on-disk store does."""

    def __init__(self, count):
        self.pool = Tickets(count)
        self.put_back = []

    def take(self):
        return self.pool.take()

    def put(self, ticket):
        self.put_back.append(ticket)


class LookupWire(unittest.TestCase):
    def serve(self, script):
        service = Service(script)
        self.addCleanup(service.close)
        return service

    def test_request_carries_only_the_ticket_and_a_generic_user_agent(self):
        dev.phase("metadata", "wire format of a lookup")
        service = self.serve([(200, {"Set-Cookie": "sid=1; Path=/"}, {"results": [], "page": 1, "totalPages": 1})])
        pool = Tickets(3)
        client = metadata.MetadataClient(pool.take, lambda: service.url)
        out = client.lookup({"op": "search", "type": "movie", "query": "x", "page": 1})
        self.assertEqual(out["page"], 1)
        request = service.requests[0]
        self.assertEqual(request["path"], "/lookup")
        headers = dict(request["headers"])
        self.assertEqual(headers["authorization"], 'PrivateToken token="%s"' % pool.taken[0])
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["user-agent"], metadata.GENERIC_USER_AGENT)
        self.assertEqual(json.loads(request["body"]), {"op": "search", "type": "movie", "query": "x", "page": 1})
        allowed = {"authorization", "content-type", "user-agent", "host", "content-length", "accept-encoding", "connection"}
        self.assertEqual(set(headers) - allowed, set())
        self.assertNotIn("Badger", headers["user-agent"])
        self.assertEqual(len(pool.taken), 1)  # one ticket per request
        # a second lookup does not send the cookie the first answer tried to set
        client.lookup({"op": "image", "path": "/p.jpg"})
        self.assertNotIn("cookie", dict(service.requests[1]["headers"]))

    def test_401_drops_the_ticket_and_tries_the_next_at_most_two_retries(self):
        dev.phase("metadata", "401 handling")
        service = self.serve([(401, {}, {"error": "invalid_token"}), (401, {}, None), (200, {}, {"url": "data:,x"})])
        pool = Tickets(5)
        out = metadata.MetadataClient(pool.take, lambda: service.url).lookup({"op": "image", "path": "/p"})
        self.assertEqual(out, {"url": "data:,x"})
        self.assertEqual(len(pool.taken), 3)
        self.assertEqual(len(set(dict(r["headers"])["authorization"] for r in service.requests)), 3)

        always = self.serve([(401, {}, None)])
        pool = Tickets(9)
        with self.assertRaises(metadata.TicketRejectedError):
            metadata.MetadataClient(pool.take, lambda: always.url).lookup({"op": "image", "path": "/p"})
        self.assertEqual(len(pool.taken), 3)  # the first try plus 2 retries

    def test_429_and_503_report_unavailable_and_spend_the_ticket(self):
        for status in (429, 503):
            service = self.serve([(status, {"Retry-After": "120"}, {"error": "upstream_capacity"})])
            pool = Tickets(2)
            with self.assertRaises(metadata.MetadataUnavailableError) as caught:
                metadata.MetadataClient(pool.take, lambda: service.url).lookup({"op": "image", "path": "/p"})
            self.assertEqual((caught.exception.status, caught.exception.retry_after), (status, 120))
            self.assertEqual(len(pool.taken), 1)  # no retry with another ticket

    def test_the_two_refusals_before_the_spend_put_the_ticket_back(self):
        dev.phase("metadata", "META-ANON-05 put-back pairs")
        for status, code in ((429, "rate_limited"), (503, "ticket_store_unavailable")):
            service = self.serve([(status, {"Retry-After": "7"}, {"error": code})])
            reserve = PutBack(2)
            with self.assertRaises(metadata.MetadataUnavailableError) as caught:
                metadata.MetadataClient(reserve.take, lambda: service.url, put=reserve.put).lookup({"op": "image", "path": "/p"})
            self.assertEqual((caught.exception.status, caught.exception.retry_after, caught.exception.code), (status, 7, code))
            self.assertEqual(reserve.put_back, reserve.pool.taken)  # the very ticket that was presented

    def test_every_other_refusal_keeps_the_ticket_spent(self):
        dev.phase("metadata", "META-ANON-05 spent answers")
        cases = [
            (503, {"error": "upstream_capacity"}),  # the service spent it first
            (429, {"error": "upstream_capacity"}),
            (503, {"error": "rate_limited"}),
            (429, {"error": "ticket_store_unavailable"}),
            (429, {"error": 5}),
            (503, {}),
            (503, None),
        ]
        for status, body in cases:
            service = self.serve([(status, {}, body)])
            reserve = PutBack(2)
            with self.assertRaises(metadata.MetadataUnavailableError):
                metadata.MetadataClient(reserve.take, lambda: service.url, put=reserve.put).lookup({"op": "image", "path": "/p"})
            self.assertEqual(reserve.put_back, [], (status, body))
        # a network failure and a 400 are spent as well
        service = self.serve([(400, {}, {"error": "bad_request"})])
        reserve = PutBack(2)
        with self.assertRaises(metadata.MetadataRequestError):
            metadata.MetadataClient(reserve.take, lambda: service.url, put=reserve.put).lookup({"op": "image", "path": "/p"})
        self.assertEqual(reserve.put_back, [])

    def test_a_failing_put_back_never_hides_the_answer_and_no_put_is_fine(self):
        service = self.serve([(429, {}, {"error": "rate_limited"})])

        def boom(ticket):
            raise OSError("disk full")

        with self.assertRaises(metadata.MetadataUnavailableError) as caught:
            metadata.MetadataClient(Tickets(1).take, lambda: service.url, put=boom).lookup({"op": "image", "path": "/p"})
        self.assertEqual(caught.exception.code, "rate_limited")
        with self.assertRaises(metadata.MetadataUnavailableError):
            metadata.MetadataClient(Tickets(1).take, lambda: service.url).lookup({"op": "image", "path": "/p"})

    def test_other_statuses_and_garbage_are_request_errors(self):
        for script in ([(400, {}, {"error": "invalid_path"})], [(200, {}, [1, 2])]):
            service = self.serve(script)
            with self.assertRaises(metadata.MetadataRequestError):
                metadata.MetadataClient(Tickets(1).take, lambda: service.url).lookup({"op": "image", "path": "/p"})

    def test_empty_reserve_raises_without_any_request(self):
        service = self.serve([(200, {}, {})])
        with self.assertRaises(metadata.NoTicketError):
            metadata.MetadataClient(Tickets(0).take, lambda: service.url).lookup({"op": "image", "path": "/p"})
        self.assertEqual(service.requests, [])

    def test_network_failure_spends_the_ticket_and_reports_unavailable(self):
        pool = Tickets(2)
        with self.assertRaises(metadata.MetadataUnavailableError) as caught:
            metadata.MetadataClient(pool.take, lambda: "http://127.0.0.1:1").lookup({"op": "image", "path": "/p"})
        self.assertIsNone(caught.exception.status)
        self.assertEqual(len(pool.taken), 1)

    def test_a_redirect_is_never_followed_so_the_ticket_cannot_leave_the_origin(self):
        elsewhere = self.serve([(200, {}, {"url": "x"})])
        service = self.serve([(302, {"Location": elsewhere.url + "/lookup"}, None)])
        with self.assertRaises(metadata.MetadataRequestError) as caught:
            metadata.MetadataClient(Tickets(1).take, lambda: service.url).lookup({"op": "image", "path": "/p"})
        self.assertEqual(caught.exception.status, 302)
        self.assertEqual(elsewhere.requests, [])

    def test_error_messages_never_carry_a_ticket_or_an_address(self):
        service = self.serve([(500, {}, {"error": "x"})])
        pool = Tickets(1)
        with self.assertRaises(metadata.MetadataRequestError) as caught:
            metadata.MetadataClient(pool.take, lambda: service.url).lookup({"op": "image", "path": "/secret/title.jpg"})
        text = str(caught.exception)
        for secret in (pool.taken[0], service.url, "127.0.0.1", "secret"):
            self.assertNotIn(secret, text)


class UrlResolution(unittest.TestCase):
    def test_precedence_and_defaults(self):
        resolve = metadata.resolve_metadata_url
        self.assertEqual(resolve(None, "https://api.spacefleet.io", environ={}), "https://metadata.spacefleet.io")
        self.assertEqual(resolve("", None, environ={}), "https://metadata.spacefleet.io")
        self.assertEqual(resolve(None, "http://localhost:3000", environ={"METADATA_URL": "https://m.example/"}), "https://m.example")
        self.assertEqual(resolve(" http://custom:1/ ", "http://localhost:3000", environ={"METADATA_URL": "https://m.example"}), "http://custom:1")

    def test_follows_the_ticket_issuing_api(self):
        """@req META-ANON-08 @bugfix @regression-proof: the service of the API that issues the tickets, never production
        for a dev stack (231 wrong_key refusals on 2026-11-09) and never localhost for the production API."""
        resolve = metadata.resolve_metadata_url
        cases = (
            ("https://api.spacefleet.io/", "https://metadata.spacefleet.io"),
            ("http://localhost:3000", "http://localhost:3002"),
            ("http://127.0.0.1:3100/", "http://127.0.0.1:3102"),
            ("http://[::1]:3000", "http://[::1]:3002"),
            ("http://192.168.0.20:3000", "http://192.168.0.20:3002"),
            ("http://tvbox.local:3000", "http://tvbox.local:3002"),
            ("http://test-laptop.example.test:3000", "http://test-laptop.example.test:3002"),
            ("http://test-laptop", "http://test-laptop:3002"),
            ("https://api.lane-2.dev.spacefleet.io", "https://metadata.lane-2.dev.spacefleet.io"),
            ("https://api.spacefleet.io.evil.example", "https://metadata.spacefleet.io.evil.example"),
            ("not a url", "https://metadata.spacefleet.io"),
        )
        for api, expected in cases:
            got = resolve(None, api, environ={})
            print("[kodi-metadata-url] phase: case | api=%s -> %s" % (api, got))
            self.assertEqual(got, expected, api)

    def test_non_http_values_are_refused(self):
        for bad in ("ftp://x", "metadata.example", "file:///etc/passwd", "http://"):
            with self.assertRaises(ValueError):
                metadata.resolve_metadata_url(bad, None, environ={})


class NoRelayLeft(unittest.TestCase):
    def test_no_module_posts_metadata_through_the_api_any_more(self):
        """META-RELAY-01: the add-on has no path to POST /metadata/relay (the only /metadata/ API path left is the blind
        ticket issuance, /metadata/tickets)."""
        lib = _path.LIB
        for path in glob.glob(os.path.join(lib, "*.py")):
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            self.assertNotIn("metadata/relay", text, os.path.basename(path))
            for found in re.findall(r"/metadata/[a-z]+", text):
                self.assertEqual(found, "/metadata/tickets", os.path.basename(path))


if __name__ == "__main__":
    unittest.main()
