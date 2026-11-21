/**
 * The stored chunks being read right now (PAR-LYR-07). Writing found lyrics into a stored file (PAR-LYR-01) stores it
 * again as new chunks and then removes the old ones; the loudness pass or the player may still be reading the old
 * chunks then (2026-11-21: `download_source_missing` on a song the loudness pass was reading). A reader holds the
 * chunks it reads until it ends, and the old chunks are removed only once none of them is held.
 */
export type ParrotChunkReads = {
  /** Marks `objectKeys` as being read until the returned release is called (a second call of it does nothing). */
  hold(objectKeys: readonly string[]): () => void;
  /** Resolves once none of `objectKeys` is held: true, or false when `timeoutMs` passed first. */
  free(objectKeys: readonly string[], timeoutMs: number): Promise<boolean>;
};

export const createParrotChunkReads = (): ParrotChunkReads => {
  const readers = new Map<string, number>();
  let waiters: Array<() => void> = [];
  const held = (objectKeys: readonly string[]) => objectKeys.some((key) => (readers.get(key) ?? 0) > 0);
  return {
    hold(objectKeys) {
      const keys = [...new Set(objectKeys)];
      for (const key of keys) readers.set(key, (readers.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const key of keys) {
          const left = (readers.get(key) ?? 1) - 1;
          if (left > 0) readers.set(key, left);
          else readers.delete(key);
        }
        const woken = waiters;
        waiters = [];
        for (const wake of woken) wake();
      };
    },
    async free(objectKeys, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (held(objectKeys)) {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, left);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        await promise;
      }
      return true;
    },
  };
};
