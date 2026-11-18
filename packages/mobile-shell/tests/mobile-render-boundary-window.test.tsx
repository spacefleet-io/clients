/**
 * @test-id MOBILE-SHELL-RENDER-BOUNDARY-002
 * @level unit
 * @why UX-CRASH-01: on the phone and TV apps a crash outside every screen (a provider, the navigator, sign-in) must
 *   show a full-screen "Something went wrong. <App> needs to restart this screen." over the sign-in screen's star sky
 *   and mascot (Chris, 2026-11-10), with one "Try again" button in the app's language (Chris 2026-11-12 (chat)),
 *   never a white or red screen. A screen or item guard keeps its small plain notice.
 * @req UX-CRASH-01[badger-mobile] @req UX-CRASH-01[parrot] @bugfix @regression-proof
 *   Chris 2026-11-12 (chat): "Retry never works". "Try again" first calls `onRetry` and mounts the part anew; a second
 *   failure within a few seconds reloads the app's tree by itself (through the window guard); a crash that survives
 *   that reload shows the notice again and the next press only retries, never a loop.
 */
import React, { useEffect, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RENDER_ERROR_COPY } from "@space/shared/renderError";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const lang = vi.hoisted(() => ({ value: "de" }));

// Host components: the test renderer draws them as plain nodes.
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    brandName: "Parrot",
    colors: { bg: "#000", text: "#fff", textMuted: "#aaa" },
    accentHex: "#40dd8f",
    accentTextHex: "#121421",
  }),
}));
vi.mock("../src/i18n", () => ({ getCurrentLanguage: () => lang.value }));
// The window notice's sky and mascot, as plain host nodes (their own tests cover them).
vi.mock("../src/components/mobile-app-backdrop", () => ({ default: "MobileAppBackdrop" }));
vi.mock("../src/components/mobile-auth-brand", () => ({ MobileAuthBrand: "MobileAuthBrand" }));

import { MobileRenderBoundary } from "../src/components/mobile-render-boundary";

const MASCOT = { uri: "parrot-mascot" };
const hostNodes = (renderer: ReactTestRenderer, type: string) => renderer.root.findAll((node) => (node.type as unknown) === type);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const crash = { left: 0, mounts: 0 };
let clock = 0;
const log = (phase: string, message: string, extra?: unknown) =>
  process.stdout.write(`[mobile-render-boundary-window.test] [${phase}] ${message} ${extra === undefined ? "" : JSON.stringify(extra)}\n`);

/** Stands for the app below the window guard: counts its mounts and throws while `crash.left` is above zero. */
const AppTree = () => {
  const [mount] = useState(() => ++crash.mounts);
  useEffect(() => undefined, []);
  if (crash.left > 0) {
    crash.left -= 1;
    throw new Error("provider blew up");
  }
  return React.createElement("Text", { testID: "app" }, `mount ${mount}`);
};

const textsOf = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => (node.type as unknown) === "Text").map((node) => node.props.children);

const press = (renderer: ReactTestRenderer, testID: string) =>
  act(() => renderer.root.find((node) => node.props.testID === testID && (node.type as unknown) === "Pressable").props.onPress());

