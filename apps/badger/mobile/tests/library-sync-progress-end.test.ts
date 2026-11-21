/**
 * @test-id MOBILE-LIBRARY-SYNC-PROGRESS-END-001
 * @level unit
 * @req LIB-SYNC-13[badger-mobile]
 * @bugfix
 * @regression-proof
 *
 * Why this exists: on op9 (2026-11-21) the cold start's sync was begun by the db itself before the store's tracked
 * call joined it, and the tab bar's sign never showed for a 15.9 MB catch-up. The tracker now shows any run that finds
 * the server newer, so the db must say when that run is over (`end`), whoever started it. Drives the real LibraryDb
 * over the in-memory fixture.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import type { LibrarySyncProgressEvent } from "../src/lib/librarySyncStatus";
import { fx, resetFixture, seedSplitCache, setServer, settingOp, settle } from "./library-db-fixture";

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

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("LibraryDb sync progress (LIB-SYNC-13)", () => {
  // @req LIB-SYNC-13[badger-mobile]
  it("a run that finds the server newer says start, each page's size before it, each page, then end", async () => {
    setServer({
      version: 6,
      snapshotVersion: 1,
      ops: [2, 3, 4, 5, 6].map((version) => ({ opId: `op-${version}`, version, op: settingOp(`op-${version}`, `k${version}`, "v") })),
    });
    seedSplitCache({ version: 2 });
    const db = await LibraryDb.open("token", "key");
    const events: LibrarySyncProgressEvent[] = [];
    db.onSyncProgress((event) => events.push(event));

    expect(await db.syncFromRemoteIfNewer(fx.meta ?? undefined)).toBe(true);
    await settle(db);
    expect(events[0]).toEqual({ kind: "start", fromVersion: 2, toVersion: 6 });
    expect(events.filter((event) => event.kind === "page").at(-1)).toEqual({ kind: "page", version: 6 });
    events.forEach((event, index) => {
      if (event.kind !== "page") return;
      const before = events[index - 1];
      expect(before?.kind, "each page is announced with its size before its download").toBe("fetch");
      expect(before?.kind === "fetch" && before.bytes).toBeGreaterThan(0);
    });
    expect(events.at(-1), "the run's last word is its end").toEqual({ kind: "end", error: null });
    expect(events.filter((event) => event.kind === "end")).toHaveLength(1);
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("a check that finds nothing new says nothing, not even end", async () => {
    setServer({ version: 3, snapshotVersion: 1, ops: [] });
    seedSplitCache({ version: 3 });
    const db = await LibraryDb.open("token", "key");
    const events: LibrarySyncProgressEvent[] = [];
    db.onSyncProgress((event) => events.push(event));

    expect(await db.syncFromRemoteIfNewer(fx.meta ?? undefined)).toBe(false);
    expect(events).toEqual([]);
  });
});
