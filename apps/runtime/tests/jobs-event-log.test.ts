import { describe, expect, it } from "vitest";
import {
  createEventLog,
  REPLAY_LIMIT_DEFAULT,
  type EventLogDeps,
  type EventRow,
} from "@space/runtime-jobs-engine/eventLog";

const buildStubDeps = (): EventLogDeps & { rows: EventRow[]; nextId: number } => {
  const rows: EventRow[] = [];
  let nextId = 1;
  const deps: EventLogDeps = {
    insert: (row) => {
      const inserted: EventRow = { ...row, eventId: nextId++ };
      rows.push(inserted);
      return inserted;
    },
    selectAfter: (lastEventId, limit) =>
      rows.filter((r) => r.eventId > lastEventId).slice(0, limit),
    selectMaxEventId: () => (rows.length ? rows[rows.length - 1].eventId : 0),
    trim: (beforeIso) => {
      const before = rows.length;
      const remaining = rows.filter((r) => r.createdAt >= beforeIso);
      rows.splice(0, rows.length, ...remaining);
      return before - rows.length;
    },
  };
  return Object.assign(deps, { rows, get nextId() { return nextId; } });
};

const dumpEventLogSnapshot = (label: string, deps: ReturnType<typeof buildStubDeps>, result?: unknown) => {
  try {
    console.error(`=== [jobs-event-log:${label}] snapshot ===`);
    console.error(`rows.length=${deps.rows.length}`);
    console.error(`first 5 rows=${JSON.stringify(deps.rows.slice(0, 5), null, 2)}`);
    console.error(`last 5 rows=${JSON.stringify(deps.rows.slice(-5), null, 2)}`);
    if (result !== undefined) console.error(`result=${JSON.stringify(result, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("createEventLog [jobs-event-log]", () => {
  it("appends events and replay round-trips them in order", () => {
    console.info(`[jobs-event-log:round-trip] appending 3 events across j1+j2`);
    const deps = buildStubDeps();
    const log = createEventLog(deps);
    let result: ReturnType<typeof log.replay> | null = null;

    try {
      log.append("j1", "created", { foo: 1 });
      log.append("j1", "started", { foo: 2 });
      log.append("j2", "created", { foo: 3 });

      result = log.replay(0);
      console.info(`[jobs-event-log:round-trip] result events=${result.events.length} maxEventId=${result.maxEventId}`);

      expect(result.events.map((e) => e.event)).toEqual([
        "created",
        "started",
        "created",
      ]);
      expect(result.replayOverflow).toBe(false);
      expect(result.maxEventId).toBe(3);
    } catch (err) {
      dumpEventLogSnapshot("round-trip-failure", deps, result);
      throw err;
    }
  });

  it("replay with lastEventId=N returns only events with eventId > N", () => {
    console.info(`[jobs-event-log:replay-after] appending 10 events, replay(7)`);
    const deps = buildStubDeps();
    const log = createEventLog(deps);
    let result: ReturnType<typeof log.replay> | null = null;
    try {
      for (let i = 0; i < 10; i++) {
        log.append("j1", "progress", { i });
      }

      result = log.replay(7);
      console.info(`[jobs-event-log:replay-after] ids=${JSON.stringify(result.events.map((e) => e.eventId))}`);

      expect(result.events.map((e) => e.eventId)).toEqual([8, 9, 10]);
      expect(result.replayOverflow).toBe(false);
      expect(result.maxEventId).toBe(10);
    } catch (err) {
      dumpEventLogSnapshot("replay-after-failure", deps, result);
      throw err;
    }
  });

  it("signals replayOverflow when more events exist than the limit", () => {
    console.info(`[jobs-event-log:overflow] appending 12 events, replay(0,5)`);
    const deps = buildStubDeps();
    const log = createEventLog(deps);
    let result: ReturnType<typeof log.replay> | null = null;
    try {
      for (let i = 0; i < 12; i++) {
        log.append("j1", "progress", { i });
      }

      result = log.replay(0, 5);
      console.info(`[jobs-event-log:overflow] events=${result.events.length} overflow=${result.replayOverflow}`);

      expect(result.events.length).toBe(5);
      expect(result.replayOverflow).toBe(true);
      expect(result.events[0].eventId).toBe(1);
      expect(result.events[4].eventId).toBe(5);
    } catch (err) {
      dumpEventLogSnapshot("overflow-failure", deps, result);
      throw err;
    }
  });

  it("does NOT signal replayOverflow when exactly limit events fit", () => {
    console.info(`[jobs-event-log:exact-limit] appending 5 events, replay(0,5)`);
    const deps = buildStubDeps();
    const log = createEventLog(deps);
    let result: ReturnType<typeof log.replay> | null = null;
    try {
      for (let i = 0; i < 5; i++) {
        log.append("j1", "progress", { i });
      }
      result = log.replay(0, 5);
      console.info(`[jobs-event-log:exact-limit] events=${result.events.length} overflow=${result.replayOverflow}`);
      expect(result.events.length).toBe(5);
      expect(result.replayOverflow).toBe(false);
    } catch (err) {
      dumpEventLogSnapshot("exact-limit-failure", deps, result);
      throw err;
    }
  });

  it("uses 5000 as the default replay cap", () => {
    console.info(`[jobs-event-log:default-cap] REPLAY_LIMIT_DEFAULT=${REPLAY_LIMIT_DEFAULT}`);
    expect(REPLAY_LIMIT_DEFAULT).toBe(5000);
  });

  it("appends with default channel runtime.jobs", () => {
    console.info(`[jobs-event-log:default-channel] expecting row.channel=runtime.jobs`);
    const deps = buildStubDeps();
    const log = createEventLog(deps);
    const row = log.append("j1", "created", {});
    try {
      expect(row.channel).toBe("runtime.jobs");
    } catch (err) {
      dumpEventLogSnapshot("default-channel-failure", deps, row);
      throw err;
    }
  });

  it("respects an explicit channel argument", () => {
    console.info(`[jobs-event-log:explicit-channel] passing custom.channel`);
    const deps = buildStubDeps();
    const log = createEventLog(deps);
    const row = log.append("j1", "created", {}, "custom.channel");
    try {
      expect(row.channel).toBe("custom.channel");
    } catch (err) {
      dumpEventLogSnapshot("explicit-channel-failure", deps, row);
      throw err;
    }
  });

  it("encodes the payload as JSON in payloadJson", () => {
    console.info(`[jobs-event-log:payload-json] payload={a:1,b:"two"}`);
    const deps = buildStubDeps();
    const log = createEventLog(deps);
    const row = log.append("j1", "created", { a: 1, b: "two" });
    try {
      expect(JSON.parse(row.payloadJson)).toEqual({ a: 1, b: "two" });
    } catch (err) {
      dumpEventLogSnapshot("payload-json-failure", deps, row);
      throw err;
    }
  });

  it("trim removes events older than the threshold", () => {
    console.info(`[jobs-event-log:trim] inserting old(2026-01-01)+new(2026-04-01), cutoff=now → expect removed=2`);
    const deps = buildStubDeps();
    const log = createEventLog(deps);
    let removed = -1;
    try {
      // Force-insert with handcrafted createdAt by going through deps directly.
      deps.insert({
        jobId: "j1",
        channel: "runtime.jobs",
        event: "created",
        payloadJson: "{}",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      deps.insert({
        jobId: "j1",
        channel: "runtime.jobs",
        event: "succeeded",
        payloadJson: "{}",
        createdAt: "2026-04-01T00:00:00.000Z",
      });

      removed = log.trimTerminalsOlderThan(0); // cutoff = now → removes both
      console.info(`[jobs-event-log:trim] removed=${removed}`);
      expect(removed).toBe(2);
    } catch (err) {
      dumpEventLogSnapshot("trim-failure", deps, { removed });
      throw err;
    }
  });
});
