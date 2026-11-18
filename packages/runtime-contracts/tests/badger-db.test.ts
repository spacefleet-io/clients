import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parsePayload } from "../src/helpers";
import {
  badgerDbOpen,
  badgerDbClose,
  badgerDbSnapshot,
  badgerDbCall,
  badgerDbStatus,
} from "../src/badger/db";

const SUITE = "badger-db";

type ParseOutcome = ReturnType<typeof parsePayload>;

const summarizeContract = (
  contract:
    | typeof badgerDbOpen
    | typeof badgerDbClose
    | typeof badgerDbSnapshot
    | typeof badgerDbCall
    | typeof badgerDbStatus,
) => ({
  name: contract.name,
  module: contract.module,
  payloadSchemaKind: contract.payloadSchema.def.type,
  resultSchemaKind: contract.resultSchema.def.type,
});

const dumpBadgerDbSnapshot = (
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
      `contract envelope:\n${JSON.stringify(ctx.contract, null, 2)}`,
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
      const issuesDump = ctx.safeParse.success
        ? null
        : ctx.safeParse.error.issues;
      console.error(
        `safeParse outcome:\n${JSON.stringify(
          {
            success: ctx.safeParse.success,
            data: ctx.safeParse.success ? ctx.safeParse.data : undefined,
            issues: issuesDump,
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

describe("badger.db commands", () => {
  console.info(
    `[${SUITE}:setup] contracts under test=${JSON.stringify(
      [
        badgerDbOpen.name,
        badgerDbClose.name,
        badgerDbCall.name,
        badgerDbStatus.name,
        badgerDbSnapshot.name,
      ],
    )}`,
  );

  describe("badger.db.open", () => {
    it("has correct command name", () => {
      try {
        expect(badgerDbOpen.name).toBe("badger.db.open");
        expect(badgerDbOpen.module).toBe("badger");
      } catch (err) {
        dumpBadgerDbSnapshot("open-name-drift", {
          contract: summarizeContract(badgerDbOpen),
          note: "badger.db.open contract name/module drift",
        });
        throw err;
      }
    });

    it("accepts valid payload", () => {
      const payload = { token: "session-abc", keyBase64: "key123==" };
      console.info(
        `[${SUITE}:open] parsing valid payload keys=${JSON.stringify(Object.keys(payload))}`,
      );
      const result = parsePayload(badgerDbOpen, { payload });
      try {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.token).toBe("session-abc");
          expect(result.data.keyBase64).toBe("key123==");
        }
      } catch (err) {
        dumpBadgerDbSnapshot("open-valid-payload-failed-parse", {
          contract: summarizeContract(badgerDbOpen),
          payload,
          parseResult: result,
        });
        throw err;
      }
    });

    it("rejects empty token", () => {
      const payload = { token: "", keyBase64: "key123==" };
      const result = parsePayload(badgerDbOpen, { payload });
      try {
        expect(result.ok).toBe(false);
      } catch (err) {
        dumpBadgerDbSnapshot("open-empty-token-unexpectedly-accepted", {
          contract: summarizeContract(badgerDbOpen),
          payload,
          parseResult: result,
          note: "Expected min(1) on token to reject empty string",
        });
        throw err;
      }
    });

    it("rejects missing keyBase64", () => {
      const payload = { token: "abc" };
      const result = parsePayload(badgerDbOpen, { payload });
      try {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("keyBase64");
        }
      } catch (err) {
        dumpBadgerDbSnapshot("open-missing-keybase64-message-drift", {
          contract: summarizeContract(badgerDbOpen),
          payload,
          parseResult: result,
          note: "keyBase64 should be referenced in the formatted error path",
        });
        throw err;
      }
    });
  });

  describe("badger.db.close", () => {
    it("has correct command name", () => {
      try {
        expect(badgerDbClose.name).toBe("badger.db.close");
      } catch (err) {
        dumpBadgerDbSnapshot("close-name-drift", {
          contract: summarizeContract(badgerDbClose),
        });
        throw err;
      }
    });

    it("accepts empty payload", () => {
      const payload = {};
      const result = parsePayload(badgerDbClose, { payload });
      try {
        expect(result.ok).toBe(true);
      } catch (err) {
        dumpBadgerDbSnapshot("close-empty-payload-rejected", {
          contract: summarizeContract(badgerDbClose),
          payload,
          parseResult: result,
        });
        throw err;
      }
    });
  });

  describe("badger.db.call", () => {
    it("accepts method with args", () => {
      const payload = { method: "addMediaFromCatalog", args: [{ id: 1 }] };
      const result = parsePayload(badgerDbCall, { payload });
      try {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.method).toBe("addMediaFromCatalog");
          expect(result.data.args).toEqual([{ id: 1 }]);
        }
      } catch (err) {
        dumpBadgerDbSnapshot("call-method-with-args-failed", {
          contract: summarizeContract(badgerDbCall),
          payload,
          parseResult: result,
        });
        throw err;
      }
    });

    it("carries deferPublish through (#25 progress saves from a hidden window) and leaves it absent otherwise", () => {
      const deferred = parsePayload(badgerDbCall, { payload: { method: "setProgress", args: ["m1", 5], deferPublish: true } });
      const plain = parsePayload(badgerDbCall, { payload: { method: "setProgress", args: ["m1", 5] } });
      console.info(`[badger-db:deferPublish] deferred=${JSON.stringify(deferred)} plain=${JSON.stringify(plain)}`);
      expect(deferred.ok && deferred.data.deferPublish).toBe(true);
      expect(plain.ok && plain.data.deferPublish).toBeUndefined();
    });

    it("rejects empty method", () => {
      const payload = { method: "" };
      const result = parsePayload(badgerDbCall, { payload });
      try {
        expect(result.ok).toBe(false);
      } catch (err) {
        dumpBadgerDbSnapshot("call-empty-method-accepted", {
          contract: summarizeContract(badgerDbCall),
          payload,
          parseResult: result,
        });
        throw err;
      }
    });

    it("defaults args to empty array", () => {
      const payload = { method: "getVersion" };
      const result = parsePayload(badgerDbCall, { payload });
      try {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.args).toEqual([]);
        }
      } catch (err) {
        dumpBadgerDbSnapshot("call-args-default-drift", {
          contract: summarizeContract(badgerDbCall),
          payload,
          parseResult: result,
          note: "args should default to []",
        });
        throw err;
      }
    });
  });

  describe("badger.db.status", () => {
    it("accepts empty payload", () => {
      const payload = {};
      const parsed = parsePayload(badgerDbStatus, { payload });
      try {
        expect(parsed.ok).toBe(true);
      } catch (err) {
        dumpBadgerDbSnapshot("status-empty-payload-rejected", {
          contract: summarizeContract(badgerDbStatus),
          payload,
          parseResult: parsed,
        });
        throw err;
      }
    });

    it("validates result schema", () => {
      const input = {
        open: true,
        version: "1.0",
        datasetStatus: { core: true, metadata: false, playback: false },
      };
      const result = badgerDbStatus.resultSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpBadgerDbSnapshot("status-result-schema-rejected", {
          contract: summarizeContract(badgerDbStatus),
          payload: input,
          safeParse: result,
        });
        throw err;
      }
    });
  });

  describe("badger.db.snapshot", () => {
    it("accepts empty payload", () => {
      const payload = {};
      const parsed = parsePayload(badgerDbSnapshot, { payload });
      try {
        expect(parsed.ok).toBe(true);
      } catch (err) {
        dumpBadgerDbSnapshot("snapshot-empty-payload-rejected", {
          contract: summarizeContract(badgerDbSnapshot),
          payload,
          parseResult: parsed,
        });
        throw err;
      }
    });
  });
});
