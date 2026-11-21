/**
 * @test-id MOBILE-LIBRARY-CACHE-OWNER-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: the split local library (cache.json + sqlite files + pending ops) is global to
 * the app install. `pickBlob` treats ANY split cache as usable, so signing in as a different
 * account after a session rejection (token revoked: the auth store drops token+user but, unlike
 * logout, never cleared the local library) opened the previous account's library and then pushed
 * its pending ops to the new account. The cache now records its owner (user id) and the store
 * claims it before opening: a different owner wipes the local library first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import { fx, readCacheJson, resetFixture, seedSplitCache, settingOp } from "./library-db-fixture";

const TAG = "[library-cache-owner]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("../src/lib/library/opsPage", async (importOriginal) => (await import("./library-db-fixture")).opsPageMock(await importOriginal()));
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).dbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

const PENDING_OPS = "/docs/library/pending_ops.json";

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("local library is bound to the account that created it", () => {
  it("@bugfix @regression-proof a different user claiming the install wipes the previous user's cache and pending ops", async () => {
    seedSplitCache({ version: 7 });
    fx.files.set(PENDING_OPS, JSON.stringify([settingOp("a-op", "k", "v")]));
    await LibraryDb.claimLocalCache("user-a");
    expect(readCacheJson(), "first claim adopts the existing cache").not.toBeNull();

    await LibraryDb.claimLocalCache("user-b");
    log("after user-b claim", { cache: readCacheJson(), files: [...fx.files.keys()] });
    expect(readCacheJson(), "user A's cache must not be reused for user B").toBeNull();
    expect(fx.files.has(PENDING_OPS), "user A's unsynced ops must not be pushed to user B").toBe(false);
  });

  it("@bugfix @regression-proof the same user reclaiming keeps the cache and pending ops", async () => {
    seedSplitCache({ version: 7 });
    fx.files.set(PENDING_OPS, JSON.stringify([settingOp("a-op", "k", "v")]));
    await LibraryDb.claimLocalCache("user-a");
    await LibraryDb.claimLocalCache("user-a");
    expect(readCacheJson()?.version).toBe(7);
    expect(fx.files.has(PENDING_OPS)).toBe(true);
  });

  it("@bugfix @regression-proof clearLocalCache forgets the owner so the next account starts clean", async () => {
    seedSplitCache({ version: 7 });
    await LibraryDb.claimLocalCache("user-a");
    await LibraryDb.clearLocalCache();
    seedSplitCache({ version: 3 });
    await LibraryDb.claimLocalCache("user-b");
    expect(readCacheJson()?.version, "no stale owner: a cache created after the clear is adopted").toBe(3);
  });
});
