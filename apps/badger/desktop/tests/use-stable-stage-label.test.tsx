// @vitest-environment jsdom
//
// Phase 4 — UI minimum-dwell stage label.
//
// On fast uploads the runtime emits stageCode transitions
// `extracting → uploading → committing → done` in <100ms, faster than the
// human eye can register a state change. `useStableStageLabel` gates
// non-terminal transitions behind a per-instance dwell window so each
// active phase visibly sticks for at least `minDwellMs`. Terminal states
// (`done`, `failed`, `cancelled`) bypass the dwell so the user sees the
// outcome the moment it's known.
//
// Plan reference: we-ve-done-quite-a-immutable-dahl.md (Phase 4).

import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useStableStageLabel } from "../src/renderer/src/lib/libraryGhosts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// Dump-on-failure helper. The dwell hook is timer-driven, so when an
// assertion about the displayed label is wrong the single most useful fact
// is the relationship between the latest raw input, the currently displayed
// value, and how much fake time has elapsed. Wrapped in try/catch so a dump
// failure can never mask the real assertion.
const dumpStableStageLabelSnapshot = (
  label: string,
  ctx: { expected?: unknown; displayed?: unknown; raw?: unknown; minDwellMs?: number },
) => {
  try {
    console.error(`=== [use-stable-stage-label:${label}] state snapshot ===`);
    console.error(
      `raw(input)=${JSON.stringify(ctx.raw)} displayed(hook)=${JSON.stringify(ctx.displayed)} expected=${JSON.stringify(ctx.expected)} minDwellMs=${ctx.minDwellMs ?? "(n/a)"}`,
    );
    console.error(
      `wall-clock now=${Date.now()} (fake timers in use — advance via vi.advanceTimersByTime, see preceding phase markers for elapsed)`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const mount = <T,>(useHook: () => T): { read: () => T; rerender: () => void } => {
  let value!: T;
  let renderToken = 0;
  const Probe = () => {
    void renderToken;
    value = useHook();
    return null;
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(React.createElement(Probe));
  });
  return {
    read: () => value,
    rerender: () => {
      renderToken += 1;
      act(() => {
        root!.render(React.createElement(Probe));
      });
    },
  };
};

beforeEach(() => {
  console.info(`[use-stable-stage-label:setup] enabling fake timers`);
  vi.useFakeTimers();
});

afterEach(() => {
  console.info(`[use-stable-stage-label:teardown] unmounting probe + restoring real timers`);
  if (root && container) {
    act(() => root!.unmount());
  }
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
  vi.useRealTimers();
});

describe("useStableStageLabel @bugfix @regression-proof", () => {
  it("emits the initial value immediately on first render", () => {
    const raw = "queued";
    const harness = mount(() =>
      useStableStageLabel(raw, { minDwellMs: 600 }),
    );
    expect(harness.read()).toBe("queued");
  });

  it("holds non-terminal transitions for at least minDwellMs", () => {
    let raw: "queued" | "uploading" | "done" = "queued";
    console.info(`[use-stable-stage-label:hold-non-terminal] mounting with minDwellMs=600 raw=${raw}`);
    const harness = mount(() =>
      useStableStageLabel(raw, {
        minDwellMs: 600,
        isTerminal: (s) => s === "done",
      }),
    );
    if (harness.read() !== "queued")
      dumpStableStageLabelSnapshot("hold-non-terminal:initial", { expected: "queued", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("queued");

    // 50ms after first emit — flip to "uploading". Within dwell window:
    // the visible label must NOT update yet.
    console.info(`[use-stable-stage-label:hold-non-terminal] t=50ms flip raw->uploading (within dwell, must stay queued)`);
    vi.advanceTimersByTime(50);
    raw = "uploading";
    harness.rerender();
    if (harness.read() !== "queued")
      dumpStableStageLabelSnapshot("hold-non-terminal:within-dwell", { expected: "queued", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("queued");

    // Advance to just before the dwell elapses — still queued visible.
    console.info(`[use-stable-stage-label:hold-non-terminal] t=550ms (just before dwell elapses, must stay queued)`);
    vi.advanceTimersByTime(500);
    if (harness.read() !== "queued")
      dumpStableStageLabelSnapshot("hold-non-terminal:pre-elapse", { expected: "queued", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("queued");

    // Advance past the window — the queued "uploading" flushes.
    console.info(`[use-stable-stage-label:hold-non-terminal] t=650ms (past dwell, uploading must flush)`);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    if (harness.read() !== "uploading")
      dumpStableStageLabelSnapshot("hold-non-terminal:post-elapse", { expected: "uploading", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("uploading");
  });

  it("terminal states bypass the dwell window", () => {
    let raw: "queued" | "uploading" | "done" = "queued";
    const harness = mount(() =>
      useStableStageLabel(raw, {
        minDwellMs: 600,
        isTerminal: (s) => s === "done",
      }),
    );
    // Immediately flip to "done" — the user must see it now, not in 600ms.
    raw = "done";
    harness.rerender();
    expect(harness.read()).toBe("done");
  });

  it("terminal flushes a queued non-terminal mid-window (uploading→done before dwell elapses)", () => {
    // The bug-1-targeted scenario: a fast upload emits
    // `queued → uploading → done` within 100ms. Without this behaviour
    // the user would see "queued" frozen for 600ms, then "done" — never
    // observing "uploading". With the bypass, the moment the runtime
    // says "done", we display it (skipping the queued mid-state).
    let raw: "queued" | "uploading" | "done" = "queued";
    console.info(`[use-stable-stage-label:terminal-flush-midwindow] mounting minDwellMs=600 raw=${raw}`);
    const harness = mount(() =>
      useStableStageLabel(raw, {
        minDwellMs: 600,
        isTerminal: (s) => s === "done",
      }),
    );
    // 30ms after start: receive "uploading". Within dwell — queued.
    console.info(`[use-stable-stage-label:terminal-flush-midwindow] t=30ms flip raw->uploading (within dwell, must stay queued)`);
    vi.advanceTimersByTime(30);
    raw = "uploading";
    harness.rerender();
    if (harness.read() !== "queued")
      dumpStableStageLabelSnapshot("terminal-flush-midwindow:within-dwell", { expected: "queued", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("queued");

    // 50ms later (still inside the dwell): receive "done". Terminal —
    // must flush immediately, ignoring the queued "uploading".
    console.info(`[use-stable-stage-label:terminal-flush-midwindow] t=80ms flip raw->done (terminal, must bypass dwell)`);
    vi.advanceTimersByTime(50);
    raw = "done";
    harness.rerender();
    if (harness.read() !== "done")
      dumpStableStageLabelSnapshot("terminal-flush-midwindow:terminal-bypass", { expected: "done", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("done");
  });

  it("plays the full sequence of distinct intermediates, each dwelled (extracting→uploading→committing)", () => {
    // The exact spec from the Phase 4 brief: feed the full transition
    // chain inside the first dwell window; assert the displayed sequence
    // plays each intermediate in turn, each visible for at least
    // `minDwellMs`. Without FIFO queueing the user would never see the
    // middle state on a fast ingest.
    let raw: "extracting" | "uploading" | "committing" = "extracting";
    console.info(`[use-stable-stage-label:full-sequence] mounting minDwellMs=600 raw=${raw}`);
    const harness = mount(() =>
      useStableStageLabel(raw, { minDwellMs: 600 }),
    );
    if (harness.read() !== "extracting")
      dumpStableStageLabelSnapshot("full-sequence:t0", { expected: "extracting", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("extracting");

    // t=200ms: receive "uploading" — queued behind extracting's window.
    console.info(`[use-stable-stage-label:full-sequence] t=200ms raw->uploading (queued behind extracting)`);
    vi.advanceTimersByTime(200);
    raw = "uploading";
    harness.rerender();
    if (harness.read() !== "extracting")
      dumpStableStageLabelSnapshot("full-sequence:t200", { expected: "extracting", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("extracting");

    // t=400ms: receive "committing" — queued behind uploading.
    console.info(`[use-stable-stage-label:full-sequence] t=400ms raw->committing (queued behind uploading)`);
    vi.advanceTimersByTime(200);
    raw = "committing";
    harness.rerender();
    if (harness.read() !== "extracting")
      dumpStableStageLabelSnapshot("full-sequence:t400", { expected: "extracting", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("extracting");

    // t=600ms: extracting's dwell elapsed — uploading drains.
    console.info(`[use-stable-stage-label:full-sequence] t=600ms extracting dwell elapsed (uploading drains)`);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    if (harness.read() !== "uploading")
      dumpStableStageLabelSnapshot("full-sequence:t600", { expected: "uploading", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("uploading");

    // t=1000ms: still inside uploading's window (started at t=600).
    console.info(`[use-stable-stage-label:full-sequence] t=1000ms (still inside uploading dwell)`);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    if (harness.read() !== "uploading")
      dumpStableStageLabelSnapshot("full-sequence:t1000", { expected: "uploading", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("uploading");

    // t=1200ms: uploading's dwell elapsed — committing drains.
    console.info(`[use-stable-stage-label:full-sequence] t=1200ms uploading dwell elapsed (committing drains)`);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    if (harness.read() !== "committing")
      dumpStableStageLabelSnapshot("full-sequence:t1200", { expected: "committing", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("committing");
  });

  it("coalesces identical adjacent labels (5 ticks of the same value don't pile up)", () => {
    // If 5 transitions arrive with identical values inside one window,
    // the queue must NOT pile up — the user sees one transition, not
    // five back-to-back identical ones. (Common in practice: progress
    // updates arrive that don't change the displayed status word.)
    let raw: "A" | "B" = "A";
    console.info(`[use-stable-stage-label:coalesce] mounting minDwellMs=600 raw=${raw}`);
    const harness = mount(() =>
      useStableStageLabel(raw, { minDwellMs: 600 }),
    );
    if (harness.read() !== "A")
      dumpStableStageLabelSnapshot("coalesce:t0", { expected: "A", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("A");

    // Five identical "B" transitions inside the dwell — only the first
    // is queued; the rest coalesce against the queue tail.
    console.info(`[use-stable-stage-label:coalesce] t=100ms five identical raw->B rerenders inside dwell (must coalesce, stay A)`);
    vi.advanceTimersByTime(100);
    raw = "B";
    harness.rerender();
    harness.rerender();
    harness.rerender();
    harness.rerender();
    harness.rerender();
    if (harness.read() !== "A")
      dumpStableStageLabelSnapshot("coalesce:within-dwell", { expected: "A", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("A");

    // After the dwell window: B drains and stays — no further drains
    // scheduled because the queue collapsed to a single entry.
    console.info(`[use-stable-stage-label:coalesce] t=700ms dwell elapsed (single B drains)`);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    if (harness.read() !== "B")
      dumpStableStageLabelSnapshot("coalesce:post-dwell", { expected: "B", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("B");
    // Advance another full window — no further state change because
    // the queue is empty.
    console.info(`[use-stable-stage-label:coalesce] t=2700ms extra window (queue empty, must stay B)`);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    if (harness.read() !== "B")
      dumpStableStageLabelSnapshot("coalesce:queue-empty", { expected: "B", displayed: harness.read(), raw, minDwellMs: 600 });
    expect(harness.read()).toBe("B");
  });

  it("two parallel hook instances maintain independent dwell timelines (per-job state isolation)", () => {
    // Each LabStatusBadge mount gets its own dwell — two jobs in flight
    // at different speeds must NOT bleed timing into each other.
    let rawA: "queued" | "uploading" = "queued";
    let rawB: "queued" | "uploading" | "done" = "queued";

    const Probe = () => {
      const a = useStableStageLabel(rawA, { minDwellMs: 600 });
      const b = useStableStageLabel(rawB, {
        minDwellMs: 600,
        isTerminal: (s) => s === "done",
      });
      // Stash both onto module-scope captures via the harness.
      capture.a = a;
      capture.b = b;
      return null;
    };
    const capture: { a?: string; b?: string } = {};

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(Probe));
    });
    console.info(`[use-stable-stage-label:parallel-instances] mounted; a=${capture.a} b=${capture.b}`);
    if (capture.a !== "queued" || capture.b !== "queued")
      dumpStableStageLabelSnapshot("parallel-instances:initial", { expected: "queued/queued", displayed: `${capture.a}/${capture.b}`, raw: `${rawA}/${rawB}`, minDwellMs: 600 });
    expect(capture.a).toBe("queued");
    expect(capture.b).toBe("queued");

    // A: change to "uploading" inside dwell — should remain queued.
    // B: change to terminal "done" — should bypass and display now.
    console.info(`[use-stable-stage-label:parallel-instances] t=100ms A->uploading (within dwell), B->done (terminal bypass)`);
    vi.advanceTimersByTime(100);
    rawA = "uploading";
    rawB = "done";
    act(() => {
      root!.render(React.createElement(Probe));
    });
    if (capture.a !== "queued" || capture.b !== "done")
      dumpStableStageLabelSnapshot("parallel-instances:t100", { expected: "a=queued b=done", displayed: `a=${capture.a} b=${capture.b}`, raw: `${rawA}/${rawB}`, minDwellMs: 600 });
    expect(capture.a).toBe("queued"); // A is still in its dwell
    expect(capture.b).toBe("done"); // B bypassed via terminal

    // Advance past A's dwell — A drains, B unchanged.
    console.info(`[use-stable-stage-label:parallel-instances] t=700ms A dwell elapsed (A drains to uploading, B unchanged)`);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    if (capture.a !== "uploading" || capture.b !== "done")
      dumpStableStageLabelSnapshot("parallel-instances:t700", { expected: "a=uploading b=done", displayed: `a=${capture.a} b=${capture.b}`, raw: `${rawA}/${rawB}`, minDwellMs: 600 });
    expect(capture.a).toBe("uploading");
    expect(capture.b).toBe("done");
  });

  it("emits immediately when the change happens AFTER the dwell window has elapsed", () => {
    let raw: "A" | "B" = "A";
    const harness = mount(() =>
      useStableStageLabel(raw, { minDwellMs: 600 }),
    );

    // Wait past the window; the next change is outside dwell — emit now.
    vi.advanceTimersByTime(700);
    raw = "B";
    act(() => {
      harness.rerender();
    });
    expect(harness.read()).toBe("B");
  });

  it("uses the custom equals predicate for tuple values", () => {
    // Tuple values create a new object each render; without an equals
    // predicate the hook would dwell every render. The custom equals
    // collapses identical-content tuples to no-op.
    let raw = { status: "uploading", stageLabel: "Uploading 1080p" };
    const harness = mount(() =>
      useStableStageLabel(raw, {
        minDwellMs: 600,
        equals: (a, b) =>
          a.status === b.status && a.stageLabel === b.stageLabel,
      }),
    );
    const initial = harness.read();
    // Same content, new object — must remain the initial value.
    raw = { status: "uploading", stageLabel: "Uploading 1080p" };
    harness.rerender();
    expect(harness.read()).toEqual(initial);
  });

  it("clears its pending timer on unmount (no late state update)", () => {
    let raw = "A";
    const harness = mount(() => useStableStageLabel(raw, { minDwellMs: 600 }));
    vi.advanceTimersByTime(50);
    raw = "B";
    harness.rerender();
    // Unmount BEFORE the timer fires.
    act(() => root!.unmount());
    root = null;
    container?.parentNode?.removeChild(container);
    container = null;
    // Advancing past the window must not throw or trigger React act
    // warnings — the timer was cleaned up.
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    void harness; // keep harness reference until end-of-test for clarity
  });
});
