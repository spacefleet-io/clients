/**
 * @test-id MOBILE-SHELL-RENDER-BOUNDARY-003
 * @level unit
 * @why UX-CRASH-01: on the phone and TV apps a crash inside a pop-up (a `<Modal>`'s content) closes the pop-up and
 *   the window guard says "This window hit an error and was closed." with OK in the app's language; the screen
 *   behind it stays.
 */
import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RENDER_ERROR_COPY, popupCrashNotice } from "@space/shared/renderError";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const lang = vi.hoisted(() => ({ value: "fr" }));

// Host components: the test renderer draws them as plain nodes.
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
vi.mock("../src/i18n", () => ({ getCurrentLanguage: () => lang.value }));
// The window notice's sky and mascot, as plain host nodes (their own tests cover them).
vi.mock("../src/components/mobile-app-backdrop", () => ({ default: "MobileAppBackdrop" }));
vi.mock("../src/components/mobile-auth-brand", () => ({ MobileAuthBrand: "MobileAuthBrand" }));

import { MobileRenderBoundary } from "../src/components/mobile-render-boundary";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const crash = { on: true };

const BrokenSheet = () => {
  if (crash.on) throw new Error("boom in sheet");
  return React.createElement("Text", { testID: "sheet" }, "sheet works");
};

/** A screen with a pop-up: the pop-up's content sits in its own guard, as inside a `<Modal>`. */
const Screen = ({ onClose }: { onClose: () => void }) => {
  const [open, setOpen] = useState(true);
  return React.createElement(
    "View",
    null,
    React.createElement("Text", { testID: "screen" }, "library"),
    open
      ? React.createElement(
          MobileRenderBoundary,
          {
            name: "modal:sheet",
            onDismiss: () => {
              onClose();
              setOpen(false);
            },
          },
          React.createElement(BrokenSheet),
        )
      : null,
  );
};

const byTestId = (renderer: ReactTestRenderer, testID: string) => renderer.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");

describe("MobileRenderBoundary pop-up guard", () => {
  let errors: MockInstance<typeof console.error>;
  let infos: MockInstance<typeof console.info>;
  beforeEach(() => {
    crash.on = true;
    lang.value = "fr";
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infos = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    act(() => popupCrashNotice.dismiss());
    errors.mockRestore();
    infos.mockRestore();
  });

  it("closes the pop-up whose content throws and shows the closed message with OK over the app", async () => {
    const onClose = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(MobileRenderBoundary, { name: "window", variant: "window" }, React.createElement(Screen, { onClose })),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(byTestId(renderer, "sheet")).toHaveLength(0);
    expect(byTestId(renderer, "screen")).toHaveLength(1);
    expect(byTestId(renderer, "render-boundary:window")).toHaveLength(0);
    const [notice] = byTestId(renderer, "render-boundary-popup-closed:modal:sheet");
    expect(notice).toBeTruthy();
    const texts = renderer.root.findAll((node) => String(node.type) === "Text").map((node) => node.props.children);
    expect(texts).toContain(RENDER_ERROR_COPY.fr.popupClosed);
    expect(texts).toContain(RENDER_ERROR_COPY.fr.dismiss);
    expect(infos.mock.calls.some((call) => String(call[0]).includes("[render-boundary] modal:sheet closed"))).toBe(true);

    await act(async () => byTestId(renderer, "render-boundary-popup-closed:dismiss")[0].props.onPress());
    expect(byTestId(renderer, "render-boundary-popup-closed:modal:sheet")).toHaveLength(0);
    expect(byTestId(renderer, "screen")).toHaveLength(1);
  });

  it("a pop-up guard that is fine draws its content, and no message shows", async () => {
    crash.on = false;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(MobileRenderBoundary, { name: "window", variant: "window" }, React.createElement(Screen, { onClose: () => undefined })),
      );
    });
    expect(byTestId(renderer, "sheet")).toHaveLength(1);
    expect(byTestId(renderer, "render-boundary-popup-closed:dismiss")).toHaveLength(0);
  });
});
