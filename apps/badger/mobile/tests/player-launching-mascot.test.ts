/**
 * @test-id BADGER-MOBILE-LAUNCHING-MASCOT-001
 * @level unit
 * @req UX-WAIT-02[badger-mobile]
 * @req UX-WAIT-02[badger-tv]
 * @why Chris 2026-11-18: when playback starts, the small "Preparing playback…" window and the player's wait before
 *   its first frame show the hovering badger of the launch screens instead of a spinner, on the see-through backdrop
 *   with no card. Once the picture shows, rebuffering and seeking keep the plain spinner. Phone and TV share the code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { useEffect } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m: { exports: unknown }) => {
    m.exports = 7;
  };
});

vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {} },
  View: "View",
  Text: "Text",
  Image: "Image",
  Modal: "Modal",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ width: 960, height: 540 }),
}));
vi.mock("@space/mobile-shell/mascot-loader", () => ({ MobileMascotLoader: "MobileMascotLoader" }));
vi.mock("@space/mobile-shell/render-boundary", () => ({
  MobileRenderBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/tv/lib/tvRuntime", () => ({ IS_TV: false }));
vi.mock("../src/tv/components/TvFocusable", () => ({ TvFocusable: "TvFocusable" }));
vi.mock("../src/theme/theme", () => {
  const anyKey = new Proxy({}, { get: () => "x" });
  return { theme: { colors: anyKey, spacing: anyKey } };
});
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../src/lib/uiLanguage", () => ({ ensureI18n: () => undefined }));
vi.mock("../src/lib/useMediaImage", () => ({ useMediaImage: () => null }));

import { LoadingModalProvider, useLoadingModal } from "../src/components/LoadingModalProvider";
import { PlayerSpinner } from "../src/screens/player/PlayerOverlays";

const LOG = "[BADGER-MOBILE-LAUNCHING-MASCOT-001]";
let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

const mount = async (element: React.ReactElement) => {
  await act(async () => {
    renderer = create(element);
  });
  return renderer as ReactTestRenderer;
};

const hosts = (tree: ReactTestRenderer, name: string): ReactTestInstance[] => tree.root.findAll((node) => node.type === name);
const texts = (tree: ReactTestRenderer) => hosts(tree, "Text").map((node) => [node.props.children].flat().join(""));

const Opener = () => {
  const { showLoading } = useLoadingModal();
  useEffect(() => {
    showLoading({ title: "player.loading" });
  }, [showLoading]);
  return null;
};

describe("the player's launching wait (phone and TV)", () => {
  it("the 'Preparing playback…' window shows the hovering badger above its text, with no spinner", async () => {
    const tree = await mount(React.createElement(LoadingModalProvider, null, React.createElement(Opener)));
    console.info(LOG, "modal texts", JSON.stringify(texts(tree)));
    expect(hosts(tree, "Modal")[0]!.props).toMatchObject({ transparent: true, visible: true });
    expect(hosts(tree, "MobileMascotLoader")).toHaveLength(1);
    expect(hosts(tree, "MobileMascotLoader")[0]!.props.app).toBe("badger");
    expect(hosts(tree, "ActivityIndicator")).toHaveLength(0);
    expect(texts(tree)).toEqual(["player.loading"]);
  });

  it("the player shows the badger until its first frame, then the plain spinner while rebuffering", async () => {
    const launching = await mount(React.createElement(PlayerSpinner, { launching: true, slow: true }));
    expect(hosts(launching, "MobileMascotLoader")).toHaveLength(1);
    expect(hosts(launching, "ActivityIndicator")).toHaveLength(0);
    expect(texts(launching)).toEqual(["player.loadingSlow"]);
    await act(async () => renderer?.unmount());

    const rebuffering = await mount(React.createElement(PlayerSpinner, { slow: false }));
    expect(hosts(rebuffering, "MobileMascotLoader")).toHaveLength(0);
    expect(hosts(rebuffering, "ActivityIndicator")).toHaveLength(1);
  });

  it("every wait before the first frame asks for the badger", () => {
    const screen = readFileSync(join(import.meta.dirname, "../src/screens/PlayerScreen.tsx"), "utf8");
    const spinners = screen.match(/<PlayerSpinner[^>]*\/>/g);
    console.info(LOG, "player spinners", JSON.stringify(spinners));
    expect(spinners).toEqual([
      "<PlayerSpinner launching />",
      "<PlayerSpinner launching />",
      "<PlayerSpinner slow={slowLoading} launching={!firstFrameShown} />",
    ]);
  });

  it("the window's words use the typographic ellipsis in every language (Main 2026-11-19, PR #2993 review)", () => {
    for (const lang of ["en", "fr", "de", "es", "nl"]) {
      const strings = JSON.parse(readFileSync(join(import.meta.dirname, `../../../../packages/mobile-shell/src/i18n/${lang}.json`), "utf8"));
      console.info(LOG, lang, JSON.stringify(strings.player.loading));
      expect(strings.player.loading).toMatch(/[^.]…$/);
    }
  });
});
