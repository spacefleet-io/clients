/**
 * @req UX-CRASH-01[parrot] @bugfix @regression-proof
 * Chris 2026-11-12 (chat): "Retry never works". The crash notice's "Try again" mounted the part anew on the same data,
 * so a part that crashed on that data crashed again at once. Each Parrot guard now reads its data afresh first
 * (`onRetry`); `RenderBoundary` waits for the returned promise before mounting the part anew.
 *
 * Source-read: mounting App or Library needs the whole `window.parrot` bridge. The guard's own behaviour is covered in
 * `packages/ui/tests/render-boundary-try-again.test.tsx`.
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

describe("Parrot desktop crash notice: Try again reads the data afresh first", () => {
  it("the screen guard re-reads the app state from main", () => {
    const source = read("App.tsx");
    expect(source).toContain('<RenderBoundary name={`screen:${screen}`} resetKey={screen} className="m-8" onRetry={refresh}>');
  });

  it("the library list and route guards reload the library", () => {
    const source = read("Library.tsx");
    const guards = (source.match(/<RenderBoundary name=\{`(?:library-list|route):.*$/gm) ?? []).map((line) => line.trim());
    console.info(`[crash-try-again-wiring] Library.tsx guards: ${JSON.stringify(guards)}`);
    expect(guards).toEqual([
      "<RenderBoundary name={`library-list:${view}`} resetKey={view} onRetry={() => load(true)}>",
      "<RenderBoundary name={`route:${route.kind}`} resetKey={route} onRetry={() => load(true)}>",
    ]);
  });
});
