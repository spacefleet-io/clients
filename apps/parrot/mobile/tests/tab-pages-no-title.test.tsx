/**
 * @test-id PARROT-MOBILE-TAB-NO-TITLE-001
 * @level unit
 * @req PAR-NAV-04[parrot]
 * @why Chris 2026-11-13: the phone's tab pages show no big page title, because the bottom tab bar already says which
 *   page is open (as on Badger's phone, UX-PHONE-01, UX-PHONE-02). The real MainScreen is rendered with the real shared
 *   tab bar: tapping each tab marks that tab selected (and only it) and opens its page, and nothing on screen is a
 *   heading. The Playlists page starts on its "New playlist" row. Home, Library and Settings are checked in their own
 *   tests (home-screen, library-tabs, settings-order). The unpaid notice sits around every screen of the navigator,
 *   not on the tab pages (ACCT-UNPAID-05): see screen-layout.test.tsx.
 */
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";

const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-TAB-NO-TITLE-001] ${step}`, JSON.stringify(detail));

vi.mock("react-native", () => {
  class Value {
    constructor(public value: number) {}
    setValue(next: number) {
      this.value = next;
    }
  }
  return {
    Animated: { Value, View: "AnimatedView", spring: () => ({ start: () => undefined, stop: () => undefined }) },
    FlatList: "FlatList",
    Platform: { select: (options: { default: unknown }) => options.default },
    Pressable: "Pressable",
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1 },
    Text: "Text",
    Vibration: { vibrate: () => undefined },
    View: "View",
    ScrollView: "ScrollView",
    ActivityIndicator: "ActivityIndicator",
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
vi.mock("lucide-react-native", () =>
  Object.fromEntries(["House", "LibraryBig", "ListMusic", "Search", "Settings", "Heart", "Plus"].map((name) => [name, `Icon:${name}`]))
);
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
// The shared tab bar is rendered for real; its theme module is the one `@space/mobile-shell/theme` names.
vi.mock("@space/mobile-shell/theme", () => ({
  UNAVAILABLE_LOOK: { opacity: 0.4 },
  useMobileShellTheme: () => ({ colors: { accent: "#40dd8f", textMuted: "#b6bace", textDim: "#555" }, font: { family: { sans: "Inter" } } }),
}));
vi.mock("@space/mobile-shell/sky-cover", () => ({
  SkyCover: ({ children, ...props }: { children?: unknown }) => createElement("SkyCover", props, children as never),
  useSkyScroll: () => ({}),
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}#${options.count}`), i18n: { language: "en" } }),
}));
// The shared tab pager is rendered for real too.
vi.mock("@space/mobile-shell/components", async () => ({
  SkyCover: "SkyCover",
  useSkyScroll: () => ({}),
  MobileTabPager: (await vi.importActual<typeof import("@space/mobile-shell/tab-pager")>(
    "../../../../packages/mobile-shell/src/components/mobile-tab-pager"
  )).MobileTabPager,
  MobileFounderNoticeHost: () => null,
}));
vi.mock("@space/mobile-shell/render-boundary", () => ({ guardRenderItem: (_id: string, fn: unknown) => fn }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }), useIsFocused: () => true }));
vi.mock("../src/theme", () => ({ colors: { accent: "#40dd8f", text: "#fff", textMuted: "#aaa", surface: "#111", border: "#333" }, spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } }));
vi.mock("../src/screens/sky", () => ({
  ParrotSky: ({ children }: { children?: unknown }) => createElement("ParrotSky", null, children as never),
}));
vi.mock("../src/screens/HomeScreen", () => ({ HomeScreen: "HomeScreen" }));
vi.mock("../src/screens/LibraryScreen", () => ({ LibraryScreen: "LibraryScreen" }));
vi.mock("../src/screens/PlaylistsView", () => ({ PlaylistsView: "PlaylistsView" }));
vi.mock("../src/screens/SettingsScreen", () => ({ SettingsScreen: "SettingsScreen" }));
vi.mock("../src/screens/NowPlayingBar", () => ({ NowPlayingBar: "NowPlayingBar" }));
vi.mock("../src/screens/PhoneSearch", () => ({ PhoneSearch: "PhoneSearch" }));
vi.mock("../src/screens/NoticeBell", () => ({ ParrotNoticeBell: "ParrotNoticeBell" }));
vi.mock("../src/screens/ui", () => ({ Body: "Body" }));
vi.mock("../src/screens/kept", () => ({ useOfflineReach: () => null }));
vi.mock("../src/state/session", () => ({
  useSession: () => ({ library: { status: "ready", version: 1 }, localChanges: 0, reloadLibrary: async () => undefined }),
}));
vi.mock("../src/state/useQuery", () => ({
  useQuery: () => ({ data: [{ id: "liked", name: "Liked songs", trackCount: 3 }, { id: "pl-1", name: "Hollow Signal mix", trackCount: 12 }], error: null, loading: false }),
}));
vi.mock("../src/state/playlistEditor", () => ({ usePlaylistEditor: () => ({ newPlaylist() {}, openSong() {} }) }));
vi.mock("../src/lib/library", () => ({ listPlaylists: async () => [] }));
vi.mock("../src/lib/playlists", () => ({ isLikedPlaylist: (id: string) => id === "liked" }));

