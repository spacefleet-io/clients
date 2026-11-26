/**
 * Append-only event ring buffer per plan §5.
 *
 * The persistent event log lives in the `runtime_job_events` table; this
 * module is the in-process surface around it. I/O is parametrised via `deps`
 * so this stays unit-testable without a SQLite driver.
 *
 * Replay protocol: clients ack the highest `eventId` they have seen, the
 * server returns every event with `eventId > lastEventId` capped at
 * `REPLAY_LIMIT_DEFAULT = 5000`. If more events are pending past the cap, the
 * server signals `replayOverflow: true` and the client falls back to a single
 * `runtime.jobs.list` snapshot fetch.
 */

export type EventRow = {
  eventId: number;
  jobId: string;
  channel: string;
  event: string;
  payloadJson: string;
  createdAt: string;
};

export type EventLogDeps = {
  /** Insert a row and return it with its assigned `eventId`. */
  insert(row: Omit<EventRow, "eventId">): EventRow;
  /**
   * Return up to `limit` events with `eventId > lastEventId`, ordered by
   * `eventId` ascending. Caller passes `limit + 1` to detect overflow.
   */
  selectAfter(lastEventId: number, limit: number): EventRow[];
  /** Highest `eventId` currently in the table (or 0 if empty). */
  selectMaxEventId(): number;
  /**
   * Delete events with `created_at < beforeIso`, at most `limit` of them when
   * given. Returns count deleted.
   */
  trim(beforeIso: string, limit?: number): number;
};

export type ReplayResult = {
  events: EventRow[];
  replayOverflow: boolean;
  maxEventId: number;
};

export const REPLAY_LIMIT_DEFAULT = 5000;
export const DEFAULT_CHANNEL = "runtime.jobs";

export type EventLog = {
  append(
    jobId: string,
    event: string,
    payload: Record<string, unknown>,
    channel?: string
  ): EventRow;
  replay(lastEventId: number, limit?: number): ReplayResult;
  /** Highest `eventId` (0 when empty): one indexed lookup, no row replay. */
  maxEventId(): number;
  /**
   * Delete events older than `hours`, at most `limit` per call so a caller can
   * work through a big backlog without blocking the event loop.
   */
  trimTerminalsOlderThan(hours: number, limit?: number): number;
};

/**
 * Build the EventLog facade over the supplied I/O seam.
 */
export function createEventLog(deps: EventLogDeps): EventLog {
  return {
    append(
      jobId: string,
      event: string,
      payload: Record<string, unknown>,
      channel: string = DEFAULT_CHANNEL
    ): EventRow {
      return deps.insert({
        jobId,
        channel,
        event,
        payloadJson: JSON.stringify(payload ?? {}),
        createdAt: new Date().toISOString(),
      });
    },

    /**
     * Probe with `limit + 1`. If we got more than `limit` rows back, there is
     * at least one more event past the window — return the first `limit` and
     * raise `replayOverflow`. Otherwise return everything.
     */
    replay(lastEventId: number, limit: number = REPLAY_LIMIT_DEFAULT): ReplayResult {
      const probe = deps.selectAfter(lastEventId, limit + 1);
      const replayOverflow = probe.length > limit;
      const events = replayOverflow ? probe.slice(0, limit) : probe;
      return {
        events,
        replayOverflow,
        maxEventId: deps.selectMaxEventId(),
      };
    },

    maxEventId(): number {
      return deps.selectMaxEventId();
    },

    trimTerminalsOlderThan(hours: number, limit?: number): number {
      const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
      return deps.trim(cutoff, limit);
    },
  };
}
