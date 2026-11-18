import fsp from "node:fs/promises";
import path from "node:path";
import type { KeyValueStorage } from "./types";

/** A file-backed ticket store for a Node process (the Jellyfin sidecar, Parrot's main process), plus the sign-out switch. */
export interface TicketStorage extends KeyValueStorage {
  /** Stops all writes and resolves once the write in flight (if any) has landed, so the caller may delete the directory. */
  close(): Promise<void>;
  /** Allows writes again (a new session). */
  open(): void;
}

/**
 * Anonymous-ticket store for a Node process: one 0600 file per key inside the caller's state dir, so the reserve
 * dies with the rest of the session state on sign-out (PRIV-KEY-05). Writes are serialised and go to a temp file
 * renamed over the target, so a crash leaves either the old or the new blob, never a half-written one.
 *
 * `close()` is called before the sign-out wipe: a refill still running at that moment must not write its tickets
 * back into the directory the wipe just removed, so `set` does nothing while the store is closed.
 */
export function createFileKeyValueStorage(dir: string): TicketStorage {
  const fileFor = (key: string) => path.join(dir, `${key.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`);
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  const write = async (key: string, value: string) => {
    if (closed) return;
    const file = fileFor(key);
    const temp = `${file}.${process.pid}.tmp`;
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(temp, value, { mode: 0o600 });
    await fsp.rename(temp, file);
  };

  return {
    async get(key) {
      try {
        return await fsp.readFile(fileFor(key), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    set(key, value) {
      const op = queue.then(() => write(key, value));
      queue = op.catch(() => undefined);
      return op;
    },
    async remove(key) {
      await fsp.rm(fileFor(key), { force: true });
    },
    close() {
      closed = true;
      return queue;
    },
    open() {
      closed = false;
    },
  };
}
