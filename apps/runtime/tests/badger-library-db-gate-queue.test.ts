/**
 * @bugfix @regression-proof
 *
 * #25 N4 — runtime library commands queued for minutes behind one opGate.
 *
 * Symptom (ultimate stress run, 4-core low-end profile): POST
 * /modules/badger/commands calls over 1 s had p50 13-23 s, p90 85-129 s, max
 * 336 s while /runtime/health answered in 1 ms. The event loop was free; the
 * commands were QUEUED. `BadgerLibraryDbService` ran every LibraryDb call —
 * reads included — through one promise gate, and `syncFromRemoteIfNewer`
 * held that gate across its whole network round trip (flushPending, flushOps
 * incl. compaction snapshot upload, meta, ops download). On a saturated
 * uplink one sync held it for minutes; `hasPendingSync`, `getMediaDetails`,
 * progress writes and ingest commits all waited behind it.
 *
 * Fix: the sync's network half (`prepareRemoteSync`) runs outside the gate,
 * only the local apply takes it; pure synchronous reads bypass the gate
 * unless an atomic op (lifecycle, runBatch, sync apply) is queued/running;
 * concurrent syncs coalesce; every slow gate op is logged with wait/hold
 * time and queue depth.
 *
 * Pre-fix every "must not wait" case below times out: the fake's legacy
 * `syncFromRemoteIfNewer` blocks on the same deferred network the new
 * `prepareRemoteSync` does, and the old gate serialised everything behind it.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";

const SUITE = "badger-library-db-gate-queue";
const log = (label: string, data?: unknown) =>
  console.info(`[${SUITE}] ${label}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => Promise.withResolvers<void>();

/**
 * Lets every queued promise reaction and the gate's chained `.then`s run
 * (one macrotask turn, no wall-clock duration), so "still pending after
 * this" means "blocked on something", not "not scheduled yet".
 */
const drainMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
};

/** The value if `promise` settled once the queue drained, else PENDING. */
const settledValue = async <T,>(promise: Promise<T>): Promise<T | "PENDING"> => {
  let state: { value: T } | null = null;
  void promise.then((value) => {
    state = { value };
  }, () => undefined);
  await drainMicrotasks();
  const settled = state as { value: T } | null;
  return settled ? settled.value : "PENDING";
};

/**
 * Fake LibraryDb. `network` stands for the remote round trip: both the
 * legacy one-shot `syncFromRemoteIfNewer` and the split `prepareRemoteSync`
 * block on it, so the pre-fix service (which only knows the one-shot path)
 * is exercised against the same slow network.
 */
class FakeLibraryDb {
  version = 1;
  remoteVersion = 0;
  network = deferred();
  calls: string[] = [];
  prepareCount = 0;
  applyCount = 0;
  /** When > 0, the next apply reports the base moved (a concurrent ops flush committed). */
  staleApplies = 0;
  progress = new Map<string, number>();
  getVersion() {
    return this.version;
  }
  getSnapshot() {
    return { media: [], playlists: [] };
  }
  getCountSummary() {
    return { mediaCount: 0, playlistCount: 0 };
  }
  takeChangedMedia() {
    return { mediaIds: [] as string[], all: false };
  }
  getDatasetStatus() {
    return { core: true, metadata: true, playback: true };
  }
  hasPendingSync() {
    this.calls.push("hasPendingSync");
    return false;
  }
  getMediaDetails(mediaId: string) {
    this.calls.push(`getMediaDetails:${mediaId}`);
    return { id: mediaId, progressPct: this.progress.get(mediaId) ?? null };
  }
  setProgress(mediaId: string, pct: number) {
    this.calls.push(`setProgress:${mediaId}:${pct}`);
    this.progress.set(mediaId, pct);
    this.version += 1;
    return Promise.resolve(true);
  }
  markMediaPlayable(mediaId: string) {
    this.calls.push(`markMediaPlayable:${mediaId}`);
    this.version += 1;
    return Promise.resolve(true);
  }
  async syncFromRemoteIfNewer() {
    this.calls.push("syncFromRemoteIfNewer:legacy:start");
    await this.network.promise;
    this.remoteVersion += 1;
    this.version += 1;
    this.calls.push("syncFromRemoteIfNewer:legacy:done");
    return true;
  }
  async prepareRemoteSync(meta: unknown) {
    this.prepareCount += 1;
    this.calls.push(`prepareRemoteSync:start meta=${JSON.stringify(meta)}`);
    await this.network.promise;
    this.calls.push("prepareRemoteSync:done");
    return { kind: "ops", fromVersion: this.remoteVersion, toVersion: this.remoteVersion + 1, ops: [], meta };
  }
  async applyPreparedRemoteSync(prepared: { fromVersion: number; toVersion: number }) {
    this.applyCount += 1;
    if (this.staleApplies > 0) {
      this.staleApplies -= 1;
      this.calls.push("applyPreparedRemoteSync:stale");
      return "stale";
    }
    this.calls.push(`applyPreparedRemoteSync:${prepared.fromVersion}->${prepared.toVersion}`);
    this.remoteVersion = prepared.toVersion;
    this.version += 1;
    return true;
  }
}

