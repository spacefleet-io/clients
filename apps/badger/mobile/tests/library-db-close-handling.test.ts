/**
 * @test-id MOBILE-LIBRARY-DB-CLOSE-HANDLING-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists (two phone bugs, one root area — DB open/close lifecycle):
 *
 * Bug 3: a red "Uncaught (in promise): Error: database not open" appeared
 *   intermittently during "Loading library…", mostly when JS reloaded mid-load.
 *   Every path below was a fire-and-forget promise with no `.catch`:
 *     - the lazy metadata/playback/ingest opens kicked off by the warm-start
 *       hot path (nobody awaits them until a query needs them);
 *     - `scheduleOpsFlush()` -> `void this.flushOps()`;
 *     - a second `close()` on a closed handle (the store closes from the
 *       effect cleanup, from reload() and from logout) rejecting with
 *       "database not open".
 *
 * Bug 2: after first login + key validation Home stayed on "No media yet"
 *   until a manual pull-to-refresh. OnboardingKeyScreen validates the key by
 *   `LibraryDb.open()` + a NON-awaited `testDb.close()`, then immediately
 *   calls `acknowledgeKey()` -> `load()` -> `LibraryDb.open()`.
 *   react-native-sqlite-storage shares ONE native connection per db name, and
 *   `close()` first waits for the lazy metadata/playback opens. That late
 *   close then closed the connection the freshly opened library was using, so
 *   the load failed over to a stale local cache and no sync ever refreshed
 *   the UI.
 *
 * The tests drive the real LibraryDb class over fake sqlite handles that
 * share a native "open" flag per db name, like the plugin does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import {
  fx,
  handlesNamed,
  mediaUpsertOp,
  resetFixture,
  seedSplitCache,
  setServer,
  settingOp,
  sleep,
} from "./library-db-fixture";

const TAG = "[library-db-close-handling]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

// vi.mock factories are hoisted above the static imports, so they cannot use
// them: the dynamic imports are the only way to reach the shared fixture.
vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).dbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

/** Private members the tests drive; LibraryDb exposes no public seam for them. */
// Pick<…, keyof …> drops the private members, which the seam below re-declares as public for the test.
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  queueOp(op: unknown, flushDelayMs?: number): Promise<void>;
};

const openDb = async () => (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;

/** Collects `unhandledRejection`s raised while the callback runs plus a settle window. */
const collectUnhandled = async (run: () => Promise<void>, settleMs = 30) => {
  const seen: string[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    await sleep(settleMs);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  log("unhandled rejections", seen);
  return seen;
};

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setServer({ version: 3, snapshotVersion: 3 });
  seedSplitCache({ version: 3 });
});

describe("mobile library DB open/close lifecycle", () => {
  it("@bugfix @regression-proof a failing lazy metadata open nobody awaits is handled, not an unhandled rejection", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    fx.openGate.set("library.metadata.sqlite", { gate, failWith: "database not open" });
    const seen = await collectUnhandled(async () => {
      const db = await openDb();
      log("opened; metadata open still pending", { version: db.getVersion() });
      release(); // the lazy open now fails with nobody awaiting it
      await sleep(5);
    });
    expect(seen, "lazy open failures must be handled and logged").toEqual([]);
  });

  it("@bugfix @regression-proof close() is idempotent: a second close never rejects with 'database not open'", async () => {
    const db = await openDb();
    await db.close();
    log("first close done", { core: handlesNamed("library.core.sqlite").map((handle) => handle.closed) });
    await expect(db.close()).resolves.toBeUndefined();
    await expect(db.close()).resolves.toBeUndefined();
  });

  it("@bugfix @regression-proof close() racing a still-pending lazy open leaves nothing unhandled and every opened handle closed", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    fx.openGate.set("library.metadata.sqlite", { gate, failWith: "database not open" });
    const seen = await collectUnhandled(async () => {
      const db = await openDb();
      const closing = db.close();
      release();
      await closing;
    });
    expect(seen).toEqual([]);
    for (const handle of fx.handles) {
      expect(handle.closed, `${handle.name} must be closed`).toBe(true);
    }
  });

  it("@bugfix @regression-proof a failing scheduled ops flush is handled", async () => {
    const db = await openDb();
    fx.opEncryptShouldFail = true;
    const seen = await collectUnhandled(async () => {
      await db.queueOp(settingOp("local-1", "k", "v"), 0);
      await sleep(300); // the flush timer fires after the 250 ms default delay at the latest
    }, 50);
    expect(seen).toEqual([]);
  });

  it("@bugfix @regression-proof a late close() of an earlier instance must not close the connection of a newer one (key validation -> load race)", async () => {
    // First login: OnboardingKeyScreen opens the library to validate the key
    // and fires `testDb.close()` without awaiting it. Its metadata open is
    // slow, and close() waits for it before closing anything.
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    fx.openGate.set("library.metadata.sqlite", { gate });
    const validationDb = await openDb();
    const validationClose = validationDb.close();

    // acknowledgeKey() -> load() -> LibraryDb.open() starts right away.
    const loadOpen = openDb();
    await sleep(10);
    log("validation close still waiting for the lazy open; releasing it");
    release();
    const loadedDb = await loadOpen;
    await validationClose;
    await sleep(5);

    log("native connection state after both settled", Object.fromEntries(fx.nativeOpen));
    expect(
      fx.nativeOpen.get("library.core.sqlite"),
      "the loaded library's core connection must still be open"
    ).toBe(true);
    await expect(loadedDb.listMedia(), "Home's first query must work").resolves.toEqual([]);
  });

  it("@bugfix @regression-proof remote ops applied by a sync notify data listeners so the UI refreshes without a manual pull", async () => {
    setServer({
      version: 5,
      snapshotVersion: 3,
      ops: [4, 5].map((version) => ({
        opId: `op-${version}`,
        version,
        op: version === 4 ? mediaUpsertOp(`op-${version}`, "media-1") : settingOp(`op-${version}`, "k", "v"),
      })),
    });
    const db = await openDb();
    const notifications: number[] = [];
    const unsubscribe = db.onDataChanged(() => {
      notifications.push(Date.now());
    });
    const changed = await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    unsubscribe();
    log("sync finished", { changed, notifications: notifications.length });
    expect(changed).toBe(true);
    expect(notifications.length, "listeners are told once the ops are applied").toBeGreaterThan(0);

    // A 409-driven sync from inside flushOps must notify too (no `changed` flag reaches the store there).
    setServer({
      version: 6,
      snapshotVersion: 3,
      ops: [{ opId: "op-6", version: 6, op: settingOp("op-6", "k2", "v2") }],
    });
    const again: number[] = [];
    db.onDataChanged(() => again.push(Date.now()));
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    expect(again.length).toBeGreaterThan(0);
  });

  it("@bugfix @regression-proof a progress save that lands after close() (player unmount after library teardown) is a no-op, not 'database not open'", async () => {
    const db = await openDb();
    await db.close();
    const seen = await collectUnhandled(async () => {
      await expect(db.setPlaybackProgress("media-1", "ep-1", 42, { positionSeconds: 10, durationSeconds: 100 })).resolves.toBeUndefined();
      await db.queueOp(settingOp("late", "k", "v"), 0);
      await sleep(300);
    }, 50);
    log("late save after close", { unhandled: seen });
    expect(seen).toEqual([]);
  });
});
