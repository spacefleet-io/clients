/**
 * @test-id MOBILE-SHELL-RENDER-BOUNDARY-REPORTS
 * @level unit
 * @why REL-LOG-06 + UX-CRASH-01 (Chris 2026-11-10): a crash the phone or TV guard catches never reaches the SDK's
 *   global handler, so the guard hands it to the running reporter; with reports off it goes nowhere.
 */
// @req REL-LOG-06[badger-mobile] @req REL-LOG-06[badger-tv] @req REL-LOG-06[parrot]
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCaughtErrorSink, type CaughtErrorGuard } from "@space/error-report/caught";
import { popupCrashNotice } from "@space/shared/renderError";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { bg: "#000", surface: "#111", border: "#333", text: "#fff", textMuted: "#aaa" },
    accentHex: "#ffb357",
    accentTextHex: "#121421",
  }),
}));
vi.mock("../src/i18n", () => ({ getCurrentLanguage: () => "en" }));
// The window notice's sky and mascot, as plain host nodes (their own tests cover them).
vi.mock("../src/components/mobile-app-backdrop", () => ({ default: "MobileAppBackdrop" }));
vi.mock("../src/components/mobile-auth-brand", () => ({ MobileAuthBrand: "MobileAuthBrand" }));

import { MobileRenderBoundary } from "../src/components/mobile-render-boundary";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const Bomb = (): React.ReactNode => {
  throw new Error("boom on the phone");
};

describe("MobileRenderBoundary reports what it catches", () => {
  const caught: Array<{ message: string; guard: CaughtErrorGuard }> = [];
  let tree: ReactTestRenderer | undefined;
  beforeEach(() => {
    caught.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setCaughtErrorSink((error, guard) => caught.push({ message: (error as Error).message, guard }));
  });
  afterEach(() => {
    act(() => tree?.unmount());
    tree = undefined;
    setCaughtErrorSink(undefined);
    popupCrashNotice.dismiss();
    vi.restoreAllMocks();
  });

  it("@req REL-LOG-06[badger-mobile] @req REL-LOG-06[badger-tv] @req REL-LOG-06[parrot] hands item and pop-up crashes to the reporter", () => {
    const onDismiss = vi.fn();
    act(() => {
      tree = create(
        React.createElement(
          MobileRenderBoundary,
          { name: "window", variant: "window" },
          React.createElement(MobileRenderBoundary, { name: "card:b", variant: "item" }, React.createElement(Bomb)),
          React.createElement(MobileRenderBoundary, { name: "modal", onDismiss }, React.createElement(Bomb)),
        ),
      );
    });
    console.info("[mobile-boundary-reports] caught =", JSON.stringify(caught));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(caught).toEqual([
      { message: "boom on the phone", guard: "item" },
      { message: "boom on the phone", guard: "popup" },
    ]);
  });

  it("sends nothing while reports are off", () => {
    setCaughtErrorSink(undefined);
    act(() => {
      tree = create(React.createElement(MobileRenderBoundary, { name: "screen:Home" }, React.createElement(Bomb)));
    });
    expect(caught).toEqual([]);
  });
});
