/**
 * @test-id MOBILE-LIBRARY-LOGOUT-PENDING-SNAPSHOT-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: found on a OnePlus 6. `LibraryDb.clearLocalCache` (logout, owner mismatch) removed
 * the cache, pending ops and DB files but left the unsynced pending snapshot (pending.json,
 * pending.snapshot, pending.manifest). After signing back in, the fresh LibraryDb loaded that stale
 * pending record, so `syncFromRemoteIfNewer` took its `pendingSync` early-return forever and Home stayed
 * on "No media yet" at local version 1 while the server held version 525. The stale snapshot would also
 * have been pushed into whichever account signed in next.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import { fx, readCacheJson, resetFixture, seedSplitCache, settingOp } from "./library-db-fixture";

const TAG = "[library-logout-pending-snapshot]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
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


const PENDING_FILES = [
  "/docs/library/pending.json",
  "/docs/library/pending.snapshot",
  "/docs/library/pending.manifest",
];

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("logout clears the unsynced pending snapshot", () => {
  it("@bugfix @regression-proof clearLocalCache removes pending.json, pending.snapshot and pending.manifest", async () => {
    seedSplitCache({ version: 7 });
    for (const path of PENDING_FILES) fx.files.set(path, "stale");
    await LibraryDb.clearLocalCache();
    log("after clearLocalCache", { files: [...fx.files.keys()] });
    for (const path of PENDING_FILES) {
      expect(fx.files.has(path), `${path} must not survive logout`).toBe(false);
    }
  });
});
