import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSqliteRuntimeJobsStore,
  type SqliteRuntimeJobsStore,
} from "@space/runtime-jobs-engine/sqliteStore";
import { createSqliteEventLogDeps } from "@space/runtime-jobs-engine/sqliteEventLogDeps";
import { createEventLog } from "@space/runtime-jobs-engine/eventLog";

const dumpSqliteEventLogSnapshot = (label: string, store: SqliteRuntimeJobsStore | null) => {
  try {
    if (!store) {
      console.error(`=== [jobs-sqlite-event-log-deps:${label}] no store available ===`);
      return;
    }
    const deps = createSqliteEventLogDeps(store.db);
    const allEvents = deps.selectAfter(0, 100);
    console.error(`=== [jobs-sqlite-event-log-deps:${label}] snapshot ===`);
    console.error(`event count=${allEvents.length}`);
    console.error(`first 10 events:\n${JSON.stringify(allEvents.slice(0, 10), null, 2)}`);
    console.error(`last 5 events:\n${JSON.stringify(allEvents.slice(-5), null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("createSqliteEventLogDeps [jobs-sqlite-event-log-deps]", () => {
  let store: SqliteRuntimeJobsStore;
  let log: ReturnType<typeof createEventLog>;

  beforeEach(() => {
    console.info(`[jobs-sqlite-event-log-deps:before-each] opening :memory: sqlite store + event log`);
    store = createSqliteRuntimeJobsStore(":memory:");
    log = createEventLog(createSqliteEventLogDeps(store.db));
  });

  afterEach(() => {
    console.info(`[jobs-sqlite-event-log-deps:after-each] closing sqlite store`);
    store.close();
  });

  it("insert assigns autoincrement event_id and returns the row", () => {
    console.info(`[jobs-sqlite-event-log-deps:insert-autoincrement] appending single event j1/created`);
    try {
      const row = log.append("j1", "created", { foo: 1 });
      expect(row.eventId).toBe(1);
      expect(row.jobId).toBe("j1");
      expect(row.event).toBe("created");
      expect(JSON.parse(row.payloadJson)).toEqual({ foo: 1 });
    } catch (err) {
      dumpSqliteEventLogSnapshot("insert-autoincrement-failure", store);
      throw err;
    }
  });

  it("selectAfter returns events with eventId > lastEventId in order, capped at limit", () => {
    console.info(`[jobs-sqlite-event-log-deps:select-after-cap] appending 100 events then replay(0,50)`);
    try {
      for (let i = 0; i < 100; i++) log.append("j1", "progress", { i });
      const replay = log.replay(0, 50);
      console.info(
        `[jobs-sqlite-event-log-deps:select-after-cap] got events=${replay.events.length} overflow=${replay.replayOverflow}`,
      );
      expect(replay.events).toHaveLength(50);
      expect(replay.events[0].eventId).toBe(1);
      expect(replay.events[49].eventId).toBe(50);
      expect(replay.replayOverflow).toBe(true);
    } catch (err) {
      dumpSqliteEventLogSnapshot("select-after-cap-failure", store);
      throw err;
    }
  });

  it("selectAfter respects checkpoints", () => {
    console.info(`[jobs-sqlite-event-log-deps:checkpoint] appending 30 then replay(20)`);
    try {
      for (let i = 0; i < 30; i++) log.append("j1", "progress", { i });
      const replay = log.replay(20);
      console.info(`[jobs-sqlite-event-log-deps:checkpoint] event ids=${JSON.stringify(replay.events.map((e) => e.eventId))}`);
      expect(replay.events.map((e) => e.eventId)).toEqual([
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
      ]);
    } catch (err) {
      dumpSqliteEventLogSnapshot("checkpoint-failure", store);
      throw err;
    }
  });

  it("selectMaxEventId returns 0 when empty and the highest id otherwise", () => {
    console.info(`[jobs-sqlite-event-log-deps:max-event-id] empty→0, two appends→2`);
    try {
      expect(log.replay(0).maxEventId).toBe(0);
      log.append("j1", "created", {});
      log.append("j1", "started", {});
      expect(log.replay(0).maxEventId).toBe(2);
    } catch (err) {
      dumpSqliteEventLogSnapshot("max-event-id-failure", store);
      throw err;
    }
  });

  it("trim deletes events older than the cutoff and returns the count", () => {
    console.info(`[jobs-sqlite-event-log-deps:trim] inserting old(2026-01-01)+new(2026-04-01), cutoff=2026-03-01`);
    try {
      const deps = createSqliteEventLogDeps(store.db);
      deps.insert({
        jobId: "j1",
        channel: "runtime.jobs",
        event: "old",
        payloadJson: "{}",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      deps.insert({
        jobId: "j1",
        channel: "runtime.jobs",
        event: "new",
        payloadJson: "{}",
        createdAt: "2026-04-01T00:00:00.000Z",
      });
      const removed = deps.trim("2026-03-01T00:00:00.000Z");
      console.info(`[jobs-sqlite-event-log-deps:trim] removed=${removed} remaining=${deps.selectAfter(0, 100).length}`);
      expect(removed).toBe(1);
      expect(deps.selectAfter(0, 100)).toHaveLength(1);
    } catch (err) {
      dumpSqliteEventLogSnapshot("trim-failure", store);
      throw err;
    }
  });

  it("survives multiple insert/replay round-trips and preserves ordering", () => {
    console.info(`[jobs-sqlite-event-log-deps:round-trip] appending j1:a, j2:b, j1:c`);
    try {
      log.append("j1", "a", { n: 1 });
      log.append("j2", "b", { n: 2 });
      log.append("j1", "c", { n: 3 });
      const events = log.replay(0).events;
      console.info(
        `[jobs-sqlite-event-log-deps:round-trip] order=${JSON.stringify(events.map((e) => `${e.jobId}:${e.event}`))}`,
      );
      expect(events.map((e) => `${e.jobId}:${e.event}`)).toEqual([
        "j1:a",
        "j2:b",
        "j1:c",
      ]);
      // event_ids strictly ascending
      expect(events.map((e) => e.eventId)).toEqual([1, 2, 3]);
    } catch (err) {
      dumpSqliteEventLogSnapshot("round-trip-failure", store);
      throw err;
    }
  });
});
