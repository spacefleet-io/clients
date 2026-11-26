/**
 * PAR-UP-15: what an import's uploads do while a song plays on this computer. The desktop feeds content-core's
 * UploadPlaybackGate (the one Badger's runtime uses, #25) with Parrot's playing state and this computer's choice
 * (full / throttle / pause); the importer only reads it. `createParrotChunkSlots` holds every chunk of the import (all
 * songs, originals and light copies) to the gate's `maxConcurrency()`: Infinity in full, 2 in throttle, 0 in pause
 * (no new chunk starts; the ones in flight finish), and waits `pacingMs()` after a chunk before its slot takes the next.
 */

/** The part of content-core's UploadPlaybackGate the importer reads. */
export type ParrotPlaybackGate = {
  maxConcurrency: () => number;
  pacingMs: () => number;
  subscribe: (listener: () => void) => () => void;
};

export type ParrotChunkSlots = {
  /** Waits for a free slot (the gate allowing one more chunk); returns its release, which applies the gate's pacing. */
  take: (signal?: AbortSignal) => Promise<() => Promise<void>>;
  /** Waits while the gate starts nothing (pause): a light copy is not encoded then either. */
  whileHeld: (signal?: AbortSignal) => Promise<void>;
};

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const createParrotChunkSlots = (gate?: ParrotPlaybackGate, log?: (message: string) => void): ParrotChunkSlots => {
  let inFlight = 0;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  gate?.subscribe(wake);
  // Resolves once `ready()` holds, re-checking on every gate change and freed slot; rejects when `signal` aborts.
  // `ready` also claims what it checked (in the same tick), so two waiters woken together never both take the last slot.
  const until = async (ready: () => boolean, signal: AbortSignal | undefined, held: string) => {
    signal?.throwIfAborted();
    if (ready()) return;
    log?.(`[parrot-import] ${held} while a song plays (${gate?.maxConcurrency()} chunks allowed)`);
    for (;;) {
      signal?.throwIfAborted();
      const { promise, resolve } = Promise.withResolvers<void>();
      const onAbort = () => resolve();
      waiters.add(resolve);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await promise;
      } finally {
        waiters.delete(resolve);
        signal?.removeEventListener("abort", onAbort);
      }
      signal?.throwIfAborted();
      if (ready()) return;
    }
  };
  const allowed = () => gate?.maxConcurrency() ?? Number.POSITIVE_INFINITY;
  return {
    async take(signal) {
      const claim = () => {
        if (inFlight >= allowed()) return false;
        inFlight += 1;
        return true;
      };
      await until(claim, signal, "chunk held");
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const pacing = gate?.pacingMs() ?? 0;
        if (pacing > 0) await sleep(pacing);
        inFlight -= 1;
        wake();
      };
    },
    whileHeld: (signal) => until(() => allowed() > 0, signal, "light copy held"),
  };
};
