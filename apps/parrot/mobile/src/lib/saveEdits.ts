// Saving changes from the phone (playlists and hearts PAR-PL-02/03/04, edits PAR-META-16, deletes PAR-LIB-03): the
// changes become library ops on the phone's open copy, which is published as the account's next encrypted snapshot.
// The loop is the one every Parrot client shares (`publishParrotEditsWith`, @space/parrot-core) and the snapshot
// steps are the shared platform-neutral ones (@space/library-db-definition/snapshotPublish); this module only says
// how the phone opens, changes and reads its SQLite copy, so it runs in a test without React Native.
import {
  isParrotPublishConflict,
  parrotOpStatements,
  parrotPlaylistEditOps,
  publishParrotEditsWith,
  type ParrotPlaylist,
  type ParrotPlaylistEdit,
} from "@space/parrot-core";
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type { ParrotSqlStatement } from "@space/parrot-library-db-definition/ops";
import { publishLibrarySnapshotWith, type LibrarySnapshotPublishDeps } from "@space/library-db-definition/snapshotPublish";

/** The open library as a save sees it: the server version it was read at and its playlists. */
export type PhoneLibraryState = { baseVersion: number; playlists: ParrotPlaylist[] };

export type PhoneSaveDeps = {
  /** The library open on the phone now. */
  current: () => Promise<PhoneLibraryState>;
  /** Downloads and opens the account's latest snapshot in place of the open one (another device published first). */
  loadLatest: () => Promise<PhoneLibraryState>;
  /** Runs the statements on the open library in one transaction. */
  run: (statements: readonly ParrotSqlStatement[]) => Promise<void>;
  /** The open library's SQLite file, every change written. */
  readBytes: () => Promise<Uint8Array>;
  /** Marks the open library as the server's `version` once it is published. */
  published: (version: number) => void;
  /** After a failed save: the server's library again, so the screens never show a change the server lacks. */
  reload: () => Promise<void>;
  /**
   * Copies the open library before a save changes it; the function it returns puts that copy back. Used when the
   * server's library cannot be opened after a failed save (no connection), so the change is still undone (PAR-PL-03).
   */
  keep: () => Promise<() => Promise<void>>;
  /** The open library changed (a change was written into it, or undone): the screens read it again at once. */
  changed: () => void;
  snapshot: LibrarySnapshotPublishDeps;
  now: () => number;
  newId: () => string;
  log?: (message: string) => void;
};

/** Plans a change on the library open now; run again on a newer library after another device published first. */
export type PhoneOpsBuild = (library: PhoneLibraryState) => readonly ParrotLibraryOp[] | Promise<readonly ParrotLibraryOp[]>;

/**
 * One save at a time, each built on the library the previous one left: playlists, edits and deletes share it.
 * `serial` runs a whole save (planning, storage, publish) in that order; `publish` applies and publishes ops from
 * inside it, resolving to the published version. On any failure the server's library is opened again and the error
 * rethrown (the screen undoes its change and says so).
 */
export const createPhoneOpsSaver = (deps: PhoneSaveDeps) => {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
  const publish = async (label: string, ops: readonly ParrotLibraryOp[], build: PhoneOpsBuild): Promise<number> => {
    const opened = await deps.current();
    const state = { db: opened, baseVersion: opened.baseVersion };
    const restore = await deps.keep();
    try {
      // The change shows at once: written into the open copy, then published in the background (PAR-PL-03).
      await deps.run(parrotOpStatements(ops));
      deps.changed();
      const version = await publishParrotEditsWith(state, build, {
        loadLatest: async () => {
          const latest = await deps.loadLatest();
          return { db: latest, baseVersion: latest.baseVersion };
        },
        applyOps: async (_library, replayed) => {
          await deps.run(parrotOpStatements(replayed));
          deps.changed();
        },
        publish: async (_library, baseVersion) => (await publishLibrarySnapshotWith(await deps.readBytes(), baseVersion, deps.snapshot)).version,
        isConflict: isParrotPublishConflict,
        log: deps.log,
      });
      deps.published(version);
      return version;
    } catch (error) {
      deps.log?.(`[parrot-save] ${label} not saved (${error instanceof Error ? error.message : String(error)})`);
      try {
        await deps.reload();
      } catch (reloadError) {
        deps.log?.(`[parrot-save] reload after the failed save failed (${String(reloadError)}); putting the copy from before the change back`);
        await restore().catch((restoreError: unknown) => deps.log?.(`[parrot-save] putting the copy back failed (${String(restoreError)})`));
      }
      deps.changed();
      throw error;
    }
  };
  /** Plans `build` on the open library and publishes it, in turn. */
  const save = (label: string, build: PhoneOpsBuild): Promise<number> =>
    serial(async () => publish(label, await build(await deps.current()), build));
  /** Playlist and heart edits (PAR-PL-02/03/04). */
  const savePlaylistEdits = (edits: readonly ParrotPlaylistEdit[]): Promise<number> =>
    save(`${edits.length} playlist edit(s)`, (library) => parrotPlaylistEditOps(library.playlists, edits, { now: deps.now(), newId: deps.newId }));
  return { serial, publish, save, savePlaylistEdits };
};
