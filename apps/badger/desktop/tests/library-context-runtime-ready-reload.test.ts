/**
 * @test-id LIBRARY-RUNTIME-READY-RELOAD-001
 * @bugfix
 * @regression-proof
 * @level unit
 * @why Ultimate stress finding F5 (issue #25, runs 2026-10-05T00-45-33 and
 *      01-29-49): the app was relaunched while the previous runtime was still
 *      dying, so the renderer's one-shot library open failed with ECONNREFUSED.
 *      The guardian later brought the runtime back, but nothing re-ran the
 *      renderer's `load()`: the library stayed on "Could not load your library
 *      database." / LIBRARY_DB_NOT_READY for the whole session. Pre-fix
 *      `shouldReloadLibraryAfterRuntimeReady` and the effect that calls it do
 *      not exist.
 * @covers apps/badger/desktop/src/renderer/src/lib/libraryContext.tsx
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldReloadLibraryAfterRuntimeReady } from "../src/renderer/src/lib/libraryContext";

const LOAD_FAILED = "Could not load your library database.";

const dump = (label: string, value: unknown) => {
  try {
    console.error(`=== [library-context-runtime-ready-reload:${label}] snapshot ===`);
    console.error(JSON.stringify(value, null, 2));
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("[@bugfix][@regression-proof] reload the library when the runtime becomes ready and the open had failed", () => {
  const base = { previousInstanceId: 1, instanceId: 2, hasDb: false, error: LOAD_FAILED, userId: "u1" };

  it("reloads on a ready transition while the library is not open and load failed", () => {
    console.info(`[library-context-runtime-ready-reload:reload] input=${JSON.stringify(base)}`);
    expect(shouldReloadLibraryAfterRuntimeReady(base)).toBe(true);
  });

  it("also reloads when the first ready (0 -> 1) arrives after load already failed", () => {
    expect(shouldReloadLibraryAfterRuntimeReady({ ...base, previousInstanceId: 0, instanceId: 1 })).toBe(true);
  });

  it("does NOT reload on the normal boot-time 0 -> 1 transition while load is still in flight (no error yet)", () => {
    expect(shouldReloadLibraryAfterRuntimeReady({ ...base, previousInstanceId: 0, instanceId: 1, error: null })).toBe(false);
  });

  it("leaves an open library alone (main re-opens the runtime-side DB itself)", () => {
    expect(shouldReloadLibraryAfterRuntimeReady({ ...base, hasDb: true })).toBe(false);
  });

  it("does nothing when the instance id did not change (no reload loop on re-render)", () => {
    expect(shouldReloadLibraryAfterRuntimeReady({ ...base, previousInstanceId: 2, instanceId: 2 })).toBe(false);
  });

  it("does nothing without a signed-in user or before any ready", () => {
    expect(shouldReloadLibraryAfterRuntimeReady({ ...base, userId: null })).toBe(false);
    expect(shouldReloadLibraryAfterRuntimeReady({ ...base, previousInstanceId: 0, instanceId: 0 })).toBe(false);
  });

  it("LibraryProvider wires the helper to reload() keyed on the runtime instance id", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/renderer/src/lib/libraryContext.tsx", import.meta.url)),
      "utf8",
    );
    const idx = src.indexOf("lastSeenRuntimeInstanceIdRef");
    const region = src.slice(idx, idx + 1400);
    const checks = {
      found: idx > -1,
      callsHelper: region.includes("shouldReloadLibraryAfterRuntimeReady("),
      callsReload: region.includes("reload();"),
      keyedOnInstanceId: region.includes("[runtimeInstanceId, db, error, user?.id, reload]"),
    };
    console.info(`[library-context-runtime-ready-reload:wiring] checks=${JSON.stringify(checks)}`);
    try {
      expect(checks).toEqual({ found: true, callsHelper: true, callsReload: true, keyedOnInstanceId: true });
    } catch (err) {
      dump("wiring", { checks, region });
      throw err;
    }
  });
});
