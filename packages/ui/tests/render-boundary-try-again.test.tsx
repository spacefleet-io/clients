// @vitest-environment jsdom
// @req UX-CRASH-01[badger-desktop] @req UX-CRASH-01[parrot] @bugfix @regression-proof
// Chris 2026-11-12 (chat): "Retry never works". The old Retry only cleared the caught error, so the same children
// rendered again from the same cached data and threw the same error straight away. The notice now has one button,
// "Try again": the first press clears the app's data (`onRetry`) and mounts the part anew; a second failure within a
// few seconds reloads the window by itself; a marker stops a crash that survives the reload from looping.
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { RELOAD_MARKER_TTL_MS, RENDER_ERROR_COPY } from "@space/shared/renderError";
import { RenderBoundary } from "../src/render-boundary";

const MARKER_KEY = "sf:render-boundary:reloaded-at";
const log = (phase: string, message: string, extra?: unknown) =>
  console.info(`[render-boundary-try-again.test] [${phase}] ${message}`, extra ?? "");

/** Stands in for an app's query cache: the part renders from it, `onRetry` clears it. */
let cache: { rows: unknown };
let clock = 0;

/** Throws on cached data it cannot render (the bad row stays in the cache until the app drops it). */
const Rows = () => {
  if (!Array.isArray(cache.rows)) throw new Error("rows is not an array");
  return <p>{cache.rows.length} rows</p>;
};

/** Throws on every render: a crash no data refresh fixes. */
const AlwaysBroken = (): React.ReactNode => {
  throw new Error("broken for good");
};

const tryAgain = () => screen.getByRole("button", { name: RENDER_ERROR_COPY.en.retry });

describe("RenderBoundary: Try again", () => {
  let errorSpy: MockInstance;
  let infoSpy: MockInstance;
  beforeEach(() => {
    document.documentElement.lang = "en";
    sessionStorage.removeItem(MARKER_KEY);
    cache = { rows: { broken: true } };
    clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "info");
    log("setup", "clock", clock);
  });
  afterEach(() => {
    log("teardown", "console.error calls", errorSpy.mock.calls.map((call) => String(call[0]).slice(0, 120)));
    cleanup();
    vi.restoreAllMocks();
  });

  const infoLines = () => infoSpy.mock.calls.map((call) => String(call[0]));

  it("shows one button only, 'Try again', on every notice with a button", () => {
    for (const variant of ["screen", "section", "overlay"] as const) {
      const view = render(
        <RenderBoundary name={`part:${variant}`} variant={variant}>
          <AlwaysBroken />
        </RenderBoundary>,
      );
      const labels = screen.getAllByRole("button").map((button) => button.textContent);
      log("notice", variant, labels);
      expect(labels).toEqual([RENDER_ERROR_COPY.en.retry]);
      expect(RENDER_ERROR_COPY.en.retry).toBe("Try again");
      view.unmount();
    }
  });

  it("the first press calls onRetry and mounts the part anew, so a crash from cached data recovers", () => {
    const onRetry = vi.fn(() => {
      log("retry", "app drops its cached rows");
      cache = { rows: [1, 2, 3] };
    });
    const onReload = vi.fn();
    render(
      <RenderBoundary name="route:/library" onRetry={onRetry} onReload={onReload}>
        <Rows />
      </RenderBoundary>,
    );
    expect(screen.getByTestId("render-boundary-section")).toBeTruthy();
    log("crash", "notice shown");
    clock += 2_000;
    fireEvent.click(tryAgain());
    log("press", "after Try again", document.body.textContent);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("3 rows")).toBeTruthy();
    expect(onReload).not.toHaveBeenCalled();
    expect(infoLines()).toContain("[render-boundary] route:/library try again");
  });

  it("the part is mounted under a fresh key: component state below the guard starts over", () => {
    let mounts = 0;
    const Counted = () => {
      React.useState(() => {
        mounts += 1;
        return mounts;
      });
      if (!Array.isArray(cache.rows)) throw new Error("rows is not an array");
      return <p>mount {mounts}</p>;
    };
    render(
      <RenderBoundary name="route:/library" onRetry={() => {
        cache = { rows: [] };
      }}>
        <Counted />
      </RenderBoundary>,
    );
    const before = mounts;
    fireEvent.click(tryAgain());
    log("press", "mounts before/after", { before, after: mounts });
    expect(mounts).toBeGreaterThan(before);
    expect(screen.getByText(`mount ${mounts}`)).toBeTruthy();
  });

  it("a second failure within a few seconds of the press reloads the window by itself, with no extra click", () => {
    const onRetry = vi.fn();
    const onReload = vi.fn(() => log("reload", "window reload requested"));
    render(
      <RenderBoundary name="route:/library" onRetry={onRetry} onReload={onReload}>
        <AlwaysBroken />
      </RenderBoundary>,
    );
    clock += 3_000;
    fireEvent.click(tryAgain());
    log("press", "info lines", infoLines());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(infoLines()).toContain("[render-boundary] route:/library crash after try again: reload");
    expect(Number(sessionStorage.getItem(MARKER_KEY))).toBe(clock);
  });

  it("a crash long after a press that worked shows the notice and never reloads", () => {
    const onReload = vi.fn();
    let broken = false;
    const Later = () => {
      if (broken) throw new Error("broke later");
      return <p>fine</p>;
    };
    const view = render(
      <RenderBoundary name="route:/library" onReload={onReload} onRetry={() => {
        cache = { rows: [] };
      }}>
        <Rows />
      </RenderBoundary>,
    );
    fireEvent.click(tryAgain());
    expect(screen.getByText("0 rows")).toBeTruthy();
    clock += 30_000;
    broken = true;
    view.rerender(
      <RenderBoundary name="route:/library" onReload={onReload}>
        <Later />
      </RenderBoundary>,
    );
    log("later crash", "info lines", infoLines());
    expect(screen.getByTestId("render-boundary-section")).toBeTruthy();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("no reload loop: after an automatic reload, a crash shows the notice again and the press only retries", () => {
    // The window has just reloaded by itself (the marker a failed retry wrote before the reload).
    sessionStorage.setItem(MARKER_KEY, String(clock - 5_000));
    const onRetry = vi.fn();
    const onReload = vi.fn();
    render(
      <RenderBoundary name="app" variant="screen" onRetry={onRetry} onReload={onReload}>
        <AlwaysBroken />
      </RenderBoundary>,
    );
    expect(screen.getByTestId("render-boundary-screen")).toBeTruthy();
    for (const step of [1, 2, 3]) {
      clock += 1_000;
      fireEvent.click(tryAgain());
      log("press", `press ${step}`, { onRetry: onRetry.mock.calls.length, onReload: onReload.mock.calls.length });
      expect(screen.getByTestId("render-boundary-screen")).toBeTruthy();
    }
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onReload).not.toHaveBeenCalled();
    expect(infoLines()).toContain("[render-boundary] app crash after try again: show");

    // Once the marker is old, a failed retry may reload again (a new problem, not the same loop).
    clock += RELOAD_MARKER_TTL_MS;
    fireEvent.click(tryAgain());
    log("press", "after marker expiry", onReload.mock.calls.length);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("an onRetry that throws is logged and the part is still mounted anew", () => {
    const onRetry = vi.fn(() => {
      cache = { rows: [1] };
      throw new Error("cache reset failed");
    });
    render(
      <RenderBoundary name="route:/library" onRetry={onRetry}>
        <Rows />
      </RenderBoundary>,
    );
    fireEvent.click(tryAgain());
    expect(screen.getByText("1 rows")).toBeTruthy();
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("onRetry failed"))).toBe(true);
  });
});

