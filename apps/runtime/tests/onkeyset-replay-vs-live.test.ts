/**
 * @bugfix all-newly-added-jobs-cuddly-cookie
 * @regression-proof
 *
 * Bug A from the plan file. Startup-replay over `runtime_keys.json`
 * previously called `onKeySet(userId, key)` for EACH persisted entry, and
 * `onKeySet` then called `badgerModule.setBackendUserId(userId)` for every
 * one. Last-write-wins, so a leftover E2E fixture entry (the literal
 * "e2e-fmt-too-new-user" from `library-format-too-new-gate.e2e.test.ts`)
 * would silently become the `backendUserId` whenever it sat last in the
 * persisted JSON. Post-ingest replan jobs then resolved that fixture user
 * via `getActiveIngestUserId()` fallback, stamped it onto the format job
 * payload, and the retranscode step rejected with
 * `STEP_RETRANSCODE_AUTH_NOT_READY: no backend token for userId=e2e-fmt-too-new-user`.
 *
 * Fix: `onKeySet` now takes a `source: "replay" | "live"` parameter.
 * Replay applies library keys (per-user storage) but does NOT stamp
 * `backendUserId`, leaving it `null` until the authenticated desktop calls
 * `/runtime/keys/set` and pins it to the real user.
 *
 * Pre-fix: backendUserId == last entry in persisted store after replay.
 * Post-fix: backendUserId == null after replay; only the live keys/set pins it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import {
  onKeySet,
  resetModulesForTests,
  setBadgerModuleForTests,
} from "../src/modules";
import { runtimeJobsStore } from "../src/core/jobs/store";

const VALID_KEY_BASE64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const REAL_USER = "b4a1a5c7-851e-4993-aac4-a213e7112e08";
const IDLE_FIXTURE = "idle-ipc-user-1";
const FORMAT_TOO_NEW_FIXTURE = "e2e-fmt-too-new-user";

let mod: BadgerModule | null = null;

// On assertion failure, dump the module's resolved identity state so the
// reason a backendUserId did/didn't stamp is visible offline (per the
// "Tests log generously" rule: tests must self-diagnose).
const dumpOnKeySetSnapshot = (label: string) => {
  try {
    console.error(`=== [onkeyset-replay-vs-live:${label}] snapshot ===`);
    if (!mod) {
      console.error("module: (null — not installed)");
      return;
    }
    console.error(
      `activeIngestUserId=${JSON.stringify(mod.getActiveIngestUserId())}`,
    );
    console.error(
      `activeIngestToken=${JSON.stringify(mod.getActiveIngestToken())}`,
    );
    console.error(
      `fixtures: REAL_USER=${JSON.stringify(REAL_USER)} IDLE=${JSON.stringify(IDLE_FIXTURE)} TOO_NEW=${JSON.stringify(FORMAT_TOO_NEW_FIXTURE)}`,
    );
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

const installFreshModule = () => {
  console.info("[onkeyset-replay-vs-live:setup] resetting jobs store + installing fresh BadgerModule");
  runtimeJobsStore.reset({ clearPersistence: true });
  mod = new BadgerModule({
    processMediaJob: vi.fn(async () => ({
      produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
      encoder: "cpu" as const,
    })),
  });
  setBadgerModuleForTests(mod);
  console.info("[onkeyset-replay-vs-live:setup] module installed; initial activeIngestUserId=", JSON.stringify(mod.getActiveIngestUserId()));
};

beforeEach(() => {
  installFreshModule();
});

afterEach(() => {
  console.info("[onkeyset-replay-vs-live:teardown] shutting down module + restoring singleton");
  try {
    mod?.shutdown();
  } catch (err) {
    // ignore teardown errors
    console.error("[onkeyset-replay-vs-live:teardown] shutdown error (ignored):", err instanceof Error ? err.message : String(err));
  }
  mod = null;
  // Restore the singleton so other test files see a clean module — without
  // this, modifying state via setBadgerModuleForTests can leak into the
  // next file's run if vitest does not reset between suites.
  resetModulesForTests();
});

describe("@bugfix @regression-proof onKeySet — replay vs live source distinction", () => {
  it("replay source does NOT stamp backendUserId", () => {
    console.info("[onkeyset-replay-vs-live:single-replay] replaying REAL_USER with source=replay");
    onKeySet(REAL_USER, VALID_KEY_BASE64, undefined, "replay");
    const resolved = mod!.getActiveIngestUserId();
    console.info(
      "[onkeyset-replay-vs-live:single-replay] backendUserId:",
      JSON.stringify(resolved),
    );
    if (resolved !== null) dumpOnKeySetSnapshot("single-replay-unexpected-stamp");
    expect(resolved).toBeNull();
  });

  it("replay across multiple persisted entries does NOT stamp backendUserId from the last one", () => {
    // Reproduces the production bug: runtime_keys.json on disk had three
    // entries — the real user, a stale idle fixture, and a stale "too-new"
    // E2E fixture (last). Pre-fix the last call wins; post-fix none stamp.
    console.info("[onkeyset-replay-vs-live:multi-replay] replaying REAL_USER, IDLE_FIXTURE, FORMAT_TOO_NEW_FIXTURE (all source=replay)");
    onKeySet(REAL_USER, VALID_KEY_BASE64, undefined, "replay");
    onKeySet(IDLE_FIXTURE, VALID_KEY_BASE64, undefined, "replay");
    onKeySet(FORMAT_TOO_NEW_FIXTURE, VALID_KEY_BASE64, undefined, "replay");
    const resolved = mod!.getActiveIngestUserId();
    console.info(
      "[onkeyset-replay-vs-live:multi-replay] backendUserId:",
      JSON.stringify(resolved),
      "(must not be a fixture)",
    );
    if (resolved !== null) dumpOnKeySetSnapshot("multi-replay-unexpected-stamp");
    expect(resolved).toBeNull();
  });

  it("live source stamps backendUserId so the post-ingest fallback resolves it", () => {
    console.info("[onkeyset-replay-vs-live:live] setting REAL_USER with source=live");
    onKeySet(REAL_USER, VALID_KEY_BASE64, undefined, "live");
    const resolved = mod!.getActiveIngestUserId();
    console.info("[onkeyset-replay-vs-live:live] backendUserId:", JSON.stringify(resolved));
    if (resolved !== REAL_USER) dumpOnKeySetSnapshot("live-userid-mismatch");
    expect(resolved).toBe(REAL_USER);
  });

  it("live source stamps backendToken when one is supplied", () => {
    console.info("[onkeyset-replay-vs-live:live-token] setting REAL_USER + bearer with source=live");
    onKeySet(REAL_USER, VALID_KEY_BASE64, "real-bearer-xyz", "live");
    const resolved = mod!.getActiveIngestToken();
    console.info(
      "[onkeyset-replay-vs-live:live-token] backendToken:",
      JSON.stringify(resolved),
    );
    if (resolved !== "real-bearer-xyz" || mod!.getActiveIngestUserId() !== REAL_USER) {
      dumpOnKeySetSnapshot("live-token-mismatch");
    }
    expect(resolved).toBe("real-bearer-xyz");
    expect(mod!.getActiveIngestUserId()).toBe(REAL_USER);
  });

  it("replay-then-live mirrors production startup → first keys/set: live wins", () => {
    // The realistic production sequence: persisted keys are replayed at
    // boot, then the authenticated desktop POSTs /runtime/keys/set which
    // calls onKeySet with source="live". The live call must overwrite
    // whatever the replay left behind (which post-fix should be null
    // anyway, but this test pins the contract).
    console.info("[onkeyset-replay-vs-live:replay-then-live] replaying 3 entries, then live keys/set for REAL_USER + bearer-from-session");
    onKeySet(REAL_USER, VALID_KEY_BASE64, undefined, "replay");
    onKeySet(IDLE_FIXTURE, VALID_KEY_BASE64, undefined, "replay");
    onKeySet(FORMAT_TOO_NEW_FIXTURE, VALID_KEY_BASE64, undefined, "replay");
    onKeySet(REAL_USER, VALID_KEY_BASE64, "bearer-from-session", "live");
    const resolvedUser = mod!.getActiveIngestUserId();
    const resolvedToken = mod!.getActiveIngestToken();
    console.info(
      "[onkeyset-replay-vs-live:replay-then-live] resolved:",
      JSON.stringify({ user: resolvedUser, token: resolvedToken }),
    );
    if (resolvedUser !== REAL_USER || resolvedToken !== "bearer-from-session") {
      dumpOnKeySetSnapshot("replay-then-live-mismatch");
    }
    expect(resolvedUser).toBe(REAL_USER);
    expect(resolvedToken).toBe("bearer-from-session");
  });

  it("default source argument is treated as live (backwards compatibility)", () => {
    // The signature was extended with a defaulted parameter so the
    // existing /runtime/keys/set call site keeps working without a
    // simultaneous edit. Pin that default explicitly.
    console.info("[onkeyset-replay-vs-live:default-source] calling onKeySet with no source arg (should default to live)");
    onKeySet(REAL_USER, VALID_KEY_BASE64);
    const resolved = mod!.getActiveIngestUserId();
    console.info("[onkeyset-replay-vs-live:default-source] backendUserId:", JSON.stringify(resolved));
    if (resolved !== REAL_USER) dumpOnKeySetSnapshot("default-source-mismatch");
    expect(resolved).toBe(REAL_USER);
  });
});
