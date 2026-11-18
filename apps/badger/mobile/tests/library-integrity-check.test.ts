/**
 * @test-id MOBILE-LIB-INTEGRITY-001
 * @level unit
 * @why Mid-session SQLite errors had no recovery path before this change.
 *   PRAGMA integrity_check after each split DB open + auto-recovery (close,
 *   delete file, retry once) prevents stuck-corrupt-cache states.
 */
import { describe, expect, it, vi } from "vitest";
import type { IntegrityCheckFailedError as IntegrityCheckFailedErrorInstance } from "../src/lib/library/dbFiles";

vi.mock("react-native-fs", () => ({ default: {} }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("react-native-sqlite-storage", () => ({
  default: {
    openDatabase: vi.fn(),
    enablePromise: vi.fn(),
  },
}));
vi.mock("react-native-quick-crypto", () => ({
  default: {
    randomBytes: () => Buffer.alloc(16),
    createHash: () => ({ update: () => ({ digest: () => "" }) }),
  },
}));
vi.mock("../src/lib/librarySchema", () => ({
  ensureSchema: vi.fn(),
  ensureCoreSchema: vi.fn(),
  ensureMetadataSchema: vi.fn(),
  ensurePlaybackSchema: vi.fn(),
}));
vi.mock("../src/lib/libraryStorage", () => ({
  getCacheBlobPath: () => "/tmp/library/blob",
  getCoreDbPath: () => "/tmp/library/core.sqlite",
  getMetadataDbPath: () => "/tmp/library/metadata.sqlite",
  getPlaybackDbPath: () => "/tmp/library/playback.sqlite",
  getSnapshotDbPath: () => "/tmp/library/snapshot.sqlite",
}));

const { IntegrityCheckFailedError, runIntegrityCheck } = await import(
  "../src/lib/library/dbFiles"
);

type Row = Record<string, unknown>;

const makeFakeDb = (integrityResult: string) => ({
  executeSql: vi.fn(async (sql: string) => {
    if (/PRAGMA\s+integrity_check/i.test(sql)) {
      return [
        {
          rows: {
            length: 1,
            item: (_: number) => ({ integrity_check: integrityResult } as Row),
          },
        },
      ];
    }
    return [{ rows: { length: 0, item: (_: number) => ({} as Row) } }];
  }),
  close: vi.fn(async () => undefined),
});

// On assertion failure, dump what the integrity check actually did: the SQL it
// ran, the recorded log calls, and any thrown error's shape (dbName/result).
const dumpIntegritySnapshot = (
  label: string,
  ctx: {
    db?: { executeSql?: { mock?: { calls?: unknown[] } } };
    log?: { mock?: { calls?: unknown[] } };
    error?: unknown;
  },
) => {
  try {
    console.error(`=== [library-integrity-check:${label}] snapshot ===`);
    const sqlCalls = ctx.db?.executeSql?.mock?.calls ?? [];
    console.error(`executeSql calls (${sqlCalls.length}):\n${JSON.stringify(sqlCalls, null, 2)}`);
    if (ctx.log) {
      const logCalls = ctx.log.mock?.calls ?? [];
      console.error(`log calls (${logCalls.length}):\n${JSON.stringify(logCalls, null, 2)}`);
    }
    if ("error" in ctx) {
      const e = ctx.error;
      const shape =
        e instanceof IntegrityCheckFailedError
          ? { kind: "IntegrityCheckFailedError", dbName: e.dbName, result: e.result, message: e.message }
          : { kind: e?.constructor?.name ?? typeof e, value: String(e) };
      console.error(`thrown error:\n${JSON.stringify(shape, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runIntegrityCheck", () => {
  it('returns silently when PRAGMA integrity_check returns "ok"', async () => {
    console.info(`[library-integrity-check:ok-path] running integrity_check on "core" with result="ok"`);
    const db = makeFakeDb("ok");
    const log = vi.fn();
    try {
      await expect(
        runIntegrityCheck(db as never, "core", log)
      ).resolves.toBeUndefined();
      expect(db.executeSql).toHaveBeenCalledWith("PRAGMA integrity_check;");
      expect(log).toHaveBeenCalledWith("library.db.integrity.ok", { db: "core" });
    } catch (err) {
      dumpIntegritySnapshot("ok-path", { db, log });
      throw err;
    }
  });

  it("throws IntegrityCheckFailedError with the failure detail", async () => {
    console.info(`[library-integrity-check:fail-path] running integrity_check on "metadata" with result="malformed database"`);
    const db = makeFakeDb("malformed database");
    const log = vi.fn();

    try {
      await expect(
        runIntegrityCheck(db as never, "metadata", log)
      ).rejects.toThrow(IntegrityCheckFailedError);

      expect(log).toHaveBeenCalledWith("library.db.integrity.fail", {
        db: "metadata",
        result: "malformed database",
      });
    } catch (err) {
      dumpIntegritySnapshot("fail-path", { db, log });
      throw err;
    }
  });

  it("uses the dbName in the error so the recovery layer knows what to wipe", async () => {
    console.info(`[library-integrity-check:error-shape] running integrity_check on "playback" with result="non-trivial issue"`);
    const db = makeFakeDb("non-trivial issue");
    let caught: unknown;
    try {
      await runIntegrityCheck(db as never, "playback");
      caught = new Error("expected_throw");
      throw caught;
    } catch (error) {
      caught = error;
      try {
        expect(error).toBeInstanceOf(IntegrityCheckFailedError);
        const integrity = error as IntegrityCheckFailedErrorInstance;
        console.info(
          `[library-integrity-check:error-shape] caught dbName=${integrity.dbName} result=${integrity.result}`,
        );
        expect(integrity.dbName).toBe("playback");
        expect(integrity.result).toBe("non-trivial issue");
        expect(integrity.message).toContain("integrity_check_failed:playback:");
      } catch (assertErr) {
        dumpIntegritySnapshot("error-shape", { db, error: caught });
        throw assertErr;
      }
    }
  });

  it("treats missing integrity_check column as a failure (defensive)", async () => {
    console.info(`[library-integrity-check:missing-column] integrity row present but integrity_check column absent`);
    const db = {
      executeSql: vi.fn(async () => [
        {
          rows: {
            length: 1,
            item: () => ({}),
          },
        },
      ]),
      close: vi.fn(async () => undefined),
    };
    try {
      await expect(
        runIntegrityCheck(db as never, "core")
      ).rejects.toThrow(IntegrityCheckFailedError);
    } catch (err) {
      dumpIntegritySnapshot("missing-column", { db });
      throw err;
    }
  });

  it("treats empty rows as a failure (defensive)", async () => {
    console.info(`[library-integrity-check:empty-rows] integrity_check returned zero rows`);
    const db = {
      executeSql: vi.fn(async () => [
        {
          rows: {
            length: 0,
            item: () => ({}),
          },
        },
      ]),
      close: vi.fn(async () => undefined),
    };
    try {
      await expect(
        runIntegrityCheck(db as never, "snapshot")
      ).rejects.toThrow(IntegrityCheckFailedError);
    } catch (err) {
      dumpIntegritySnapshot("empty-rows", { db });
      throw err;
    }
  });
});