const attach = (fake: FakeLibraryDb) => {
  const service = new BadgerLibraryDbService();
  // Test seam: inject the fake as the open LibraryDb (no bun:sqlite under vitest).
  (service as unknown as { db: unknown }).db = fake;
  const published: Array<{ version: unknown; reason: unknown }> = [];
  service.setEventPublisher((_channel, _event, payload) => {
    published.push({ version: payload.version, reason: payload.reason });
  });
  return { service, published };
};

const dump = (label: string, service: BadgerLibraryDbService, fake: FakeLibraryDb, extra?: Record<string, unknown>) => {
  console.error(
    `=== [${SUITE}:${label}] state ===\n${JSON.stringify(
      { gate: service.getGateStats(), fake: { version: fake.version, remoteVersion: fake.remoteVersion, prepareCount: fake.prepareCount, applyCount: fake.applyCount, calls: fake.calls.slice(-40) }, ...extra },
      null,
      2
    )}`
  );
};

describe("BadgerLibraryDbService op gate under a slow remote sync [#25 N4]", () => {
  let warnSpy: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn");
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("a read does not wait behind a remote sync's network round trip", async () => {
    const fake = new FakeLibraryDb();
    const { service } = attach(fake);
    log("phase:start sync whose network never answers until released");
    const sync = service.call("syncFromRemoteIfNewer", [null]);
    await drainMicrotasks();
    log("phase:read hasPendingSync + getMediaDetails during the sync", service.getGateStats());
    const pending = await settledValue(service.call("hasPendingSync"));
    const details = await settledValue(service.call("getMediaDetails", ["m1"]));
    try {
      expect(pending).toBe(false);
      expect(details).toEqual({ id: "m1", progressPct: null });
      expect(service.getGateStats().bypassedReads).toBe(2);
    } catch (err) {
      dump("read-behind-sync", service, fake, { pending, details });
      throw err;
    } finally {
      fake.network.resolve();
      await sync;
    }
    log("phase:sync settled", service.getGateStats());
  });

  it("a progress write does not wait behind a remote sync's network round trip, and the sync still applies after it", async () => {
    const fake = new FakeLibraryDb();
    const { service, published } = attach(fake);
    const sync = service.call("syncFromRemoteIfNewer", [null]);
    await drainMicrotasks();
    log("phase:setProgress during sync network", service.getGateStats());
    const write = await settledValue(service.call("setProgress", ["m1", 42.5]));
    try {
      expect(write).toBe(true);
      expect(fake.progress.get("m1")).toBe(42.5);
    } catch (err) {
      dump("write-behind-sync", service, fake, { write });
      throw err;
    }
    fake.network.resolve();
    const changed = await sync;
    log("phase:sync settled", { changed, published, calls: fake.calls });
    try {
      expect(changed).toBe(true);
      expect(fake.applyCount).toBe(1);
      // The write and the sync apply each published their own version.
      expect(published.map((p) => p.reason)).toEqual(["setProgress", "syncFromRemoteIfNewer"]);
      expect(fake.progress.get("m1")).toBe(42.5);
    } catch (err) {
      dump("sync-after-write", service, fake, { changed, published });
      throw err;
    }
  });

  it("reads still wait for an in-flight runBatch (no half-done commit is visible)", async () => {
    const fake = new FakeLibraryDb();
    const { service } = attach(fake);
    const release = deferred();
    const batch = service.runBatch("commit:job-1", async () => {
      await service.call("setProgress", ["m1", 1]);
      await release.promise;
      await service.call("markMediaPlayable", ["m1"]);
    });
    await drainMicrotasks();
    const read = service.call("getMediaDetails", ["m1"]);
    const early = await settledValue(read);
    try {
      expect(early).toBe("PENDING");
    } catch (err) {
      dump("read-during-batch", service, fake, { early });
      throw err;
    }
    release.resolve();
    await batch;
    await expect(read).resolves.toEqual({ id: "m1", progressPct: 1 });
    const order = fake.calls.filter((c) => c.startsWith("markMediaPlayable") || c.startsWith("getMediaDetails"));
    log("phase:order", order);
    expect(order).toEqual(["markMediaPlayable:m1", "getMediaDetails:m1"]);
  });

  it("concurrent sync requests coalesce into one follow-up round trip", async () => {
    const fake = new FakeLibraryDb();
    const { service } = attach(fake);
    const first = service.call("syncFromRemoteIfNewer", [null]);
    await drainMicrotasks();
    const metaA = { version: 5, exists: true };
    const metaB = { version: 7, exists: true };
    const followers = [
      service.call("syncFromRemoteIfNewer", [metaA]),
      service.call("syncFromRemoteIfNewer", [metaB]),
      service.call("syncFromRemoteIfNewer", [metaB]),
    ];
    fake.network.resolve();
    const results = await Promise.all([first, ...followers]);
    log("phase:coalesced", { results, prepareCount: fake.prepareCount, gate: service.getGateStats(), calls: fake.calls });
    try {
      expect(fake.prepareCount).toBe(2);
      expect(service.getGateStats().coalescedSyncs).toBe(2);
      // The follow-up synced against the newest meta it was handed.
      expect(fake.calls).toContain(`prepareRemoteSync:start meta=${JSON.stringify(metaB)}`);
    } catch (err) {
      dump("coalesce", service, fake, { results });
      throw err;
    }
  });

  it("a stale apply (base moved during prepare) re-prepares outside the gate with fresh meta", async () => {
    const fake = new FakeLibraryDb();
    fake.staleApplies = 1;
    fake.network.resolve();
    const { service } = attach(fake);
    const changed = await service.call("syncFromRemoteIfNewer", [{ version: 3, exists: true }]);
    log("phase:stale", { changed, calls: fake.calls, gate: service.getGateStats() });
    try {
      expect(changed).toBe(true);
      expect(fake.prepareCount).toBe(2);
      expect(fake.calls).toContain("prepareRemoteSync:start meta=null");
      expect(service.getGateStats().staleSyncApplies).toBe(1);
    } catch (err) {
      dump("stale", service, fake, { changed });
      throw err;
    }
  });

  it("logs every slow gate op with wait, hold and queue depth", async () => {
    // The gate measures with performance.now(); drive it by hand so the
    // "slow" op is slow without a real wall-clock wait.
    let clockMs = 1_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clockMs);
    const fake = new FakeLibraryDb();
    const { service } = attach(fake);
    const release = deferred();
    const batch = service.runBatch("commit:slow", async () => {
      await release.promise;
    });
    const queuedWrite = service.call("setProgress", ["m1", 9]);
    await drainMicrotasks();
    clockMs += 300;
    release.resolve();
    await batch;
    await queuedWrite;
    const gateLines = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.startsWith("[badger-library-db] gate "));
    log("phase:gate log lines", gateLines);
    try {
      const parsed: Array<Record<string, unknown>> = gateLines.map((line) =>
        JSON.parse(line.slice("[badger-library-db] gate ".length))
      );
      const batchLine = parsed.find((entry) => entry.op === "batch:commit:slow");
      const writeLine = parsed.find((entry) => entry.op === "setProgress");
      expect(batchLine).toMatchObject({ kind: "batch", ok: true });
      expect(batchLine?.holdMs).toBeGreaterThanOrEqual(250);
      expect(writeLine).toMatchObject({ kind: "call", depthAtEnqueue: 2, behind: "batch:commit:slow" });
      expect(writeLine?.waitMs).toBeGreaterThanOrEqual(250);
    } catch (err) {
      dump("gate-log", service, fake, { gateLines });
      throw err;
    } finally {
      nowSpy.mockRestore();
    }
  });
});
