import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { render, renderHook } from "./render";

// On assertion failure, dump the observed effect-firing counts so a StrictMode
// regression (single vs double mount) is obvious without re-instrumenting.
// Wrapped in try/catch so a dump failure can't mask the real assertion error.
const dumpRenderCounts = (
  label: string,
  counts: { mounts?: number; cleanups?: number; expected: Record<string, number> },
) => {
  try {
    console.error(`=== [render-helper:${label}] effect counts snapshot ===`);
    console.error(
      `observed mounts=${counts.mounts ?? "n/a"} cleanups=${counts.cleanups ?? "n/a"}`,
    );
    console.error(`expected: ${JSON.stringify(counts.expected)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("render helper", () => {
  // Regression: renderer production (main.tsx:20) wraps in <StrictMode> but
  // tests used to render without it. That blindspot hid a runner-dispose bug
  // in useAsyncAction that only surfaced in StrictMode's simulated unmount-
  // remount cycle. Lock the default behaviour in.
  it("@bugfix @regression-proof render helper wraps in StrictMode by default (double-mounts effects)", () => {
    console.info(`[render-helper:strict-default] rendering probe with default (strict) render`);
    let mounts = 0;
    let cleanups = 0;
    const Probe = () => {
      useEffect(() => {
        mounts++;
        return () => {
          cleanups++;
        };
      }, []);
      return null;
    };

    render(<Probe />);
    console.info(`[render-helper:strict-default] observed mounts=${mounts} cleanups=${cleanups}`);

    if (mounts !== 2 || cleanups !== 1) {
      dumpRenderCounts("strict-default", { mounts, cleanups, expected: { mounts: 2, cleanups: 1 } });
    }
    expect(mounts).toBe(2);
    expect(cleanups).toBe(1);
  });

  it("lets callers opt out with { strict: false } so a single mount fires exactly once", () => {
    console.info(`[render-helper:strict-false] rendering probe with { strict: false }`);
    let mounts = 0;
    const Probe = () => {
      useEffect(() => {
        mounts++;
      }, []);
      return null;
    };

    render(<Probe />, { strict: false });
    console.info(`[render-helper:strict-false] observed mounts=${mounts}`);

    if (mounts !== 1) {
      dumpRenderCounts("strict-false", { mounts, expected: { mounts: 1 } });
    }
    expect(mounts).toBe(1);
  });

  it("renderHook wraps in StrictMode by default", () => {
    console.info(`[render-helper:hook-strict-default] rendering hook with default (strict) renderHook`);
    let mounts = 0;
    renderHook(() => {
      useEffect(() => {
        mounts++;
      }, []);
    });
    console.info(`[render-helper:hook-strict-default] observed mounts=${mounts}`);

    if (mounts !== 2) {
      dumpRenderCounts("hook-strict-default", { mounts, expected: { mounts: 2 } });
    }
    expect(mounts).toBe(2);
  });
});
