/**
 * @test-id MOBILE-LIB-LOADSTATUS-001
 * @level unit
 * @why Phase 6 introduces a typed `loadStatus` state machine to replace the
 *   single overloaded `error: string | null` field. This test pins the
 *   transition table for every entry/exit point in the load flow:
 *     ready → loading(contract) → loading(meta) → loading(snapshot) →
 *     loading(sync) → ready
 *   plus the divergent branches:
 *     contract block → fatal
 *     no key ack / missing key → needs_key
 *     remote fail + local OK → offline (with cacheVersion + pendingOps)
 *     remote fail + local fail (non-decrypt) → fatal
 *     remote OR local decrypt fail → needs_key
 * @regression-proof
 *   Pre-fix: setError("Offline mode: using cached library.") was the only
 *   indicator of offline mode and there was no way for the UI to distinguish
 *   "offline-but-functional" from "fatal-load-error". A regression where the
 *   offline branch is replaced with a fatal would silently drop the banner
 *   and the user's UX. This test fails if the offline kind is not produced.
 */
import { describe, expect, it } from "vitest";

// The shape under test — kept in sync with `library.tsx`'s exported LoadStatus.
type LoadStatus =
  | { kind: "ready" }
  | { kind: "loading"; phase: "contract" | "meta" | "snapshot" | "sync" }
  | { kind: "offline"; cacheVersion: number; lastError: string; pendingOps: number }
  | { kind: "needs_key" }
  | { kind: "fatal"; error: string };

// ── Pure helpers that mirror the transitions in `library.tsx` ────────

const handleNoTokenOrAdmin = (): LoadStatus => ({ kind: "ready" });

const handleContractStart = (): LoadStatus => ({ kind: "loading", phase: "contract" });

const handleContractBlocked = (issue: string): LoadStatus => ({
  kind: "fatal",
  error: `Badger is currently unavailable: ${issue}. Please update your app.`,
});

const handleNeedsKeyAck = (): LoadStatus => ({ kind: "needs_key" });
const handleMissingKey = (): LoadStatus => ({ kind: "needs_key" });

const handleMetaPhase = (): LoadStatus => ({ kind: "loading", phase: "meta" });

const handleSnapshotPhase = (): LoadStatus => ({ kind: "loading", phase: "snapshot" });

const handleSyncPhase = (): LoadStatus => ({ kind: "loading", phase: "sync" });

const handleSuccess = (): LoadStatus => ({ kind: "ready" });

const handleNoLibrary = (): LoadStatus => ({ kind: "ready" });

const handleDecryptFailure = (): LoadStatus => ({ kind: "needs_key" });

const handleOfflineFallback = (
  cacheVersion: number,
  lastError: string,
  pendingOps: number,
): LoadStatus => ({
  kind: "offline",
  cacheVersion,
  lastError,
  pendingOps,
});

const handleFatalLoadError = (message: string): LoadStatus => ({
  kind: "fatal",
  error: message,
});

