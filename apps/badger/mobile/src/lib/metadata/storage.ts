/**
 * The reserve's key/value storage with a sign-out erase that cannot be undone by a write already in flight.
 *
 * The reserve serialises its own reads and writes behind one in-process lock, but erasing the stored tickets from the
 * outside (`remove`) bypasses that lock: a `take()` that had already read the blob would write it back afterwards and
 * the tickets of the signed-out account would be there for the next one. `erase()` therefore closes the storage first
 * (reads answer "nothing", a write throws, so the reserve neither hands out a ticket nor stores one), waits for every
 * operation already started, removes the key, and only then opens the storage again.
 */
import type { KeyValueStorage } from "@space/metadata-client";

export class StorageClosedError extends Error {
  constructor() {
    super("ticket storage is being erased");
    this.name = "StorageClosedError";
  }
}

export type ErasableStorage = KeyValueStorage & {
  /** Removes `key` once every operation already started has finished; operations started meanwhile do not touch the store. */
  erase: (key: string) => Promise<void>;
};

export const createErasableStorage = (base: KeyValueStorage): ErasableStorage => {
  let erasing = 0;
  const isClosed = () => erasing > 0;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    const done = () => pending.delete(operation);
    operation.then(done, done);
    return operation;
  };

  return {
    get: (key) => (isClosed() ? Promise.resolve(null) : track(base.get(key))),
    set: (key, value) => (isClosed() ? Promise.reject(new StorageClosedError()) : track(base.set(key, value))),
    remove: (key) => (isClosed() ? Promise.resolve() : track(base.remove(key))),
    async erase(key) {
      erasing += 1;
      try {
        await Promise.allSettled([...pending]);
        await base.remove(key);
      } finally {
        erasing -= 1;
      }
    },
  };
};
