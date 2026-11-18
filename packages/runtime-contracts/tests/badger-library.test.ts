import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parsePayload } from "../src/helpers";
import {
  badgerLibraryGetState,
  badgerLibraryUpsertSnapshot,
  badgerLibraryListSnapshots,
  badgerLibraryGetSnapshot,
  badgerLibraryClear,
} from "../src/badger/library";

const SUITE = "badger-library";

type AnyContract =
  | typeof badgerLibraryGetState
  | typeof badgerLibraryUpsertSnapshot
  | typeof badgerLibraryListSnapshots
  | typeof badgerLibraryGetSnapshot
  | typeof badgerLibraryClear;

type ParseOutcome = ReturnType<typeof parsePayload>;

const summarizeContract = (contract: AnyContract) => ({
  name: contract.name,
  module: contract.module,
});

const dumpLibrarySnapshot = (
  label: string,
  ctx: {
    contract: { name: string; module: string };
    payload?: unknown;
    parseResult?: ParseOutcome;
    safeParse?: z.ZodSafeParseResult<unknown>;
    note?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    console.error(
      `library contract envelope:\n${JSON.stringify(ctx.contract, null, 2)}`,
    );
    if (ctx.payload !== undefined) {
      console.error(`payload:\n${JSON.stringify(ctx.payload, null, 2)}`);
    }
    if (ctx.parseResult !== undefined) {
      console.error(
        `parsePayload outcome:\n${JSON.stringify(ctx.parseResult, null, 2)}`,
      );
    }
    if (ctx.safeParse !== undefined) {
      console.error(
        `safeParse outcome:\n${JSON.stringify(
          {
            success: ctx.safeParse.success,
            data: ctx.safeParse.success ? ctx.safeParse.data : undefined,
            issues: ctx.safeParse.success ? null : ctx.safeParse.error.issues,
          },
          null,
          2,
        )}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("badger.library commands", () => {
  console.info(
    `[${SUITE}:setup] contracts=${JSON.stringify([
      badgerLibraryGetState.name,
      badgerLibraryUpsertSnapshot.name,
      badgerLibraryListSnapshots.name,
      badgerLibraryGetSnapshot.name,
      badgerLibraryClear.name,
    ])}`,
  );

  describe("badger.library.get_state", () => {
    it("has correct command name", () => {
      try {
        expect(badgerLibraryGetState.name).toBe("badger.library.get_state");
      } catch (err) {
        dumpLibrarySnapshot("get-state-name-drift", {
          contract: summarizeContract(badgerLibraryGetState),
        });
        throw err;
      }
    });

    it("accepts empty payload", () => {
      const payload = {};
      const parsed = parsePayload(badgerLibraryGetState, { payload });
      try {
        expect(parsed.ok).toBe(true);
      } catch (err) {
        dumpLibrarySnapshot("get-state-empty-payload-rejected", {
          contract: summarizeContract(badgerLibraryGetState),
          payload,
          parseResult: parsed,
        });
        throw err;
      }
    });

    it("validates result with head snapshot", () => {
      const input = {
        listedAt: "2026-03-27T00:00:00Z",
        totalSnapshots: 1,
        headSnapshotId: "snap-1",
        head: {
          snapshotId: "snap-1",
          version: 3,
          stateHash: "abc123",
          mediaCount: 42,
          playlistCount: 2,
          updatedAt: "2026-03-27T00:00:00Z",
        },
      };
      const result = badgerLibraryGetState.resultSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLibrarySnapshot("get-state-with-head-rejected", {
          contract: summarizeContract(badgerLibraryGetState),
          payload: input,
          safeParse: result,
        });
        throw err;
      }
    });

    it("validates result with null head", () => {
      const input = {
        listedAt: "2026-03-27T00:00:00Z",
        totalSnapshots: 0,
        headSnapshotId: null,
        head: null,
      };
      const result = badgerLibraryGetState.resultSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLibrarySnapshot("get-state-null-head-rejected", {
          contract: summarizeContract(badgerLibraryGetState),
          payload: input,
          safeParse: result,
          note: "Null head should be valid for an empty library",
        });
        throw err;
      }
    });
  });

  describe("badger.library.upsert_snapshot", () => {
    it("accepts full payload", () => {
      const payload = {
        snapshotId: "desktop-5",
        version: 5,
        mediaCount: 10,
        playlistCount: 1,
        stateHash: "hash123",
        updatedAt: "2026-03-27T00:00:00Z",
      };
      const result = parsePayload(badgerLibraryUpsertSnapshot, { payload });
      try {
        expect(result.ok).toBe(true);
      } catch (err) {
        dumpLibrarySnapshot("upsert-full-payload-rejected", {
          contract: summarizeContract(badgerLibraryUpsertSnapshot),
          payload,
          parseResult: result,
        });
        throw err;
      }
    });

    it("accepts minimal payload with defaults", () => {
      const payload = { snapshotId: "snap-1", version: 0 };
      const result = parsePayload(badgerLibraryUpsertSnapshot, { payload });
      try {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.mediaCount).toBe(0);
          expect(result.data.playlistCount).toBe(0);
        }
      } catch (err) {
        dumpLibrarySnapshot("upsert-minimal-defaults-drift", {
          contract: summarizeContract(badgerLibraryUpsertSnapshot),
          payload,
          parseResult: result,
          note: "mediaCount/playlistCount should default to 0",
        });
        throw err;
      }
    });

    it("rejects missing snapshotId", () => {
      const payload = { version: 1 };
      const result = parsePayload(badgerLibraryUpsertSnapshot, { payload });
      try {
        expect(result.ok).toBe(false);
      } catch (err) {
        dumpLibrarySnapshot("upsert-missing-snapshot-id-accepted", {
          contract: summarizeContract(badgerLibraryUpsertSnapshot),
          payload,
          parseResult: result,
        });
        throw err;
      }
    });

    it("rejects negative version", () => {
      const payload = { snapshotId: "s1", version: -1 };
      const result = parsePayload(badgerLibraryUpsertSnapshot, { payload });
      try {
        expect(result.ok).toBe(false);
      } catch (err) {
        dumpLibrarySnapshot("upsert-negative-version-accepted", {
          contract: summarizeContract(badgerLibraryUpsertSnapshot),
          payload,
          parseResult: result,
        });
        throw err;
      }
    });
  });

  describe("badger.library.list_snapshots", () => {
    it("accepts empty payload", () => {
      const payload = {};
      const parsed = parsePayload(badgerLibraryListSnapshots, { payload });
      try {
        expect(parsed.ok).toBe(true);
      } catch (err) {
        dumpLibrarySnapshot("list-empty-payload-rejected", {
          contract: summarizeContract(badgerLibraryListSnapshots),
          payload,
          parseResult: parsed,
        });
        throw err;
      }
    });

    it("accepts limit", () => {
      const payload = { limit: 10 };
      const result = parsePayload(badgerLibraryListSnapshots, { payload });
      try {
        expect(result.ok).toBe(true);
      } catch (err) {
        dumpLibrarySnapshot("list-limit-rejected", {
          contract: summarizeContract(badgerLibraryListSnapshots),
          payload,
          parseResult: result,
        });
        throw err;
      }
    });
  });

  describe("badger.library.get_snapshot", () => {
    it("accepts with snapshotId", () => {
      const payload = { snapshotId: "snap-1" };
      const result = parsePayload(badgerLibraryGetSnapshot, { payload });
      try {
        expect(result.ok).toBe(true);
      } catch (err) {
        dumpLibrarySnapshot("get-snapshot-by-id-rejected", {
          contract: summarizeContract(badgerLibraryGetSnapshot),
          payload,
          parseResult: result,
        });
        throw err;
      }
    });

    it("accepts without snapshotId (uses head)", () => {
      const payload = {};
      const parsed = parsePayload(badgerLibraryGetSnapshot, { payload });
      try {
        expect(parsed.ok).toBe(true);
      } catch (err) {
        dumpLibrarySnapshot("get-snapshot-head-fallback-rejected", {
          contract: summarizeContract(badgerLibraryGetSnapshot),
          payload,
          parseResult: parsed,
          note: "Empty payload should fall back to head snapshot",
        });
        throw err;
      }
    });
  });

  describe("badger.library.clear", () => {
    it("has correct name", () => {
      try {
        expect(badgerLibraryClear.name).toBe("badger.library.clear");
      } catch (err) {
        dumpLibrarySnapshot("clear-name-drift", {
          contract: summarizeContract(badgerLibraryClear),
        });
        throw err;
      }
    });

    it("accepts empty payload", () => {
      const payload = {};
      const parsed = parsePayload(badgerLibraryClear, { payload });
      try {
        expect(parsed.ok).toBe(true);
      } catch (err) {
        dumpLibrarySnapshot("clear-empty-payload-rejected", {
          contract: summarizeContract(badgerLibraryClear),
          payload,
          parseResult: parsed,
        });
        throw err;
      }
    });
  });
});
