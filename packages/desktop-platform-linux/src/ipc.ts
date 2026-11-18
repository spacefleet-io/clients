import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MpvIpcLayer } from "@space/desktop-platform-contract";

/** mpv's `--input-ipc-server` on Linux is a unix socket `<tmpdir>/sf-mpv-<token>.sock`. */
export const linuxMpvIpc: MpvIpcLayer = {
  endpoint: (token) => join(tmpdir(), `sf-mpv-${token}.sock`),
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
