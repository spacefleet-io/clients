/**
 * @test-id MOBILE-LIBRARY-OP-STREAM-V4-001
 * @level unit
 * @req LIB-FMT-12 LIB-FMT-13
 *
 * Why this exists: an account switched to op stream 4 refuses every read that does not declare 4 (426) and every
 * write that declares 3 once switched; a write declaring 4 before the switch is a 409 `op_stream_not_switched`. The
 * phone must declare 4 on reads always, convert its playback copy in place when meta says switched, declare 4 on
 * writes only after that conversion, retry a refused write once after re-reading meta, and stop on an op type it
 * does not know with nothing applied and the update screen latched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { ApiError } from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import { __resetAppVersionStateForTests, getAppUpdateRequired, setLibraryReadOpStreamVersion } from "@space/shared/appVersion";
import { OP_STREAM_VERSION, READ_OP_STREAM_VERSION, UnknownOpTypeError } from "@space/library-db-definition/ops";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import { LibraryDb } from "../src/lib/libraryDb";
import { libraryReadHeaders, libraryReadOpStreamVersion } from "../src/lib/library/libraryReads";
import { nativeHttpError } from "../src/lib/library/opsPage";
import { inlineBlobParams, packedListFromRow } from "../src/lib/library/packedChunkRows";
import { fx, PLAYBACK_DB_PATH, resetFixture, seedSplitCache, setServer, settingOp, settle } from "./library-db-fixture";

const TAG = "[library-op-stream-v4]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

/** What native `convertChunkLists` was asked to do, and whether it fails (it leaves the file unchanged then). */
const native = vi.hoisted(() => ({ converts: [] as string[], convertFails: false }));

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
vi.mock("../src/native/LibrarySync", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  convertChunkLists: async (path: string) => {
    native.converts.push(path);
    if (native.convertFails) throw Object.assign(new Error("convert failed"), { code: "CONVERT_FAILED" });
    return { lists: 2, rows: 40, ms: 3 };
  },
}));
// The migration runner itself is covered by library-migrations; here the conversion step only has to run.
vi.mock("../src/lib/librarySchema", () => ({
  convertPlaybackToPacked: async (_db: unknown, convert: () => Promise<unknown>) => {
    await convert();
  },
}));

type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  remoteVersion: number;
  pendingOps: LibraryOp[];
  queueOp(op: unknown): Promise<void>;
  flushOps(): Promise<void>;
};

const declared = (opStreamVersion: number) => ({ storageFormatVersion: STORAGE_FORMAT_VERSION, opStreamVersion });

const SWITCH_426 = { error: "app_update_required", reason: "library_op_stream", opStreamVersion: 4 };

