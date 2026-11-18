/**
 * @bugfix replan-retranscode-missing-user-id
 * @regression-proof
 *
 * Post-ingest replan_qualities resolves the calling user via
 * `getActiveIngestUserId()` (modules/index.ts wires it as the handler's
 * resolveActiveUserId). That returned ONLY `activeIngestUserId`, which is set
 * during an ingest session and cleared after — so on a sync-populated library
 * (no ingest ever opened) it returned null, the format job was stamped with an
 * empty userId, and the retranscode step failed with
 * STEP_RETRANSCODE_MISSING_USER_ID.
 *
 * Fix: store the auth-attached user (`backendUserId`, set by onKeySet via
 * `setBackendUserId`) and fall back to it — mirroring how
 * `getActiveIngestToken()` already falls back to `backendToken`.
 *
 * Pre-fix: getActiveIngestUserId() === null after setBackendUserId.
 * Post-fix: it returns the auth-attached user.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import { runtimeJobsStore } from "../src/core/jobs/store";

const createModule = () => {
  runtimeJobsStore.reset({ clearPersistence: true });
  return new BadgerModule({
    processMediaJob: vi.fn(async () => ({
      produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
      encoder: "cpu" as const,
    })),
  });
};

let mod: BadgerModule | null = null;

afterEach(() => {
  try {
    mod?.shutdown();
  } catch {
    // ignore teardown errors
  }
  mod = null;
});

describe("@bugfix @regression-proof BadgerModule.getActiveIngestUserId — auth-attached fallback", () => {
  it("returns null with no ingest session and no auth-attached user", () => {
    mod = createModule();
    console.info(`[active-user-fallback] no-user case → ${JSON.stringify(mod.getActiveIngestUserId())}`);
    expect(mod.getActiveIngestUserId()).toBeNull();
  });

  it("falls back to the auth-attached backendUserId when no ingest session is active", () => {
    mod = createModule();
    mod.setBackendUserId("user-abc");
    const resolved = mod.getActiveIngestUserId();
    console.info(`[active-user-fallback] fallback case → ${JSON.stringify(resolved)} (expect "user-abc")`);
    // Pre-fix: null → replan stamps "" → STEP_RETRANSCODE_MISSING_USER_ID.
    expect(resolved).toBe("user-abc");
  });

  it("normalizes empty / whitespace-only backendUserId to null", () => {
    mod = createModule();
    mod.setBackendUserId("   ");
    console.info(`[active-user-fallback] whitespace case → ${JSON.stringify(mod.getActiveIngestUserId())}`);
    expect(mod.getActiveIngestUserId()).toBeNull();
  });
});
