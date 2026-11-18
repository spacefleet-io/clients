// @req PLAY-OPEN-01[badger-mobile,badger-tv]
// While the player first loads, the screen shows the title's background picture (else its poster, else the app's dark
// background) under a scrim, with the loading spinner on top — never a blank default placeholder.
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultMobileShellTheme } from "@space/mobile-shell/theme";
import { PlayerLoadingBackdrop, PlayerSpinner } from "../src/screens/player/PlayerOverlays";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {} },
  View: "View",
  Text: "Text",
  Image: "Image",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  useWindowDimensions: () => ({ width: 960, height: 540 }),
}));
// The prompt buttons pick their TV flavour from the runtime; the phone one is under test here.
vi.mock("../src/tv/lib/tvRuntime", () => ({ IS_TV: false }));
vi.mock("../src/tv/components/TvFocusable", () => ({ TvFocusable: "TvFocusable" }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../src/lib/uiLanguage", () => ({ ensureI18n: () => undefined }));
// Resolves a stored picture path to a URL the way the real hook does once signed in: size + path, or nothing.
vi.mock("../src/lib/useMediaImage", () => ({
  useMediaImage: (path: string | null, size: string) => (path ? `https://img.test/${size}${path}` : null),
}));

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

const mount = async (backdropPath: string | null, posterPath: string | null) => {
  await act(async () => {
    renderer = create(
      React.createElement(PlayerLoadingBackdrop, { backdropPath, posterPath }, React.createElement(PlayerSpinner)),
    );
  });
  return renderer as ReactTestRenderer;
};

/** The mocked react-native renders host components as plain strings, so a node's type is its component name. */
const hostName = (node: ReactTestInstance): string | undefined => (typeof node.type === "string" ? node.type : undefined);

const imageUris = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((node) => hostName(node) === "Image")
    .map((node) => {
      const source: unknown = node.props.source;
      return source && typeof source === "object" && "uri" in source ? source.uri : undefined;
    });

describe("player loading backdrop", () => {
  it("shows the title's background picture with the spinner over it", async () => {
    const tree = await mount("/backdrop.jpg", "/poster.jpg");
    expect(imageUris(tree)).toEqual(["https://img.test/backdrop/backdrop.jpg"]);
    expect(tree.root.findAll((node) => hostName(node) === "ActivityIndicator")).toHaveLength(1);
  });

  it("falls back to the poster when the title has no background picture", async () => {
    const tree = await mount(null, "/poster.jpg");
    expect(imageUris(tree)).toEqual(["https://img.test/poster/poster.jpg"]);
  });

  it("shows the app's dark background, not an empty picture, when there is no artwork at all", async () => {
    const tree = await mount(null, null);
    expect(imageUris(tree)).toEqual([]);
    const wrap = tree.root.find((node) => node.props.testID === "player-backdrop" && hostName(node) === "View");
    console.info(`[backdrop] no artwork: style=${JSON.stringify(wrap.props.style)} theme bg=${defaultMobileShellTheme.colors.bg}`);
    // The real theme: its background, not any other colour of the palette (surface, text, accent...).
    expect(wrap.props.style).toMatchObject({ backgroundColor: defaultMobileShellTheme.colors.bg });
    expect(Object.entries(defaultMobileShellTheme.colors).filter(([, hex]) => hex === wrap.props.style.backgroundColor).map(([key]) => key)).toEqual(["bg"]);
    expect(tree.root.findAll((node) => hostName(node) === "ActivityIndicator")).toHaveLength(1);
  });
});