const openSwitched = async (target: number | null) => {
  setServer({ version: 10, snapshotVersion: 10 });
  if (fx.meta) fx.meta.targetOpStreamVersion = target;
  seedSplitCache({ version: 10 });
  fx.nextPutVersion = 11;
  return (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
};

beforeEach(() => {
  resetFixture();
  __resetAppVersionStateForTests();
  // What apiConfig does at start-up on this build.
  setLibraryReadOpStreamVersion(READ_OP_STREAM_VERSION);
  native.converts = [];
  native.convertFails = false;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  __resetAppVersionStateForTests();
});

describe("library reads declare op stream 4", () => {
  it("@req LIB-FMT-13 a hand-made read (the native ops page) sends the op stream and the app", () => {
    const headers = libraryReadHeaders("tok");
    log("headers", headers);
    expect(libraryReadOpStreamVersion).toBe(4);
    expect(headers["x-library-op-stream-version"]).toBe("4");
    expect(headers["x-space-app"]).toBe("badger");
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("@req REL-CD-29 a native HTTP_426 rejection becomes the ApiError the update latch reads", () => {
    const error = nativeHttpError(
      Object.assign(new Error(JSON.stringify({ error: "app_update_required", reason: "library_op_stream", opStreamVersion: 5 })), {
        code: "HTTP_426",
      })
    );
    log("mapped", { isApiError: error instanceof ApiError });
    expect(error).toBeInstanceOf(ApiError);
    expect(error instanceof ApiError ? [error.status, error.payload.reason] : null).toEqual([426, "library_op_stream"]);
    const network = Object.assign(new Error("offline"), { code: "NETWORK_FAILED" });
    expect(nativeHttpError(network), "anything else passes through").toBe(network);
  });
});

describe("switch: convert in place, then write 4 (LIB-FMT-12, LIB-FMT-13)", () => {
  it("@req LIB-FMT-13 an unswitched account: no conversion, writes declare 3", async () => {
    const db = await openSwitched(null);
    try {
      await db.queueOp(settingOp("local-1", "episode_resume_v1:e1", "{}"));
      await db.flushOps();
      log("state", { converts: native.converts, declared: fx.declaredFormats.op });
      expect(native.converts).toEqual([]);
      expect(fx.declaredFormats.op).toEqual([declared(OP_STREAM_VERSION)]);
    } finally {
      await db.close();
    }
  });

  it("@req LIB-FMT-12 meta says switched: the playback copy is converted on open and writes declare 4", async () => {
    const db = await openSwitched(4);
    try {
      await db.queueOp(settingOp("local-1", "episode_resume_v1:e1", "{}"));
      await db.flushOps();
      log("state", { converts: native.converts, declared: fx.declaredFormats.op });
      expect(native.converts, "converted once, on the playback file").toEqual([PLAYBACK_DB_PATH]);
      expect(fx.declaredFormats.op).toEqual([declared(4)]);
    } finally {
      await db.close();
    }
  });

  it("@req LIB-FMT-12 a failed conversion keeps writing 3, so an op never claims rows it does not hold", async () => {
    native.convertFails = true;
    const db = await openSwitched(4);
    try {
      fx.putOpError = { status: 426, payload: SWITCH_426 };
      await db.queueOp(settingOp("local-1", "episode_resume_v1:e1", "{}"));
      await db.flushOps();
      log("state", { converts: native.converts, declared: fx.declaredFormats.op, pending: db.pendingOps.length });
      expect(fx.declaredFormats.op, "the retry would declare the same, so it is not sent").toEqual([declared(OP_STREAM_VERSION)]);
      expect(db.pendingOps.length, "the op waits for the next flush").toBe(1);
    } finally {
      await db.close();
    }
  });

  it("@req LIB-FMT-13 a write refused for the switch re-reads meta, converts and retries once declaring 4", async () => {
    const db = await openSwitched(null);
    try {
      // The account flips after this device opened: its first write still declares 3.
      if (fx.meta) fx.meta.targetOpStreamVersion = 4;
      fx.putOpError = { status: 426, payload: SWITCH_426 };
      fx.putOpAcceptsOpStream = 4;
      await db.queueOp(settingOp("local-1", "episode_resume_v1:e1", "{}"));
      await db.flushOps();
      log("state", { converts: native.converts, declared: fx.declaredFormats.op, pending: db.pendingOps.length });
      expect(native.converts).toEqual([PLAYBACK_DB_PATH]);
      expect(fx.declaredFormats.op).toEqual([declared(OP_STREAM_VERSION), declared(4)]);
      expect(db.pendingOps.length, "the retried op was accepted").toBe(0);
    } finally {
      await db.close();
    }
  });

  it("@req LIB-FMT-13 the switch retry happens once per flush, never in a loop", async () => {
    const db = await openSwitched(null);
    try {
      if (fx.meta) fx.meta.targetOpStreamVersion = 4;
      fx.putOpError = { status: 409, payload: { error: "op_stream_not_switched" } };
      await db.queueOp(settingOp("local-1", "episode_resume_v1:e1", "{}"));
      await db.flushOps();
      log("state", { putOpCalls: fx.putOpCalls, declared: fx.declaredFormats.op });
      expect(fx.putOpCalls).toBe(2);
      expect(db.pendingOps.length).toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe("an op type this build does not know (LIB-FMT-13)", () => {
  it("@req LIB-FMT-13 stops the sync with nothing applied, the cursor unchanged and the update screen latched", async () => {
    const unknown = { id: "op-12", type: "media.hologram.set", createdAt: "2026-11-21T00:00:00.000Z", payload: {} } as unknown as LibraryOp;
    setServer({
      version: 12,
      snapshotVersion: 1,
      ops: [
        { opId: "op-11", version: 11, op: settingOp("op-11", "k11", "v") },
        { opId: "op-12", version: 12, op: unknown },
      ],
    });
    seedSplitCache({ version: 10 });
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    try {
      const failure = await db.syncFromRemoteIfNewer(fx.meta ?? undefined).then(
        () => null,
        (error: unknown) => error
      );
      await settle(db);
      log("state", { failure: String(failure), remoteVersion: db.remoteVersion, latch: getAppUpdateRequired() });
      expect(failure).toBeInstanceOf(UnknownOpTypeError);
      expect(db.remoteVersion, "the cursor stays before the page").toBe(10);
      expect(getAppUpdateRequired()?.reason).toBe("library_op_stream");
    } finally {
      await db.close();
    }
  });
});

describe("packed chunk lists over react-native-sqlite-storage (LIB-FMT-11)", () => {
  it("@req LIB-FMT-11 a BLOB parameter is written as an X'..' literal; quoted '?' and other parameters stay", () => {
    const [sql, params] = inlineBlobParams("INSERT INTO t (a, b, c, d) VALUES (?, '?', ?, ?)", [
      "owner",
      new Uint8Array([0, 15, 255]),
      null,
    ]);
    log("inline", { sql, params });
    expect(sql).toBe("INSERT INTO t (a, b, c, d) VALUES (?, '?', X'000fff', ?)");
    expect(params).toEqual(["owner", null]);
  });

  it("@req LIB-FMT-11 a row read with hex() BLOBs decodes to the stored list; an unknown key mode throws", () => {
    const row = { owner_id: "f1", placement_id: "p1", key_mode: 2, key_data: "0A0b", count: 3, sizes: "010203", starts: null };
    const list = packedListFromRow(row);
    log("list", { ...list, keyData: [...list.keyData], sizes: [...list.sizes] });
    expect(list).toEqual({
      placementId: "p1",
      keyMode: 2,
      keyData: new Uint8Array([10, 11]),
      count: 3,
      sizes: new Uint8Array([1, 2, 3]),
      starts: null,
    });
    expect(() => packedListFromRow({ ...row, key_mode: 9 })).toThrow(/unknown key_mode 9/);
  });
});
