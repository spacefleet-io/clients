// @bugfix @regression-proof
//
// Repro for "media_key_missing at extract step": apps/runtime/src/modules/
// badgerIngest.ts encryptMediaObject reads the library master key via
// parseLibraryKey(); when null it throws "media_key_missing". The desktop
// only forwarded the key to the runtime from the FIRST-time onboarding
// path (pages/OnboardingKey.tsx:78). Returning users with a saved session
// loaded the library locally via the libraryContext load path but never
// re-fired forwardKeyToRuntime, so the runtime view of the key was empty.
//
// Fix: libraryContext.tsx's `syncMediaKey` callback now forwards the
// non-null master key to BOTH the local main process (setMediaKey) and
// the runtime (forwardKeyToRuntime) on every key change. Since
// syncMediaKey is invoked from every library-open path and from
// logout/reset, this covers cold-boot returning user, OnboardingKey
// first-time, login-after-logout, and key-rotation.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(path.resolve(desktopRoot, rel), "utf8");

// Dump-on-failure: this suite scans the syncMediaKey region of
// libraryContext.tsx for required symbols. On failure, print the located index
// and the extracted source tail so a refactor that moved/renamed the callback
// is diagnosable offline without re-reading the file by hand.
const dumpKeyForwardSnapshot = (
  label: string,
  ctx: { idx: number; tail: string; checks: Record<string, boolean> },
) => {
  try {
    console.error(`=== [library-key-forward-on-load:${label}] snapshot ===`);
    console.error(`syncMediaKey index in source=${ctx.idx}`);
    console.error(`symbol checks=${JSON.stringify(ctx.checks, null, 2)}`);
    console.error(`extracted tail:\n${ctx.tail}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("[@bugfix][@regression-proof] library master key forwarded to runtime on every load", () => {
  it("syncMediaKey in libraryContext forwards non-null keys to forwardKeyToRuntime with the active userId", () => {
    console.info(`[library-key-forward-on-load:forward-non-null] scanning syncMediaKey region of libraryContext.tsx`);
    const src = read("renderer/src/lib/libraryContext.tsx");
    const idx = src.indexOf("const syncMediaKey = useCallback");
    const tail = src.slice(idx, idx + 800);
    const checks = {
      hasSetMediaKey: tail.includes("setMediaKey"),
      hasForwardKeyToRuntime: tail.includes("forwardKeyToRuntime"),
      hasTruthyGuard: tail.includes("if (key && ") || tail.includes("if (key &&"),
    };
    console.info(
      `[library-key-forward-on-load:forward-non-null] idx=${idx} checks=${JSON.stringify(checks)}`,
    );
    try {
      expect(idx, "syncMediaKey callback must exist").toBeGreaterThan(-1);

      expect(
        tail.includes("setMediaKey"),
        "must keep the existing local main-process forward (setMediaKey)"
      ).toBe(true);
      expect(
        tail.includes("forwardKeyToRuntime"),
        "must forward the master key to the runtime via window.sf.forwardKeyToRuntime"
      ).toBe(true);
      // Guard against `null`-forwarding regressions: we never want to send
      // a logout/reset clear to the runtime as a forward (only the desktop
      // main needs the null clear).
      expect(
        tail.includes("if (key && ") || tail.includes("if (key &&"),
        "must guard the runtime forward with a truthy-key check (no null forwards)"
      ).toBe(true);
    } catch (err) {
      dumpKeyForwardSnapshot("forward-non-null", { idx, tail, checks });
      throw err;
    }
  });

  it("syncMediaKey logs forwardKeyToRuntime failures so the next regression is visible", () => {
    console.info(`[library-key-forward-on-load:logs-failures] scanning syncMediaKey region for error logging`);
    const src = read("renderer/src/lib/libraryContext.tsx");
    const idx = src.indexOf("const syncMediaKey = useCallback");
    const tail = src.slice(idx, idx + 1200);
    const checks = {
      hasErrorLog: tail.includes("libraryContextLog.error"),
      hasFailureMessage: tail.includes("forwardKeyToRuntime failed"),
    };
    console.info(
      `[library-key-forward-on-load:logs-failures] idx=${idx} checks=${JSON.stringify(checks)}`,
    );
    try {
      expect(idx).toBeGreaterThan(-1);
      expect(
        tail.includes("libraryContextLog.error") &&
          tail.includes("forwardKeyToRuntime failed"),
        "failures must surface via libraryContextLog.error so a future broken IPC is visible in pino logs",
      ).toBe(true);
    } catch (err) {
      dumpKeyForwardSnapshot("logs-failures", { idx, tail, checks });
      throw err;
    }
  });
});
