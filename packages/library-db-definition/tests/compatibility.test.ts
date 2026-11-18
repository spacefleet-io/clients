/**
 * @test-id LIB-DB-COMPAT-001
 * @level unit
 * @why `compatibility.ts` is the single funnel every open path routes through.
 *   If it fails to throw on a too-new surface, older clients silently corrupt
 *   state — the exact class of failure that caused the manifest bug. If it
 *   throws in the wrong order, the UI shows the wrong root cause. If
 *   `LibraryFormatTooNewError` carries wrong field values, the error handler
 *   cannot distinguish storage from schema failures and cannot route to the
 *   right update-now modal. These tests pin the pass-through semantics, the
 *   per-surface throw contract, surface-check order, and the error shape so
 *   any regression is caught before it reaches users.
 */
import { describe, expect, it } from "vitest";
import {
  assertLibraryCompatible,
  currentLibrarySupport,
  LibraryFormatTooNewError,
  type GroupMigrationRegistries,
  type LibrarySupport,
  type ObservedLibraryVersions,
} from "../src/compatibility";
import { STORAGE_FORMAT_VERSION } from "../src/storageFormat";
import { OP_STREAM_VERSION } from "../src/ops";

const SUITE = "compatibility";

const dumpCompatSnapshot = (
  label: string,
  ctx: {
    observed?: ObservedLibraryVersions;
    support?: LibrarySupport;
    expectedSurface?: "storage" | "op-stream" | "schema";
    expectedThrow?: boolean;
    matrixEntry?: { surface: string; observed?: number; supported?: number; group?: string };
    caughtError?: unknown;
    expectedFields?: Record<string, unknown>;
    observedFields?: Record<string, unknown>;
    registries?: GroupMigrationRegistries;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.observed) console.error(`observed versions:\n${JSON.stringify(ctx.observed, null, 2)}`);
    if (ctx.support) console.error(`support snapshot:\n${JSON.stringify(ctx.support, null, 2)}`);
    if (ctx.expectedSurface) console.error(`expected surface: ${ctx.expectedSurface}`);
    if (ctx.expectedThrow !== undefined) console.error(`expected throw: ${ctx.expectedThrow}`);
    if (ctx.matrixEntry) {
      console.error(`compatibility matrix entry under test:\n${JSON.stringify(ctx.matrixEntry, null, 2)}`);
    }
    if (ctx.expectedFields) {
      console.error(`expected fields:\n${JSON.stringify(ctx.expectedFields, null, 2)}`);
    }
    if (ctx.observedFields) {
      console.error(`observed fields:\n${JSON.stringify(ctx.observedFields, null, 2)}`);
    }
    if (ctx.caughtError !== undefined) {
      const e = ctx.caughtError;
      console.error(`caught: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      if (e instanceof LibraryFormatTooNewError) {
        console.error(`  surface=${e.surface} observed=${e.observed} supported=${e.supported} group=${e.group}`);
      }
    }
    if (ctx.registries) {
      console.error(`registries snapshot:\n${JSON.stringify(ctx.registries, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Representative support fixture (used across most tests)
// ---------------------------------------------------------------------------

/** Build's declared support — stands in for the real `LIBRARY_SUPPORT` constant. */
const SUPPORT: LibrarySupport = {
  storageFormatVersion: 1,
  opStreamVersion: 1,
  groupSchemaVersions: {
    core: 1,
    metadata: 1,
    playback: 2,
    ingest: 1,
    templates: 1,
  },
};

// ---------------------------------------------------------------------------
// LibraryFormatTooNewError — class contract
// ---------------------------------------------------------------------------

describe("LibraryFormatTooNewError — class contract", () => {
  console.info(`[${SUITE}:setup] testing LibraryFormatTooNewError class contract`);

  it("is an instance of Error", () => {
    const err = new LibraryFormatTooNewError({
      surface: "storage",
      observed: 2,
      supported: 1,
    });
    try {
      expect(err).toBeInstanceOf(Error);
    } catch (e) {
      dumpCompatSnapshot("not-instance-of-error", { caughtError: err });
      throw e;
    }
  });

  it("error.name is 'LibraryFormatTooNewError'", () => {
    const err = new LibraryFormatTooNewError({
      surface: "storage",
      observed: 2,
      supported: 1,
    });
    try {
      expect(err.name).toBe("LibraryFormatTooNewError");
    } catch (e) {
      dumpCompatSnapshot("wrong-error-name", { caughtError: err, expectedFields: { name: "LibraryFormatTooNewError" } });
      throw e;
    }
  });

  it("carries the correct surface, observed, supported fields", () => {
    const err = new LibraryFormatTooNewError({
      surface: "op-stream",
      observed: 5,
      supported: 1,
    });
    try {
      expect(err.surface).toBe("op-stream");
      expect(err.observed).toBe(5);
      expect(err.supported).toBe(1);
    } catch (e) {
      dumpCompatSnapshot("wrong-error-fields", {
        caughtError: err,
        expectedFields: { surface: "op-stream", observed: 5, supported: 1 },
        observedFields: { surface: err.surface, observed: err.observed, supported: err.supported },
      });
      throw e;
    }
  });

  it("group is undefined when not supplied", () => {
    const err = new LibraryFormatTooNewError({
      surface: "storage",
      observed: 2,
      supported: 1,
    });
    try {
      expect(err.group).toBeUndefined();
    } catch (e) {
      dumpCompatSnapshot("group-leaked-when-omitted", { caughtError: err });
      throw e;
    }
  });

  it("group is set when supplied", () => {
    const err = new LibraryFormatTooNewError({
      surface: "schema",
      observed: 3,
      supported: 2,
      group: "playback",
    });
    try {
      expect(err.group).toBe("playback");
    } catch (e) {
      dumpCompatSnapshot("group-not-set", { caughtError: err, expectedFields: { group: "playback" } });
      throw e;
    }
  });

  it("error.message contains 'LIBRARY_FORMAT_TOO_NEW'", () => {
    const err = new LibraryFormatTooNewError({
      surface: "storage",
      observed: 9,
      supported: 1,
    });
    try {
      expect(err.message).toContain("LIBRARY_FORMAT_TOO_NEW");
    } catch (e) {
      dumpCompatSnapshot("error-message-missing-marker", { caughtError: err });
      throw e;
    }
  });

  it("error.message for a schema surface includes the group name (format: 'schema:playback observed=3 supported=2')", () => {
    const err = new LibraryFormatTooNewError({
      surface: "schema",
      observed: 3,
      supported: 2,
      group: "playback",
    });
    console.info(`[${SUITE}:check] schema error.message="${err.message}"`);
    try {
      expect(err.message).toContain("LIBRARY_FORMAT_TOO_NEW");
      expect(err.message).toContain("schema:playback");
      expect(err.message).toContain("observed=3");
      expect(err.message).toContain("supported=2");
    } catch (e) {
      dumpCompatSnapshot("schema-message-shape-wrong", {
        caughtError: err,
        expectedFields: { mustContain: ["LIBRARY_FORMAT_TOO_NEW", "schema:playback", "observed=3", "supported=2"] },
      });
      throw e;
    }
  });

  it("error.message for a non-schema surface does not include a colon-separated group", () => {
    const err = new LibraryFormatTooNewError({
      surface: "op-stream",
      observed: 5,
      supported: 1,
    });
    console.info(`[${SUITE}:check] op-stream error.message="${err.message}"`);
    try {
      // Should be 'op-stream observed=5 supported=1' — no group segment.
      expect(err.message).toContain("op-stream");
      expect(err.message).not.toMatch(/op-stream:\w/);
    } catch (e) {
      dumpCompatSnapshot("non-schema-leaked-group-in-message", {
        caughtError: err,
        expectedFields: { mustContain: "op-stream", mustNotMatch: "op-stream:" },
      });
      throw e;
    }
  });
});

// ---------------------------------------------------------------------------
// Pass-through: no throw when all observed versions are within support
// ---------------------------------------------------------------------------

describe("assertLibraryCompatible — pass-through (no throw)", () => {
  const checkNoThrow = (
    label: string,
    observed: ObservedLibraryVersions,
    support: LibrarySupport,
  ) => {
    console.info(`[${SUITE}:pass-through] ${label} observed=${JSON.stringify(observed)} support=${JSON.stringify(support)}`);
    let caught: unknown;
    try {
      try {
        assertLibraryCompatible(observed, support);
      } catch (e) {
        caught = e;
        throw e;
      }
    } catch (err) {
      dumpCompatSnapshot(`pass-through-${label}-threw`, {
        observed,
        support,
        expectedThrow: false,
        caughtError: caught,
      });
      throw err;
    }
  };

  it("returns without throwing when observed is empty ({})", () => {
    checkNoThrow("empty-observed", {}, SUPPORT);
  });

  it("returns without throwing when observed storage version equals supported", () => {
    checkNoThrow("storage-equals", { storageFormatVersion: 1 }, SUPPORT);
  });

  it("returns without throwing when observed op-stream version equals supported", () => {
    checkNoThrow("op-stream-equals", { opStreamVersion: 1 }, SUPPORT);
  });

  it("returns without throwing when observed group schema version equals supported", () => {
    checkNoThrow("schema-equals", { groupSchemaVersions: { playback: 2 } }, SUPPORT);
  });

  it("returns without throwing when all observed versions equal supported exactly", () => {
    const observed: ObservedLibraryVersions = {
      storageFormatVersion: 1,
      opStreamVersion: 1,
      groupSchemaVersions: {
        core: 1,
        metadata: 1,
        playback: 2,
        ingest: 1,
        templates: 1,
      },
    };
    checkNoThrow("all-equal", observed, SUPPORT);
  });

  it("returns without throwing when observed storage version is less than supported", () => {
    const support: LibrarySupport = { ...SUPPORT, storageFormatVersion: 3 };
    checkNoThrow("storage-less-than", { storageFormatVersion: 1 }, support);
  });

  it("returns without throwing when observed op-stream version is less than supported", () => {
    const support: LibrarySupport = { ...SUPPORT, opStreamVersion: 4 };
    checkNoThrow("op-stream-less-than", { opStreamVersion: 2 }, support);
  });

  it("returns without throwing when observed groupSchemaVersions is an empty object", () => {
    checkNoThrow("empty-group-schema-versions", { groupSchemaVersions: {} }, SUPPORT);
  });
});

// ---------------------------------------------------------------------------
// Storage surface too-new
// ---------------------------------------------------------------------------

describe("assertLibraryCompatible — storage too-new", () => {
  console.info(`[${SUITE}:storage-too-new:setup] storageFormatVersion observed=2 supported=1`);

  it("throws LibraryFormatTooNewError when storageFormatVersion is too new", () => {
    try {
      expect(() =>
        assertLibraryCompatible({ storageFormatVersion: 2 }, SUPPORT)
      ).toThrow(LibraryFormatTooNewError);
    } catch (err) {
      dumpCompatSnapshot("storage-too-new-not-thrown", {
        observed: { storageFormatVersion: 2 },
        support: SUPPORT,
        expectedSurface: "storage",
        expectedThrow: true,
      });
      throw err;
    }
  });

  it("thrown error has surface==='storage'", () => {
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible({ storageFormatVersion: 2 }, SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught).toBeDefined();
      expect(caught!.surface).toBe("storage");
    } catch (err) {
      dumpCompatSnapshot("storage-too-new-surface-wrong", {
        observed: { storageFormatVersion: 2 },
        support: SUPPORT,
        expectedSurface: "storage",
        caughtError: caught,
      });
      throw err;
    }
  });

  it("thrown error has observed===2, supported===1", () => {
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible({ storageFormatVersion: 2 }, SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught!.observed).toBe(2);
      expect(caught!.supported).toBe(1);
    } catch (err) {
      dumpCompatSnapshot("storage-too-new-fields-wrong", {
        observed: { storageFormatVersion: 2 },
        support: SUPPORT,
        expectedFields: { observed: 2, supported: 1 },
        caughtError: caught,
      });
      throw err;
    }
  });

  it("thrown error has group===undefined", () => {
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible({ storageFormatVersion: 2 }, SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught!.group).toBeUndefined();
    } catch (err) {
      dumpCompatSnapshot("storage-too-new-group-leaked", {
        observed: { storageFormatVersion: 2 },
        caughtError: caught,
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Op-stream surface too-new
// ---------------------------------------------------------------------------

describe("assertLibraryCompatible — op-stream too-new", () => {
  console.info(`[${SUITE}:op-stream-too-new:setup] opStreamVersion observed=5 supported=1`);

  it("throws LibraryFormatTooNewError when opStreamVersion is too new", () => {
    try {
      expect(() =>
        assertLibraryCompatible({ opStreamVersion: 5 }, SUPPORT)
      ).toThrow(LibraryFormatTooNewError);
    } catch (err) {
      dumpCompatSnapshot("op-stream-too-new-not-thrown", {
        observed: { opStreamVersion: 5 },
        support: SUPPORT,
        expectedSurface: "op-stream",
        expectedThrow: true,
      });
      throw err;
    }
  });

  it("thrown error has surface==='op-stream'", () => {
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible({ opStreamVersion: 5 }, SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught!.surface).toBe("op-stream");
    } catch (err) {
      dumpCompatSnapshot("op-stream-surface-wrong", {
        observed: { opStreamVersion: 5 },
        expectedSurface: "op-stream",
        caughtError: caught,
      });
      throw err;
    }
  });

  it("thrown error carries observed===5, supported===1", () => {
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible({ opStreamVersion: 5 }, SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught!.observed).toBe(5);
      expect(caught!.supported).toBe(1);
    } catch (err) {
      dumpCompatSnapshot("op-stream-fields-wrong", {
        observed: { opStreamVersion: 5 },
        expectedFields: { observed: 5, supported: 1 },
        caughtError: caught,
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Schema surface too-new
// ---------------------------------------------------------------------------

describe("assertLibraryCompatible — schema too-new", () => {
  console.info(`[${SUITE}:schema-too-new:setup] playback observed=3 supported=2`);

  it("throws LibraryFormatTooNewError when a group schema version is too new", () => {
    try {
      expect(() =>
        assertLibraryCompatible(
          { groupSchemaVersions: { playback: 3 } },
          SUPPORT
        )
      ).toThrow(LibraryFormatTooNewError);
    } catch (err) {
      dumpCompatSnapshot("schema-too-new-not-thrown", {
        observed: { groupSchemaVersions: { playback: 3 } },
        support: SUPPORT,
        expectedSurface: "schema",
        expectedThrow: true,
      });
      throw err;
    }
  });

  it("thrown error has surface==='schema'", () => {
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible({ groupSchemaVersions: { playback: 3 } }, SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught!.surface).toBe("schema");
    } catch (err) {
      dumpCompatSnapshot("schema-surface-wrong", {
        observed: { groupSchemaVersions: { playback: 3 } },
        caughtError: caught,
      });
      throw err;
    }
  });

  it("thrown error has group==='playback', observed===3, supported===2", () => {
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible({ groupSchemaVersions: { playback: 3 } }, SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught!.group).toBe("playback");
      expect(caught!.observed).toBe(3);
      expect(caught!.supported).toBe(2);
    } catch (err) {
      dumpCompatSnapshot("schema-fields-wrong", {
        observed: { groupSchemaVersions: { playback: 3 } },
        matrixEntry: { surface: "schema", observed: 3, supported: 2, group: "playback" },
        caughtError: caught,
      });
      throw err;
    }
  });

  it("a group at exactly the supported version does NOT throw", () => {
    // playback supported = 2; observed = 2 → should pass
    console.info(`[${SUITE}:schema-equal] playback observed=2 supported=2 — must pass`);
    try {
      expect(() =>
        assertLibraryCompatible(
          { groupSchemaVersions: { playback: 2 } },
          SUPPORT
        )
      ).not.toThrow();
    } catch (err) {
      dumpCompatSnapshot("schema-equal-version-threw", {
        observed: { groupSchemaVersions: { playback: 2 } },
        support: SUPPORT,
        expectedThrow: false,
      });
      throw err;
    }
  });

  it("a group NOT present in support.groupSchemaVersions is skipped (no throw)", () => {
    // Construct a support that does NOT include 'playback'. Any observed version
    // for an unknown group must be treated as "not our concern" and skipped.
    const limitedSupport: LibrarySupport = {
      storageFormatVersion: 1,
      opStreamVersion: 1,
      groupSchemaVersions: {
        core: 1,
        metadata: 1,
        playback: 2,
        ingest: 1,
        templates: 1,
      },
    };
    // Override groupSchemaVersions to a type-cast that omits a key at runtime.
    const supportWithoutIngest = {
      ...limitedSupport,
      groupSchemaVersions: { core: 1, metadata: 1, playback: 2, templates: 1 },
    } as unknown as LibrarySupport;
    console.info(`[${SUITE}:unknown-group] observed ingest=99 with no 'ingest' in support — must skip`);
    try {
      // ingest is not in support → should not throw regardless of observed value.
      expect(() =>
        assertLibraryCompatible(
          { groupSchemaVersions: { ingest: 99 } },
          supportWithoutIngest
        )
      ).not.toThrow();
    } catch (err) {
      dumpCompatSnapshot("unknown-group-not-skipped", {
        observed: { groupSchemaVersions: { ingest: 99 } },
        support: supportWithoutIngest,
        expectedThrow: false,
      });
      throw err;
    }
  });

  it("groupSchemaVersions entry explicitly set to undefined is skipped (no throw)", () => {
    // ObservedLibraryVersions uses Partial<Record<...>> so undefined values
    // are legal and must be treated as "not observed".
    console.info(`[${SUITE}:undefined-version] observed playback=undefined — must skip`);
    try {
      expect(() =>
        assertLibraryCompatible(
          {
            groupSchemaVersions: {
              playback: undefined,
            } as ObservedLibraryVersions["groupSchemaVersions"],
          },
          SUPPORT
        )
      ).not.toThrow();
    } catch (err) {
      dumpCompatSnapshot("undefined-version-not-skipped", {
        observed: { groupSchemaVersions: { playback: undefined } as ObservedLibraryVersions["groupSchemaVersions"] },
        support: SUPPORT,
        expectedThrow: false,
      });
      throw err;
    }
  });

  it("throws for the first too-new group when multiple groups are observed", () => {
    // core observed=5, playback observed=3 — both are too new; whichever
    // the implementation visits first is thrown. We only assert it throws
    // LibraryFormatTooNewError and the surface is 'schema'.
    console.info(`[${SUITE}:multi-group] core=5 playback=3 — first-visited must throw`);
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible(
        { groupSchemaVersions: { core: 5, playback: 3 } },
        SUPPORT
      );
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught).toBeDefined();
      expect(caught!.surface).toBe("schema");
    } catch (err) {
      dumpCompatSnapshot("multi-too-new-not-thrown", {
        observed: { groupSchemaVersions: { core: 5, playback: 3 } },
        support: SUPPORT,
        expectedSurface: "schema",
        caughtError: caught,
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Surface-check order (storage → op-stream → schema)
// ---------------------------------------------------------------------------

describe("assertLibraryCompatible — surface-check order", () => {
  const checkSurfaceOrder = (
    label: string,
    observed: ObservedLibraryVersions,
    expectedSurface: "storage" | "op-stream" | "schema",
  ) => {
    console.info(`[${SUITE}:surface-order] ${label} observed=${JSON.stringify(observed)} expect surface=${expectedSurface}`);
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible(observed, SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught).toBeDefined();
      expect(caught!.surface).toBe(expectedSurface);
    } catch (err) {
      dumpCompatSnapshot(`surface-order-${label}-wrong`, {
        observed,
        support: SUPPORT,
        expectedSurface,
        caughtError: caught,
      });
      throw err;
    }
  };

  it("when storage AND op-stream are both too-new, the storage error is thrown (checked first)", () => {
    checkSurfaceOrder("storage-vs-op-stream", { storageFormatVersion: 9, opStreamVersion: 9 }, "storage");
  });

  it("when op-stream AND schema are both too-new, the op-stream error is thrown (checked before schema)", () => {
    checkSurfaceOrder(
      "op-stream-vs-schema",
      { opStreamVersion: 9, groupSchemaVersions: { playback: 9 } },
      "op-stream",
    );
  });

  it("when all three surfaces are too-new, the storage error is thrown", () => {
    checkSurfaceOrder(
      "all-three-too-new",
      { storageFormatVersion: 9, opStreamVersion: 9, groupSchemaVersions: { playback: 9 } },
      "storage",
    );
  });

  it("storage within support → op-stream error surfaces next when op-stream is too-new", () => {
    // Storage = 1 (OK), op-stream = 9 (too new), schema = 9 (too new).
    // Expected: op-stream error.
    checkSurfaceOrder(
      "storage-ok-op-stream-too-new",
      { storageFormatVersion: 1, opStreamVersion: 9, groupSchemaVersions: { playback: 9 } },
      "op-stream",
    );
  });

  it("storage + op-stream within support → schema error surfaces when schema is too-new", () => {
    checkSurfaceOrder(
      "storage-and-op-stream-ok-schema-too-new",
      { storageFormatVersion: 1, opStreamVersion: 1, groupSchemaVersions: { playback: 9 } },
      "schema",
    );
  });
});

// ---------------------------------------------------------------------------
// currentLibrarySupport — helper that assembles LibrarySupport from registries
// ---------------------------------------------------------------------------

describe("currentLibrarySupport — storageFormatVersion + opStreamVersion", () => {
  console.info(`[${SUITE}:currentLibrarySupport:setup] STORAGE_FORMAT_VERSION=${STORAGE_FORMAT_VERSION} OP_STREAM_VERSION=${OP_STREAM_VERSION}`);

  it("storageFormatVersion equals the STORAGE_FORMAT_VERSION build constant", () => {
    const support = currentLibrarySupport({});
    try {
      expect(support.storageFormatVersion).toBe(STORAGE_FORMAT_VERSION);
    } catch (err) {
      dumpCompatSnapshot("storage-version-build-constant-drift", { support });
      throw err;
    }
  });

  it("opStreamVersion equals the OP_STREAM_VERSION build constant", () => {
    const support = currentLibrarySupport({});
    try {
      expect(support.opStreamVersion).toBe(OP_STREAM_VERSION);
    } catch (err) {
      dumpCompatSnapshot("op-stream-version-build-constant-drift", { support });
      throw err;
    }
  });

  it("both constants are unaffected by which registries are passed", () => {
    const registries: GroupMigrationRegistries = {
      core: [{ version: 1 }, { version: 2 }],
      playback: [{ version: 1 }],
    };
    const withRegistries = currentLibrarySupport(registries);
    try {
      expect(withRegistries.storageFormatVersion).toBe(STORAGE_FORMAT_VERSION);
      expect(withRegistries.opStreamVersion).toBe(OP_STREAM_VERSION);
    } catch (err) {
      dumpCompatSnapshot("constants-affected-by-registries", { support: withRegistries, registries });
      throw err;
    }
  });
});

describe("currentLibrarySupport — groupSchemaVersions folding", () => {
  it("single-migration registry yields that migration's version as the group's supported version", () => {
    const registries: GroupMigrationRegistries = { playback: [{ version: 2 }] };
    const support = currentLibrarySupport(registries);
    console.info(`[${SUITE}:fold] single-mig playback support=${JSON.stringify(support.groupSchemaVersions)}`);
    try {
      expect(support.groupSchemaVersions.playback).toBe(2);
    } catch (err) {
      dumpCompatSnapshot("single-mig-fold-wrong", { support, registries });
      throw err;
    }
  });

  it("multi-entry sorted registry yields the highest version", () => {
    const registries: GroupMigrationRegistries = { playback: [{ version: 1 }, { version: 2 }] };
    const support = currentLibrarySupport(registries);
    try {
      expect(support.groupSchemaVersions.playback).toBe(2);
    } catch (err) {
      dumpCompatSnapshot("sorted-multi-fold-wrong", { support, registries });
      throw err;
    }
  });

  it("unsorted registry still yields the true max (not last-element)", () => {
    // Passing [{version:3},{version:1},{version:2}] — max is 3, not 2.
    const registries: GroupMigrationRegistries = {
      playback: [{ version: 3 }, { version: 1 }, { version: 2 }],
    };
    const support = currentLibrarySupport(registries);
    console.info(`[${SUITE}:fold-unsorted] playback support=${support.groupSchemaVersions.playback} expected=3`);
    try {
      expect(support.groupSchemaVersions.playback).toBe(3);
    } catch (err) {
      dumpCompatSnapshot("unsorted-fold-takes-last-not-max", { support, registries });
      throw err;
    }
  });

  it("empty registry array → group resolves to 0 (user_version baseline)", () => {
    const registries: GroupMigrationRegistries = { core: [] };
    const support = currentLibrarySupport(registries);
    try {
      expect(support.groupSchemaVersions.core).toBe(0);
    } catch (err) {
      dumpCompatSnapshot("empty-array-fold-not-zero", { support, registries });
      throw err;
    }
  });

  it("group absent from registries is absent from groupSchemaVersions", () => {
    // Passing only 'core' — 'playback' should not appear in the result.
    const registries: GroupMigrationRegistries = { core: [{ version: 1 }] };
    const support = currentLibrarySupport(registries);
    try {
      expect("playback" in support.groupSchemaVersions).toBe(false);
    } catch (err) {
      dumpCompatSnapshot("absent-group-leaked-as-key", { support, registries });
      throw err;
    }
  });

  it("multiple groups are all folded independently", () => {
    const registries: GroupMigrationRegistries = {
      core: [{ version: 1 }],
      metadata: [{ version: 1 }, { version: 2 }],
      playback: [{ version: 3 }, { version: 1 }, { version: 2 }],
      ingest: [],
    };
    const support = currentLibrarySupport(registries);
    console.info(`[${SUITE}:fold-multi] groupSchemaVersions=${JSON.stringify(support.groupSchemaVersions)}`);
    try {
      expect(support.groupSchemaVersions.core).toBe(1);
      expect(support.groupSchemaVersions.metadata).toBe(2);
      expect(support.groupSchemaVersions.playback).toBe(3);
      expect(support.groupSchemaVersions.ingest).toBe(0);
      expect("templates" in support.groupSchemaVersions).toBe(false);
    } catch (err) {
      dumpCompatSnapshot("multi-group-fold-wrong", {
        support,
        registries,
        expectedFields: {
          "groupSchemaVersions.core": 1,
          "groupSchemaVersions.metadata": 2,
          "groupSchemaVersions.playback": 3,
          "groupSchemaVersions.ingest": 0,
          "templates-present": false,
        },
      });
      throw err;
    }
  });
});

describe("currentLibrarySupport — round-trip with assertLibraryCompatible", () => {
  it("observed at-or-below every supported version returns without throwing", () => {
    const registries: GroupMigrationRegistries = {
      core: [{ version: 1 }],
      playback: [{ version: 2 }],
    };
    const support = currentLibrarySupport(registries);
    const observed: ObservedLibraryVersions = {
      storageFormatVersion: STORAGE_FORMAT_VERSION,
      opStreamVersion: OP_STREAM_VERSION,
      groupSchemaVersions: { core: 1, playback: 2 },
    };
    console.info(`[${SUITE}:roundtrip] observed=${JSON.stringify(observed)} support=${JSON.stringify(support)}`);
    try {
      expect(() => assertLibraryCompatible(observed, support)).not.toThrow();
    } catch (err) {
      dumpCompatSnapshot("roundtrip-at-or-below-threw", { observed, support, registries, expectedThrow: false });
      throw err;
    }
  });

  it("observed above a group schema version throws LibraryFormatTooNewError", () => {
    const registries: GroupMigrationRegistries = { playback: [{ version: 2 }] };
    const support = currentLibrarySupport(registries);
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible(
        { groupSchemaVersions: { playback: 3 } },
        support
      );
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    try {
      expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
      expect(caught!.surface).toBe("schema");
      expect(caught!.group).toBe("playback");
      expect(caught!.observed).toBe(3);
      expect(caught!.supported).toBe(2);
    } catch (err) {
      dumpCompatSnapshot("roundtrip-schema-too-new-wrong", {
        observed: { groupSchemaVersions: { playback: 3 } },
        support,
        registries,
        matrixEntry: { surface: "schema", observed: 3, supported: 2, group: "playback" },
        caughtError: caught,
      });
      throw err;
    }
  });

  it("observed above storageFormatVersion throws LibraryFormatTooNewError (storage surface)", () => {
    // One above the build's STORAGE_FORMAT_VERSION must be refused.
    const support = currentLibrarySupport({});
    const observed: ObservedLibraryVersions = { storageFormatVersion: STORAGE_FORMAT_VERSION + 1 };
    try {
      expect(() => assertLibraryCompatible(observed, support)).toThrow(LibraryFormatTooNewError);
    } catch (err) {
      dumpCompatSnapshot("roundtrip-storage-too-new-not-thrown", {
        observed,
        support,
        expectedSurface: "storage",
        expectedThrow: true,
      });
      throw err;
    }
  });
});