describe("MobileRenderBoundary window variant", () => {
  let errors: MockInstance<typeof console.error>;
  let infos: MockInstance<typeof console.info>;
  beforeEach(() => {
    crash.left = 0;
    crash.mounts = 0;
    lang.value = "de";
    // The reload marker lives in module memory for the whole file: each test starts well past its lifetime.
    clock += 10 * 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infos = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    log("teardown", "info lines", infos.mock.calls.map((call) => String(call[0])));
    vi.restoreAllMocks();
  });

  it("shows the full-screen notice with its one button, Try again, and the press mounts the app anew", async () => {
    crash.left = 2; // React renders a failing tree twice before giving up on it.
    const onRetry = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MobileRenderBoundary name="window" variant="window" mascotSource={MASCOT} onRetry={onRetry}>
          <AppTree />
        </MobileRenderBoundary>
      );
    });

    const notice = renderer.root.find((node) => node.props.testID === "render-boundary:window" && (node.type as unknown) === "View");
    expect(notice.props.accessibilityRole).toBe("alert");
    const copy = RENDER_ERROR_COPY.de;
    expect(textsOf(renderer)).toEqual([copy.message, "Parrot muss diesen Bildschirm neu starten.", copy.retry]);
    expect(hostNodes(renderer, "Pressable")).toHaveLength(1);
    // The sign-in screen's look: the star sky behind, the app's floating mascot above the words.
    expect(hostNodes(renderer, "MobileAppBackdrop")).toHaveLength(1);
    const [mascot] = hostNodes(renderer, "MobileAuthBrand");
    expect(mascot.props.iconSource).toBe(MASCOT);
    expect(mascot.props.subtitle).toBeUndefined();
    // Try again is the accent button.
    const retry = renderer.root.find((node) => node.props.testID === "render-boundary:window:retry" && (node.type as unknown) === "Pressable");
    expect(retry.props.style).toContainEqual({ backgroundColor: "#40dd8f" });
    expect(errors.mock.calls.some((call) => String(call[0]) === "[render-boundary] window crashed: provider blew up")).toBe(true);
    const mountsBefore = crash.mounts;

    clock += 1_000;
    await press(renderer, "render-boundary:window:retry");
    log("press", "mounts before/after", { mountsBefore, after: crash.mounts });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(infos).toHaveBeenCalledWith("[render-boundary] window try again");
    // The tree is mounted anew (fresh state), not merely re-rendered.
    expect(crash.mounts).toBeGreaterThan(mountsBefore);
    expect(textsOf(renderer)).toEqual([`mount ${crash.mounts}`]);
  });

  it("a second failure right after the press reloads the app's tree by itself, then never loops", async () => {
    crash.left = 1_000; // broken for good
    const onRetry = vi.fn();
    const onReload = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MobileRenderBoundary name="window" variant="window" onRetry={onRetry} onReload={onReload}>
          <AppTree />
        </MobileRenderBoundary>
      );
    });
    clock += 2_000;
    await press(renderer, "render-boundary:window:retry");
    log("first press", "calls", { onRetry: onRetry.mock.calls.length, onReload: onReload.mock.calls.length });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(infos).toHaveBeenCalledWith("[render-boundary] window reload");
    // The crash survived the reload: the notice is back, and the next presses only retry.
    expect(textsOf(renderer)[0]).toBe(RENDER_ERROR_COPY.de.message);
    for (const step of [2, 3]) {
      clock += 1_000;
      await press(renderer, "render-boundary:window:retry");
      log("press", `press ${step}`, { onRetry: onRetry.mock.calls.length, onReload: onReload.mock.calls.length });
    }
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(textsOf(renderer)[0]).toBe(RENDER_ERROR_COPY.de.message);
  });

  it("a screen guard whose retry failed asks the window guard to reload the whole app tree", async () => {
    let screenBroken = true;
    const Screen = () => {
      if (screenBroken) throw new Error("screen blew up");
      return React.createElement("Text", { testID: "screen" }, "screen works");
    };
    const onReload = vi.fn(() => log("reload", "window onReload"));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MobileRenderBoundary name="window" variant="window" onReload={onReload}>
          <AppTree />
          <MobileRenderBoundary name="screen:Home">
            <Screen />
          </MobileRenderBoundary>
        </MobileRenderBoundary>
      );
    });
    const mountsBefore = crash.mounts;
    clock += 1_000;
    await press(renderer, "render-boundary:screen:Home:retry");
    log("press", "app mounts before/after", { mountsBefore, after: crash.mounts });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(crash.mounts).toBeGreaterThan(mountsBefore);
    expect(infos).toHaveBeenCalledWith("[render-boundary] screen:Home still failing after try again: reloading the app");
    // Still broken after the reload: the screen's notice again, never a loop; once fixed, the press recovers it.
    expect(renderer.root.findAll((node) => node.props.testID === "render-boundary:screen:Home")).not.toHaveLength(0);
    screenBroken = false;
    clock += 1_000;
    await press(renderer, "render-boundary:screen:Home:retry");
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAll((node) => node.props.testID === "screen")).toHaveLength(1);
  });

  it("waits for an async onRetry (the app refetching its data) before mounting anew; the button is busy meanwhile", async () => {
    let data: unknown = { broken: true };
    const Rows = () => {
      if (!Array.isArray(data)) throw new Error("rows is not an array");
      return React.createElement("Text", { testID: "rows" }, `${data.length} rows`);
    };
    const refresh = Promise.withResolvers<void>();
    const onRetry = vi.fn(() => refresh.promise);
    const onReload = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MobileRenderBoundary name="window" variant="window" onReload={onReload}>
          <MobileRenderBoundary name="screen:Library" onRetry={onRetry}>
            <Rows />
          </MobileRenderBoundary>
        </MobileRenderBoundary>
      );
    });
    await press(renderer, "render-boundary:screen:Library:retry");
    const button = renderer.root.find((node) => node.props.testID === "render-boundary:screen:Library:retry" && (node.type as unknown) === "Pressable");
    log("pending", "button disabled", button.props.disabled);
    expect(button.props.disabled).toBe(true);
    await act(async () => {
      data = [1, 2];
      refresh.resolve();
    });
    expect(textsOf(renderer)).toEqual(["2 rows"]);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });

  // Found in the hand try (Parrot desktop dev, 2026-11-12): StrictMode mounts, unmounts and mounts every component again
  // on the same instance, so an "unmounted" flag set in componentWillUnmount stayed true and the notice stayed busy.
  it("in StrictMode (every dev build) the part is still mounted anew once the refreshed data is in", async () => {
    let data: unknown = { broken: true };
    const Rows = () => {
      if (!Array.isArray(data)) throw new Error("rows is not an array");
      return React.createElement("Text", { testID: "rows" }, `${data.length} rows`);
    };
    const refresh = Promise.withResolvers<void>();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <React.StrictMode>
          <MobileRenderBoundary name="screen:Library" onRetry={() => refresh.promise}>
            <Rows />
          </MobileRenderBoundary>
        </React.StrictMode>
      );
    });
    await press(renderer, "render-boundary:screen:Library:retry");
    await act(async () => {
      data = [1, 2, 3];
      refresh.resolve();
    });
    log("strict-mode", "after the refresh", textsOf(renderer));
    expect(textsOf(renderer)).toEqual(["3 rows"]);
  });

  it("a new resetKey clears the notice", async () => {
    crash.left = 2;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MobileRenderBoundary name="window" variant="window">
          <AppTree />
        </MobileRenderBoundary>
      );
    });
    expect(textsOf(renderer)[0]).toBe(RENDER_ERROR_COPY.de.message);
    await act(async () => renderer.update(
      <MobileRenderBoundary name="window" variant="window" resetKey="again">
        <AppTree />
      </MobileRenderBoundary>
    ));
    expect(renderer.root.findAll((node) => node.props.testID === "app")).toHaveLength(1);
  });

  it("the section variant (a screen or item) keeps the small plain notice with Try again only: no sky, no mascot", async () => {
    crash.left = 2;
    lang.value = "nl";
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MobileRenderBoundary name="screen:Home">
          <AppTree />
        </MobileRenderBoundary>
      );
    });
    const copy = RENDER_ERROR_COPY.nl;
    expect(textsOf(renderer)).toEqual([copy.message, copy.detail, copy.retry]);
    expect(hostNodes(renderer, "MobileAppBackdrop")).toHaveLength(0);
    expect(hostNodes(renderer, "MobileAuthBrand")).toHaveLength(0);
  });
});
