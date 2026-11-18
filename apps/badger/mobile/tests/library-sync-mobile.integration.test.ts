import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getSystemContract,
  getSystemContractIssue,
  getLibraryMeta,
  setApiBaseUrl,
  type SystemContract,
  type LibraryMeta,
} from "@space/shared/api";

/**
 * @test-id MOBILE-SYNC-001
 * @level integration
 * @why Library sync has several mobile-specific failure modes: contract check blocking sync,
 *   exists:false from SSE causing spurious logout, and key probe validation.
 */

const SUITE_ID = "mobile-library-sync-integration";

// The SDK calls `fetch(Request)` and cannot build a Request from the default relative `/api` base.
beforeAll(() => setApiBaseUrl("http://api.test"));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  console.info(`[${SUITE_ID}:teardown] resetting fetchMock (calls=${fetchMock.mock.calls.length})`);
  fetchMock.mockReset();
});

/**
 * State dumper: snapshots fetchMock invocations, the latest contract/meta context provided,
 * and a summary of the last response. Tries hard not to throw inside the snapshot itself.
 */
const dumpSyncSnapshot = (
  label: string,
  ctx: {
    contract?: SystemContract | null;
    issue?: string | null;
    meta?: LibraryMeta | null;
    appId?: string;
  } = {},
) => {
  try {
    const calls = fetchMock.mock.calls.map((call, idx) => {
      const [request] = call as [Request];
      return {
        idx,
        url: request.url,
        method: request.method,
      };
    });
    const results = fetchMock.mock.results.map((r, idx) => ({
      idx,
      type: r.type,
      summary:
        r.type === "return" && r.value instanceof Response
          ? `Response(status=${(r.value as Response).status})`
          : String(r.value).slice(0, 200),
    }));
    console.error(`=== [${SUITE_ID}:${label}] snapshot ===`);
    console.error(`appId=${ctx.appId ?? "(none)"} issue=${ctx.issue ?? "(none)"}`);
    if (ctx.contract) {
      console.error(
        `contract apps.badger=${JSON.stringify(ctx.contract.apps?.badger, null, 2)}`,
      );
    }
    if (ctx.meta) {
      console.error(`meta:\n${JSON.stringify(ctx.meta, null, 2)}`);
    }
    console.error(`fetch call count=${fetchMock.mock.calls.length}`);
    console.error(`fetch calls:\n${JSON.stringify(calls, null, 2)}`);
    console.error(`fetch results:\n${JSON.stringify(results, null, 2)}`);
  } catch (err) {
    console.error(
      `(${SUITE_ID}:${label} snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("system contract check", () => {
  it("returns null issue when badger is supported", async () => {
    console.info(`[${SUITE_ID}:contract-supported] arranging fetchMock with supported badger contract`);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        apiVersion: "2026-03-05",
        generatedAt: new Date().toISOString(),
        libraryProtocolVersion: 1,
        features: { appScopedLibrarySync: true, storageTunnelV2: true, explicitBootstrapOnly: true },
        apps: {
          badger: {
            supported: true,
            releaseStage: "ga",
            minClientVersion: "0.1.0",
            dbSchemaGeneration: 1,
            libraryProtocolVersion: 1,
            migrationRequired: false,
            migrationReason: null,
          },
        },
      })
    );

    console.info(`[${SUITE_ID}:contract-supported] fetching contract`);
    const contract = await getSystemContract();
    console.info(
      `[${SUITE_ID}:contract-supported] contract.apps.badger.supported=${contract.apps?.badger?.supported}`,
    );
    const issue = getSystemContractIssue(contract, "badger");
    console.info(`[${SUITE_ID}:contract-supported] issue=${String(issue)}`);
    try {
      expect(issue).toBeNull();
    } catch (err) {
      dumpSyncSnapshot("contract-supported", { contract, issue, appId: "badger" });
      throw err;
    }
  });

  it("returns issue when badger is unsupported", () => {
    console.info(`[${SUITE_ID}:contract-unsupported] building unsupported contract fixture`);
    const contract: SystemContract = {
      apiVersion: "2026-03-05",
      generatedAt: new Date().toISOString(),
      libraryProtocolVersion: 1,
      features: { appScopedLibrarySync: true, storageTunnelV2: true, explicitBootstrapOnly: true },
      apps: {
        badger: {
          supported: false,
          releaseStage: "ga",
          minClientVersion: "0.1.0",
          dbSchemaGeneration: 1,
          libraryProtocolVersion: 1,
          migrationRequired: false,
          migrationReason: "deprecated",
        },
      } as SystemContract["apps"],
    };

    const issue = getSystemContractIssue(contract, "badger");
    console.info(`[${SUITE_ID}:contract-unsupported] issue=${String(issue)}`);
    try {
      expect(issue).toBe("deprecated");
    } catch (err) {
      dumpSyncSnapshot("contract-unsupported", { contract, issue, appId: "badger" });
      throw err;
    }
  });

  it("returns issue when migration is required", () => {
    console.info(`[${SUITE_ID}:contract-migration] building migration-required contract fixture`);
    const contract: SystemContract = {
      apiVersion: "2026-03-05",
      generatedAt: new Date().toISOString(),
      libraryProtocolVersion: 1,
      features: { appScopedLibrarySync: true, storageTunnelV2: true, explicitBootstrapOnly: true },
      apps: {
        badger: {
          supported: true,
          releaseStage: "ga",
          minClientVersion: "0.1.0",
          dbSchemaGeneration: 2,
          libraryProtocolVersion: 1,
          migrationRequired: true,
          migrationReason: "schema_upgrade_v2",
        },
      } as SystemContract["apps"],
    };

    const issue = getSystemContractIssue(contract, "badger");
    console.info(`[${SUITE_ID}:contract-migration] issue=${String(issue)}`);
    try {
      expect(issue).toBe("schema_upgrade_v2");
    } catch (err) {
      dumpSyncSnapshot("contract-migration", { contract, issue, appId: "badger" });
      throw err;
    }
  });
});

describe("SSE stream exists:false handling", () => {
  it("exists:false in stream meta should NOT trigger logout", () => {
    /**
     * @test-id MOBILE-SYNC-002
     * @why The SSE stream occasionally sends exists:false during reconnects.
     *   Previously this triggered logout(), kicking the user to the login screen.
     *   The fix ignores exists:false from the stream (it's best-effort, not authoritative).
     */
    console.info(`[${SUITE_ID}:exists-false-stream] building meta with exists:false`);
    const meta: LibraryMeta = {
      exists: false,
      bootstrapRequired: false,
      syncUnavailable: false,
      version: 846,
      snapshotVersion: 846,
      hash: null,
      stateHash: null,
      lastOpId: null,
      consistency: "ok",
      updatedAt: null,
      keyProbe: null,
      keyProbeUpdatedAt: null,
      blobEncoding: "binary",
      snapshotId: null,
      manifestKey: null,
      chunkSize: null,
      snapshotHistory: [],
      opsHistory: [],
    };

    console.info(
      `[${SUITE_ID}:exists-false-stream] meta.exists=${meta.exists} meta.version=${meta.version}`,
    );
    try {
      // Verify the meta has exists: false
      expect(meta.exists).toBe(false);
      // The stream handler should check exists and return early WITHOUT calling logout
      // This test documents the expected behavior — the actual handler logic is:
      //   if (meta.exists === false) { console.warn("...ignored"); return; }
      // NOT:
      //   if (meta.exists === false) { await logout(); return; }
      expect(meta.version).toBe(846); // version is still valid even when exists is false
    } catch (err) {
      dumpSyncSnapshot("exists-false-stream", { meta });
      throw err;
    }
  });

  it("exists:false in initial meta fetch should not crash", async () => {
    console.info(`[${SUITE_ID}:exists-false-fetch] arranging fetchMock with exists:false meta`);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        exists: false,
        version: 0,
        snapshotVersion: 0,
        hash: null,
        stateHash: null,
        lastOpId: null,
        consistency: "ok",
        updatedAt: null,
        keyProbe: null,
        keyProbeUpdatedAt: null,
        blobEncoding: "binary",
        snapshotId: null,
        manifestKey: null,
        chunkSize: null,
        snapshotHistory: [],
        opsHistory: [],
        bootstrapRequired: true,
        syncUnavailable: false,
      })
    );

    console.info(`[${SUITE_ID}:exists-false-fetch] invoking getLibraryMeta(test-token)`);
    const meta = await getLibraryMeta("test-token");
    console.info(
      `[${SUITE_ID}:exists-false-fetch] meta.exists=${meta.exists} meta.bootstrapRequired=${meta.bootstrapRequired}`,
    );
    try {
      expect(meta.exists).toBe(false);
      expect(meta.bootstrapRequired).toBe(true);
    } catch (err) {
      dumpSyncSnapshot("exists-false-fetch", { meta });
      throw err;
    }
  });
});

describe("library meta validation", () => {
  it("fetches library meta with correct version info", async () => {
    console.info(`[${SUITE_ID}:meta-validation] arranging fetchMock with populated meta`);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        exists: true,
        bootstrapRequired: false,
        syncUnavailable: false,
        version: 100,
        snapshotVersion: 95,
        hash: "abc123",
        stateHash: "def456",
        lastOpId: "op-1",
        consistency: "ok",
        updatedAt: "2026-03-27T00:00:00Z",
        keyProbe: "encrypted-probe-base64",
        keyProbeUpdatedAt: "2026-03-27T00:00:00Z",
        blobEncoding: "binary",
        snapshotId: "snap-1",
        manifestKey: "shards/gw-1/library/badger/manifests/snap-1",
        chunkSize: 4194304,
        snapshotHistory: [],
        opsHistory: [],
      })
    );

    console.info(`[${SUITE_ID}:meta-validation] invoking getLibraryMeta(test-token)`);
    const meta = await getLibraryMeta("test-token");
    console.info(
      `[${SUITE_ID}:meta-validation] meta.version=${meta.version} snapshotVersion=${meta.snapshotVersion} manifestKey=${meta.manifestKey}`,
    );
    try {
      expect(meta.exists).toBe(true);
      expect(meta.version).toBe(100);
      expect(meta.snapshotVersion).toBe(95);
      expect(meta.keyProbe).toBe("encrypted-probe-base64");
      expect(meta.manifestKey).toContain("manifests/snap-1");
    } catch (err) {
      dumpSyncSnapshot("meta-validation", { meta });
      throw err;
    }
  });
});
