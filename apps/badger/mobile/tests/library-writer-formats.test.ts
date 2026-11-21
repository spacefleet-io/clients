/**
 * @test-id MOBILE-LIBRARY-WRITER-FORMATS-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: once a library is stamped storage format v2 (LIB-FMT-07 writer flip), the API
 * answers 409 `library_format_downgrade` to any write that declares a lower version, and an absent
 * declaration counts as 1. Mobile sent no `x-library-storage-format-version` on op POSTs and no
 * `storageFormatVersion` on snapshot PUTs, so every mobile write into a v2 library would have been
 * rejected. Every mobile library write must declare this build's storage and op-stream versions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import { LibraryDb } from "../src/lib/libraryDb";
import { decodeCompressedFrame, isCompressedFrame } from "@space/library-db-definition/payloadCompression";
import { fflateCodec } from "@space/mobile-shell/libraryOps";
import { fx, resetFixture, seedSplitCache, setServer, settingOp } from "./library-db-fixture";

const TAG = "[library-writer-formats]";
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

const PENDING_JSON = "/docs/library/pending.json";
const PENDING_SNAPSHOT = "/docs/library/pending.snapshot";
const PENDING_MANIFEST = "/docs/library/pending.manifest";

// Pick<…, keyof …> drops the private members, which the seam below re-declares as public for the test.
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  queueOp(op: unknown): Promise<void>;
  flushOps(): Promise<void>;
};

const EXPECTED = { storageFormatVersion: STORAGE_FORMAT_VERSION, opStreamVersion: OP_STREAM_VERSION };

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("mobile declares the library formats it writes", () => {
  it("@bugfix @regression-proof an op upload declares the build's storage and op-stream versions", async () => {
    log("phase:open");
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.nextPutVersion = 11;
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    try {
      await db.queueOp(settingOp("local-1", "episode_resume_v1:e1", "{}"));
      await db.flushOps();
      log("state", { putOpCalls: fx.putOpCalls, declared: fx.declaredFormats.op, expected: EXPECTED });
      expect(fx.putOpCalls, "fixture sanity: the op was uploaded").toBe(1);
      expect(fx.declaredFormats.op).toEqual([EXPECTED]);
    } finally {
      await db.close();
    }
  });

  it("@bugfix @regression-proof a pending snapshot publish declares the build's storage and op-stream versions", async () => {
    log("phase:open");
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.nextPutVersion = 11;
    fx.files.set(PENDING_SNAPSHOT, "snapshot");
    fx.files.set(PENDING_MANIFEST, "manifest");
    fx.files.set(
      PENDING_JSON,
      JSON.stringify({
        baseVersion: 10,
        snapshotId: "snapshot-formats",
        chunkSize: 4 * 1024 * 1024,
        snapshotPath: PENDING_SNAPSHOT,
        manifestPath: PENDING_MANIFEST,
        updatedAt: "2026-10-21T00:00:00.000Z",
        keyProbe: "probe",
        chunkRefs: [],
      })
    );
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    try {
      await db.flushPending();
      log("state", { putDbCalls: fx.putDbCalls, declared: fx.declaredFormats.db, expected: EXPECTED });
      expect(fx.putDbCalls, "fixture sanity: the pending snapshot was published").toBe(1);
      expect(fx.declaredFormats.db).toEqual([EXPECTED]);
    } finally {
      await db.close();
    }
  });

  it("@req LIB-FMT-07 an op upload sends the op compressed before encryption, even a tiny one", async () => {
    log("phase:open");
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.nextPutVersion = 11;
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    try {
      const op = settingOp("local-frame", "episode_resume_v1:e1", "{}");
      await db.queueOp(op);
      await db.flushOps();
      const posted = fx.postedOps[0];
      log("state", { posted: posted?.length, framed: posted ? isCompressedFrame(posted) : null });
      expect(posted, "fixture sanity: the op was uploaded").toBeDefined();
      expect(isCompressedFrame(posted!), "the bytes handed to encryption are a v2 frame").toBe(true);
      const plain = JSON.parse(new TextDecoder().decode(decodeCompressedFrame(posted!, fflateCodec)));
      expect(plain.id).toBe("local-frame");
    } finally {
      await db.close();
    }
  });
});
