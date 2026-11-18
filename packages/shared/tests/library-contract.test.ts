import { describe, expect, it } from "vitest";
import {
  ChunkHashSchema,
  LibraryContractError,
  LibraryMigrationAdvisorySchema,
  LibraryOpsResponseSchema,
  LibrarySnapshotHistoryEntrySchema,
  PutLibraryDbRequestSchema,
  PutLibraryDbResponseSchema,
  parseLibraryOpsResponse,
  parsePutLibraryDbRequest,
  parsePutLibraryDbResponse,
} from "../src/contracts/library";
// Barrel re-export reachability (deliverable 6 equivalent for @space/shared)
import { LibraryMigrationAdvisorySchema as BarrelAdvisory } from "../src/index";

// Structural shape of any Zod schema we care about here — just `safeParse`.
// Typed structurally (not via a zod type import) so this stays decoupled from
// whatever the installed zod version exports.
type SafeParseable = {
  safeParse: (input: unknown) => { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; code: string; message: string }> } };
};

// On assertion failure these schema tests are hard to diagnose from a bare
// "expected false to be true" — the Zod issue paths/messages are what you
// actually need. Dump them (and the parsed result when present) on the failure
// path. Wrapped in try/catch so a dump failure can't mask the assertion.
const dumpLibraryContractSnapshot = (
  label: string,
  ctx: { schema?: SafeParseable; input?: unknown; parsed?: unknown; extras?: Record<string, unknown> } = {},
) => {
  try {
    console.error(`=== [library-contract:${label}] snapshot ===`);
    if (ctx.input !== undefined) {
      console.error(`input:\n${JSON.stringify(ctx.input, null, 2)}`);
    }
    if (ctx.schema) {
      const result = ctx.schema.safeParse(ctx.input);
      console.error(`safeParse.success=${result.success}`);
      if (!result.success && result.error) {
        const issues = result.error.issues.map((i) => ({
          path: i.path.map((p) => String(p)).join("."),
          code: i.code,
          message: i.message,
        }));
        console.error(`zod issues:\n${JSON.stringify(issues, null, 2)}`);
      }
    }
    if (ctx.parsed !== undefined) {
      console.error(`parsed:\n${JSON.stringify(ctx.parsed, null, 2)}`);
    }
    if (ctx.extras) {
      console.error(`extras:\n${JSON.stringify(ctx.extras, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const validResponse = {
  version: 12,
  snapshotVersion: 8,
  tooOld: false,
  ops: [
    {
      opId: "op-1",
      objectKey: "library/badger/ops/op-1",
      version: 9,
      createdAt: "2026-05-07T12:00:00.000Z",
      size: 256,
    },
  ],
};

describe("LibraryOpsResponseSchema", () => {
  it("accepts the canonical server response shape", () => {
    console.info("[library-contract:accept-canonical] parsing canonical ops response (version=12, 1 op)");
    const parsed = LibraryOpsResponseSchema.parse(validResponse);
    console.info(`[library-contract:accept-canonical] parsed version=${parsed.version} ops[0].objectKey=${parsed.ops[0]?.objectKey}`);
    if (parsed.ops[0]?.objectKey !== "library/badger/ops/op-1" || parsed.version !== 12) {
      dumpLibraryContractSnapshot("accept-canonical-mismatch", { input: validResponse, parsed });
    }
    expect(parsed.ops[0]?.objectKey).toBe("library/badger/ops/op-1");
    expect(parsed.version).toBe(12);
  });

  it("accepts an empty ops list", () => {
    const input = { version: 0, snapshotVersion: 0, tooOld: false, ops: [] };
    console.info("[library-contract:accept-empty-ops] parsing response with empty ops list");
    const parsed = parseLibraryOpsResponse(input);
    if (parsed.ops.length !== 0) {
      dumpLibraryContractSnapshot("accept-empty-ops-mismatch", { input, parsed });
    }
    expect(parsed.ops).toHaveLength(0);
  });

  it("rejects an op entry that uses downloadUrl in place of objectKey", () => {
    const drifted = {
      version: 12,
      snapshotVersion: 8,
      tooOld: false,
      ops: [
        {
          opId: "op-1",
          downloadUrl: "https://signed.example/op-1",
          version: 9,
          createdAt: "2026-05-07T12:00:00.000Z",
          size: 256,
        },
      ],
    };

    console.info("[library-contract:reject-downloadurl] parsing op with downloadUrl instead of objectKey → expect throw");
    if (LibraryOpsResponseSchema.safeParse(drifted).success) {
      dumpLibraryContractSnapshot("reject-downloadurl-accepted", {
        schema: LibraryOpsResponseSchema as unknown as SafeParseable,
        input: drifted,
      });
    }
    expect(() => parseLibraryOpsResponse(drifted)).toThrow(LibraryContractError);
  });

  it("rejects an op entry missing objectKey", () => {
    const drifted = {
      ...validResponse,
      ops: [{ opId: "op-1", version: 9, createdAt: "2026-05-07T12:00:00.000Z", size: 256 }],
    };
    console.info("[library-contract:reject-missing-objectkey] parsing op missing objectKey → expect failure + ops.0.objectKey issue");
    const result = LibraryOpsResponseSchema.safeParse(drifted);
    console.info(`[library-contract:reject-missing-objectkey] safeParse.success=${result.success}`);
    if (result.success) {
      dumpLibraryContractSnapshot("reject-missing-objectkey-accepted", {
        schema: LibraryOpsResponseSchema as unknown as SafeParseable,
        input: drifted,
      });
    }
    expect(result.success).toBe(false);
    if (!result.success) {
      const objectKeyIssue = result.error.issues.find((issue) => issue.path.join(".") === "ops.0.objectKey");
      if (!objectKeyIssue) {
        dumpLibraryContractSnapshot("reject-missing-objectkey-no-issue", {
          schema: LibraryOpsResponseSchema as unknown as SafeParseable,
          input: drifted,
          extras: { issuePaths: result.error.issues.map((i) => i.path.join(".")) },
        });
      }
      expect(objectKeyIssue).toBeDefined();
    }
  });

  it("rejects negative version numbers", () => {
    const invalid = { ...validResponse, version: -1 };
    expect(LibraryOpsResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a non-boolean tooOld", () => {
    const invalid = { ...validResponse, tooOld: "false" as unknown as boolean };
    expect(LibraryOpsResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it("LibraryContractError surfaces the offending field path", () => {
    const input = { ...validResponse, ops: [{ opId: "x" }] };
    console.info("[library-contract:error-field-path] parsing op with only opId → expect LibraryContractError on ops.0.*");
    try {
      parseLibraryOpsResponse(input);
      throw new Error("expected_throw");
    } catch (error) {
      const issues = error instanceof LibraryContractError ? error.issues : [];
      const paths = issues.map((issue) => issue.path);
      console.info(`[library-contract:error-field-path] issue paths=${JSON.stringify(paths)}`);
      if (!(error instanceof LibraryContractError) || !paths.some((path) => path.startsWith("ops.0."))) {
        dumpLibraryContractSnapshot("error-field-path-unexpected", {
          schema: LibraryOpsResponseSchema as unknown as SafeParseable,
          input,
          extras: {
            isLibraryContractError: error instanceof LibraryContractError,
            issuePaths: paths,
            raw: error instanceof Error ? error.message : String(error),
          },
        });
      }
      expect(error).toBeInstanceOf(LibraryContractError);
      expect(paths.some((path) => path.startsWith("ops.0."))).toBe(true);
    }
  });
});

describe("server response shape parity", () => {
  it("parses the shape produced by the API's getLibraryOps service", () => {
    const serverShape = {
      version: 14,
      snapshotVersion: 11,
      tooOld: false,
      ops: [
        {
          opId: "op-aaa",
          objectKey: "library/badger/ops/op-aaa",
          version: 12,
          createdAt: "2026-05-07T12:00:00.000Z",
          size: 1024,
        },
        {
          opId: "op-bbb",
          objectKey: "library/badger/ops/op-bbb",
          version: 13,
          createdAt: "2026-05-07T12:01:00.000Z",
          size: 512,
        },
      ],
    };
    console.info("[library-contract:server-parity] parsing the API's getLibraryOps service shape (2 ops)");
    const parsed = LibraryOpsResponseSchema.parse(serverShape);
    console.info(`[library-contract:server-parity] parsed ops.length=${parsed.ops.length} ops[1].objectKey=${parsed.ops[1]?.objectKey}`);
    if (parsed.ops.length !== 2 || parsed.ops[1]?.objectKey !== "library/badger/ops/op-bbb") {
      dumpLibraryContractSnapshot("server-parity-mismatch", { input: serverShape, parsed });
    }
    expect(parsed.ops).toHaveLength(2);
    expect(parsed.ops[1]?.objectKey).toBe("library/badger/ops/op-bbb");
  });

  it("parses the tooOld branch (empty ops, snapshot fallback signal)", () => {
    const tooOldShape = {
      version: 50,
      snapshotVersion: 40,
      tooOld: true,
      ops: [],
    };
    console.info("[library-contract:server-parity-too-old] parsing tooOld=true / empty-ops fallback shape");
    const parsed = LibraryOpsResponseSchema.parse(tooOldShape);
    if (parsed.tooOld !== true || parsed.ops.length !== 0) {
      dumpLibraryContractSnapshot("server-parity-too-old-mismatch", { input: tooOldShape, parsed });
    }
    expect(parsed.tooOld).toBe(true);
    expect(parsed.ops).toHaveLength(0);
  });
});

describe("ChunkHashSchema", () => {
  it("accepts a typical SHA-256 hex hash", () => {
    const hash = "a".repeat(64);
    expect(ChunkHashSchema.parse(hash)).toBe(hash);
  });

  it("accepts mixed-case hex", () => {
    expect(ChunkHashSchema.parse("AbCdEf0123456789")).toBe("AbCdEf0123456789");
  });

  it("rejects non-hex characters", () => {
    const input = "not-a-hash";
    if (ChunkHashSchema.safeParse(input).success) {
      dumpLibraryContractSnapshot("chunkhash-nonhex-accepted", {
        schema: ChunkHashSchema as unknown as SafeParseable,
        input,
      });
    }
    expect(ChunkHashSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an empty hash", () => {
    if (ChunkHashSchema.safeParse("").success) {
      dumpLibraryContractSnapshot("chunkhash-empty-accepted", {
        schema: ChunkHashSchema as unknown as SafeParseable,
        input: "",
      });
    }
    expect(ChunkHashSchema.safeParse("").success).toBe(false);
  });

  it("rejects hashes longer than 128 chars", () => {
    const input = "a".repeat(129);
    if (ChunkHashSchema.safeParse(input).success) {
      dumpLibraryContractSnapshot("chunkhash-too-long-accepted", {
        schema: ChunkHashSchema as unknown as SafeParseable,
        extras: { inputLength: input.length },
      });
    }
    expect(ChunkHashSchema.safeParse(input).success).toBe(false);
  });
});

describe("LibrarySnapshotHistoryEntrySchema", () => {
  it("accepts a canonical entry", () => {
    const entry = {
      snapshotId: "snap-1",
      manifestKey: "library/badger/manifests/snap-1",
      version: 42,
      createdAt: "2026-05-12T10:00:00.000Z",
    };
    console.info("[library-contract:snapshot-entry] parsing canonical snapshot history entry");
    const parsed = LibrarySnapshotHistoryEntrySchema.parse(entry);
    if (parsed.snapshotId !== "snap-1" || parsed.version !== 42) {
      dumpLibraryContractSnapshot("snapshot-entry-mismatch", { input: entry, parsed });
    }
    expect(parsed.snapshotId).toBe("snap-1");
    expect(parsed.version).toBe(42);
  });

  it("does NOT accept a chunkRefs field on the wire (server-internal only)", () => {
    const withChunkRefs = {
      snapshotId: "snap-1",
      manifestKey: "library/badger/manifests/snap-1",
      version: 42,
      createdAt: "2026-05-12T10:00:00.000Z",
      chunkRefs: ["abc123"],
    };
    console.info("[library-contract:snapshot-entry-strips-chunkrefs] parsing entry with chunkRefs → expect it stripped from output");
    const parsed = LibrarySnapshotHistoryEntrySchema.parse(withChunkRefs);
    if (Object.prototype.hasOwnProperty.call(parsed, "chunkRefs")) {
      dumpLibraryContractSnapshot("snapshot-entry-chunkrefs-leaked", {
        input: withChunkRefs,
        parsed,
        extras: { parsedKeys: Object.keys(parsed as Record<string, unknown>) },
      });
    }
    expect(parsed).not.toHaveProperty("chunkRefs");
  });
});

describe("PutLibraryDbRequestSchema", () => {
  const validRequest = {
    snapshotId: "snap-1",
    expectedVersion: 5,
    manifest: "dGVzdC1tYW5pZmVzdA==",
    chunkRefs: ["abc123", "def456"],
    chunkSize: 4194304,
    stateHash: "9a9a9a9a",
    lastOpId: "op-42",
    keyProbe: "kp-1",
  };

  it("accepts a canonical PUT body", () => {
    console.info("[library-contract:put-accept-canonical] parsing canonical PUT body + checking defaults (manifestEncoding/force)");
    const parsed = PutLibraryDbRequestSchema.parse(validRequest);
    console.info(
      `[library-contract:put-accept-canonical] parsed manifestEncoding=${parsed.manifestEncoding} force=${parsed.force} chunkRefs.length=${parsed.chunkRefs.length}`,
    );
    if (
      parsed.snapshotId !== "snap-1" ||
      parsed.expectedVersion !== 5 ||
      parsed.chunkRefs.length !== 2 ||
      parsed.manifestEncoding !== "base64" ||
      parsed.force !== false
    ) {
      dumpLibraryContractSnapshot("put-accept-canonical-mismatch", { input: validRequest, parsed });
    }
    expect(parsed.snapshotId).toBe("snap-1");
    expect(parsed.expectedVersion).toBe(5);
    expect(parsed.chunkRefs).toHaveLength(2);
    expect(parsed.manifestEncoding).toBe("base64");
    expect(parsed.force).toBe(false);
  });

  it("requires chunkRefs to be present (no implicit empty)", () => {
    const { chunkRefs: _omit, ...withoutRefs } = validRequest;
    void _omit;
    expect(PutLibraryDbRequestSchema.safeParse(withoutRefs).success).toBe(false);
  });

  it("accepts an explicit empty chunkRefs array (first-write case)", () => {
    const input = { ...validRequest, chunkRefs: [] };
    console.info("[library-contract:put-empty-chunkrefs] parsing PUT body with explicit empty chunkRefs (first-write)");
    const parsed = PutLibraryDbRequestSchema.parse(input);
    if (parsed.chunkRefs.length !== 0) {
      dumpLibraryContractSnapshot("put-empty-chunkrefs-mismatch", { input, parsed });
    }
    expect(parsed.chunkRefs).toHaveLength(0);
  });

  it("accepts a large chunkRefs array (no header-size cap)", () => {
    const manyRefs = Array.from({ length: 5000 }, (_, i) =>
      i.toString(16).padStart(64, "0")
    );
    console.info(`[library-contract:put-large-chunkrefs] parsing PUT body with ${manyRefs.length} chunkRefs (no cap expected)`);
    const parsed = PutLibraryDbRequestSchema.parse({ ...validRequest, chunkRefs: manyRefs });
    console.info(`[library-contract:put-large-chunkrefs] parsed chunkRefs.length=${parsed.chunkRefs.length}`);
    if (parsed.chunkRefs.length !== 5000) {
      dumpLibraryContractSnapshot("put-large-chunkrefs-mismatch", {
        extras: { inputLength: manyRefs.length, parsedLength: parsed.chunkRefs.length },
      });
    }
    expect(parsed.chunkRefs).toHaveLength(5000);
  });

  it("rejects non-hex chunkRefs entries", () => {
    const bad = { ...validRequest, chunkRefs: ["not-hex!"] };
    if (PutLibraryDbRequestSchema.safeParse(bad).success) {
      dumpLibraryContractSnapshot("put-nonhex-chunkrefs-accepted", {
        schema: PutLibraryDbRequestSchema as unknown as SafeParseable,
        input: bad,
      });
    }
    expect(PutLibraryDbRequestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a negative expectedVersion", () => {
    expect(
      PutLibraryDbRequestSchema.safeParse({ ...validRequest, expectedVersion: -1 }).success
    ).toBe(false);
  });

  it("rejects a non-positive chunkSize", () => {
    expect(
      PutLibraryDbRequestSchema.safeParse({ ...validRequest, chunkSize: 0 }).success
    ).toBe(false);
  });

  it("rejects an empty manifest", () => {
    expect(
      PutLibraryDbRequestSchema.safeParse({ ...validRequest, manifest: "" }).success
    ).toBe(false);
  });

  it("parsePutLibraryDbRequest surfaces field path on error", () => {
    const input = { ...validRequest, expectedVersion: -1 };
    console.info("[library-contract:put-error-field-path] parsing PUT body with expectedVersion=-1 → expect expectedVersion issue");
    try {
      parsePutLibraryDbRequest(input);
      throw new Error("expected_throw");
    } catch (error) {
      const issues = error instanceof LibraryContractError ? error.issues : [];
      console.info(`[library-contract:put-error-field-path] issue paths=${JSON.stringify(issues.map((i) => i.path))}`);
      if (!(error instanceof LibraryContractError) || !issues.some((i) => i.path === "expectedVersion")) {
        dumpLibraryContractSnapshot("put-error-field-path-unexpected", {
          schema: PutLibraryDbRequestSchema as unknown as SafeParseable,
          input,
          extras: {
            isLibraryContractError: error instanceof LibraryContractError,
            issuePaths: issues.map((i) => i.path),
            raw: error instanceof Error ? error.message : String(error),
          },
        });
      }
      expect(error).toBeInstanceOf(LibraryContractError);
      expect(issues.some((i) => i.path === "expectedVersion")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// LibraryOpsResponseSchema — format version fields (deliverable 4)
// ---------------------------------------------------------------------------

describe("LibraryOpsResponseSchema — storageFormatVersion + opStreamVersion", () => {
  it("body without the version fields parses successfully (backward compat via .default(1))", () => {
    const result = LibraryOpsResponseSchema.safeParse({
      version: 1,
      snapshotVersion: 0,
      tooOld: false,
      ops: [],
    });
    expect(result.success).toBe(true);
  });

  it("body without version fields defaults both to 1", () => {
    const parsed = LibraryOpsResponseSchema.parse({
      version: 1,
      snapshotVersion: 0,
      tooOld: false,
      ops: [],
    });
    expect(parsed.storageFormatVersion).toBe(1);
    expect(parsed.opStreamVersion).toBe(1);
  });

  it("explicit storageFormatVersion and opStreamVersion round-trip correctly", () => {
    const input = { version: 1, snapshotVersion: 0, tooOld: false, ops: [], storageFormatVersion: 2, opStreamVersion: 3 };
    console.info("[library-contract:ops-version-roundtrip] parsing response with storageFormatVersion=2 opStreamVersion=3");
    const parsed = LibraryOpsResponseSchema.parse(input);
    console.info(
      `[library-contract:ops-version-roundtrip] parsed storageFormatVersion=${parsed.storageFormatVersion} opStreamVersion=${parsed.opStreamVersion}`,
    );
    if (parsed.storageFormatVersion !== 2 || parsed.opStreamVersion !== 3) {
      dumpLibraryContractSnapshot("ops-version-roundtrip-mismatch", { input, parsed });
    }
    expect(parsed.storageFormatVersion).toBe(2);
    expect(parsed.opStreamVersion).toBe(3);
  });

  it("rejects storageFormatVersion === 0 (must be positive)", () => {
    expect(
      LibraryOpsResponseSchema.safeParse({
        version: 1,
        snapshotVersion: 0,
        tooOld: false,
        ops: [],
        storageFormatVersion: 0,
      }).success
    ).toBe(false);
  });

  it("rejects negative storageFormatVersion", () => {
    expect(
      LibraryOpsResponseSchema.safeParse({
        version: 1,
        snapshotVersion: 0,
        tooOld: false,
        ops: [],
        storageFormatVersion: -1,
      }).success
    ).toBe(false);
  });

  it("rejects opStreamVersion === 0 (must be positive)", () => {
    expect(
      LibraryOpsResponseSchema.safeParse({
        version: 1,
        snapshotVersion: 0,
        tooOld: false,
        ops: [],
        opStreamVersion: 0,
      }).success
    ).toBe(false);
  });

  it("rejects negative opStreamVersion", () => {
    expect(
      LibraryOpsResponseSchema.safeParse({
        version: 1,
        snapshotVersion: 0,
        tooOld: false,
        ops: [],
        opStreamVersion: -5,
      }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LibraryOpsResponseSchema — migrationAdvisory (deliverable 4)
// ---------------------------------------------------------------------------

describe("LibraryOpsResponseSchema — migrationAdvisory", () => {
  const base = {
    version: 1,
    snapshotVersion: 0,
    tooOld: false,
    ops: [],
  };

  it("omitted migrationAdvisory parses to undefined", () => {
    const parsed = LibraryOpsResponseSchema.parse(base);
    expect(parsed.migrationAdvisory).toBeUndefined();
  });

  it("valid advisory with holdGroups and deprecationNotices parses correctly", () => {
    const input = {
      ...base,
      migrationAdvisory: {
        holdGroups: ["metadata", "playback"],
        deprecationNotices: [
          { surface: "op-stream", message: "op format v0 deprecated in this release" },
        ],
      },
    };
    console.info("[library-contract:advisory-valid] parsing migrationAdvisory with 2 holdGroups + 1 deprecationNotice");
    const parsed = LibraryOpsResponseSchema.parse(input);
    console.info(
      `[library-contract:advisory-valid] parsed advisory=${JSON.stringify(parsed.migrationAdvisory)}`,
    );
    if (
      !parsed.migrationAdvisory ||
      JSON.stringify(parsed.migrationAdvisory.holdGroups) !== JSON.stringify(["metadata", "playback"]) ||
      parsed.migrationAdvisory.deprecationNotices.length !== 1 ||
      parsed.migrationAdvisory.deprecationNotices[0]?.surface !== "op-stream"
    ) {
      dumpLibraryContractSnapshot("advisory-valid-mismatch", { input, parsed });
    }
    expect(parsed.migrationAdvisory).toBeDefined();
    expect(parsed.migrationAdvisory!.holdGroups).toEqual(["metadata", "playback"]);
    expect(parsed.migrationAdvisory!.deprecationNotices).toHaveLength(1);
    expect(parsed.migrationAdvisory!.deprecationNotices[0]?.surface).toBe("op-stream");
  });

  it("valid advisory with empty arrays parses correctly", () => {
    const parsed = LibraryOpsResponseSchema.parse({
      ...base,
      migrationAdvisory: { holdGroups: [], deprecationNotices: [] },
    });
    expect(parsed.migrationAdvisory!.holdGroups).toHaveLength(0);
    expect(parsed.migrationAdvisory!.deprecationNotices).toHaveLength(0);
  });

  it("rejects advisory whose holdGroups contains a non-string entry", () => {
    expect(
      LibraryOpsResponseSchema.safeParse({
        ...base,
        migrationAdvisory: {
          holdGroups: [42],
          deprecationNotices: [],
        },
      }).success
    ).toBe(false);
  });

  it("rejects advisory whose deprecationNotice is missing 'message'", () => {
    expect(
      LibraryOpsResponseSchema.safeParse({
        ...base,
        migrationAdvisory: {
          holdGroups: [],
          deprecationNotices: [{ surface: "storage" }], // missing message
        },
      }).success
    ).toBe(false);
  });

  it("rejects advisory whose deprecationNotice is missing 'surface'", () => {
    expect(
      LibraryOpsResponseSchema.safeParse({
        ...base,
        migrationAdvisory: {
          holdGroups: [],
          deprecationNotices: [{ message: "something deprecated" }], // missing surface
        },
      }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LibraryMigrationAdvisorySchema — reachable from @space/shared barrel
// ---------------------------------------------------------------------------

describe("LibraryMigrationAdvisorySchema — barrel re-export reachability", () => {
  it("is importable from @space/shared barrel and parses a valid advisory", () => {
    const result = BarrelAdvisory.safeParse({
      holdGroups: ["core"],
      deprecationNotices: [{ surface: "schema", message: "v0 schema retired" }],
    });
    expect(result.success).toBe(true);
  });

  it("standalone LibraryMigrationAdvisorySchema and barrel import are the same schema (co-identity)", () => {
    const input = { holdGroups: ["core"], deprecationNotices: [] };
    console.info("[library-contract:advisory-co-identity] checking standalone + barrel-imported schema both accept the same input");
    const standalone = LibraryMigrationAdvisorySchema.safeParse(input).success;
    const barrel = BarrelAdvisory.safeParse(input).success;
    console.info(`[library-contract:advisory-co-identity] standalone.success=${standalone} barrel.success=${barrel}`);
    if (!standalone || !barrel) {
      dumpLibraryContractSnapshot("advisory-co-identity-divergence", {
        input,
        extras: { standalone, barrel },
      });
    }
    expect(LibraryMigrationAdvisorySchema.safeParse(input).success).toBe(true);
    expect(BarrelAdvisory.safeParse(input).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PutLibraryDbRequestSchema — format version fields (deliverable 4)
// ---------------------------------------------------------------------------

describe("PutLibraryDbRequestSchema — storageFormatVersion + opStreamVersion", () => {
  const validRequest = {
    snapshotId: "snap-1",
    expectedVersion: 5,
    manifest: "dGVzdC1tYW5pZmVzdA==",
    chunkRefs: ["abc123"],
    chunkSize: 4194304,
  };

  it("body without version fields parses successfully (backward compat via .default(1))", () => {
    expect(PutLibraryDbRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("body without version fields defaults both to 1", () => {
    const parsed = PutLibraryDbRequestSchema.parse(validRequest);
    expect(parsed.storageFormatVersion).toBe(1);
    expect(parsed.opStreamVersion).toBe(1);
  });

  it("explicit storageFormatVersion and opStreamVersion round-trip correctly", () => {
    const input = { ...validRequest, storageFormatVersion: 2, opStreamVersion: 3 };
    console.info("[library-contract:put-version-roundtrip] parsing PUT body with storageFormatVersion=2 opStreamVersion=3");
    const parsed = PutLibraryDbRequestSchema.parse(input);
    console.info(
      `[library-contract:put-version-roundtrip] parsed storageFormatVersion=${parsed.storageFormatVersion} opStreamVersion=${parsed.opStreamVersion}`,
    );
    if (parsed.storageFormatVersion !== 2 || parsed.opStreamVersion !== 3) {
      dumpLibraryContractSnapshot("put-version-roundtrip-mismatch", { input, parsed });
    }
    expect(parsed.storageFormatVersion).toBe(2);
    expect(parsed.opStreamVersion).toBe(3);
  });

  it("rejects storageFormatVersion === 0", () => {
    expect(
      PutLibraryDbRequestSchema.safeParse({
        ...validRequest,
        storageFormatVersion: 0,
      }).success
    ).toBe(false);
  });

  it("rejects negative storageFormatVersion", () => {
    expect(
      PutLibraryDbRequestSchema.safeParse({
        ...validRequest,
        storageFormatVersion: -1,
      }).success
    ).toBe(false);
  });

  it("rejects opStreamVersion === 0", () => {
    expect(
      PutLibraryDbRequestSchema.safeParse({
        ...validRequest,
        opStreamVersion: 0,
      }).success
    ).toBe(false);
  });

  it("rejects negative opStreamVersion", () => {
    expect(
      PutLibraryDbRequestSchema.safeParse({
        ...validRequest,
        opStreamVersion: -3,
      }).success
    ).toBe(false);
  });
});

describe("PutLibraryDbResponseSchema", () => {
  it("accepts a canonical response", () => {
    const input = { version: 6, snapshotVersion: 6, stateHash: "deadbeef", lastOpId: "op-42" };
    console.info("[library-contract:put-response-canonical] parsing canonical PUT response (version=6)");
    const parsed = parsePutLibraryDbResponse(input);
    if (parsed.version !== 6 || parsed.snapshotVersion !== 6) {
      dumpLibraryContractSnapshot("put-response-canonical-mismatch", { input, parsed });
    }
    expect(parsed.version).toBe(6);
    expect(parsed.snapshotVersion).toBe(6);
  });

  it("accepts null stateHash and lastOpId", () => {
    const input = { version: 1, snapshotVersion: 1, stateHash: null, lastOpId: null };
    console.info("[library-contract:put-response-null-fields] parsing PUT response with null stateHash + lastOpId");
    const parsed = PutLibraryDbResponseSchema.parse(input);
    if (parsed.stateHash !== null || parsed.lastOpId !== null) {
      dumpLibraryContractSnapshot("put-response-null-fields-mismatch", { input, parsed });
    }
    expect(parsed.stateHash).toBeNull();
    expect(parsed.lastOpId).toBeNull();
  });

  it("rejects negative versions", () => {
    expect(
      PutLibraryDbResponseSchema.safeParse({
        version: -1,
        snapshotVersion: 0,
        stateHash: null,
        lastOpId: null,
      }).success
    ).toBe(false);
  });
});
