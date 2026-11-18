import { readdirSync } from "node:fs";
import { createConnection } from "node:net";
import type { MpvIpcLayer } from "@space/desktop-platform-contract";

const PIPE_DIRECTORY = "\\\\.\\pipe\\";

export type WindowsMpvIpcDeps = {
  /** Names (not paths) of every named pipe that currently exists. */
  listPipes: () => string[];
};

/**
 * mpv's `--input-ipc-server` on Windows is the named pipe `\\.\pipe\sf-mpv-<token>`.
 *
 * `exists` lists the pipe directory instead of opening the pipe: `existsSync` on a pipe
 * path is a `CreateFile`, which connects to a free instance of mpv's single-instance
 * server (mpv then re-creates it) or fails with ERROR_PIPE_BUSY while it does. Either way
 * the pre-request check reported a live mpv as missing and ate a connection. Listing the
 * directory touches no instance. Pipe names are case-insensitive.
 */
export const createWindowsMpvIpc = (deps: WindowsMpvIpcDeps): MpvIpcLayer => ({
  endpoint: (token) => `${PIPE_DIRECTORY}sf-mpv-${token}`,
  exists: (endpoint) => {
    if (endpoint.slice(0, PIPE_DIRECTORY.length).toLowerCase() !== PIPE_DIRECTORY) return false;
    const name = endpoint.slice(PIPE_DIRECTORY.length).toLowerCase();
    if (name.length === 0 || name.includes("\\")) return false;
    return deps.listPipes().some((listed) => listed.toLowerCase() === name);
  },
  connect: (endpoint, onConnect) => createConnection(endpoint, onConnect),
  // A named pipe vanishes with its last handle: nothing to clean up.
  remove: () => {},
});

export const windowsMpvIpc: MpvIpcLayer = createWindowsMpvIpc({ listPipes: () => readdirSync(PIPE_DIRECTORY) });