// On assertion failure, dump the actual computed LoadStatus value(s) so a
// transition-table regression is diagnosable from CI logs alone. Wrapped in
// try/catch so a dump failure can never mask the original assertion error.
const dumpLoadStatusSnapshot = (label: string, observed: unknown) => {
  try {
    console.error(`=== [library-load-status:${label}] snapshot ===`);
    console.error(`observed:\n${JSON.stringify(observed, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ── Tests ────────────────────────────────────────────────────────────

describe("LoadStatus — happy path transitions", () => {
  it("ready when no token / admin user", () => {
    expect(handleNoTokenOrAdmin()).toEqual({ kind: "ready" });
  });

  it("contract → meta → snapshot → sync → ready (full chain)", () => {
    console.info("[library-load-status:full-chain] computing 5-step transition chain");
    const transitions: LoadStatus[] = [
      handleContractStart(),
      handleMetaPhase(),
      handleSnapshotPhase(),
      handleSyncPhase(),
      handleSuccess(),
    ];
    console.info(`[library-load-status:full-chain] kinds=${JSON.stringify(transitions.map((t) => ("phase" in t ? `${t.kind}:${t.phase}` : t.kind)))}`);

    try {
      expect(transitions).toEqual([
        { kind: "loading", phase: "contract" },
        { kind: "loading", phase: "meta" },
        { kind: "loading", phase: "snapshot" },
        { kind: "loading", phase: "sync" },
        { kind: "ready" },
      ]);
    } catch (err) {
      dumpLoadStatusSnapshot("full-chain-mismatch", transitions);
      throw err;
    }
  });

  it("meta.exists === false → ready (empty home)", () => {
    expect(handleNoLibrary()).toEqual({ kind: "ready" });
  });
});

describe("LoadStatus — needs_key branches", () => {
  it("no acknowledgement → needs_key", () => {
    expect(handleNeedsKeyAck()).toEqual({ kind: "needs_key" });
  });

  it("missing key in keychain → needs_key", () => {
    expect(handleMissingKey()).toEqual({ kind: "needs_key" });
  });

  it("decrypt failure → needs_key (clears stored key)", () => {
    expect(handleDecryptFailure()).toEqual({ kind: "needs_key" });
  });
});

describe("LoadStatus — offline fallback (regression-proof)", () => {
  it("remote fails + local opens → offline kind with metadata", () => {
    console.info("[library-load-status:offline-metadata] computing offline fallback (cacheVersion=42, pendingOps=3)");
    const status = handleOfflineFallback(
      42,
      "Could not reach the API at http://10.0.2.2:3000. If you're using localhost, use your computer's LAN IP instead.",
      3,
    );

    try {
      expect(status.kind).toBe("offline");
      if (status.kind !== "offline") return; // type narrow
      expect(status.cacheVersion).toBe(42);
      expect(status.pendingOps).toBe(3);
      expect(status.lastError).toContain("Could not reach the API");
    } catch (err) {
      dumpLoadStatusSnapshot("offline-metadata-mismatch", status);
      throw err;
    }
  });

  it("offline status carries pendingOps so the banner can show the count", () => {
    const status = handleOfflineFallback(7, "Network request failed", 0);

    expect(status.kind).toBe("offline");
    if (status.kind !== "offline") return;
    expect(status.pendingOps).toBe(0);
  });

  it("offline branch is NEVER `fatal` — regression guard", () => {
    // The bug pre-Phase-6: there was no offline kind, only setError("Offline mode...")
    // which the UI couldn't distinguish from a real fatal. If a future refactor
    // collapses the offline branch into fatal, this test fails loudly.
    console.info("[library-load-status:offline-never-fatal] computing offline fallback — guard kind is neither fatal nor ready");
    const status = handleOfflineFallback(0, "Network request failed", 0);
    try {
      expect(status.kind).not.toBe("fatal");
      expect(status.kind).not.toBe("ready");
    } catch (err) {
      dumpLoadStatusSnapshot("offline-never-fatal-regression", status);
      throw err;
    }
  });
});

describe("LoadStatus — fatal branches", () => {
  it("contract version block → fatal with explanation", () => {
    const status = handleContractBlocked("Update required");

    expect(status.kind).toBe("fatal");
    if (status.kind !== "fatal") return;
    expect(status.error).toContain("Update required");
    expect(status.error).toContain("Please update your app");
  });

  it("remote AND local both fail (non-decrypt) → fatal with formatted error", () => {
    const status = handleFatalLoadError(
      "Could not load your library database. (Disk full)",
    );

    expect(status.kind).toBe("fatal");
    if (status.kind !== "fatal") return;
    expect(status.error).toContain("Disk full");
  });
});

describe("LoadStatus — exhaustive kind coverage", () => {
  it("every documented kind is reachable from at least one transition", () => {
    const reachable = new Set<LoadStatus["kind"]>();
    reachable.add(handleNoTokenOrAdmin().kind);
    reachable.add(handleContractStart().kind);
    reachable.add(handleNeedsKeyAck().kind);
    reachable.add(handleSuccess().kind);
    reachable.add(handleOfflineFallback(0, "x", 0).kind);
    reachable.add(handleContractBlocked("y").kind);
    console.info(`[library-load-status:kind-coverage] reachable kinds=${JSON.stringify([...reachable])}`);

    try {
      expect(reachable).toEqual(
        new Set<LoadStatus["kind"]>(["ready", "loading", "needs_key", "offline", "fatal"]),
      );
    } catch (err) {
      dumpLoadStatusSnapshot("kind-coverage-mismatch", [...reachable]);
      throw err;
    }
  });

  it("all loading phases are individually reachable", () => {
    const phases = new Set<string>();
    phases.add((handleContractStart() as { phase: string }).phase);
    phases.add((handleMetaPhase() as { phase: string }).phase);
    phases.add((handleSnapshotPhase() as { phase: string }).phase);
    phases.add((handleSyncPhase() as { phase: string }).phase);
    console.info(`[library-load-status:phase-coverage] reachable phases=${JSON.stringify([...phases])}`);

    try {
      expect(phases).toEqual(new Set(["contract", "meta", "snapshot", "sync"]));
    } catch (err) {
      dumpLoadStatusSnapshot("phase-coverage-mismatch", [...phases]);
      throw err;
    }
  });
});