import { MainScreen } from "../src/screens/MainScreen";

const PAGES = { home: "HomeScreen", library: "LibraryScreen", playlists: "PlaylistsView", settings: "SettingsScreen" } as const;
type Tab = keyof typeof PAGES;
const hosts = (root: ReactTestInstance, match: (node: ReactTestInstance) => boolean) => root.findAll((node) => typeof node.type === "string" && match(node));
const headings = (root: ReactTestInstance) => hosts(root, (node) => node.props.accessibilityRole === "header");
const tabButton = (tree: ReactTestRenderer, tab: Tab) => hosts(tree.root, (node) => node.props.testID === `tab-${tab}`)[0]!;
const selectedTabs = (tree: ReactTestRenderer) =>
  hosts(tree.root, (node) => node.props.accessibilityRole === "tab" && node.props.accessibilityState?.selected === true).map((node) => node.props.testID);
const pageShown = (tree: ReactTestRenderer) => Object.values(PAGES).filter((page) => tree.root.findAll((node) => String(node.type) === page).length > 0);

describe("the phone's tab pages have no page title", () => {
  beforeAll(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    // The pager mounts the pages not yet opened on an idle callback: never here, so a page shows once opened.
    vi.stubGlobal("requestIdleCallback", () => 0);
    vi.stubGlobal("cancelIdleCallback", () => undefined);
  });

  it("each tab, once tapped, is the one selected tab and opens its page, with no heading on screen", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(MainScreen, { navigation: { navigate: () => undefined }, route: {} } as never));
    });
    // The status-bar inset still pads the pages (applied once, around every tab).
    const content = hosts(tree.root, (node) => String(node.type) === "View" && JSON.stringify(node.props.style).includes('"paddingTop":24'));
    log("open", { selected: selectedTabs(tree), page: pageShown(tree), headings: headings(tree.root).length, insetPadded: content.length });
    expect(selectedTabs(tree)).toEqual(["tab-home"]);
    expect(pageShown(tree)).toEqual(["HomeScreen"]);
    expect(content).toHaveLength(1);

    for (const tab of ["library", "playlists", "settings", "home"] as const) {
      await act(async () => {
        tabButton(tree, tab).props.onPress();
      });
      const seen = { tab, selected: selectedTabs(tree), page: pageShown(tree), headings: headings(tree.root).length };
      log("tapped", seen);
      expect(seen.selected).toEqual([`tab-${tab}`]);
      // The pager keeps a page it has shown mounted beside the others; the tapped one is among them.
      expect(seen.page).toContain(PAGES[tab]);
      expect(seen.headings).toBe(0);
      // The tab's own label names the page: the selected button reads it.
      expect(tabButton(tree, tab).props.accessibilityLabel).toMatch(/nav\./);
    }
  });

  it("the Playlists page starts on its New playlist row, with no heading above it", async () => {
    const { PlaylistsView } = await vi.importActual<typeof import("../src/screens/PlaylistsView")>("../src/screens/PlaylistsView");
    const list = PlaylistsView() as ReactElement<{ ListHeaderComponent: ReactElement }>;
    let header!: ReactTestRenderer;
    await act(async () => {
      header = create(list.props.ListHeaderComponent);
    });
    const pressables = hosts(header.root, (node) => String(node.type) === "Pressable").map((node) => node.props.testID);
    const texts = hosts(header.root, (node) => String(node.type) === "Text").map((node) => node.props.children);
    log("playlists header", { pressables, texts, headings: headings(header.root).length });
    expect(headings(header.root)).toHaveLength(0);
    expect(pressables).toEqual(["playlist-new"]);
    expect(texts).toEqual(["shell.playlists.new"]);
  });

  /** @req UX-PHONE-09[parrot] */
  it("a swipe that settles on another page selects its tab, as on Badger's phone", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(MainScreen, { navigation: { navigate: () => undefined }, route: {} } as never));
    });
    const pager = hosts(tree.root, (node) => node.props.testID === "tab-pager")[0]!;
    expect(pager.props.pagingEnabled).toBe(true);
    // Pages are 390 wide (the mocked window): the third page is Playlists.
    await act(async () => pager.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 2 * 390 } } }));
    log("swiped", { selected: selectedTabs(tree), page: pageShown(tree) });
    expect(selectedTabs(tree)).toEqual(["tab-playlists"]);
    expect(pageShown(tree)).toContain(PAGES.playlists);
  });
});
