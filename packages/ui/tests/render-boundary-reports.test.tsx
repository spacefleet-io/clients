// @vitest-environment jsdom
// @req UX-CRASH-01[badger-desktop] @req UX-CRASH-01[parrot] @req REL-LOG-06[badger-desktop] @req REL-LOG-06[parrot]
// A crash a guard catches never reaches the SDK's global handlers, so the guard hands it to the running reporter
// (Chris 2026-11-10: "every app must report errors to Bugsink").
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCaughtErrorSink, type CaughtErrorGuard } from "@space/error-report/caught";
import { popupCrashNotice } from "@space/shared/renderError";
import { RenderBoundary } from "../src/render-boundary";

const Bomb = (): React.ReactNode => {
  throw new Error("boom in a row");
};

describe("RenderBoundary reports what it catches", () => {
  const caught: Array<{ message: string; guard: CaughtErrorGuard }> = [];
  beforeEach(() => {
    caught.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setCaughtErrorSink((error, guard) => caught.push({ message: (error as Error).message, guard }));
  });
  afterEach(() => {
    cleanup();
    setCaughtErrorSink(undefined);
    popupCrashNotice.dismiss();
    vi.restoreAllMocks();
  });

  it("@req REL-LOG-06[badger-desktop] @req REL-LOG-06[parrot] hands a section crash to the reporter with its guard kind", () => {
    render(
      <RenderBoundary name="route:/media/42" variant="screen">
        <p>top bar</p>
        <RenderBoundary name="row:continue">
          <Bomb />
        </RenderBoundary>
      </RenderBoundary>,
    );
    console.info("[render-boundary-reports] caught =", JSON.stringify(caught));
    expect(screen.getByText("top bar")).toBeTruthy();
    expect(caught).toEqual([{ message: "boom in a row", guard: "section" }]);
  });

  it("@req REL-LOG-06[badger-desktop] @req REL-LOG-06[parrot] reports a pop-up crash as `popup`", () => {
    const onDismiss = vi.fn();
    render(
      <RenderBoundary name="dialog" onDismiss={onDismiss}>
        <Bomb />
      </RenderBoundary>,
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(caught).toEqual([{ message: "boom in a row", guard: "popup" }]);
  });

  it("sends nothing when no reporter is running (reports off)", () => {
    setCaughtErrorSink(undefined);
    render(
      <RenderBoundary name="app" variant="screen">
        <Bomb />
      </RenderBoundary>,
    );
    expect(screen.getByTestId("render-boundary-screen")).toBeTruthy();
    expect(caught).toEqual([]);
  });
});
