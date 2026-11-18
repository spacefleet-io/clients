import { mkdtempSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { RuntimeState, stripSnapshotsForPersistence } from "../src/state";
import type { RuntimeEventFrame } from "../src/types";
import { runtimeState } from "../src/runtime";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps published event sequences + on-disk state on
// assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpRuntimeEventsSnapshot = (
  label: string,
  ctx: {
    filePath?: string;
    publishedSeq?: Array<{ sequence: number; eventId: string }>;
    elapsedMs?: number;
    replay?: unknown;
    written?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-events:${label}] snapshot ===`);
    if (ctx.filePath) console.error(`filePath=${ctx.filePath}`);
    if (ctx.publishedSeq) {
      console.error(`publishedSeq=\n${JSON.stringify(ctx.publishedSeq, null, 2)}`);
    }
    if (ctx.elapsedMs !== undefined) console.error(`elapsedMs=${ctx.elapsedMs}`);
    if (ctx.replay !== undefined) {
      console.error(`replay=\n${JSON.stringify(ctx.replay, null, 2)}`);
    }
    if (ctx.written !== undefined) {
      const trim = ctx.written.length > 2000 ? `${ctx.written.slice(0, 2000)}... (${ctx.written.length} bytes total)` : ctx.written;
      console.error(`written-file=\n${trim}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime event bus", () => {
  beforeEach(() => {
    console.info(`[runtime-events:setup] resetting runtimeState`);
    runtimeState.resetForTests();
  });

  it("emits monotonically increasing sequence per app/channel", () => {
    console.info(`[runtime-events:monotonic-seq] publishing two parrot/sync events`);
    const first = runtimeState.publish("parrot", "sync", "sync.command_accepted", { requestId: "r1" });
    const second = runtimeState.publish("parrot", "sync", "sync.command_accepted", { requestId: "r2" });
    try {
      console.info(`[runtime-events:monotonic-seq] first.sequence=${first.sequence} second.sequence=${second.sequence}`);
      expect(first.sequence).toBe(1);
      expect(second.sequence).toBe(2);
    } catch (err) {
      dumpRuntimeEventsSnapshot("monotonic-seq-failure", {
        publishedSeq: [
          { sequence: first.sequence, eventId: first.eventId },
          { sequence: second.sequence, eventId: second.eventId },
        ],
      });
      throw err;
    }
  });

  it("replays events after ack using lastEventId", () => {
    console.info(`[runtime-events:replay-after-ack] adding subscriber + publishing two events`);
    runtimeState.addSubscriber("s1", runtimeState.login("tok-backend", ["parrot"]).token, () => undefined);
    runtimeState.applyClientFrame("s1", {
      type: "subscribe",
      apps: ["parrot"],
      channels: ["parrot.sync"],
    });

    const first = runtimeState.publish("parrot", "sync", "sync.command_accepted", { requestId: "r1" });
    const second = runtimeState.publish("parrot", "sync", "sync.command_accepted", { requestId: "r2" });
    const replay = runtimeState.applyClientFrame("s1", { type: "ack", lastEventId: first.eventId });
    try {
      console.info(`[runtime-events:replay-after-ack] replay.length=${replay.length} replay[0].eventId=${replay[0]?.eventId}`);
      expect(replay).toHaveLength(1);
      expect(replay[0]?.eventId).toBe(second.eventId);
    } catch (err) {
      dumpRuntimeEventsSnapshot("replay-after-ack-failure", {
        publishedSeq: [
          { sequence: first.sequence, eventId: first.eventId },
          { sequence: second.sequence, eventId: second.eventId },
        ],
        replay,
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof reloads persisted websocket events and replays runtime.jobs frames after runtime restart", async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "runtime-events-"));
    const filePath = joinPath(dir, "runtime_events.json");
    console.info(`[runtime-events:reload-after-restart] persistence file=${filePath}`);

    const firstState = new RuntimeState(60_000, 50, "1", "/tmp/spacefleet-runtime-slices");
    firstState.configureEventPersistence(filePath);
    const first = firstState.publish("badger", "runtime.jobs", "runtime.jobs.updated", {
      requestId: "persist-1",
    });
    const second = firstState.publish("badger", "runtime.jobs", "runtime.jobs.updated", {
      requestId: "persist-2",
    });
    // Persistence is debounced + async; wait for the file to land before
    // the reloaded RuntimeState attempts to read it.
    console.info(`[runtime-events:reload-after-restart] flushing persisted events for shutdown`);
    await firstState.flushPersistedEventsForShutdown();

    const reloadedState = new RuntimeState(60_000, 50, "1", "/tmp/spacefleet-runtime-slices");
    reloadedState.configureEventPersistence(filePath);
    reloadedState.addSubscriber("s1", reloadedState.login("tok-backend", ["badger"]).token, () => undefined);
    reloadedState.applyClientFrame("s1", {
      type: "subscribe",
      apps: ["badger"],
      channels: ["runtime.jobs"],
    });

    const replay = reloadedState.applyClientFrame("s1", { type: "ack", lastEventId: first.eventId });
    try {
      console.info(`[runtime-events:reload-after-restart] replay.length=${replay.length} replay[0].eventId=${replay[0]?.eventId}`);
      expect(replay).toHaveLength(1);
      expect(replay[0]?.eventId).toBe(second.eventId);
      expect(replay[0]?.payload.requestId).toBe("persist-2");
    } catch (err) {
      dumpRuntimeEventsSnapshot("reload-after-restart-failure", {
        filePath,
        publishedSeq: [
          { sequence: first.sequence, eventId: first.eventId },
          { sequence: second.sequence, eventId: second.eventId },
        ],
        replay,
      });
      throw err;
    }
  });

  /**
   * @test-id RUNTIME-EVENT-PERSIST-HOT-LOOP-001
   * @level unit
   * @bugfix @regression-proof
   *
   * Smoking-gun for the wedged-runtime CPU pin (2026-05-13): `publish()`
   * used to `JSON.stringify` the entire in-memory event ring and call
   * `writeFileSync` SYNCHRONOUSLY inside the publish path. With the ring
   * at 500 events and a few `badger.library.updated` frames each carrying
   * a ~1 MB library snapshot, the file ballooned to ~20 MB pretty-printed
   * and every cheap publish (e.g. `sync.command_accepted`, fired ~2/s)
   * paid the full 20 MB serialize + sync-write cost. Net effect: ~100% CPU
   * on the runtime main thread + 100–180 ms per `/modules/badger/commands`
   * POST while idle, and intermittent 12 s starves on trivial GETs.
   *
   * This test guards the fix: publishing a batch of frames carrying large
   * payloads must NOT block the publish() caller. Pre-fix this ran the
   * sync write inline and easily took >50 ms per publish; post-fix the
   * publishes return effectively instantly and the file write is debounced
   * + async.
   */
  it("@bugfix @regression-proof publish() does not block on synchronous disk persistence under large-payload bursts", async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "runtime-events-hotloop-"));
    const filePath = joinPath(dir, "runtime_events.json");
    console.info(`[runtime-events:hotloop] persistence file=${filePath}`);

    const state = new RuntimeState(60_000, 50, "1", "/tmp/spacefleet-runtime-slices");
    state.configureEventPersistence(filePath);

    // Fabricate a "library-snapshot-shaped" payload of ~500 KB so each
    // event meaningfully amplifies the serialized ring size, mirroring
    // the real-world `badger.library.updated` frames.
    const fatPayload = {
      version: 1,
      reason: "test_hotloop",
      mediaCount: 200,
      playlistCount: 0,
      snapshot: {
        media: Array.from({ length: 200 }, (_, i) => ({
          id: `media-${i}`,
          title: `Title ${i}`,
          synopsis: "x".repeat(2_000),
        })),
      },
    } satisfies Record<string, unknown>;

    console.info(`[runtime-events:hotloop] firing 25 publishes with ~500KB payload each`);
    const start = Date.now();
    for (let i = 0; i < 25; i += 1) {
      state.publish("badger", "library", "library.updated", fatPayload);
    }
    const elapsedMs = Date.now() - start;
    console.info(`[runtime-events:hotloop] 25 publishes done in ${elapsedMs}ms (budget <200)`);

    try {
      // Pre-fix this loop ran 25 × `writeFileSync` of an ever-growing
      // pretty-printed JSON blob and easily exceeded 1 s on a developer
      // laptop. Post-fix the publishes only mutate in-memory state and
      // schedule a debounced async flush — the loop should finish in
      // well under 200 ms even on a slow machine.
      expect(elapsedMs).toBeLessThan(200);

      // The file may not exist yet (debounce window) — explicit flush ensures
      // the persistence path is still wired up correctly and tolerates the
      // large blob without throwing.
      await state.flushPersistedEventsForShutdown();
    } catch (err) {
      dumpRuntimeEventsSnapshot("hotloop-failure", { filePath, elapsedMs });
      throw err;
    }
  });

  // @bugfix runtime-persisted-ring-bloated-by-library-snapshots
  // @regression-proof badger.library.updated frames carry the full library
  // snapshot (~1.1 MB each) on the wire so live WS subscribers see post-write
  // state instantly. But the persisted-to-disk ring is only used for replay
  // on restart, and the on-disk consumer never reads `payload.snapshot` — it
  // re-fetches via `badger.db.snapshot`. Strip the snapshot at persistence
  // time so the on-disk ring stays ~50 KB instead of ballooning to ~11 MB.
  describe("stripSnapshotsForPersistence", () => {
    const makeFrame = (
      event: string,
      payload: Record<string, unknown>
    ): RuntimeEventFrame => ({
      app: "badger",
      channel: "library",
      event,
      eventId: `${event}-id`,
      sequence: 1,
      payload,
      ts: "2026-05-13T00:00:00.000Z",
    });

    it("drops the snapshot field from badger.library.updated frames", () => {
      const fat = makeFrame("badger.library.updated", {
        version: 42,
        reason: "commit:job-1",
        mediaCount: 3,
        playlistCount: 1,
        snapshot: { media: Array(1000).fill({ id: "x" }), playlists: [] },
      });
      const stripped = stripSnapshotsForPersistence([fat]);
      expect(stripped).toHaveLength(1);
      expect(stripped[0].payload).toEqual({
        version: 42,
        reason: "commit:job-1",
        mediaCount: 3,
        playlistCount: 1,
      });
      expect((stripped[0].payload as Record<string, unknown>).snapshot).toBeUndefined();
    });

    it("leaves the live in-memory frame untouched (immutable transform)", () => {
      const live = makeFrame("badger.library.updated", {
        version: 1,
        snapshot: { foo: "bar" },
      });
      const stripped = stripSnapshotsForPersistence([live]);
      expect((live.payload as Record<string, unknown>).snapshot).toEqual({ foo: "bar" });
      expect(stripped[0]).not.toBe(live);
    });

    it("passes through unrelated event types unchanged (reference-equal)", () => {
      const other = makeFrame("sync.command_accepted", { requestId: "r1" });
      const stripped = stripSnapshotsForPersistence([other]);
      expect(stripped[0]).toBe(other);
    });

    it("passes through library.updated frames that have no snapshot field", () => {
      const trimmed = makeFrame("badger.library.updated", {
        version: 7,
        mediaCount: 0,
      });
      const stripped = stripSnapshotsForPersistence([trimmed]);
      expect(stripped[0]).toBe(trimmed);
    });
  });

  // @bugfix runtime-persisted-ring-bloated-by-library-snapshots
  // @regression-proof End-to-end: persist a library.updated frame with a fat
  // snapshot, then assert the on-disk file does NOT contain the snapshot
  // payload. Without this, restarts reload an 11 MB ring and consumers that
  // replay it get a duplicate-fetch storm.
  it("does not write library snapshots to the on-disk events file", async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "runtime-events-strip-"));
    const filePath = joinPath(dir, "runtime_events.json");
    console.info(`[runtime-events:strip-on-disk] persistence file=${filePath}`);

    const state = new RuntimeState(60_000, 50, "1", "/tmp/spacefleet-runtime-slices-strip");
    state.configureEventPersistence(filePath);
    state.publish("badger", "library", "library.updated", {
      version: 9,
      reason: "test",
      mediaCount: 1,
      playlistCount: 0,
      snapshot: { sentinel: "THIS_SHOULD_NOT_BE_ON_DISK" },
    });
    await state.flushPersistedEventsForShutdown();

    const written = readFileSync(filePath, "utf8");
    console.info(`[runtime-events:strip-on-disk] file size=${written.length} contains-sentinel=${written.includes("THIS_SHOULD_NOT_BE_ON_DISK")}`);
    try {
      expect(written).not.toContain("THIS_SHOULD_NOT_BE_ON_DISK");
      expect(written).toContain("\"version\":9");
      expect(written).toContain("\"reason\":\"test\"");
    } catch (err) {
      dumpRuntimeEventsSnapshot("strip-on-disk-failure", { filePath, written });
      throw err;
    }
  });
});
