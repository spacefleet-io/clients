"""Allowlist forward proxy of the egress proof: logs every host the build tries to reach, tunnels only allowed ones.

ALLOW = comma separated host suffixes (`github.com,archive.ubuntu.com`). HTTP requests are forwarded,
HTTPS goes through CONNECT. One log line per attempt: `<ISO time> ALLOW|DENY <method> <host>:<port>`.
"""
import http.client
import os
import select
import socket
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALLOW = tuple(entry.strip().lower() for entry in os.environ.get("ALLOW", "").split(",") if entry.strip())
LOG = open(os.environ.get("LOG", "/logs/proxy.log"), "a", buffering=1)
LOCK = threading.Lock()


def allowed(host: str) -> bool:
    host = host.lower()
    return any(host == suffix or host.endswith("." + suffix) for suffix in ALLOW)


def log(verdict: str, method: str, host: str, port: int) -> None:
    line = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {verdict} {method} {host}:{port}\n"
    with LOCK:
        LOG.write(line)
        sys.stdout.write(line)
        sys.stdout.flush()


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *_args):  # our own log line replaces the default
        pass

    def deny(self, method: str, host: str, port: int) -> None:
        log("DENY", method, host, port)
        self.send_error(403, "host not on the egress allowlist")

    def do_CONNECT(self):
        host, _, port_text = self.path.partition(":")
        port = int(port_text or 443)
        if not allowed(host):
            return self.deny("CONNECT", host, port)
        try:
            upstream = socket.create_connection((host, port), timeout=20)
        except OSError:
            log("ALLOW-FAILED", "CONNECT", host, port)
            return self.send_error(502)
        log("ALLOW", "CONNECT", host, port)
        self.send_response(200, "Connection established")
        self.end_headers()
        sockets = [self.connection, upstream]
        try:
            while True:
                readable, _, _ = select.select(sockets, [], [], 60)
                if not readable:
                    break
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is self.connection else self.connection).sendall(data)
        finally:
            upstream.close()

    def forward(self):
        from urllib.parse import urlsplit

        url = urlsplit(self.path)
        host, port = url.hostname or "", url.port or 80
        if not allowed(host):
            return self.deny(self.command, host, port)
        log("ALLOW", self.command, host, port)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        connection = http.client.HTTPConnection(host, port, timeout=60)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ("proxy-connection", "connection")}
        connection.request(self.command, (url.path or "/") + (f"?{url.query}" if url.query else ""), body, headers)
        response = connection.getresponse()
        self.send_response(response.status, response.reason)
        for key, value in response.getheaders():
            if key.lower() not in ("transfer-encoding", "connection"):
                self.send_header(key, value)
        self.end_headers()
        while chunk := response.read(65536):
            self.wfile.write(chunk)

    do_GET = do_HEAD = do_POST = do_PUT = forward


ThreadingHTTPServer(("0.0.0.0", 3128), Proxy).serve_forever()
