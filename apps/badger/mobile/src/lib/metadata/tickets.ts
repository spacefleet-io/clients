/**
 * When the anonymous-ticket reserve runs (META-ANON-02).
 *
 * The reserve (`@space/metadata-client`) refills on its own schedule, only while someone is signed in and the app is
 * in the foreground. This controller is the single place that calls `start()` / `stop()`:
 *   - signed in + foreground: `start()` (a low-water check at once, then the library's own jittered ~6 h schedule);
 *   - background, or signed out: `stop()` (the timer is dropped; the next foreground starts again);
 *   - sign-out: `stop()`, wait for a refill that was already on the wire, then erase the stored tickets.
 * Nothing else triggers a refill: taking a ticket for an image lookup never does.
 *
 * Pure logic (the reserve and the eraser are injected) so it is unit-testable without React Native.
 */
import type { TicketReserve } from "@space/metadata-client";

export type TicketLifecycleDeps = {
  reserve: Pick<TicketReserve, "start" | "stop" | "refill">;
  /** Receives the session token (or null) so the reserve's `getAuth` always reads the current one. */
  setSessionToken: (token: string | null) => void;
  /** Removes every stored ticket (and whatever else the app keeps for the session, e.g. cached artwork) from the device. */
  eraseOnSignOut: () => Promise<void>;
  /**
   * Runs a start after the current interactions (the first refills blind tickets on the JS thread). Default: at once.
   * A start that was superseded (stop, sign-out) by the time it runs is skipped.
   */
  defer?: (run: () => void) => void;
  /** Signed in and in the foreground (again): whatever was waiting for tickets may try now. */
  onResume?: () => void;
};

export type TicketLifecycle = {
  /** The signed-in session token, or null once signed out. */
  setSessionToken: (token: string | null) => void;
  /** false only while the app is in the background. */
  setForeground: (foreground: boolean) => void;
  /** Call once when the app has found that no session is stored: erases whatever a sign-out that never finished left behind. */
  eraseWithoutSession: () => void;
  /** Resolves when every queued start/stop/erase step has run (tests, shutdown). */
  settled: () => Promise<void>;
};

export const createTicketLifecycle = (deps: TicketLifecycleDeps): TicketLifecycle => {
  const { reserve } = deps;
  const defer = deps.defer ?? ((run: () => void) => run());
  let token: string | null = null;
  let foreground = true;
  // Bumped by every start decision and every stop: a deferred start that is no longer current does nothing.
  let generation = 0;
  // Erase and restart steps run one after another so a quick sign-out then sign-in cannot erase the new session's tickets.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void> | void) => {
    queue = queue.then(step).catch(() => undefined);
  };

  const stopNow = () => {
    generation += 1;
    reserve.stop();
  };

  const sync = () => {
    if (token !== null && foreground) {
      generation += 1;
      const current = generation;
      // Not awaited: the first refill can take a while on the network; start() never rejects.
      defer(() => {
        if (current === generation) void reserve.start();
      });
      deps.onResume?.();
    } else {
      stopNow();
    }
  };

  return {
    setSessionToken(next) {
      if (next === token) return;
      const signedOut = next === null;
      token = next;
      deps.setSessionToken(next);
      if (signedOut) {
        // Stop at once, then drain: with no session `getAuth` answers null, so refill() here never reaches the network;
        // it only waits for a batch that was already sent, so that batch cannot land after the erase below.
        stopNow();
        enqueue(async () => {
          // A new session may already be signed in by now; its refill is not ours to trigger here.
          if (token === null) await reserve.refill().catch(() => undefined);
          await deps.eraseOnSignOut();
        });
        return;
      }
      enqueue(sync);
    },
    setForeground(next) {
      if (next === foreground) return;
      foreground = next;
      if (!foreground) stopNow();
      enqueue(sync);
    },
    eraseWithoutSession() {
      // Cold start with no stored session: an app killed in the middle of a sign-out never ran its erase.
      enqueue(async () => {
        if (token === null) await deps.eraseOnSignOut();
      });
    },
    settled: () => queue,
  };
};
