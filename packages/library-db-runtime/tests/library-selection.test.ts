import { describe, expect, it } from "bun:test";
import { ApiError } from "../src/api";
import {
  resolveBootstrapBaseVersion,
  shouldBootstrapFromMissingSnapshot,
  shouldTreatSyncUnavailable,
} from "../src/libraryDb";

// Suite-id: library-selection
// Pure predicate suite; dump-helper records the input shape on failure so the
// reader sees which branch produced the wrong answer.
const dumpPredicateSnapshot = (label: string, input: unknown) => {
  try {
    console.error(`=== [library-selection:${label}] snapshot ===`);
    console.error(`input=${JSON.stringify(input, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("library selection recovery", () => {
  it("allows bootstrap recovery when snapshot is missing but sync is available", () => {
    const input = {
      exists: false,
      bootstrapRequired: false,
      syncUnavailable: false,
      consistency: "missing_snapshot" as const,
    };
    console.info(`[library-selection:recover-allowed] input=${JSON.stringify(input)}`);
    try {
      expect(shouldBootstrapFromMissingSnapshot(input)).toBe(true);
    } catch (err) {
      console.error(`[library-selection:recover-allowed] assertion failed`);
      dumpPredicateSnapshot("recover-allowed-failure", input);
      throw err;
    }
  });

  it("does not recover when sync is unavailable", () => {
    const input = {
      exists: false,
      bootstrapRequired: false,
      syncUnavailable: true,
      consistency: "missing_snapshot" as const,
    };
    console.info(`[library-selection:sync-unavailable] input=${JSON.stringify(input)}`);
    try {
      expect(shouldBootstrapFromMissingSnapshot(input)).toBe(false);
    } catch (err) {
      console.error(`[library-selection:sync-unavailable] assertion failed`);
      dumpPredicateSnapshot("sync-unavailable-failure", input);
      throw err;
    }
  });

  it("does not recover when bootstrap is explicitly required", () => {
    const input = {
      exists: false,
      bootstrapRequired: true,
      syncUnavailable: false,
      consistency: "missing_snapshot" as const,
    };
    console.info(`[library-selection:bootstrap-required] input=${JSON.stringify(input)}`);
    try {
      expect(shouldBootstrapFromMissingSnapshot(input)).toBe(false);
    } catch (err) {
      console.error(`[library-selection:bootstrap-required] assertion failed`);
      dumpPredicateSnapshot("bootstrap-required-failure", input);
      throw err;
    }
  });

  it("uses remote version as bootstrap base when recovering from missing snapshot", () => {
    console.info(`[library-selection:bootstrap-base] testing 3 version inputs (0, 2, -1)`);
    try {
      expect(resolveBootstrapBaseVersion({ version: 0 })).toBe(0);
      expect(resolveBootstrapBaseVersion({ version: 2 })).toBe(2);
      expect(resolveBootstrapBaseVersion({ version: -1 })).toBe(0);
      console.info(`[library-selection:bootstrap-base] all 3 versions resolved correctly`);
    } catch (err) {
      console.error(`[library-selection:bootstrap-base] assertion failed`);
      console.error(`v=0 => ${resolveBootstrapBaseVersion({ version: 0 })}`);
      console.error(`v=2 => ${resolveBootstrapBaseVersion({ version: 2 })}`);
      console.error(`v=-1 => ${resolveBootstrapBaseVersion({ version: -1 })}`);
      throw err;
    }
  });

  it("treats storage gateway outages as sync unavailable", () => {
    console.info(`[library-selection:treat-outage] testing 3 ApiError shapes`);
    try {
      const e502 = new ApiError(502, { error: "storage_tunnel_failed" });
      const e503 = new ApiError(503, { error: "storage_gateway_unavailable" });
      const e400 = new ApiError(400, { error: "invalid_blob" });
      console.info(
        `[library-selection:treat-outage] verdicts: 502=${shouldTreatSyncUnavailable(e502)} ` +
          `503=${shouldTreatSyncUnavailable(e503)} 400=${shouldTreatSyncUnavailable(e400)}`,
      );
      expect(shouldTreatSyncUnavailable(e502)).toBe(true);
      expect(shouldTreatSyncUnavailable(e503)).toBe(true);
      expect(shouldTreatSyncUnavailable(e400)).toBe(false);
    } catch (err) {
      console.error(`[library-selection:treat-outage] assertion failed`);
      throw err;
    }
  });
});
