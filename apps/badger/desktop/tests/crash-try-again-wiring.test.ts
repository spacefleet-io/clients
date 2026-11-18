/**
 * @req UX-CRASH-01[badger-desktop] @bugfix @regression-proof
 * Chris 2026-11-12 (chat): "Retry never works". The crash notice's "Try again" mounted the screen anew on the same
 * library data, so a screen that crashed on that data crashed again at once. The screen guard now reloads the library
 * first (`onRetry`) and waits for that load before mounting the screen anew (`RenderBoundary` awaits the promise).
 *
 * Source-read, like `authenticated-app-source.test.ts`: mounting AuthenticatedApp needs the whole auth, library and
 * runtime stack. The guard's own behaviour is covered in `packages/ui/tests/render-boundary-try-again.test.tsx`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => {
  const abs = path.resolve(import.meta.dirname, "../src/renderer/src", rel);
  const source = readFileSync(abs, "utf8");
  console.info(`[crash-try-again-wiring] read ${rel} (${source.length} chars)`);
  return source;
};

describe("Badger desktop crash notice: Try again reloads the library first", () => {
  it("the route guard's onRetry returns the library reload, so the screen mounts on fresh data", () => {
    const source = read("AuthenticatedApp.tsx");
    const guard = source.slice(source.indexOf("name={`route:${location.pathname}`}"));
    const onRetry = guard.slice(guard.indexOf("onRetry={"), guard.indexOf(">\n"));
    console.info(`[crash-try-again-wiring] route guard onRetry: ${onRetry.replace(/\s+/g, " ")}`);
    expect(source).toContain("const { reload: reloadLibrary } = useLibraryActions();");
    expect(onRetry).toContain("return reloadLibrary();");
  });

  it("LibraryProvider.reload resolves once the load it starts has settled", () => {
    const source = read("lib/libraryContext.tsx");
    expect(source).toContain("reload: () => Promise<void>;");
    expect(source).toMatch(/const reload = useCallback\(\(\) => \{\s*const \{ promise, resolve \} = Promise\.withResolvers<void>\(\);\s*reloadWaitersRef\.current\.push\(resolve\);/);
    const effect = source.slice(source.indexOf("const waiters = reloadWaitersRef.current.splice(0);"));
    console.info(`[crash-try-again-wiring] load effect: ${effect.slice(0, 220).replace(/\s+/g, " ")}`);
    expect(effect).toMatch(/^const waiters = reloadWaitersRef\.current\.splice\(0\);\s*void load\(\)\s*\.catch\(\(\) => undefined\)\s*\.finally\(\(\) => \{\s*for \(const resolve of waiters\) resolve\(\);/);
  });
});
