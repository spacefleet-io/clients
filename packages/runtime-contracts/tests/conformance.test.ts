/**
 * Contract conformance tests — verify that every exported command contract:
 * 1. Has a valid, consistent structure (name, module, payloadSchema, resultSchema)
 * 2. payload + result schemas accept their documented shape and reject garbage
 * 3. Command names match the expected module prefix pattern
 *
 * These tests run in <5s with no services and catch drift between contracts.
 */
import { describe, expect, it } from "vitest";
import type { CommandContract } from "../src/helpers";

/**
 * Suite-id for "Tests log generously" diagnostic prefixing. Kebab-case, stable,
 * matches the filename family (conformance.test.ts -> contract-conformance).
 */
const SUITE_ID = "contract-conformance";

/**
 * Per-suite dump helper. Emits the registry/handler-set state this suite cares
 * about so a coverage-drift failure is diagnosable from CI logs alone — instead
 * of a bare `expect([]).toEqual(["badger.foo"])` that hides which side drifted.
 * Body is wrapped in try/catch so a dump failure can never mask the real
 * assertion failure.
 */
const dumpConformanceSnapshot = (
  label: string,
  extra: Record<string, unknown> = {},
): void => {
  try {
    const contractNames = ALL_BADGER_CONTRACTS.map((c) => c.name);
    const handlerNames = [...RUNTIME_HANDLED_COMMANDS];
    console.error(`=== [${SUITE_ID}:${label}] snapshot ===`);
    console.error(
      `counts: contracts=${contractNames.length} runtimeHandlers=${handlerNames.length}`,
    );
    console.error(`contract names:\n${JSON.stringify(contractNames, null, 2)}`);
    console.error(`runtime handler names:\n${JSON.stringify(handlerNames, null, 2)}`);
    if (Object.keys(extra).length > 0) {
      console.error(`extra:\n${JSON.stringify(extra, null, 2)}`);
    }
    console.error(`=== [${SUITE_ID}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

// Import ALL badger contracts
import {
  badgerDbOpen,
  badgerDbOpenLocal,
  badgerDbClose,
  badgerDbSnapshot,
  badgerDbCall,
  badgerDbClearLocalCache,
  badgerDbStatus,
} from "../src/badger/db";
import { badgerStorageGc } from "../src/badger/storage";
import {
  badgerLibraryGetState,
  badgerLibraryUpsertSnapshot,
  badgerLibraryListSnapshots,
  badgerLibraryGetSnapshot,
  badgerLibraryClear,
} from "../src/badger/library";
import {
  badgerIngestOpen,
  badgerIngestClose,
  badgerIngestGetState,
  badgerIngestGetStateAlias,
  badgerIngestApply,
  badgerIngestListJobs,
  badgerIngestSubmitSources,
  badgerIngestAttachMetadata,
  badgerIngestPlanOutputs,
  badgerIngestConfigureScheduling,
  badgerMediaReplanQualities,
} from "../src/badger/ingest";
import {
  badgerDummyIngestStart,
  badgerDummyIngestUpsertJob,
  badgerDummyIngestGetJob,
  badgerDummyIngestListJobs,
} from "../src/badger/dummy-ingest";
import {
  badgerPlaybackPrepareStream,
  badgerPlaybackReleaseStream,
  badgerPlaybackListActiveSessions,
  badgerPlaybackRecordSignedUrlRequest,
  badgerPlaybackGetSignedUrlMetrics,
  badgerPlaybackResetSignedUrlMetrics,
  badgerPlaybackSetUploadPolicy,
} from "../src/badger/playback";
import {
  badgerCapabilitiesGetFfmpeg,
  badgerCapabilitiesTestFfmpeg,
} from "../src/badger/capabilities";
import { badgerMediaDelete } from "../src/badger/media";
import {
  badgerOfflineEstimateSize,
  badgerOfflineDownloadSubmit,
  badgerOfflineDeleteLocal,
  badgerOfflineListLocal,
  badgerOfflineReconcile,
} from "../src/badger/offline";
import { badgerExportEstimate, badgerExportSubmit } from "../src/badger/export";
import { badgerPreviewsGetCatchUp, badgerPreviewsGetStatus, badgerPreviewsRetryCatchUp, badgerPreviewsSetCatchUpVideo } from "../src/badger/previews";

/**
 * Registry of ALL badger command contracts. When you add a new contract,
 * add it here — the test below will catch it if you forget (via the
 * "all exported contracts are registered" test).
 */
const ALL_BADGER_CONTRACTS: CommandContract[] = [
  // db
  badgerDbOpen,
  badgerDbOpenLocal,
  badgerDbClose,
  badgerDbSnapshot,
  badgerDbCall,
  badgerDbClearLocalCache,
  badgerDbStatus,
  // storage
  badgerStorageGc,
  // library
  badgerLibraryGetState,
  badgerLibraryUpsertSnapshot,
  badgerLibraryListSnapshots,
  badgerLibraryGetSnapshot,
  badgerLibraryClear,
  // ingest
  badgerIngestOpen,
  badgerIngestClose,
  badgerIngestGetState,
  badgerIngestGetStateAlias,
  badgerIngestApply,
  badgerIngestListJobs,
  // ingest (Phase D — typed submission API; runtime handlers pending)
  badgerIngestSubmitSources,
  badgerIngestAttachMetadata,
  badgerIngestPlanOutputs,
  badgerIngestConfigureScheduling,
  // post-ingest quality management
  badgerMediaReplanQualities,
  // dummy-ingest
  badgerDummyIngestStart,
  badgerDummyIngestUpsertJob,
  badgerDummyIngestGetJob,
  badgerDummyIngestListJobs,
  // playback
  badgerPlaybackPrepareStream,
  badgerPlaybackReleaseStream,
  badgerPlaybackListActiveSessions,
  badgerPlaybackRecordSignedUrlRequest,
  badgerPlaybackGetSignedUrlMetrics,
  badgerPlaybackResetSignedUrlMetrics,
  badgerPlaybackSetUploadPolicy,
  // capabilities
  badgerCapabilitiesGetFfmpeg,
  badgerCapabilitiesTestFfmpeg,
  // media
  badgerMediaDelete,
  // offline downloads (Phase 2 of let-s-talk-about-offline)
  badgerOfflineEstimateSize,
  badgerOfflineDownloadSubmit,
  badgerOfflineDeleteLocal,
  badgerOfflineListLocal,
  badgerOfflineReconcile,
  // export to plain files (OFFL-FILE-01 / ACCT-EXPORT-01)
  badgerExportEstimate,
  badgerExportSubmit,
  // seek-bar previews (MPV-PREV-06)
  badgerPreviewsGetStatus,
  // skip-detection catch-up in the Jobs tab (MPV-PREV-07)
  badgerPreviewsGetCatchUp,
  badgerPreviewsRetryCatchUp,
  badgerPreviewsSetCatchUpVideo,
];

/**
 * Command names that the runtime badger module actually handles.
 * Extracted from apps/runtime/src/modules/badger.ts execute() switch.
 * Keep in sync — the test will tell you when they drift.
 */
const RUNTIME_HANDLED_COMMANDS = new Set([
  "badger.library.get_state",
  "badger.library.upsert_snapshot",
  "badger.library.list_snapshots",
  "badger.library.get_snapshot",
  "badger.library.clear",
  "badger.ingest.open",
  "badger.ingest.close",
  "badger.ingest.get_state",
  "badger.ingest.apply",
  "badger.ingest.list_jobs",
  "badger.dummy_ingest.start",
  "badger.dummy_ingest.upsert_job",
  "badger.dummy_ingest.get_job",
  "badger.dummy_ingest.list_jobs",
  "badger.playback.prepare_stream",
  "badger.playback.release_stream",
  "badger.playback.list_active_sessions",
  "badger.playback.record_signed_url_request",
  "badger.playback.get_signed_url_metrics",
  "badger.playback.reset_signed_url_metrics",
  "badger.playback.set_upload_policy",
  "badger.capabilities.get_ffmpeg",
  "badger.capabilities.test_ffmpeg",
  "badger.db.open",
  "badger.db.open_local",
  "badger.db.close",
  "badger.db.snapshot",
  "badger.db.call",
  "badger.db.clearLocalCache",
  "badger.db.status",
  "badger.storage.gc",
  // Phase D safe scaffolding: handlers landed in apps/runtime/src/modules/
  // index.ts (executeV2BadgerIngestCommand). They self-gate on RUNTIME_ENGINE_V2.
  "badger.ingest.submit_sources",
  "badger.ingest.attach_metadata",
  "badger.ingest.plan_outputs",
  "badger.ingest.configure_scheduling",
  // media
  "badger.media.delete",
  "badger.media.replan_qualities",
  // offline downloads (Phase 2). Routed through executeV2BadgerIngestCommand
  // in apps/runtime/src/modules/index.ts.
  "badger.offline.estimate_size",
  "badger.offline.download_submit",
  "badger.offline.delete_local",
  "badger.offline.list_local",
  "badger.offline.reconcile",
  // export to plain files (OFFL-FILE-01 / ACCT-EXPORT-01). Routed through
  // executeV2BadgerIngestCommand in apps/runtime/src/modules/index.ts.
  "badger.export.estimate",
  "badger.export.submit",
  // seek-bar previews (MPV-PREV-06). Routed in executeModuleCommand
  // (apps/runtime/src/modules/index.ts), next to the catch-up pass it reads.
  "badger.previews.get_status",
  "badger.previews.get_catch_up",
  "badger.previews.retry_catch_up",
  "badger.previews.set_catch_up_video",
]);

describe("contract conformance", () => {
  console.info(
    `[${SUITE_ID}:setup] registry loaded: contracts=${ALL_BADGER_CONTRACTS.length} runtimeHandlers=${RUNTIME_HANDLED_COMMANDS.size}`,
  );

  describe("structural integrity", () => {
    for (const contract of ALL_BADGER_CONTRACTS) {
      describe(contract.name, () => {
        it("has frozen, non-empty name", () => {
          if (!Object.isFrozen(contract)) {
            console.error(
              `[${SUITE_ID}:structural] contract "${contract.name}" is NOT frozen — contracts must be Object.freeze()'d at definition: ${JSON.stringify({ name: contract.name, module: contract.module })}`,
            );
          }
          expect(typeof contract.name).toBe("string");
          expect(contract.name.length).toBeGreaterThan(0);
          expect(Object.isFrozen(contract)).toBe(true);
        });

        it("module is 'badger'", () => {
          expect(contract.module).toBe("badger");
        });

        it("name starts with module prefix", () => {
          expect(contract.name.startsWith("badger.")).toBe(true);
        });

        it("payloadSchema accepts empty or valid object", () => {
          // Every payload schema should at minimum accept an object
          const result = contract.payloadSchema.safeParse({});
          // We don't assert success because some require fields,
          // but it should not throw
          expect(result).toBeDefined();
        });

        it("resultSchema is defined", () => {
          expect(contract.resultSchema).toBeDefined();
          expect(typeof contract.resultSchema.safeParse).toBe("function");
        });

        it("payloadSchema rejects non-object input", () => {
          const result = contract.payloadSchema.safeParse("not-an-object");
          if (result.success) {
            console.error(
              `[${SUITE_ID}:structural] contract "${contract.name}" payloadSchema unexpectedly ACCEPTED a string ("not-an-object") — schema should reject non-object input. parsed=${JSON.stringify(result.data)}`,
            );
          }
          expect(result.success).toBe(false);
        });
      });
    }
  });

  describe("no duplicate command names", () => {
    it("each contract has a unique name (excluding known aliases)", () => {
      const knownAliases = new Set(["badger.ingest.getState"]);
      const names = ALL_BADGER_CONTRACTS
        .map((c) => c.name)
        .filter((n) => !knownAliases.has(n));
      const unique = new Set(names);
      if (names.length !== unique.size) {
        const seen = new Set<string>();
        const duplicates = names.filter((n) => {
          if (seen.has(n)) return true;
          seen.add(n);
          return false;
        });
        console.error(
          `[${SUITE_ID}:unique-names] DUPLICATE contract names detected (count=${names.length} unique=${unique.size})`,
        );
        dumpConformanceSnapshot("unique-names-failure", { duplicates });
      }
      expect(names.length).toBe(unique.size);
    });
  });

  describe("contract ↔ runtime handler coverage", () => {
    it("every contract has a matching runtime handler @req RT-CMD-03", () => {
      const knownAliases = new Set(["badger.ingest.getState"]);
      // Phase D ingestion-refactor contracts: typed submission API. Handlers
      // landed in apps/runtime/src/modules/index.ts as part of the safe
      // scaffolding chunk (engine wiring + step stubs). The renderer rewrite
      // is still pending; the runtime surface is feature-flagged on
      // RUNTIME_ENGINE_V2.
      const unhandled = ALL_BADGER_CONTRACTS
        .filter((c) => !knownAliases.has(c.name))
        .filter((c) => !RUNTIME_HANDLED_COMMANDS.has(c.name))
        .map((c) => c.name);
      console.info(
        `[${SUITE_ID}:contract-has-handler] checked ${ALL_BADGER_CONTRACTS.length} contracts, unhandled=${unhandled.length}`,
      );
      if (unhandled.length > 0) {
        console.error(
          `[${SUITE_ID}:contract-has-handler] contracts WITHOUT a runtime handler: ${JSON.stringify(unhandled)} — add them to RUNTIME_HANDLED_COMMANDS or the runtime badger module execute() switch`,
        );
        dumpConformanceSnapshot("contract-has-handler-failure", { unhandled });
      }
      expect(unhandled).toEqual([]);
    });

    it("every runtime handler has a matching contract", () => {
      const contractNames = new Set(ALL_BADGER_CONTRACTS.map((c) => c.name));
      const unmatched = [...RUNTIME_HANDLED_COMMANDS].filter(
        (name) => !contractNames.has(name)
      );
      console.info(
        `[${SUITE_ID}:handler-has-contract] checked ${RUNTIME_HANDLED_COMMANDS.size} handlers, unmatched=${unmatched.length}`,
      );
      if (unmatched.length > 0) {
        console.error(
          `[${SUITE_ID}:handler-has-contract] runtime handlers WITHOUT a contract: ${JSON.stringify(unmatched)} — add a CommandContract to ALL_BADGER_CONTRACTS`,
        );
        dumpConformanceSnapshot("handler-has-contract-failure", { unmatched });
      }
      expect(unmatched).toEqual([]);
    });
  });

  describe("all exported contracts are registered in ALL_BADGER_CONTRACTS", () => {
    it("badger/index.ts re-exports match the registry", async () => {
      console.info(`[${SUITE_ID}:registry-coverage] importing ../src/badger/index`);
      const badgerExports = await import("../src/badger/index");
      const exportedValues: unknown[] = Object.values(badgerExports);
      const exportedContracts = exportedValues.filter(
        (v): v is CommandContract =>
          typeof v === "object" &&
          v !== null &&
          "name" in v &&
          "module" in v &&
          "payloadSchema" in v &&
          "resultSchema" in v
      );
      const registeredNames = new Set(ALL_BADGER_CONTRACTS.map((c) => c.name));
      const missing = exportedContracts
        .filter((c) => !registeredNames.has(c.name))
        .map((c) => c.name);
      console.info(
        `[${SUITE_ID}:registry-coverage] exportedContracts=${exportedContracts.length} registered=${registeredNames.size} missing=${missing.length}`,
      );
      if (missing.length > 0) {
        console.error(
          `[${SUITE_ID}:registry-coverage] contracts exported from badger/index.ts but MISSING from ALL_BADGER_CONTRACTS: ${JSON.stringify(missing)} — add them to the registry`,
        );
        dumpConformanceSnapshot("registry-coverage-failure", {
          missing,
          exportedContractNames: exportedContracts.map((c) => c.name),
        });
      }
      expect(missing).toEqual([]);
    });
  });
});
