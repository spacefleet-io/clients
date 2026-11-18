/**
 * #25: durable, main-process copy of the signed-in session.
 *
 * Why it exists: the renderer keeps the session (auth token, cached user,
 * library key) ONLY in Chromium `localStorage`. Chromium commits that to its
 * LevelDB lazily (batched, ~5 s after a write) and the app has no say in how the
 * storage comes back after a SIGKILL / crash — on the e2e relaunch loop about
 * 30% of relaunches rendered the Login page with an empty `localStorage` while
 * the LevelDB on disk was intact. A real user would be signed out after a crash.
 * SIGKILL runs no handler, so the fix cannot be "flush on exit": the session is
 * written here, fsynced, at the moment it changes (before `replace()` resolves),
 * and the renderer refills an empty `localStorage` from it
 * (renderer/lib/sessionMirror.ts).
 *
 * The file is a `@space/desktop-platform/secret-file`: sealed with Electron's
 * ASYNC safeStorage API (spec ACCT-AUTH-08), a login only the legacy sync
 * `decryptString` opens (Linux KDE) is re-sealed with `encryptStringAsync`, and
 * writes are tmp file → fsync → rename → fsync(dir). Because decryption is async,
 * `load()` must resolve before the first window is created: the preload reads the
 * snapshot over a synchronous IPC and `read()` only serves the loaded copy.
 *
 * File format `<userData>/session.json` (owner-only, mode 0600), unchanged since
 * the sync API (`envelopeSecretFormat`):
 *   { v: 1, enc: "safeStorage", data: <base64 of safeStorage encryption of json> }
 *   { v: 1, enc: "plain",       data: <json string> }   // no OS keyring available
 * where json = JSON.stringify(SessionEntries).
 *
 * Loads and writes run one at a time, in call order, so a slower encryption can
 * never let an older session overwrite a newer one.
 */
import { createSecretFile, envelopeSecretFormat, type SecretSafeStorage } from "@space/desktop-platform/secret-file";
import { sanitizeSessionEntries, type SessionEntries } from "../shared/sessionKeys";

export type SessionStore = {
  /**
   * Read and decrypt the persisted session once. Never rejects: an unreadable
   * file is "no session" (logged). Resolve it before creating the first window.
   */
  load: () => Promise<SessionEntries>;
  /** The loaded entries; `{}` when there is no (readable) session. Throws before `load()` resolved. */
  read: () => SessionEntries;
  /** Replace the persisted entries with exactly `entries` (durable when it resolves). Rejects on a write failure. */
  replace: (entries: unknown) => Promise<void>;
};

const sameEntries = (a: SessionEntries, b: SessionEntries): boolean => {
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => a[key] === b[key]);
};

export const createSessionStore = (options: {
  filePath: string;
  safeStorage: SecretSafeStorage | null;
  log: (line: string) => void;
}): SessionStore => {
  const { filePath, log } = options;
  const file = createSecretFile({
    path: filePath,
    format: envelopeSecretFormat,
    safeStorage: options.safeStorage,
    log,
    label: "session-store",
  });
  let cache: SessionEntries | null = null;
  let loading: Promise<SessionEntries> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /** Run `task` after every earlier load/replace has settled. */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  /** Only call from inside an `enqueue`d task. */
  const ensureLoaded = async (): Promise<SessionEntries> => {
    if (cache !== null) return cache;
    const json = await file.read();
    let entries: SessionEntries = {};
    if (json !== null) {
      try {
        entries = sanitizeSessionEntries(JSON.parse(json));
        log(`[session-store] loaded ${Object.keys(entries).length} entries`);
      } catch (err) {
        log(`[session-store] unreadable ${filePath}, treating as no session: ${String(err)}`);
      }
    }
    cache = entries;
    return entries;
  };

  const load = (): Promise<SessionEntries> => {
    loading ??= enqueue(ensureLoaded);
    return loading.then((entries) => ({ ...entries }));
  };

  const read = (): SessionEntries => {
    if (cache === null) throw new Error("session store read before load() resolved");
    return { ...cache };
  };

  const replace = (input: unknown): Promise<void> => {
    const next = sanitizeSessionEntries(input);
    return enqueue(async () => {
      const current = await ensureLoaded();
      if (sameEntries(current, next)) return;
      try {
        await file.write(JSON.stringify(next));
      } catch (err) {
        // Fail closed: if this write was meant to drop the token (logout / 401) and
        // could not land, the old file would bring the signed-out session back on the
        // next launch. Losing the library-key mirror is acceptable, resurrecting a
        // logged-out token is not.
        if (current.sf_client_token !== undefined && next.sf_client_token === undefined) {
          cache = {};
          file.remove();
        }
        throw err;
      }
      cache = next;
      log(`[session-store] persisted ${Object.keys(next).length} entries`);
    });
  };

  return { load, read, replace };
};
