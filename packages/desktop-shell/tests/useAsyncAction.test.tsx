import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "./utils/render";
import { useAsyncAction } from "../src/hooks/useAsyncAction";

// On assertion failure, dump the hook + mock state so a timing/spinner mismatch
// is diagnosable offline (tests self-diagnose). Wrapped in try/catch so a dump
// failure can never mask the real assertion failure.
const dumpAsyncActionSnapshot = (
  label: string,
  ctx: {
    state?: { pending?: boolean; spinnerVisible?: boolean } | null;
    mocks?: Record<string, ReturnType<typeof vi.fn>>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [use-async-action:${label}] snapshot ===`);
    if (ctx.state !== undefined) {
      console.error(`hook state: ${JSON.stringify(ctx.state)}`);
    }
    if (ctx.mocks) {
      const mockState = Object.fromEntries(
        Object.entries(ctx.mocks).map(([name, fn]) => [
          name,
          { calls: fn.mock.calls.length, args: fn.mock.calls, results: fn.mock.results },
        ]),
      );
      console.error(`mock call state:\n${JSON.stringify(mockState, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("useAsyncAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops re-clicks while pending — underlying fn called exactly once", async () => {
    console.info("[use-async-action:drop-reclicks] setup fn with 500ms async work");
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    });

    const { result } = renderHook(() => useAsyncAction(fn));

    let p1: Promise<unknown> | undefined;
    let p2: Promise<unknown> | undefined;
    console.info("[use-async-action:drop-reclicks] first trigger");
    act(() => {
      p1 = result.current.trigger();
    });
    try {
      expect(result.current.pending).toBe(true);
    } catch (err) {
      dumpAsyncActionSnapshot("drop-reclicks-pending-after-first", {
        state: { pending: result.current.pending, spinnerVisible: result.current.spinnerVisible },
        mocks: { fn },
        extra: { callCount },
      });
      throw err;
    }

    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    console.info("[use-async-action:drop-reclicks] second trigger while pending (must be dropped)");
    act(() => {
      p2 = result.current.trigger();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
      await Promise.all([p1, p2]);
    });

    console.info(
      `[use-async-action:drop-reclicks] final callCount=${callCount} fn.calls=${fn.mock.calls.length} pending=${result.current.pending}`,
    );
    try {
      expect(callCount).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(result.current.pending).toBe(false);
    } catch (err) {
      dumpAsyncActionSnapshot("drop-reclicks-final", {
        state: { pending: result.current.pending, spinnerVisible: result.current.spinnerVisible },
        mocks: { fn },
        extra: { callCount },
      });
      throw err;
    }
  });

  it("exposes spinnerVisible=true after spinnerDelayMs, then false after min-visible", async () => {
    console.info(
      "[use-async-action:spinner-timing] setup spinnerDelayMs=400 minVisibleMs=250 fn=500ms",
    );
    const fn = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    });

    const { result } = renderHook(() =>
      useAsyncAction(fn, { spinnerDelayMs: 400, minVisibleMs: 250 }),
    );

    let p: Promise<unknown> | undefined;
    console.info("[use-async-action:spinner-timing] trigger; spinner must be hidden initially");
    act(() => {
      p = result.current.trigger();
    });
    try {
      expect(result.current.spinnerVisible).toBe(false);
    } catch (err) {
      dumpAsyncActionSnapshot("spinner-timing-initial-hidden", {
        state: { pending: result.current.pending, spinnerVisible: result.current.spinnerVisible },
        mocks: { fn },
        extra: { phase: "before-advance", spinnerDelayMs: 400 },
      });
      throw err;
    }

    console.info("[use-async-action:spinner-timing] advance 420ms; spinner must be visible");
    await act(async () => {
      vi.advanceTimersByTime(420);
    });
    try {
      expect(result.current.spinnerVisible).toBe(true);
    } catch (err) {
      dumpAsyncActionSnapshot("spinner-timing-after-420ms", {
        state: { pending: result.current.pending, spinnerVisible: result.current.spinnerVisible },
        mocks: { fn },
        extra: { phase: "after-advance-420ms", spinnerDelayMs: 400 },
      });
      throw err;
    }

    console.info("[use-async-action:spinner-timing] run all timers; spinner must hide, pending=false");
    await act(async () => {
      await vi.runAllTimersAsync();
      await p;
    });
    try {
      expect(result.current.spinnerVisible).toBe(false);
      expect(result.current.pending).toBe(false);
    } catch (err) {
      dumpAsyncActionSnapshot("spinner-timing-final", {
        state: { pending: result.current.pending, spinnerVisible: result.current.spinnerVisible },
        mocks: { fn },
        extra: { phase: "after-run-all-timers" },
      });
      throw err;
    }
  });

  it("wires loadingModal: showLoading fires with title; hideLoading fires with same token after resolve", async () => {
    console.info("[use-async-action:loading-modal] setup showLoading->token-xyz, hideLoading");
    const fn = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    });

    const showLoading = vi.fn(() => "token-xyz");
    const hideLoading = vi.fn();

    const { result } = renderHook(() =>
      useAsyncAction(fn, {
        spinnerDelayMs: 400,
        minVisibleMs: 250,
        loadingModal: { showLoading, hideLoading },
        globalLoading: { title: "Launching", subtitle: "10%" },
      }),
    );

    let p: Promise<unknown> | undefined;
    console.info("[use-async-action:loading-modal] trigger");
    act(() => {
      p = result.current.trigger();
    });

    console.info("[use-async-action:loading-modal] advance 420ms; showLoading must fire once");
    await act(async () => {
      vi.advanceTimersByTime(420);
    });
    try {
      expect(showLoading).toHaveBeenCalledOnce();
      expect(showLoading).toHaveBeenCalledWith({ title: "Launching", subtitle: "10%" });
      expect(hideLoading).not.toHaveBeenCalled();
    } catch (err) {
      dumpAsyncActionSnapshot("loading-modal-after-show", {
        state: { pending: result.current.pending, spinnerVisible: result.current.spinnerVisible },
        mocks: { fn, showLoading, hideLoading },
        extra: { phase: "after-advance-420ms" },
      });
      throw err;
    }

    console.info("[use-async-action:loading-modal] run all timers; hideLoading must fire with token");
    await act(async () => {
      await vi.runAllTimersAsync();
      await p;
    });
    try {
      expect(hideLoading).toHaveBeenCalledOnce();
      expect(hideLoading).toHaveBeenCalledWith("token-xyz");
    } catch (err) {
      dumpAsyncActionSnapshot("loading-modal-after-hide", {
        state: { pending: result.current.pending, spinnerVisible: result.current.spinnerVisible },
        mocks: { fn, showLoading, hideLoading },
        extra: { phase: "after-run-all-timers", expectedToken: "token-xyz" },
      });
      throw err;
    }
  });

  it("unmount during pending disposes cleanly and hides any open loading modal", async () => {
    console.info("[use-async-action:unmount-during-pending] setup never-resolving fn + loading modal");
    const fn = vi.fn(() => new Promise<void>(() => undefined));
    const hideLoading = vi.fn();
    const showLoading = vi.fn(() => "open-token");

    function Host() {
      const action = useAsyncAction(fn, {
        spinnerDelayMs: 100,
        minVisibleMs: 50,
        loadingModal: { showLoading, hideLoading },
        globalLoading: { title: "Working" },
      });
      return (
        <button type="button" onClick={() => void action.trigger()} data-testid="go">
          Go
        </button>
      );
    }

    const { getByTestId, unmount } = render(<Host />);
    console.info("[use-async-action:unmount-during-pending] click Go, advance 150ms");
    act(() => {
      getByTestId("go").click();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    try {
      expect(showLoading).toHaveBeenCalledOnce();
    } catch (err) {
      dumpAsyncActionSnapshot("unmount-during-pending-after-show", {
        mocks: { fn, showLoading, hideLoading },
        extra: { phase: "after-advance-150ms" },
      });
      throw err;
    }

    console.info("[use-async-action:unmount-during-pending] unmount; hideLoading must fire with token");
    unmount();
    try {
      expect(hideLoading).toHaveBeenCalledWith("open-token");
    } catch (err) {
      dumpAsyncActionSnapshot("unmount-during-pending-after-unmount", {
        mocks: { fn, showLoading, hideLoading },
        extra: { phase: "after-unmount", expectedToken: "open-token" },
      });
      throw err;
    }
  });

  // Regression: in React StrictMode (dev) the hook's useEffect cleanup fired
  // on simulated unmount+remount, disposing the memoized runner. Subsequent
  // triggers returned undefined synchronously because of the disposed guard,
  // and the underlying fn never ran. Guard with a live StrictMode render.
  it("@bugfix @regression-proof strictmode-unmount-remount: trigger still fires fn after StrictMode simulated remount", async () => {
    console.info(
      "[use-async-action:strictmode-remount] setup fn returning 'ok' after 50ms; StrictMode render",
    );
    const fn = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return "ok";
    });

    function Host({ onReady }: { onReady: (trigger: () => Promise<unknown>) => void }) {
      const action = useAsyncAction(fn);
      onReady(() => action.trigger());
      return null;
    }

    let triggerFn: (() => Promise<unknown>) | null = null;
    // render() from ./utils/render wraps in StrictMode by default, which is
    // exactly the dev-mode cycle this test exercises.
    render(<Host onReady={(t) => (triggerFn = t)} />);

    try {
      expect(triggerFn).not.toBeNull();
    } catch (err) {
      dumpAsyncActionSnapshot("strictmode-remount-trigger-captured", {
        mocks: { fn },
        extra: { phase: "after-render", triggerFnNull: triggerFn === null },
      });
      throw err;
    }

    console.info("[use-async-action:strictmode-remount] invoking trigger after simulated remount");
    let result: unknown;
    await act(async () => {
      const p = triggerFn!();
      await vi.runAllTimersAsync();
      result = await p;
    });

    console.info(
      `[use-async-action:strictmode-remount] fn.calls=${fn.mock.calls.length} result=${JSON.stringify(result)}`,
    );
    try {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(result).toBe("ok");
    } catch (err) {
      dumpAsyncActionSnapshot("strictmode-remount-final", {
        mocks: { fn },
        extra: { phase: "after-trigger", result },
      });
      throw err;
    }
  });
});
