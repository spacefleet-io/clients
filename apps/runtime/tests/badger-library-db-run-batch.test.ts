/**
 * @bugfix @regression-proof
 *
 * Phase 2 — Coalesce snapshot publishes inside a commit batch
 *
 * Symptom: every call to `BadgerLibraryDbService.call()` for a write
 * method republishes the FULL `LibrarySnapshot`. The commit step issues
 * 6-15 sequential write calls per source-job (linkFileToMedia +
 * addMediaFormat × N + addAudioTrackWithChunks × N +
 * addSubtitleTrackWithObject × N + addChaptersForFormat +
 * markMediaPlayable), so the renderer received that whole burst of
 * intermediate snapshots — most carrying `hasFiles=false` because the
 * commit had not yet run `markMediaPlayable`. By the time the final
 * `markMediaPlayable` snapshot landed, the renderer had already paid
 * the parse-cost on every prior intermediate. End-to-end this delayed
 * the play-button enable on the user's "done" event by 3-5 s.
 *
 * Fix: `BadgerLibraryDbService.runBatch(label, fn)` suspends per-write
 * publishes for the duration of `fn` (via a `batchDepth` counter that
 * `call()` checks), then emits exactly one `library.updated` event at
 * the end if the version changed. The commit step (`apps/runtime/src/
 * modules/badger/steps/commit.ts`) wraps `deps.commit` and the trailing
 * `deps.markMediaPlayable` in a single `runLibraryBatch("commit:<jobId>")`
 * via the deps adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { commitStepHandler } from "../src/modules/badger/steps";
import {
  configureBadgerStepDeps,
  __resetBadgerStepDeps,
  type BadgerStepDeps,
  type CommitInput,
  type CommitResult,
  type ProbeResult,
  type IdentifyResult,
  type ExtractResult,
  type TranscodeResult,
  type UploadResult,
} from "../src/modules/badger/steps/deps";
import type { StepHandlerCtx } from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "@space/runtime-jobs-engine/stepStore";

const SUITE = "badger-library-db-run-batch";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerLibraryDbRunBatchSnapshot = (
  label: string,
  ctx: {
    batchLabel?: string;
    dbVersion?: number;
    dbVersionBefore?: number;
    dbVersionAfter?: number;
    snapshot?: unknown;
    publishedEvents?: unknown;
    publishedEventsCount?: number;
    libraryEvents?: unknown;
    libraryEventsCount?: number;
    expectedLibraryEventsCount?: number;
    terminalEvent?: unknown;
    terminalReason?: string;
    terminalVersion?: number;
    terminalSnapshot?: unknown;
    changedMediaIds?: unknown;
    jobId?: string;
    mediaId?: string;
    fileId?: string;
    callOrder?: unknown;
    fakeDbCallCounts?: unknown;
    batchDepthObserved?: number;
    threwError?: boolean;
    errorMessage?: string;
    commitOutputs?: unknown;
    expected?: unknown;
    actual?: unknown;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-library-db-run-batch snapshot ===`);
    if (ctx.batchLabel !== undefined) console.error(`batchLabel: ${ctx.batchLabel}`);
    if (ctx.dbVersion !== undefined) console.error(`dbVersion: ${ctx.dbVersion}`);
    if (ctx.dbVersionBefore !== undefined) console.error(`dbVersionBefore: ${ctx.dbVersionBefore}`);
    if (ctx.dbVersionAfter !== undefined) console.error(`dbVersionAfter: ${ctx.dbVersionAfter}`);
    if (ctx.snapshot !== undefined) {
      console.error(`snapshot:\n${JSON.stringify(ctx.snapshot, jsonReplacer, 2)}`);
    }
    if (ctx.publishedEvents !== undefined) {
      console.error(`publishedEvents:\n${JSON.stringify(ctx.publishedEvents, jsonReplacer, 2)}`);
    }
    if (ctx.publishedEventsCount !== undefined) {
      console.error(`publishedEventsCount: ${ctx.publishedEventsCount}`);
    }
    if (ctx.libraryEvents !== undefined) {
      console.error(`libraryEvents:\n${JSON.stringify(ctx.libraryEvents, jsonReplacer, 2)}`);
    }
    if (ctx.libraryEventsCount !== undefined) {
      console.error(`libraryEventsCount: ${ctx.libraryEventsCount}`);
    }
    if (ctx.expectedLibraryEventsCount !== undefined) {
      console.error(`expectedLibraryEventsCount: ${ctx.expectedLibraryEventsCount}`);
    }
    if (ctx.terminalEvent !== undefined) {
      console.error(`terminalEvent:\n${JSON.stringify(ctx.terminalEvent, jsonReplacer, 2)}`);
    }
    if (ctx.terminalReason !== undefined) console.error(`terminalReason: ${ctx.terminalReason}`);
    if (ctx.terminalVersion !== undefined) console.error(`terminalVersion: ${ctx.terminalVersion}`);
    if (ctx.changedMediaIds !== undefined) console.error(`changedMediaIds: ${JSON.stringify(ctx.changedMediaIds)}`);
    if (ctx.terminalSnapshot !== undefined) {
      console.error(`terminalSnapshot:\n${JSON.stringify(ctx.terminalSnapshot, jsonReplacer, 2)}`);
    }
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
    if (ctx.mediaId !== undefined) console.error(`mediaId: ${ctx.mediaId}`);
    if (ctx.fileId !== undefined) console.error(`fileId: ${ctx.fileId}`);
    if (ctx.callOrder !== undefined) {
      console.error(`callOrder:\n${JSON.stringify(ctx.callOrder, jsonReplacer, 2)}`);
    }
    if (ctx.fakeDbCallCounts !== undefined) {
      console.error(`fakeDbCallCounts:\n${JSON.stringify(ctx.fakeDbCallCounts, jsonReplacer, 2)}`);
    }
    if (ctx.batchDepthObserved !== undefined) {
      console.error(`batchDepthObserved: ${ctx.batchDepthObserved}`);
    }
    if (ctx.threwError !== undefined) console.error(`threwError: ${ctx.threwError}`);
    if (ctx.errorMessage !== undefined) console.error(`errorMessage: ${ctx.errorMessage}`);
    if (ctx.commitOutputs !== undefined) {
      console.error(`commitOutputs:\n${JSON.stringify(ctx.commitOutputs, jsonReplacer, 2)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

type DbState = {
  version: number;
  snapshot: { media: unknown[]; playlists: unknown[] };
};

const makeFakeDb = () => {
  const state: DbState = {
    version: 0,
    snapshot: { media: [], playlists: [] },
  };
  // Subset of the LibraryDb surface that the BadgerLibraryDbService
  // tests touch. Each "write" bumps version and replaces snapshot —
  // mirroring the real LibraryDb's bump-on-write contract.
  const fakeDb = {
    getVersion: () => state.version,
    getSnapshot: () => state.snapshot,
    getCountSummary: () => ({ mediaCount: state.snapshot.media.length, playlistCount: 0 }),
    // The emulated writes all touch media m1 (see the snapshots they set).
    takeChangedMedia: () => ({ mediaIds: state.snapshot.media.length > 0 ? ["m1"] : [], all: false }),
    getDatasetStatus: () => ({ core: true, metadata: true, playback: true }),
    setSyncEnabled: () => {},
    close: () => {},
    flushPending: async () => {},
    // Writes — the bodies emulate "version bumped, snapshot replaced".
    linkFileToMedia: vi.fn(async () => {
      state.version += 1;
      state.snapshot = { media: [{ id: "m1" }], playlists: [] };
      return "file-1";
    }),
    addMediaFormat: vi.fn(async () => {
      state.version += 1;
      state.snapshot = { media: [{ id: "m1", formats: 1 }], playlists: [] };
      return "fmt-1";
    }),
    addAudioTrackWithChunks: vi.fn(async () => {
      state.version += 1;
      state.snapshot = { media: [{ id: "m1", audio: 1 }], playlists: [] };
    }),
    addSubtitleTrackWithObject: vi.fn(async () => {
      state.version += 1;
      state.snapshot = { media: [{ id: "m1", subs: 1 }], playlists: [] };
    }),
    markMediaPlayable: vi.fn(async () => {
      state.version += 1;
      state.snapshot = {
        media: [{ id: "m1", hasFiles: true }],
        playlists: [],
      };
    }),
    // Read — does NOT bump version. (Mirrors the real getMediaDetails.)
    getMediaDetails: vi.fn(async () => ({ id: "m1" })),
  };
  return { fakeDb, state };
};

const makeService = (fakeDb: ReturnType<typeof makeFakeDb>["fakeDb"]) => {
  const service = new BadgerLibraryDbService();
  // BadgerLibraryDbService is designed to lazy-import the real LibraryDb
  // (bun:sqlite, can't load under vitest), so we splice a fake db in
  // through the private slot. Same pattern other tests use to avoid
  // the bun:sqlite resolution path.
  (service as unknown as { db: unknown }).db = fakeDb;
  return service;
};

describe("BadgerLibraryDbService.runBatch — coalesces snapshot publishes", () => {
  console.info(`[${SUITE}:describe] entering "BadgerLibraryDbService.runBatch"`);
  let publishedEvents: Array<{ channel: string; event: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    publishedEvents = [];
    console.info(`[${SUITE}:beforeEach] cleared publishedEvents`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    console.info(`[${SUITE}:afterEach] restored mocks (publishedEvents=${publishedEvents.length})`);
  });

  const setUp = () => {
    const { fakeDb, state } = makeFakeDb();
    const service = makeService(fakeDb);
    service.setEventPublisher((channel, event, payload) => {
      publishedEvents.push({ channel, event, payload });
    });
    console.info(`[${SUITE}:setUp] service ready, initial dbVersion=${state.version}`);
    return { fakeDb, state, service };
  };

  it("emits exactly one library.updated event when 5 writes run inside a single runBatch", async () => {
    const label = "single-batch-5-writes";
    console.info(`[${SUITE}:${label}] start`);
    const { service, state } = setUp();

    console.info(`[${SUITE}:${label}] running batch 'commit:job-1' with 5 writes`);
    await service.runBatch("commit:job-1", async () => {
      await service.call("linkFileToMedia", ["m1", "/x.mkv", null, null]);
      await service.call("addMediaFormat", ["m1", "file-1", "1080p"]);
      await service.call("addAudioTrackWithChunks", [{}]);
      await service.call("addSubtitleTrackWithObject", [{}]);
      await service.call("markMediaPlayable", ["m1"]);
    });

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    console.info(`[${SUITE}:${label}] libraryEvents.length=${libraryEvents.length} dbVersion=${state.version}`);
    try {
      expect(libraryEvents.length).toBe(1);
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        batchLabel: "commit:job-1",
        dbVersion: state.version,
        publishedEvents,
        publishedEventsCount: publishedEvents.length,
        libraryEvents,
        libraryEventsCount: libraryEvents.length,
        expectedLibraryEventsCount: 1,
        expected: 1,
        actual: libraryEvents.length,
        error: err,
      });
      throw err;
    }
  });

  it("the terminal publish carries reason=label (e.g. 'commit:<jobId>')", async () => {
    const label = "terminal-reason-label";
    console.info(`[${SUITE}:${label}] start`);
    const { service } = setUp();

    console.info(`[${SUITE}:${label}] running batch 'commit:abc-123'`);
    await service.runBatch("commit:abc-123", async () => {
      await service.call("linkFileToMedia", ["m1", "/x.mkv", null, null]);
      await service.call("markMediaPlayable", ["m1"]);
    });

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    const terminalReason = libraryEvents[0]?.payload.reason;
    console.info(`[${SUITE}:${label}] libraryEvents.length=${libraryEvents.length} terminalReason=${String(terminalReason)}`);
    try {
      expect(libraryEvents.length).toBe(1);
      expect(libraryEvents[0]?.payload.reason).toBe("commit:abc-123");
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        batchLabel: "commit:abc-123",
        publishedEvents,
        libraryEvents,
        libraryEventsCount: libraryEvents.length,
        terminalEvent: libraryEvents[0],
        terminalReason: terminalReason as string | undefined,
        expected: { count: 1, reason: "commit:abc-123" },
        actual: { count: libraryEvents.length, reason: terminalReason },
        error: err,
      });
      throw err;
    }
  });

  it("the terminal publish carries the post-batch (final) version, not an intermediate one", async () => {
    const label = "terminal-post-batch-version";
    console.info(`[${SUITE}:${label}] start`);
    const { service, state } = setUp();

    console.info(`[${SUITE}:${label}] running batch 'commit:job-2' with 3 writes`);
    await service.runBatch("commit:job-2", async () => {
      await service.call("linkFileToMedia", ["m1", "/x.mkv", null, null]);
      await service.call("addMediaFormat", ["m1", "file-1", "1080p"]);
      await service.call("markMediaPlayable", ["m1"]);
    });

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    const terminalVersion = libraryEvents[0]?.payload.version as number | undefined;
    const changedMediaIds = libraryEvents[0]?.payload.changedMediaIds;
    console.info(`[${SUITE}:${label}] terminalVersion=${terminalVersion} dbVersion=${state.version} changedMediaIds=${JSON.stringify(changedMediaIds)}`);
    try {
      expect(libraryEvents[0]?.payload.version).toBe(state.version);
      // The terminal frame names the media the whole batch touched, once
      // (coalesced), and carries no snapshot (#671 R3).
      expect(libraryEvents[0]?.payload.changedMediaIds).toEqual(["m1"]);
      expect(libraryEvents[0]?.payload).not.toHaveProperty("snapshot");
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        batchLabel: "commit:job-2",
        dbVersion: state.version,
        terminalEvent: libraryEvents[0],
        terminalVersion,
        changedMediaIds,
        snapshot: state.snapshot,
        libraryEvents,
        publishedEvents,
        expected: { version: state.version, changedMediaIds: ["m1"] },
        actual: { version: terminalVersion, changedMediaIds },
        error: err,
      });
      throw err;
    }
  });

  it("emits no publish when fn does no writes (version unchanged)", async () => {
    const label = "no-publish-when-noop";
    console.info(`[${SUITE}:${label}] start`);
    const { service, state } = setUp();
    const versionBefore = state.version;

    console.info(`[${SUITE}:${label}] running batch 'commit:noop' (pure read)`);
    await service.runBatch("commit:noop", async () => {
      // Pure read — does not bump version.
      await service.call("getMediaDetails", ["m1"]);
    });

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    console.info(`[${SUITE}:${label}] libraryEvents.length=${libraryEvents.length} versionBefore=${versionBefore} versionAfter=${state.version}`);
    try {
      expect(libraryEvents.length).toBe(0);
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        batchLabel: "commit:noop",
        dbVersionBefore: versionBefore,
        dbVersionAfter: state.version,
        publishedEvents,
        libraryEvents,
        libraryEventsCount: libraryEvents.length,
        expectedLibraryEventsCount: 0,
        expected: 0,
        actual: libraryEvents.length,
        error: err,
      });
      throw err;
    }
  });

  it("propagates errors from fn and emits no terminal publish on failure", async () => {
    const label = "error-no-terminal-publish";
    console.info(`[${SUITE}:${label}] start`);
    const { service } = setUp();

    console.info(`[${SUITE}:${label}] running batch 'commit:fail' (throws after 1 write)`);
    let threw = false;
    let thrownMessage = "";
    try {
      await expect(
        service.runBatch("commit:fail", async () => {
          await service.call("linkFileToMedia", ["m1", "/x.mkv", null, null]);
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      threw = true;
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        batchLabel: "commit:fail",
        publishedEvents,
        threwError: false,
        errorMessage: thrownMessage,
        expected: "rejects.toThrow boom",
        actual: thrownMessage,
        error: err,
      });
      throw err;
    }

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    console.info(`[${SUITE}:${label}] threw=${threw} libraryEvents.length=${libraryEvents.length}`);
    try {
      // No terminal publish — the renderer's view stays anchored on the
      // pre-batch version, which is the correct semantics for a partial
      // batch. The next successful write or runBatch will re-publish.
      expect(libraryEvents.length).toBe(0);
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        batchLabel: "commit:fail",
        publishedEvents,
        libraryEvents,
        libraryEventsCount: libraryEvents.length,
        expectedLibraryEventsCount: 0,
        threwError: threw,
        expected: 0,
        actual: libraryEvents.length,
        error: err,
      });
      throw err;
    }
  });

  it("subsequent un-batched writes still publish per-call (no regression on the non-batch path)", async () => {
    const label = "unbatched-still-publishes-per-call";
    console.info(`[${SUITE}:${label}] start`);
    const { service } = setUp();

    console.info(`[${SUITE}:${label}] running 2 un-batched calls`);
    // Plain calls (not inside runBatch) still publish each time —
    // this is the un-batched path the renderer uses when no commit
    // step is in flight.
    await service.call("linkFileToMedia", ["m1", "/x.mkv", null, null]);
    await service.call("markMediaPlayable", ["m1"]);

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    console.info(`[${SUITE}:${label}] libraryEvents.length=${libraryEvents.length}`);
    try {
      expect(libraryEvents.length).toBe(2);
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        publishedEvents,
        libraryEvents,
        libraryEventsCount: libraryEvents.length,
        expectedLibraryEventsCount: 2,
        expected: 2,
        actual: libraryEvents.length,
        error: err,
      });
      throw err;
    }
  });

  it("releases batchDepth on error so subsequent un-batched calls publish normally", async () => {
    const label = "batchdepth-released-on-error";
    console.info(`[${SUITE}:${label}] start`);
    const { service } = setUp();

    console.info(`[${SUITE}:${label}] phase A: running batch 'commit:err' that throws`);
    await expect(
      service.runBatch("commit:err", async () => {
        await service.call("linkFileToMedia", ["m1", "/x.mkv", null, null]);
        throw new Error("kaboom");
      })
    ).rejects.toThrow("kaboom");

    publishedEvents.length = 0;
    console.info(`[${SUITE}:${label}] phase B: running un-batched call after failed batch`);
    // After the failing batch, the next plain `.call()` should publish
    // — proves batchDepth is decremented in the finally{} block.
    await service.call("markMediaPlayable", ["m1"]);

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    console.info(`[${SUITE}:${label}] post-recovery libraryEvents.length=${libraryEvents.length}`);
    try {
      expect(libraryEvents.length).toBe(1);
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        publishedEvents,
        libraryEvents,
        libraryEventsCount: libraryEvents.length,
        expectedLibraryEventsCount: 1,
        expected: 1,
        actual: libraryEvents.length,
        error: err,
      });
      throw err;
    }
  });

  it("a runBatch that nests inside another runBatch emits only one terminal publish (composes)", async () => {
    const label = "nested-batch-composes";
    console.info(`[${SUITE}:${label}] start`);
    const { service } = setUp();

    console.info(`[${SUITE}:${label}] running outer batch 'commit:outer' with nested 'commit:inner'`);
    await service.runBatch("commit:outer", async () => {
      await service.call("linkFileToMedia", ["m1", "/x.mkv", null, null]);
      // Re-entering runBatch from inside an outer batch would deadlock
      // pre-fix because runExclusive holds opGate. The batchDepth
      // counter lets the inner batch run inline; the outer batch keeps
      // ownership of opGate and the terminal publish.
      await service.runBatch("commit:inner", async () => {
        await service.call("addMediaFormat", ["m1", "file-1", "1080p"]);
        await service.call("markMediaPlayable", ["m1"]);
      });
    });

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    const terminalReason = libraryEvents[0]?.payload.reason;
    console.info(`[${SUITE}:${label}] libraryEvents.length=${libraryEvents.length} terminalReason=${String(terminalReason)}`);
    try {
      expect(libraryEvents.length).toBe(1);
      // The outer batch wins the label — that's the operation the
      // user's renderer attributes the event to.
      expect(libraryEvents[0]?.payload.reason).toBe("commit:outer");
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        publishedEvents,
        libraryEvents,
        libraryEventsCount: libraryEvents.length,
        terminalEvent: libraryEvents[0],
        terminalReason: terminalReason as string | undefined,
        expectedLibraryEventsCount: 1,
        expected: { count: 1, reason: "commit:outer" },
        actual: { count: libraryEvents.length, reason: terminalReason },
        error: err,
      });
      throw err;
    }
  });

  it("a concurrent call() fired while runBatch is in flight queues on the op gate and publishes only AFTER the batch's terminal event", async () => {
    const label = "concurrent-call-queues-on-opgate";
    console.info(`[${SUITE}:${label}] start`);
    // The brief asks: a `call()` invoked WHILE a runBatch is in flight
    // on the same service must not bypass the suspension. The op gate
    // serializes both, so the outside call queues until the batch
    // resolves — and then runs as an un-batched call (publishes once
    // for its own write, AFTER the batch's terminal publish).
    const { service } = setUp();

    // Hold the batch open via a manual gate so we can fire a concurrent
    // `service.call(...)` while the batch's fn is still awaiting.
    let releaseBatch: () => void = () => {};
    const batchHeld = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    console.info(`[${SUITE}:${label}] launching batch 'commit:slow' (parked)`);
    const batchPromise = service.runBatch("commit:slow", async () => {
      await service.call("linkFileToMedia", ["m1", "/x.mkv", null, null]);
      await service.call("addMediaFormat", ["m1", "file-1", "1080p"]);
      // Park the batch — its terminal publish hasn't fired yet, but
      // batchDepth is currently > 0 and opGate is held.
      await batchHeld;
      await service.call("markMediaPlayable", ["m1"]);
    });

    // Yield so the batch's fn body is mid-flight (the two writes have
    // run, batchDepth > 0, opGate held).
    await new Promise((resolve) => setTimeout(resolve, 0));

    console.info(`[${SUITE}:${label}] firing concurrent call() while batch is parked`);
    // Fire a concurrent call() from OUTSIDE the batch. Pre-fix this
    // call would race past the suspension if it bypassed opGate. With
    // the gate, it queues — runs after the batch resolves and emits
    // its own publish (it is no longer inside the batch).
    const concurrentCall = service.call("addAudioTrackWithChunks", [{}]);

    const midFlightLibraryEventCount = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    ).length;
    console.info(`[${SUITE}:${label}] mid-flight libraryEvents.length=${midFlightLibraryEventCount} (expect 0)`);
    try {
      // Snapshot publishes seen so far should still be ZERO (no batch
      // terminal yet, and the concurrent call is queued).
      expect(midFlightLibraryEventCount).toBe(0);
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        batchLabel: "commit:slow",
        publishedEvents,
        libraryEventsCount: midFlightLibraryEventCount,
        expected: { phase: "mid-flight", count: 0 },
        actual: { phase: "mid-flight", count: midFlightLibraryEventCount },
        error: err,
      });
      throw err;
    }

    releaseBatch();
    await batchPromise;
    await concurrentCall;

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    const reasons = libraryEvents.map((e) => e.payload.reason);
    console.info(`[${SUITE}:${label}] post-resolution libraryEvents.length=${libraryEvents.length} reasons=${JSON.stringify(reasons)}`);
    try {
      // Exactly two publishes: the batch's terminal (reason='commit:slow')
      // and the concurrent call's per-write publish (reason method name).
      expect(libraryEvents.length).toBe(2);
      expect(libraryEvents[0]?.payload.reason).toBe("commit:slow");
      expect(libraryEvents[1]?.payload.reason).toBe("addAudioTrackWithChunks");
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        batchLabel: "commit:slow",
        publishedEvents,
        libraryEvents,
        libraryEventsCount: libraryEvents.length,
        expectedLibraryEventsCount: 2,
        expected: { count: 2, reasons: ["commit:slow", "addAudioTrackWithChunks"] },
        actual: { count: libraryEvents.length, reasons },
        error: err,
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Commit-step end-to-end: drives the real `commitStepHandler` against a real
// `BadgerLibraryDbService` (with a fake DB) wired via the deps adapter's
// `runLibraryBatch` hook. The brief asks for an integration-ish test that
// proves the handler-to-publish path collapses the 6-15 commit writes to ONE
// `library.updated` event with `reason='commit:<jobId>'`.
// ---------------------------------------------------------------------------

describe("commit step end-to-end — wraps deps.commit + markMediaPlayable in one runBatch", () => {
  console.info(`[${SUITE}:describe] entering "commit step end-to-end"`);
  let publishedEvents: Array<{ channel: string; event: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    publishedEvents = [];
    __resetBadgerStepDeps();
    console.info(`[${SUITE}:beforeEach] cleared publishedEvents and reset deps`);
  });

  afterEach(() => {
    __resetBadgerStepDeps();
    vi.restoreAllMocks();
    console.info(`[${SUITE}:afterEach] reset deps and mocks`);
  });

  it("a synthetic source-job commit produces exactly 1 library.updated event with reason='commit:<jobId>'", async () => {
    const label = "synthetic-source-commit-1-event";
    console.info(`[${SUITE}:${label}] start`);
    const { fakeDb, state } = makeFakeDb();
    const service = makeService(fakeDb);
    service.setEventPublisher((channel, event, payload) => {
      publishedEvents.push({ channel, event, payload });
    });
    console.info(`[${SUITE}:${label}] service ready, initial dbVersion=${state.version}`);
    // Pre-seed lastSnapshotVersion to match the fake DB's starting
    // version — the real open() path normally does this. Otherwise the
    // batch would compare versionBefore=0 against versionAfter>0 and
    // fire its terminal publish, which is what we want, BUT the seeded
    // value mirrors the production lifecycle.
    (service as unknown as { lastSnapshotVersion: number }).lastSnapshotVersion =
      state.version;

    // Build a minimal deps surface: only `commit`, `markMediaPlayable`,
    // and `runLibraryBatch` are exercised by the commit-step handler
    // for a source job. The handler also calls `lookupParentSourceFileId`
    // for FORMAT jobs only — we set source scope so it's not invoked.
    const commitDeps: BadgerStepDeps = {
      probe: vi.fn(async () => ({}) as ProbeResult),
      identify: vi.fn(async () => ({}) as IdentifyResult),
      extractSource: vi.fn(async () => ({}) as ExtractResult),
      transcodeFormat: vi.fn(async () => ({}) as TranscodeResult),
      uploadOutputs: vi.fn(async () => ({}) as UploadResult),
      commit: vi.fn(async (input: CommitInput): Promise<CommitResult> => {
        // Mirror what the real deps-adapter commit does: a burst of
        // libraryDb.call() writes. The runBatch wrapper must coalesce
        // them into one terminal publish.
        await service.call("linkFileToMedia", [
          input.mediaId,
          input.filename,
          null,
          null,
        ]);
        await service.call("addMediaFormat", [input.mediaId, "file-1", "1080p"]);
        await service.call("addAudioTrackWithChunks", [{}]);
        await service.call("addSubtitleTrackWithObject", [{}]);
        return { fileId: "file-1", formatIds: ["fmt-1"] };
      }),
      markMediaPlayable: vi.fn(async (mediaId: string) => {
        // Final write — flips hasFiles=true. Must be inside the batch.
        await service.call("markMediaPlayable", [mediaId]);
      }),
      runLibraryBatch: <T,>(label: string, fn: () => Promise<T>) =>
        service.runBatch(label, fn),
    };
    configureBadgerStepDeps(commitDeps);

    const ts = "2026-01-01T00:00:00.000Z";
    const job: IngestJobRecord = {
      jobId: "job-commit-1",
      app: "badger",
      kind: "source",
      lane: "source",
      status: "running",
      stageCode: "running",
      stageLabel: "Running",
      progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
      progressPct: 0,
      payload: { userId: "u1", filename: "/tmp/movie.mkv", hints: {} },
      outputs: {},
      errorCode: null,
      errorMessage: null,
      retryable: false,
      cancelRequested: false,
      priority: 0,
      dedupeKey: null,
      createdAt: ts,
      updatedAt: ts,
      startedAt: ts,
      finishedAt: null,
      groupId: "media-1",
      mediaId: "media-1",
      variant: null,
      parentJobIds: [],
      dismissedAt: null,
      uploadSpeedBytesPerSec: null,
    };
    const step: StoredStepRecord = {
      stepId: "job-commit-1:commit",
      jobId: "job-commit-1",
      ordinal: 4,
      kind: "commit",
      status: "running",
      progressPct: 0,
      errorCode: null,
      errorMessage: null,
      startedAt: ts,
      finishedAt: null,
      app: "badger",
      lane: "source",
      dependsOn: [],
      payload: {},
      outputs: {},
      createdAt: ts,
      updatedAt: ts,
    };
    const ctx: StepHandlerCtx = {
      job,
      step,
      signal: new AbortController().signal,
      reportProgress: () => {},
      emitOutputs: () => {},
    };

    console.info(`[${SUITE}:${label}] invoking commitStepHandler`);
    await commitStepHandler(ctx);

    const libraryEvents = publishedEvents.filter(
      (e) => e.channel === "library" && e.event === "library.updated"
    );
    const terminalReason = libraryEvents[0]?.payload.reason;
    const terminalVersion = libraryEvents[0]?.payload.version as number | undefined;
    const changedMediaIds = libraryEvents[0]?.payload.changedMediaIds;
    console.info(`[${SUITE}:${label}] libraryEvents.length=${libraryEvents.length} terminalReason=${String(terminalReason)} terminalVersion=${terminalVersion} dbVersion=${state.version} changedMediaIds=${JSON.stringify(changedMediaIds)}`);
    try {
      expect(libraryEvents.length).toBe(1);
      expect(libraryEvents[0]?.payload.reason).toBe("commit:job-commit-1");
      // #671 R3: the terminal frame is a delta, not the snapshot: it names the
      // media the batch's writes touched, so the consumer fetches the
      // post-markMediaPlayable details (hasFiles=true) for exactly that media.
      expect(libraryEvents[0]?.payload.changedMediaIds).toEqual(["m1"]);
      expect(libraryEvents[0]?.payload).not.toHaveProperty("snapshot");
      // And the version on the event matches the post-batch DB version.
      expect(libraryEvents[0]?.payload.version).toBe(state.version);
    } catch (err) {
      dumpBadgerLibraryDbRunBatchSnapshot(label, {
        jobId: "job-commit-1",
        mediaId: "media-1",
        fileId: "file-1",
        dbVersion: state.version,
        publishedEvents,
        libraryEvents,
        libraryEventsCount: libraryEvents.length,
        terminalEvent: libraryEvents[0],
        terminalReason: terminalReason as string | undefined,
        terminalVersion,
        changedMediaIds,
        expectedLibraryEventsCount: 1,
        expected: {
          count: 1,
          reason: "commit:job-commit-1",
          changedMediaIds: ["m1"],
          version: state.version,
        },
        actual: {
          count: libraryEvents.length,
          reason: terminalReason,
          changedMediaIds,
          version: terminalVersion,
        },
        error: err,
      });
      throw err;
    }
  });
});