describe("RenderBoundary: Try again with an async refresh", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    sessionStorage.removeItem(MARKER_KEY);
    cache = { rows: { broken: true } };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("waits for the refreshed data before mounting the part anew; the button is busy meanwhile", async () => {
    const refresh = Promise.withResolvers<void>();
    const finish = () => {
      log("refresh", "fresh rows arrived");
      cache = { rows: [1, 2] };
      refresh.resolve();
    };
    const onReload = vi.fn();
    const onRetry = vi.fn(() => refresh.promise);
    render(
      <RenderBoundary name="route:/library" onRetry={onRetry} onReload={onReload}>
        <Rows />
      </RenderBoundary>,
    );
    fireEvent.click(tryAgain());
    const button = tryAgain() as HTMLButtonElement;
    log("pending", "button disabled", button.disabled);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.getByText("2 rows")).toBeTruthy();
    expect(onReload).not.toHaveBeenCalled();
  });

  // Found in the hand try (Parrot dev, 2026-11-12): StrictMode mounts, unmounts and mounts every component again on
  // the same instance, so an "unmounted" flag set in componentWillUnmount stayed true and the notice stayed busy for good.
  it("in StrictMode (every dev build) the part is still mounted anew once the refreshed data is in", async () => {
    const refresh = Promise.withResolvers<void>();
    render(
      <React.StrictMode>
        <RenderBoundary name="route:/library" onRetry={() => refresh.promise}>
          <Rows />
        </RenderBoundary>
      </React.StrictMode>,
    );
    fireEvent.click(tryAgain());
    await act(async () => {
      cache = { rows: [1, 2, 3] };
      refresh.resolve();
    });
    log("strict-mode", "after the refresh", document.body.textContent);
    expect(screen.getByText("3 rows")).toBeTruthy();
  });
});
