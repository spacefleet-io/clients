// Which opened library databases main may close, and when. The window reads the current library at any time
// (`parrot:library:get`, the kept songs, playback), and a save holds the database it started on across its publish;
// closing either under them answered "database is not open" during every import. A database is closed only once it
// is neither the current library nor held by a save.

export type LibraryDbs<Db> = {
  /** The library the window reads, or null. */
  current: () => Db | null;
  /** Makes `next` the current library; the previous one is closed once no save holds it. */
  setCurrent: (next: Db | null) => void;
  /** This database is no longer needed by its caller: it closes now, or once it stops being current and held. */
  retire: (db: Db) => void;
  /** Runs `work` holding `db` open, even when it stops being current meanwhile. */
  hold: <T>(db: Db, work: () => Promise<T>) => Promise<T>;
};

export const createLibraryDbs = <Db extends object>(close: (db: Db) => void, log?: (line: string) => void): LibraryDbs<Db> => {
  let current: Db | null = null;
  const holds = new Map<Db, number>();
  const retired = new Set<Db>();
  const closed = new WeakSet<Db>();

  const closeIfFree = (db: Db) => {
    if (db === current || (holds.get(db) ?? 0) > 0 || !retired.has(db)) return;
    retired.delete(db);
    if (closed.has(db)) return;
    closed.add(db);
    try {
      close(db);
    } catch (error) {
      log?.(`[library] could not close a replaced library: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const retire = (db: Db) => {
    if (closed.has(db)) return;
    retired.add(db);
    closeIfFree(db);
  };

  return {
    current: () => current,
    setCurrent: (next) => {
      const previous = current;
      current = next;
      if (next) retired.delete(next);
      if (previous && previous !== next) retire(previous);
    },
    retire,
    hold: async (db, work) => {
      holds.set(db, (holds.get(db) ?? 0) + 1);
      try {
        return await work();
      } finally {
        const left = (holds.get(db) ?? 1) - 1;
        if (left > 0) holds.set(db, left);
        else holds.delete(db);
        closeIfFree(db);
      }
    },
  };
};
