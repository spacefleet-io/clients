/**
 * @bugfix
 * @regression-proof
 *
 * Library-key/queue-open race regression.
 *
 * Background: at runtime startup (apps/runtime/src/runtime.ts:14-21), persisted
 * keys are re-applied via `onKeySet` BEFORE any client has connected. That
 * calls `badgerModule.setLibraryKey(masterKeyBase64)`, which used to iterate
 * `this.ingestUsers.values()` and mutate per-user config. At startup that map
 * is empty — so the key was silently lost.
 *
 * Symptom: every chunk upload threw `media_key_missing` because
 * `state.config.libraryKeyBase64` stayed `null`. With CPU transcoding (hours)
 * the user typically re-authenticated mid-job, hiding it. With VAAPI (minutes)
 * the race fired on every fresh-restart ingest. See investigation in plan
 * lively-goose.md.
 *
 * Fix (apps/runtime/src/modules/badger.ts):
 *   1. `setLibraryKey` now caches the key at module level (`cachedLibraryKey`).
 *   2. `openIngestQueue` seeds new `IngestUserState.config.libraryKeyBase64`
 *      from that cache, so the V1 ingest path (which reads `state.config…`
 *      directly at badger.ts:1881) picks it up.
 *   3. `getActiveLibraryKey` falls back to the cache when the active user
 *      state has no key, so the V2 deps-adapter path (which reads via the
 *      `resolveLibraryKey` injectable) also picks it up.
 *
 * Each test below pins ONE link in that chain. If any future refactor breaks
 * either: setLibraryKey caching, openIngestQueue seeding, or getActiveLibraryKey
 * fallback — exactly one assertion fires and points at the regression.
 */

import { describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import { runtimeJobsStore } from "../src/core/jobs/store";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");
const SECOND_KEY = Buffer.alloc(32, 11).toString("base64");

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps key state + active user observation on
// assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpKeyRaceSnapshot = (
  label: string,
  ctx: {
    expectedKey?: string | null;
    activeKey?: string | null;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [library-key-race:${label}] snapshot ===`);
    if (ctx.expectedKey !== undefined) console.error(`expectedKey=${ctx.expectedKey ?? "null"}`);
    if (ctx.activeKey !== undefined) console.error(`activeKey=${ctx.activeKey ?? "null"}`);
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const createModule = () => {
  console.info(`[library-key-race:setup] resetting runtimeJobsStore + creating BadgerModule`);
  runtimeJobsStore.reset({ clearPersistence: true });
  return new BadgerModule({
    processMediaJob: vi.fn(async () => ({
      produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
      encoder: "cpu" as const,
    })),
  });
};

const openQueueWithoutKey = async (module: BadgerModule, userId: string) => {
  await module.execute({
    requestId: `open-${userId}`,
    module: "badger",
    command: "badger.ingest.open",
    payload: {
      userId,
      // CRITICAL: deliberately omit libraryKeyBase64 to reproduce the
      // production scenario where the desktop's open_queue command doesn't
      // carry the key. The cache must fill the gap.
      config: {
        enableCodecSelection: false,
        transcodeOutputs: [{ quality: "360p", codec: "h264" }],
        uiLanguage: "en",
        token: "test-token",
      },
    },
  });
};

describe("BadgerModule library-key/queue-open race", () => {
  it("setLibraryKey caches the key for ingest users that don't exist yet", () => {
    console.info(`[library-key-race:cache-before-users] setLibraryKey before any ingest user exists`);
    // Pre-fix behavior: the for-loop in setLibraryKey iterated an empty Map
    // and the key was lost. Pinning the cache here makes the loss impossible.
    const module = createModule();
    const baseline = module.getActiveLibraryKey();
    console.info(`[library-key-race:cache-before-users] baseline activeKey=${baseline ?? "null"}`);

    module.setLibraryKey(VALID_KEY);
    const afterSet = module.getActiveLibraryKey();
    console.info(`[library-key-race:cache-before-users] after-setLibraryKey activeKey-len=${afterSet?.length ?? 0}`);
    try {
      expect(baseline).toBeNull(); // baseline: no key
      // No ingest user exists yet, so there's no "active" user state. Without
      // the module-level cache, getActiveLibraryKey would return null — even
      // though setLibraryKey just received a valid key.
      expect(afterSet).toBe(VALID_KEY);
    } catch (err) {
      dumpKeyRaceSnapshot("cache-before-users-failure", {
        expectedKey: VALID_KEY,
        activeKey: afterSet,
        extra: { baseline },
      });
      throw err;
    }
  });

  it("openIngestQueue seeds new IngestUserState from the cached key", async () => {
    console.info(`[library-key-race:open-seeds-from-cache] setLibraryKey before openIngestQueue (no key in payload)`);
    // Pre-fix: opening the queue AFTER setLibraryKey created a user with
    // libraryKeyBase64=null because the openIngestQueue spread used
    // DEFAULT_INGEST_CONFIG (null) and the payload didn't override.
    const module = createModule();
    module.setLibraryKey(VALID_KEY);
    await openQueueWithoutKey(module, "race-user-a");

    const activeKey = module.getActiveLibraryKey();
    console.info(`[library-key-race:open-seeds-from-cache] active-key-len=${activeKey?.length ?? 0}`);
    try {
      // After opening, the user's config must carry the cached key — this is
      // what the V1 ingest path reads at badger.ts:1881
      // (state.config.libraryKeyBase64), which never goes through
      // getActiveLibraryKey.
      expect(activeKey).toBe(VALID_KEY);
    } catch (err) {
      dumpKeyRaceSnapshot("open-seeds-from-cache-failure", {
        expectedKey: VALID_KEY,
        activeKey,
      });
      throw err;
    }
  });

  it("setLibraryKey AFTER openIngestQueue still propagates (preserves prior behavior)", async () => {
    console.info(`[library-key-race:set-after-open] openIngestQueue first, then setLibraryKey`);
    // Belt-and-braces: the original for-loop path must continue working when
    // the order is keys-after-queue. We're adding a cache, not replacing the
    // existing propagation.
    const module = createModule();
    await openQueueWithoutKey(module, "race-user-b");
    const baseline = module.getActiveLibraryKey();
    console.info(`[library-key-race:set-after-open] baseline-activeKey=${baseline ?? "null"}`);

    module.setLibraryKey(VALID_KEY);
    const afterSet = module.getActiveLibraryKey();
    console.info(`[library-key-race:set-after-open] after-setLibraryKey activeKey-len=${afterSet?.length ?? 0}`);
    try {
      expect(baseline).toBeNull();
      expect(afterSet).toBe(VALID_KEY);
    } catch (err) {
      dumpKeyRaceSnapshot("set-after-open-failure", {
        expectedKey: VALID_KEY,
        activeKey: afterSet,
        extra: { baseline },
      });
      throw err;
    }
  });

  it("explicit key in openIngestQueue payload wins over the cache", async () => {
    console.info(`[library-key-race:explicit-payload-wins] setLibraryKey(VALID), then openIngestQueue with explicit SECOND_KEY`);
    // Defensive: if the desktop ever DOES send a key in the open payload, it
    // must win. The cache is a default, not an override.
    const module = createModule();
    module.setLibraryKey(VALID_KEY);
    await module.execute({
      requestId: "open-explicit",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "race-user-c",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "360p", codec: "h264" }],
          uiLanguage: "en",
          token: "test-token",
          libraryKeyBase64: SECOND_KEY,
        },
      },
    });

    const activeKey = module.getActiveLibraryKey();
    console.info(`[library-key-race:explicit-payload-wins] activeKey-matches-second=${activeKey === SECOND_KEY}`);
    try {
      expect(activeKey).toBe(SECOND_KEY);
    } catch (err) {
      dumpKeyRaceSnapshot("explicit-payload-wins-failure", {
        expectedKey: SECOND_KEY,
        activeKey,
      });
      throw err;
    }
  });

  it("re-keying after a previous setLibraryKey replaces the cache", async () => {
    console.info(`[library-key-race:rekey-replaces-cache] setLibraryKey(VALID) then setLibraryKey(SECOND), then openIngestQueue`);
    // Key rotation: a second setLibraryKey must overwrite the cache so future
    // openIngestQueue calls and getActiveLibraryKey fallbacks see the latest.
    const module = createModule();
    module.setLibraryKey(VALID_KEY);
    module.setLibraryKey(SECOND_KEY);
    await openQueueWithoutKey(module, "race-user-d");

    const activeKey = module.getActiveLibraryKey();
    console.info(`[library-key-race:rekey-replaces-cache] activeKey-matches-second=${activeKey === SECOND_KEY}`);
    try {
      expect(activeKey).toBe(SECOND_KEY);
    } catch (err) {
      dumpKeyRaceSnapshot("rekey-replaces-cache-failure", {
        expectedKey: SECOND_KEY,
        activeKey,
      });
      throw err;
    }
  });
});
