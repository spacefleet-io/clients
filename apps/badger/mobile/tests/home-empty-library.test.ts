/**
 * @test-id MOBILE-HOME-EMPTY-LIBRARY-001
 * @level component
 * @why Chris 2026-11-12: the empty-library screen that replaced the one-line text on the computer "was for all clients
 *   not just desktop". With no media, the phone's Home shows the computer's screen through the shared
 *   `MobileEmptyLibrary`: the badger, "Your library", "Add your first title", one "Get Badger for computer" button that
 *   opens the downloads page in the app's language, and the three steps. Rendered with react-test-renderer against
 *   host-element stand-ins; the library store and navigation are stubbed, the shared screen is the real one.
 */
// @req UX-EMPTY-01[badger-mobile] @req UX-PHONE-03[badger-mobile] @req UX-WAIT-04[badger-mobile]
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
  return { opened: [] as string[], settled: true, media: [] as unknown[] };
});

vi.mock("react-native", () => ({
  Dimensions: { get: () => ({ width: 390, height: 800 }) },
  Image: "Image",
  Linking: { openURL: async (url: string) => void ctl.opened.push(url) },
  Pressable: "Pressable",
  RefreshControl: "RefreshControl",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({
  Download: "DownloadIcon",
  Headphones: "HeadphonesIcon",
  MonitorSmartphone: "MonitorSmartphoneIcon",
  MousePointerClick: "MousePointerClickIcon",
  Sparkles: "SparklesIcon",
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }) }));
vi.mock("@space/mobile-shell/components", async () => {
  // The real shared screen, so the test sees its texts and testIDs; the barrel would pull in every shell component.
  const shared = await import("@space/mobile-shell/empty-library");
  return {
    MobileEmptyLibrary: shared.MobileEmptyLibrary,
    MobileEmptyLibraryAction: shared.MobileEmptyLibraryAction,
    MobileLibraryLoading: "MobileLibraryLoading",
    useSkyScroll: () => ({}),
  };
});
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }), getCurrentLanguage: () => "fr" }));
vi.mock("../src/store/library", () => ({
  useLibraryData: () => ({ media: ctl.media }),
  // `loading: false` as the store reports it before its load starts and while a saved copy waits for the sync.
  useLibraryStatus: () => ({ loading: false, settled: ctl.settled, error: null, refresh: async () => undefined }),
  useLibraryActions: () => ({ getMediaDetails: async () => null }),
}));
vi.mock("../src/lib/resume", () => ({ getLastPlayedEpisodeId: async () => null }));
vi.mock("../src/components/PosterRail", () => ({ PosterRail: "PosterRail" }));
vi.mock("../src/components/ContinueHero", () => ({ ContinueHero: "ContinueHero" }));
vi.mock("../src/lib/useHomeRails", () => ({ useHomeRails: () => [] }));
vi.mock("../src/lib/phoneHome", () => ({ phoneHomeLayout: () => ({ hero: null, rails: [] }), seeAllTarget: () => ({ tab: "library", scope: "movies" }) }));
vi.mock("../src/lib/usePullToRefresh", () => ({
  usePullToRefresh: () => ({ refreshing: false, onRefresh: () => undefined }),
  usePullRefreshScroll: (_pull: unknown, scroll: unknown) => scroll,
}));
vi.mock("../src/theme/theme", () => {
  const anyKey = new Proxy({}, { get: () => "x" });
  return { theme: { colors: anyKey, font: new Proxy({}, { get: () => anyKey }), accentTextHex: "#000" } };
});

import { HomeScreen } from "../src/screens/HomeScreen";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("the phone's empty Home", () => {
  beforeEach(() => {
    ctl.settled = true;
    ctl.media = [];
  });

  it("@req UX-EMPTY-01 @req UX-PHONE-03 shows the computer's empty library with one button to the downloads page", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(HomeScreen));
    });
    const root = renderer.root;
    const byId = (id: string) => root.findAll((node) => node.props.testID === id && typeof node.type === "string");
    const texts = root.findAll((node) => (node.type as unknown) === "Text").map((node) => node.props.children);
    console.info("[MOBILE-HOME-EMPTY-LIBRARY-001] texts", JSON.stringify(texts));
    expect(byId("empty-library")).toHaveLength(1);
    expect(byId("empty-library-mascot")).toHaveLength(1);
    expect(texts).toEqual(
      expect.arrayContaining(["HOME.EMPTYLIBRARY.EYEBROW", "home.emptyLibrary.title", "home.emptyLibrary.subtitle", "home.emptyLibrary.getDesktop", "1. home.emptyLibrary.step1Title"]),
    );
    expect(byId("empty-library-step-3")).toHaveLength(1);
    const actions = byId("empty-library-action");
    expect(actions).toHaveLength(1);
    await act(async () => actions[0]!.props.onPress());
    console.info("[MOBILE-HOME-EMPTY-LIBRARY-001] opened", JSON.stringify(ctl.opened));
    expect(ctl.opened).toEqual(["https://spacebadger.io/fr/downloads"]);
  });

  // Chris 2026-11-18: "The badger app shows the empty library 'upload your first media on desktop' before the library
  // loads." The store reports `loading: false` before its load starts and while a saved copy waits for the sync.
  it("@req UX-WAIT-04 shows the opening screen with Loading library, never the empty library, until the load says what it holds", async () => {
    ctl.settled = false;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(HomeScreen));
    });
    const root = renderer.root;
    const loading = root.findAll((node) => (node.type as unknown) === "MobileLibraryLoading");
    const empty = root.findAll((node) => node.props.testID === "empty-library" && typeof node.type === "string");
    console.info("[UX-WAIT-04:phone-home] unsettled", JSON.stringify({ loading: loading.map((node) => node.props.label), empty: empty.length }));
    expect(empty).toHaveLength(0);
    expect(loading).toHaveLength(1);
    expect(loading[0]!.props).toMatchObject({ app: "badger", label: "nav.loadingLibrary" });
  });

  it("@req UX-WAIT-04 shows a saved library at once while the load still runs", async () => {
    ctl.settled = false;
    ctl.media = [{ id: "m1" }];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(HomeScreen));
    });
    const root = renderer.root;
    const loading = root.findAll((node) => (node.type as unknown) === "MobileLibraryLoading");
    const empty = root.findAll((node) => node.props.testID === "empty-library" && typeof node.type === "string");
    console.info("[UX-WAIT-04:phone-home] saved", JSON.stringify({ loading: loading.length, empty: empty.length }));
    expect(loading).toHaveLength(0);
    expect(empty).toHaveLength(0);
  });
});
