/**
 * @test-id MOBILE-LIBRARY-SYNC-STALL-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: on a OnePlus 6 (profile build) the JS thread blocked for seconds while the library
 * synced / flushed, so taps were dropped and the details sheet froze mid-animation. Measured causes:
 *
 *  1. `persist()` / `uploadSnapshot` built the combined snapshot DB by reading ~25k rows over the bridge
 *     and re-inserting each with its own awaited `executeSql` (80 s of saturated thread on lowend).
 *  2. Hashing the 8 MB snapshot (`hashBytes`, `exportDbBytes`) and each 4 MiB chunk ran in JS on base64
 *     that crossed the bridge in one piece: ~3 s stalls per chunk on the normal profile.
 *
 * The fix hands both to native code (ATTACH + INSERT..SELECT, streaming `sha256File`) and moves the bytes
 * JS still needs in 64 KB slices. The stall sampler logs `perf.js_stall` so regressions show in logcat.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import { startJsStallSampler, startJsStallSamplerInDevBuild } from "../src/lib/jsStallSampler";
import { buildCombinedCopyStatements } from "../src/lib/library/libraryCopy";
import { fx, resetFixture, seedSplitCache, setServer } from "./library-db-fixture";

const h = vi.hoisted(() => ({
  snapshotExecuted: [] as string[],
  snapshotBatches: [] as string[][],
  batchError: null as Error | null,
}));

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => {
  const base = (await import("./library-db-fixture")).dbFilesMock();
  return {
    ...base,
    openSnapshotDb: async () => ({
      executeSql: async (sql: string) => {
        h.snapshotExecuted.push(sql);
        return [{ rows: { length: 0, item: () => ({}) } }];
      },
      sqlBatch: async (statements: Array<[string, unknown[]] | string>) => {
        if (h.batchError) throw h.batchError;
        h.snapshotBatches.push(statements.map((entry) => (typeof entry === "string" ? entry : entry[0])));
      },
      close: async () => undefined,
    }),
  };
});
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

type LibraryDbSeam = {
  buildSnapshotDb(): Promise<unknown>;
  flushPending(): Promise<void>;
  close(): Promise<void>;
};

beforeEach(() => {
  resetFixture();
  h.snapshotExecuted = [];
  h.snapshotBatches = [];
  h.batchError = null;
});

describe("library sync does not block the JS thread", () => {
  it("@bugfix @regression-proof building the upload snapshot copies the split DBs inside SQLite instead of row by row over the bridge", async () => {
    setServer({ version: 6, snapshotVersion: 6 });
    seedSplitCache({ version: 6 });
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    h.snapshotExecuted = [];
    h.snapshotBatches = [];

    await db.buildSnapshotDb();

    const attached = h.snapshotExecuted.filter((sql) => sql.startsWith("ATTACH DATABASE"));
    expect(attached.map((sql) => sql.match(/AS (\w+);$/)?.[1])).toEqual(["src_core", "src_metadata", "src_playback"]);
    expect(h.snapshotExecuted.filter((sql) => sql.startsWith("DETACH DATABASE"))).toHaveLength(3);
    // No row ever goes through executeSql; the only round trips are ATTACH/DETACH and leaving WAL at the end.
    expect(h.snapshotExecuted.every((sql) => /^(ATTACH|DETACH) DATABASE|^PRAGMA journal_mode=DELETE;$/.test(sql))).toBe(true);
    // @req LIB-FMT-10[badger-mobile]: the built file leaves WAL last, so the export reads every row with a rollback-journal header.
    expect(h.snapshotExecuted.at(-1)).toBe("PRAGMA journal_mode=DELETE;");
    // One native transaction holds every copy statement.
    expect(h.snapshotBatches).toHaveLength(1);
    expect(h.snapshotBatches[0]).toEqual(buildCombinedCopyStatements());
  });

  it("@bugfix @regression-proof the copy statements are set-based INSERT..SELECTs from the attached DBs only", () => {
    const statements = buildCombinedCopyStatements();
    expect(statements.length).toBeLessThan(40);
    for (const sql of statements) {
      expect(sql).toMatch(/^INSERT OR REPLACE INTO main\.\w+/);
      expect(sql).toMatch(/SELECT [\s\S]+ FROM src_(core|metadata|playback)\./);
      expect(sql).not.toContain("?");
    }
    // Playback rows of titles that are no longer in the library must not be published.
    const playback = statements.filter((sql) => sql.includes("FROM src_playback."));
    expect(playback.length).toBeGreaterThan(0);
    for (const sql of playback) expect(sql).toContain("src_core.media_items");
  });

  it("@bugfix @regression-proof building the upload snapshot detaches the source DBs when the copy fails", async () => {
    setServer({ version: 6, snapshotVersion: 6 });
    seedSplitCache({ version: 6 });
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    h.snapshotExecuted = [];
    h.batchError = new Error("no such table: src_metadata.media_skip_markers");
    await expect(db.buildSnapshotDb()).rejects.toThrow("no such table");

    expect(h.snapshotExecuted.filter((sql) => sql.startsWith("DETACH DATABASE"))).toHaveLength(3);
  });
});

describe("pending snapshot publishing", () => {
  it("@bugfix @regression-proof concurrent flushPending calls publish the pending snapshot once", async () => {
    // Every stream event (~16 s) calls flushPending while the previous upload (15 s on the phone) is
    // still running; each call re-hashed and re-uploaded the whole snapshot and the loser died on ENOENT.
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.files.set("/docs/library/pending.snapshot", "snapshot");
    fx.files.set("/docs/library/pending.manifest", "manifest");
    fx.files.set(
      "/docs/library/pending.json",
      JSON.stringify({
        baseVersion: 10,
        snapshotId: "pending-snapshot",
        chunkSize: 4 * 1024 * 1024,
        snapshotPath: "/docs/library/pending.snapshot",
        manifestPath: "/docs/library/pending.manifest",
        updatedAt: "2026-10-15T00:00:00.000Z",
        keyProbe: "probe",
        chunkRefs: [],
      })
    );
    fx.nextPutVersion = 11;
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;

    await Promise.all([db.flushPending(), db.flushPending(), db.flushPending()]);

    expect(fx.putDbCalls).toBe(1);
    await db.close();
  });
});

describe("jsStallSampler", () => {
  const run = (driftsMs: number[], thresholdMs = 100) => {
    let clock = 0;
    let tick = () => undefined as void;
    const logged: Array<{ event: string; data: Record<string, number> }> = [];
    const sampler = startJsStallSampler({
      intervalMs: 50,
      thresholdMs,
      summaryMs: 1_000_000,
      now: () => clock,
      setInterval: (cb) => {
        tick = cb;
        return 0 as never;
      },
      clearInterval: () => undefined,
      log: (event, data) => logged.push({ event, data }),
    });
    for (const drift of driftsMs) {
      clock += 50 + drift;
      tick();
    }
    return { sampler, logged };
  };

  it("@bugfix @regression-proof logs perf.js_stall only for drifts at or above the threshold", () => {
    const { sampler, logged } = run([0, 40, 100, 3000, 99]);
    expect(logged.map((entry) => entry.event)).toEqual(["perf.js_stall", "perf.js_stall"]);
    expect(logged.map((entry) => entry.data.ms)).toEqual([100, 3000]);
    expect(sampler.maxStallMs()).toBe(3000);
  });

  it("@bugfix @regression-proof reports where each stall started, relative to the sampler start", () => {
    const { logged } = run([0, 500]);
    // start 0, first tick at 50, the stalled tick expected at 100 and fired at 650.
    expect(logged[0].data).toEqual({ ms: 500, atMs: 100 });
  });

  /**
   * @bugfix @regression-proof
   * On a OnePlus 6 test phone the walk logged `perf.js_stall.max totalMaxMs 24264`. Reproduced (2026-11-12): sending Badger to the
   * background for 20 s logged `perf.js_stall {"ms":21488}` on return. Android pauses JS timers while the app is in
   * the background, so the sampler counted the time away as a freeze. Time spent in the background is not a stall.
   */
  it("@bugfix @regression-proof does not count time spent in the background as a stall", () => {
    let clock = 0;
    let tick = () => undefined as void;
    let onAppState: (active: boolean) => void = () => undefined;
    let unsubscribed = false;
    const logged: Array<{ event: string; data: Record<string, number> }> = [];
    const sampler = startJsStallSampler({
      intervalMs: 50,
      thresholdMs: 100,
      summaryMs: 1_000_000,
      now: () => clock,
      setInterval: (cb) => {
        tick = cb;
        return 0 as never;
      },
      clearInterval: () => undefined,
      subscribeAppState: (listener) => {
        onAppState = listener;
        return () => {
          unsubscribed = true;
        };
      },
      log: (event, data) => logged.push({ event, data }),
    });
    const step = (ms: number) => {
      clock += ms;
      tick();
    };
    step(50);
    // Backgrounded: no tick fires for 20 s, then the first tick after return may run before or after the "active" event.
    onAppState(false);
    clock += 20_000;
    tick();
    onAppState(true);
    step(50);
    // Second absence: the "active" event arrives before the first tick.
    onAppState(false);
    clock += 15_000;
    onAppState(true);
    step(50);
    // A real stall while in the foreground is still reported.
    step(50 + 700);
    console.log("[jsStallSampler] background test logged", JSON.stringify(logged), "max", sampler.maxStallMs());
    expect(logged.map((entry) => entry.data.ms)).toEqual([700]);
    expect(sampler.maxStallMs()).toBe(700);
    sampler.stop();
    expect(unsubscribed).toBe(true);
  });

  const countingTimers = () => {
    const started: number[] = [];
    return {
      started,
      options: {
        setInterval: (_cb: () => void, ms: number) => {
          started.push(ms);
          return 0 as never;
        },
        clearInterval: () => undefined,
      },
    };
  };

  /** @req PERF-MOBILE-04[badger-mobile,badger-tv] */
  it("@regression-proof a store build starts no sampler timer (#957)", () => {
    const timers = countingTimers();
    expect(startJsStallSamplerInDevBuild({ dev: false, devTicketKeyFlag: "" }, timers.options)).toBeNull();
    expect(startJsStallSamplerInDevBuild({ dev: false, devTicketKeyFlag: undefined }, timers.options)).toBeNull();
    expect(timers.started).toEqual([]);
  });

  /** @req PERF-MOBILE-04[badger-mobile,badger-tv] */
  it("dev builds and dev-testing profile builds keep the 50 ms sampler", () => {
    const timers = countingTimers();
    expect(startJsStallSamplerInDevBuild({ dev: true, devTicketKeyFlag: undefined }, timers.options)).not.toBeNull();
    expect(startJsStallSamplerInDevBuild({ dev: false, devTicketKeyFlag: "1" }, timers.options)).not.toBeNull();
    expect(timers.started).toEqual([50, 50]);
  });
});
