import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MpvIpcLayer } from "@space/desktop-platform-contract";

/**
 * `sockaddr_un.sun_path` is 104 bytes on macOS, NUL included, and macOS's per-user `TMPDIR`
 * (`/var/folders/xx/<random>/T/`) is already ~50 of them: a path past the limit makes mpv's
 * `--input-ipc-server` fail to bind. So the endpoint is `<tmpdir>/sf-mpv-<token>.sock` (as on
 * Linux) when it fits, else the same name under `/tmp`, else a hash of the token under `/tmp`.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

export const macosMpvEndpoint = (token: string, dir: string = tmpdir()): string => {
  for (const candidate of [join(dir, `sf-mpv-${token}.sock`), join("/tmp", `sf-mpv-${token}.sock`)]) {
    if (Buffer.byteLength(candidate) <= MAX_SOCKET_PATH_BYTES) return candidate;
  }
  return join("/tmp", `sf-mpv-${createHash("sha256").update(token).digest("hex").slice(0, 16)}.sock`);
};

/** mpv's `--input-ipc-server` on macOS is a unix socket. */
export const macosMpvIpc: MpvIpcLayer = {
  endpoint: (token) => macosMpvEndpoint(token),
  exists: (endpoint) => existsSync(endpoint),
  connect: (endpoint, onConnect) => createConnection(endpoint, onConnect),
  remove: (endpoint) => {
    try {
      unlinkSync(endpoint);
    } catch {
      // best effort: already gone or not ours
    }
  },
};
