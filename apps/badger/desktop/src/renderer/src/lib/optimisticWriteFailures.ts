/**
 * #25 P5: bookkeeping for failed optimistic library writes.
 *
 * A runtime restart fails every write in flight at once. In the ultimate
 * stress run that was 247-506 progress writes within ~3 s, and each one
 * rolled the UI back (one full library re-render) and raised its own error
 * toast. The renderer then spun a full core for 2.5-9 minutes working through
 * hundreds of toasts and re-renders.
 *
 * This tracker makes the failure path O(1) per burst:
 *   - Rollback only when the failed write is still the newest optimistic
 *     write for its field (`key`). An older write's rollback would restore a
 *     value that a newer optimistic write already replaced, which is both
 *     wasted work and wrong (it reverts the newer value).
 *   - One toast per message per `coalesceWindowMs`; further failures in the
 *     window are counted and logged as one summary when the window closes.
 */

export const OPTIMISTIC_FAILURE_TOAST_WINDOW_MS = 10_000;

export type OptimisticWriteFailureDeps = {
  notifyError: (message: string) => void;
  log: (fields: Record<string, unknown>, message: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  coalesceWindowMs?: number;
};

export type OptimisticWriteTicket = { key: string | null; seq: number };

export type OptimisticWriteTracker = {
  /** Register a new optimistic write for `key` (null = unkeyed, always rolled back). */
  begin: (key: string | null) => OptimisticWriteTicket;
  /** The write persisted. */
  succeeded: (ticket: OptimisticWriteTicket) => void;
  /** The write failed: roll back if still newest for its key, toast unless coalesced. */
  failed: (ticket: OptimisticWriteTicket, rollback: () => void, message: string, error: unknown) => void;
};

type ToastWindow = { openedAt: number; suppressed: number };

export const createOptimisticWriteTracker = (deps: OptimisticWriteFailureDeps): OptimisticWriteTracker => {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const windowMs = deps.coalesceWindowMs ?? OPTIMISTIC_FAILURE_TOAST_WINDOW_MS;
  const latestSeqByKey = new Map<string, number>();
  const toastWindows = new Map<string, ToastWindow>();
  let seq = 0;

  const forgetIfLatest = (ticket: OptimisticWriteTicket) => {
    if (ticket.key !== null && latestSeqByKey.get(ticket.key) === ticket.seq) latestSeqByKey.delete(ticket.key);
  };

  return {
    begin: (key) => {
      seq += 1;
      if (key !== null) latestSeqByKey.set(key, seq);
      return { key, seq };
    },
    succeeded: forgetIfLatest,
    failed: (ticket, rollback, message, error) => {
      const superseded = ticket.key !== null && latestSeqByKey.get(ticket.key) !== ticket.seq;
      forgetIfLatest(ticket);
      if (!superseded) rollback();

      const at = now();
      const current = toastWindows.get(message);
      const coalesced = current !== undefined && at - current.openedAt < windowMs;
      if (coalesced) {
        current.suppressed += 1;
      } else {
        const opened: ToastWindow = { openedAt: at, suppressed: 0 };
        toastWindows.set(message, opened);
        deps.notifyError(message);
        setTimer(() => {
          if (toastWindows.get(message) === opened) toastWindows.delete(message);
          if (opened.suppressed > 0) {
            deps.log(
              { event: "optimistic_write_failures_coalesced", message, suppressedToasts: opened.suppressed, windowMs },
              "optimistic write failures coalesced into one toast",
            );
          }
        }, windowMs);
      }
      deps.log(
        {
          event: "optimistic_write_failed",
          key: ticket.key,
          rolledBack: !superseded,
          toastCoalesced: coalesced,
          message: error instanceof Error ? error.message : String(error),
        },
        "optimistic write failed; reverted UI",
      );
    },
  };
};
