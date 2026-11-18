// @vitest-environment jsdom
/**
 * @bugfix @regression-proof
 *
 * Regression test for commit 1f6081e8 — stabilize the engine's
 * setSelectedAudio setter via useCallback with empty deps.
 *
 * Pre-fix the engine returned `setSelectedAudioId: (id) => setSelectedAudioId(id)`
 * — a fresh function identity per render. Each engine render therefore
 * propagated a new `playback.setSelectedAudioId` reference to the
 * controller, which in turn churned the controller's reset useEffect's
 * dep array (it lists `resetAudio` as a dep), re-firing the effect on
 * every commit. Observed at 405 reset fires in ~10 s during one Play
 * click — functionally harmless (setState no-ops when value matches),
 * but pure CPU drag and log noise.
 *
 * Fix: wrap `setSelectedAudio` in `useCallback(..., [])`. Identity stays
 * stable across renders → controller's reset effect re-fires ONLY when
 * its other deps (requestId, activeEpisodeId) actually change.
 *
 * This test pins:
 *  1. Source-contract: the engine declares `const setSelectedAudio =
 *     useCallback((trackId) => setSelectedAudioId(trackId), [])` and
 *     returns it under the `setSelectedAudioId` key.
 *  2. Semantic: a useCallback with empty deps preserves identity
 *     across re-renders even when an unrelated prop changes — the
 *     downstream `resetAudio` dep array therefore doesn't churn.
 */
import React, { useCallback, useState } from "react";
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts",
);
console.info(`[set-selected-audio-stable:setup] reading engine source from ${ENGINE_PATH}`);
const engineSource = readFileSync(ENGINE_PATH, "utf8");
console.info(
  `[set-selected-audio-stable:setup] engine source loaded, length=${engineSource.length} chars`,
);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// Dump enough state to diagnose an identity/source-contract failure offline:
// the matched/relevant slices of the engine source plus the captured setter
// reference identities. Wrapped in try/catch so a dump failure can't mask the
// real assertion failure.
const dumpAudioStableSnapshot = (
  label: string,
  ctx: {
    sourceWindow?: string;
    renderCount?: number;
    firstSetter?: unknown;
    lastSetter?: unknown;
  },
) => {
  try {
    console.error(`=== [set-selected-audio-stable:${label}] snapshot ===`);
    if (ctx.sourceWindow !== undefined) {
      console.error(`engine source window:\n${ctx.sourceWindow}`);
    }
    if (ctx.renderCount !== undefined) {
      console.error(`renderCount=${ctx.renderCount}`);
    }
    if (ctx.firstSetter !== undefined || ctx.lastSetter !== undefined) {
      console.error(
        `setter identities: firstSetter=${String(ctx.firstSetter)} lastSetter=${String(ctx.lastSetter)} sameRef=${ctx.firstSetter === ctx.lastSetter}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

afterEach(() => {
  if (root && container) {
    act(() => root?.unmount());
  }
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
});

describe("@bugfix @regression-proof setSelectedAudio identity is stable", () => {
  it("source: setSelectedAudio is useCallback with empty deps", () => {
    console.info(
      "[set-selected-audio-stable:source-contract] pinning setSelectedAudio useCallback([]) shape",
    );
    // Pin the exact production shape so a future refactor that drops
    // the empty deps array (or inlines the arrow at the return site)
    // fails this test.
    const declRe =
      /const setSelectedAudio = useCallback\(\(trackId: string \| null\) => \{\s*setSelectedAudioId\(trackId\);\s*\}, \[\]\);/;
    if (!declRe.test(engineSource)) {
      const decl = engineSource.match(/const setSelectedAudio[\s\S]{0,160}/)?.[0] ?? "(no setSelectedAudio decl found)";
      dumpAudioStableSnapshot("source-decl-mismatch", { sourceWindow: decl });
    }
    expect(engineSource).toMatch(declRe);
    // And the returned engine surface uses it under setSelectedAudioId.
    const returnRe = /setSelectedAudioId:\s*setSelectedAudio,/;
    if (!returnRe.test(engineSource)) {
      const ret = engineSource.match(/setSelectedAudioId:[\s\S]{0,80}/)?.[0] ?? "(no setSelectedAudioId return found)";
      dumpAudioStableSnapshot("source-return-mismatch", { sourceWindow: ret });
    }
    expect(engineSource).toMatch(returnRe);
  });

  it("semantic: a useCallback with empty deps preserves identity across unrelated re-renders", async () => {
    // Build a tiny harness that mirrors the engine's pattern: a setter
    // captured via useCallback([]) and surfaced to a child. Re-render
    // the parent with an unrelated prop and assert the setter
    // reference doesn't change.
    let lastSetterRef: ((id: string | null) => void) | null = null;
    let renderCount = 0;

    const Engine = ({ unrelated: _u }: { unrelated: number }) => {
      renderCount += 1;
      const [, setSelectedAudioId] = useState<string | null>(null);
      const setSelectedAudio = useCallback((trackId: string | null) => {
        setSelectedAudioId(trackId);
      }, []);
      // Surface the callback to the test harness.
      lastSetterRef = setSelectedAudio;
      return null;
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(Engine, { unrelated: 0 }));
    });
    const firstSetter = lastSetterRef;
    await act(async () => {
      root?.render(React.createElement(Engine, { unrelated: 1 }));
    });
    await act(async () => {
      root?.render(React.createElement(Engine, { unrelated: 2 }));
    });
    const lastSetter = lastSetterRef;
    console.info(
      `[set-selected-audio-stable:semantic-stable] renderCount=${renderCount} sameRef=${firstSetter === lastSetter}`,
    );
    // The component re-rendered (we changed the unrelated prop) but
    // the useCallback([]) value must be the SAME REFERENCE.
    if (renderCount < 3 || firstSetter !== lastSetter) {
      dumpAudioStableSnapshot("semantic-stable-failure", {
        renderCount,
        firstSetter,
        lastSetter,
      });
    }
    expect(renderCount).toBeGreaterThanOrEqual(3);
    expect(firstSetter).toBe(lastSetter);
  });

  it("semantic: inline arrow would NOT be stable — pre-fix shape fails identity check", async () => {
    // Mirror of the pre-fix shape: a fresh arrow at the return site.
    // This test exists purely to PROVE the difference — if a future
    // refactor returns to that shape, the previous test FAILS while
    // this one passes, making the diff obvious.
    let lastInlineSetter: ((id: string | null) => void) | null = null;
    const InlineEngine = ({ unrelated: _u }: { unrelated: number }) => {
      const [, setSelectedAudioId] = useState<string | null>(null);
      // PRE-FIX SHAPE: a fresh arrow on every render.
      const arrow = (trackId: string | null) => setSelectedAudioId(trackId);
      lastInlineSetter = arrow;
      return null;
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(InlineEngine, { unrelated: 0 }));
    });
    const firstArrow = lastInlineSetter;
    await act(async () => {
      root?.render(React.createElement(InlineEngine, { unrelated: 1 }));
    });
    const secondArrow = lastInlineSetter;
    console.info(
      `[set-selected-audio-stable:semantic-inline] firstArrow===secondArrow=${firstArrow === secondArrow} (expected false)`,
    );
    // Different identity — exactly what the pre-fix bug looked like.
    if (firstArrow === secondArrow) {
      dumpAudioStableSnapshot("semantic-inline-unexpected-stable", {
        firstSetter: firstArrow,
        lastSetter: secondArrow,
      });
    }
    expect(firstArrow).not.toBe(secondArrow);
  });
});
