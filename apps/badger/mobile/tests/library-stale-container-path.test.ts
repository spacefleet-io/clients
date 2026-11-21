/**
 * @test-id MOBILE-LIBRARY-STALE-CONTAINER-PATH-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: the iPhone logged at startup
 *   [LibrarySync] ENCRYPT_FAILED failed: You don't have permission to save the file "library" in the folder "Documents".
 * iOS gives the app's data container a new UUID path on every install and update
 * (`/var/mobile/Containers/Data/Application/<UUID>/Documents`) and moves the files. cache.json keeps
 * the ABSOLUTE `blobPath` written by an earlier install, and persist() encrypted into that path:
 * Foundation's createDirectory(withIntermediateDirectories:) on `<OLD-UUID>/Documents/library`
 * fails with NSFileWriteNoPermissionError (513) and exactly that message (reproduced with a Swift
 * probe against a missing, unwritable parent chain; a plain FILE named `library` gives 516 "already
 * exists" instead, and a locked-device protection failure would name `cache.blob`, not `library`).
 * persist() then wrote the same stale path back, so it failed on every launch. pending.json's
 * absolute snapshot/manifest paths had the same flaw: loadPending saw "file missing" and silently
 * dropped a pending snapshot that was still on disk.
 *
 * Contract: a persisted path to a file in the library folder is resolved against today's library
 * folder on load.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import { CACHE_JSON, LIB_DIR, fx, readCacheJson, resetFixture, setServer } from "./library-db-fixture";

const TAG = "[library-stale-container-path]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

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

// Pick<…, keyof …> drops the private members, which the seam below re-declares as public for the test.
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  pendingSync: { snapshotPath: string; manifestPath: string; snapshotId: string } | null;
};

const OLD_LIB_DIR = "/var/mobile/Containers/Data/Application/0B5C6D2E-OLD-INSTALL/Documents/library";

const dump = (label: string, db: LibraryDbSeam | null) =>
  console.error(
    `${TAG} FAIL ${label} ${JSON.stringify({
      encryptTargets: fx.encryptTargets,
      cache: readCacheJson(),
      pendingSync: db?.pendingSync ?? null,
      files: [...fx.files.keys()],
    })}`
  );

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setServer({ version: 7, snapshotVersion: 7 });
});

describe("persisted library paths survive an iOS container move", () => {
  it("@bugfix @regression-proof a pending snapshot recorded by the old install is still found in today's folder", async () => {
    fx.files.set(
      CACHE_JSON,
      JSON.stringify({ version: 7, snapshotVersion: 7, updatedAt: "2026-10-15T00:00:00.000Z", mode: "split" })
    );
    fx.files.set(`${LIB_DIR}/pending.snapshot`, "snapshot");
    fx.files.set(`${LIB_DIR}/pending.manifest`, "manifest");
    fx.files.set(
      `${LIB_DIR}/pending.json`,
      JSON.stringify({
        baseVersion: 7,
        snapshotId: "pending-from-old-install",
        chunkSize: 4 * 1024 * 1024,
        snapshotPath: `${OLD_LIB_DIR}/pending.snapshot`,
        manifestPath: `${OLD_LIB_DIR}/pending.manifest`,
        updatedAt: "2026-10-15T00:00:00.000Z",
        keyProbe: "probe",
        chunkRefs: [],
      })
    );
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    try {
      log("opened", { pendingSync: db.pendingSync });
      expect(db.pendingSync, "pre-fix: null (stale paths looked missing, the pending snapshot was dropped)").toMatchObject({
        snapshotId: "pending-from-old-install",
        snapshotPath: `${LIB_DIR}/pending.snapshot`,
        manifestPath: `${LIB_DIR}/pending.manifest`,
      });
    } catch (error) {
      dump("pending after container move", db);
      throw error;
    } finally {
      await db.close();
    }
  });
});
