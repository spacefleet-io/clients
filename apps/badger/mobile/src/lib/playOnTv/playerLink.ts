/**
 * The TV app's link between the "Play on TV" receiver (`src/tv/lib/playOnTvReceiver.ts`) and the player screen that is
 * open (UX-TV-02): the player attaches what it can do (apply a remote command, describe its state) and publishes its
 * state; the receiver forwards that state to the phone. One player at a time, module-level like the navigation ref.
 */
import type { RemoteCommand, TvState } from "./protocol";

export type RemotePlayer = {
  /** Applies a command; resolves to an error code (`no_such_track`, ...) or null when it was applied. */
  apply: (command: Exclude<RemoteCommand, { type: "hello" } | { type: "start" }>) => Promise<string | null>;
  state: () => TvState;
};

export type RemotePlayerEvent =
  | { kind: "attached" }
  /** `handover`: the player closed to open the next episode, so the session goes on. */
  | { kind: "detached"; last: TvState; handover: boolean }
  | { kind: "state"; state: TvState };

let current: RemotePlayer | null = null;
const listeners = new Set<(event: RemotePlayerEvent) => void>();

const emit = (event: RemotePlayerEvent) => {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn("tv.cast.link.listener_failed", JSON.stringify({ error: String(error) }));
    }
  }
};

/** Called by the player screen on mount (TV only); the returned function detaches it on unmount. */
export const attachRemotePlayer = (player: RemotePlayer): ((handover?: boolean) => void) => {
  current = player;
  emit({ kind: "attached" });
  return (handover = false) => {
    if (current !== player) return;
    const last = player.state();
    current = null;
    emit({ kind: "detached", last, handover });
  };
};

export const currentRemotePlayer = (): RemotePlayer | null => current;

export const publishRemoteState = (state: TvState): void => emit({ kind: "state", state });

/** True while a receiver listens: the player only builds and sends states then. */
export const remoteStateWanted = (): boolean => listeners.size > 0;

export const onRemotePlayerEvent = (listener: (event: RemotePlayerEvent) => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test seam: forget the attached player and every listener. */
export const __resetRemotePlayerLinkForTests = () => {
  current = null;
  listeners.clear();
};
