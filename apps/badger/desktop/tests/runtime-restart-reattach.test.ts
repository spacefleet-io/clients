/**
 * @bugfix all-newly-added-jobs-cuddly-cookie
 * @regression-proof
 *
 * Bug B wiring pin. The behavioural contract of `useRuntimeInstanceId` is
 * pinned in `packages/desktop-shell/tests/use-runtime-instance-id.test.tsx`
 * (counter bumps on each ready transition). This file pins the consumers:
 * the badger-desktop renderer must thread `runtimeInstanceId` into the
 * dependency array of the attach-auth and key-forward effects, and the
 * main process must read the cached bearer instead of the legacy
 * `"desktop-key-forward"` placeholder.
 *
 * Source-grep is the right test layer here: spinning up the full
 * AuthProvider + LibraryProvider stack would require mocking every
 * IPC/library/snapshot/auth path, and the *single* property we need to
 * pin — "the useEffect dep array names runtimeInstanceId" — is exactly
 * the kind of detail TypeScript can erase silently if a reviewer trims
 * the dep array during a future refactor. The grep catches that.
 *
 * Pre-fix: auth.tsx + libraryContext.tsx had no runtimeInstanceId
 *   reference, no import from @space/desktop-shell/services/runtime-status,
 *   and forwardKeyToRuntime hard-coded the placeholder bearer.
 * Post-fix: all three are present.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..", "src");
const read = (rel: string) => {
  const abs = path.resolve(desktopRoot, rel);
  console.info(`[runtime-restart-reattach:read] reading ${abs}`);
  const src = readFileSync(abs, "utf8");
  console.info(`[runtime-restart-reattach:read] loaded ${rel}, length=${src.length} chars`);
  return src;
};

const RUNTIME_STATUS_IMPORT =
  '@space/desktop-shell/services/runtime-status';

// Dump the relevant source slice / computed indices so a source-grep failure
// (a refactor dropped runtimeInstanceId from a dep array, or the bearer wiring
// regressed) is diagnosable offline. Wrapped in try/catch so the dump can't
// mask the real assertion failure.
const dumpReattachSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [runtime-restart-reattach:${label}] snapshot ===`);
    for (const [key, value] of Object.entries(ctx)) {
      if (typeof value === "string" && value.length > 200) {
        console.error(`${key} (len=${value.length}):\n${value}`);
      } else {
        console.error(`${key}=${JSON.stringify(value)}`);
      }
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("[@bugfix][@regression-proof] runtime restart triggers desktop re-attach", () => {
  it("auth.tsx imports useRuntimeInstanceId from desktop-shell", () => {
    console.info("[runtime-restart-reattach:auth-import] checking auth.tsx imports useRuntimeInstanceId");
    const src = read("renderer/src/auth.tsx");
    const hasHook = src.includes("useRuntimeInstanceId");
    const hasImport = src.includes(RUNTIME_STATUS_IMPORT);
    if (!hasHook || !hasImport) {
      dumpReattachSnapshot("auth-import-missing", { hasHook, hasImport, importPath: RUNTIME_STATUS_IMPORT });
    }
    expect(
      hasHook && hasImport,
      "auth.tsx must import useRuntimeInstanceId from @space/desktop-shell/services/runtime-status",
    ).toBe(true);
  });

  it("auth.tsx threads runtimeInstanceId into the attachAuth effect deps", () => {
    console.info("[runtime-restart-reattach:auth-attach] checking attachAuth dep array names runtimeInstanceId");
    const src = read("renderer/src/auth.tsx");
    // Locate the attachAuth call and capture the surrounding dep array.
    const attachIdx = src.indexOf("runtimeJobs?.attachAuth");
    if (attachIdx < 0) dumpReattachSnapshot("auth-attach-not-found", { attachIdx });
    expect(attachIdx).toBeGreaterThanOrEqual(0);
    const window = src.slice(attachIdx, attachIdx + 800);
    if (!window.includes("runtimeInstanceId")) {
      dumpReattachSnapshot("auth-attach-no-dep", { attachIdx, window });
    }
    expect(
      window.includes("runtimeInstanceId"),
      "the attachAuth useEffect dep array must include runtimeInstanceId so it refires on every runtime ready",
    ).toBe(true);
  });

  it("auth.tsx threads runtimeInstanceId into the configureScheduling effect deps", () => {
    console.info("[runtime-restart-reattach:auth-scheduling] checking configureScheduling dep array names runtimeInstanceId");
    const src = read("renderer/src/auth.tsx");
    const idx = src.indexOf("runtimeJobs\n      ?.configureScheduling");
    const fallbackIdx = idx === -1 ? src.indexOf("?.configureScheduling") : idx;
    if (fallbackIdx < 0) dumpReattachSnapshot("auth-scheduling-not-found", { idx, fallbackIdx });
    expect(fallbackIdx).toBeGreaterThanOrEqual(0);
    const window = src.slice(fallbackIdx, fallbackIdx + 800);
    if (!window.includes("runtimeInstanceId")) {
      dumpReattachSnapshot("auth-scheduling-no-dep", { fallbackIdx, window });
    }
    expect(
      window.includes("runtimeInstanceId"),
      "the configureScheduling useEffect dep array must include runtimeInstanceId so the lane caps are re-applied after a restart",
    ).toBe(true);
  });

  it("libraryContext.tsx imports useRuntimeInstanceId and has a refire effect that re-pushes the library key (the runtime keeps it in memory only) @req RT-SEC-05[badger-desktop] @req RT-SEC-04[badger-desktop]", () => {
    console.info("[runtime-restart-reattach:library-ctx] checking libraryContext import + key-reforward effect");
    const src = read("renderer/src/lib/libraryContext.tsx");
    const hasHook = src.includes("useRuntimeInstanceId");
    const hasImport = src.includes(RUNTIME_STATUS_IMPORT);
    if (!hasHook || !hasImport) {
      dumpReattachSnapshot("library-ctx-import-missing", { hasHook, hasImport });
    }
    expect(
      hasHook && hasImport,
      "libraryContext.tsx must import useRuntimeInstanceId",
    ).toBe(true);
    // The new effect must read the stored library key and call
    // syncMediaKey on each ready bump.
    const idx = src.indexOf("re-forwarding library key");
    if (idx < 0) dumpReattachSnapshot("library-ctx-no-reforward-log", { idx });
    expect(
      idx,
      "libraryContext.tsx must have a useEffect that re-forwards the library key on runtime restart (look for the log line 're-forwarding library key after runtime restart')",
    ).toBeGreaterThanOrEqual(0);
    const window = src.slice(idx, idx + 400);
    if (!window.includes("syncMediaKey")) {
      dumpReattachSnapshot("library-ctx-no-syncmediakey", { idx, window });
    }
    expect(
      window.includes("syncMediaKey"),
      "the refire effect must call syncMediaKey so the key reaches both main and runtime",
    ).toBe(true);
  });

  it("runtimeJobsIpc exports a read-only getter for the cached backend bearer", () => {
    console.info("[runtime-restart-reattach:ipc-getter] checking runtimeJobsIpc exports getRuntimeJobsBackendToken");
    const src = read("main/runtimeJobsIpc.ts");
    const hasGetter = src.includes("export const getRuntimeJobsBackendToken");
    if (!hasGetter) dumpReattachSnapshot("ipc-getter-missing", { hasGetter });
    expect(
      hasGetter,
      "runtimeJobsIpc.ts must export getRuntimeJobsBackendToken so forwardKeyToRuntime can use the real bearer instead of the legacy placeholder",
    ).toBe(true);
  });

  it("forwardKeyToRuntime in main reads the cached bearer, not the legacy placeholder", () => {
    console.info("[runtime-restart-reattach:forward-key] checking forwardKeyToRuntime bearer wiring in main/index.ts");
    const src = read("main/index.ts");
    const startIdx = src.indexOf("const forwardKeyToRuntime");
    if (startIdx < 0) dumpReattachSnapshot("forward-key-not-found", { startIdx });
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // Body until the next top-level const/ipcMain or end of file.
    const endIdx = src.indexOf("\nipcMain.handle", startIdx);
    const body = src.slice(startIdx, endIdx === -1 ? startIdx + 1500 : endIdx);
    const usesGetter = body.includes("getRuntimeJobsBackendToken");
    // The placeholder is allowed only as a `??` fallback after the cached
    // bearer is consulted. Pin that the literal value reaches createRuntimeSession
    // via a `cachedBearer ?? ...` form, NOT as a hard-coded backendToken arg.
    const placeholderAsFallback =
      /cachedBearer\s*\?\?\s*"desktop-key-forward"/.test(body) ||
      /getRuntimeJobsBackendToken\(\)\s*\?\?\s*"desktop-key-forward"/.test(body);
    const placeholderAsHardCoded =
      /backendToken:\s*"desktop-key-forward"/.test(body);
    console.info(
      `[runtime-restart-reattach:forward-key] usesGetter=${usesGetter} placeholderAsFallback=${placeholderAsFallback} placeholderAsHardCoded=${placeholderAsHardCoded}`,
    );
    if (!usesGetter || placeholderAsHardCoded || !placeholderAsFallback) {
      dumpReattachSnapshot("forward-key-bearer-wiring", {
        usesGetter,
        placeholderAsFallback,
        placeholderAsHardCoded,
        body,
      });
    }
    expect(
      usesGetter,
      "forwardKeyToRuntime must read getRuntimeJobsBackendToken() so the runtime session login carries the REAL bearer; otherwise badgerModule.backendToken ends up holding the placeholder after a runtime restart and the next API call 401s",
    ).toBe(true);
    expect(
      placeholderAsHardCoded,
      "forwardKeyToRuntime must NOT pass the placeholder as the hard-coded backendToken arg to createRuntimeSession",
    ).toBe(false);
    expect(
      placeholderAsFallback,
      "if the placeholder remains it must be the ?? fallback after the cached bearer is consulted",
    ).toBe(true);
  });
});
