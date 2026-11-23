import { useMemo, useSyncExternalStore, type ComponentType } from "react";

/**
 * The playing song's position, kept outside the library's state (#3350 C4): the player writes it at every tick, and
 * only the parts that show it (Home's "Resume 1:18", the Now playing page) read it, so the rest of the window — the
 * song list, the tiles — is not drawn again every second while music plays.
 */
export type PlayerClock = {
  read: () => number;
  write: (ms: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createPlayerClock(): PlayerClock {
  let current = 0;
  const listeners = new Set<() => void>();
  return {
    read: () => current,
    write: (ms) => {
      if (ms === current) return;
      current = ms;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const usePlayerClockStore = () => useMemo(createPlayerClock, []);

export function usePlayerClock(clock: PlayerClock): number {
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read);
}

/** `Component` drawn with the clock's position, again at each change; nothing above it redraws. */
export function withPlayerClock<P extends { positionMs: number }>(Component: ComponentType<P>) {
  function Clocked({ clock, ...rest }: Omit<P, "positionMs"> & { clock: PlayerClock }) {
    return <Component {...(rest as unknown as P)} positionMs={usePlayerClock(clock)} />;
  }
  Clocked.displayName = `withPlayerClock(${Component.displayName ?? Component.name})`;
  return Clocked;
}
