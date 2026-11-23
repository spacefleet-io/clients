/**
 * @test-id PARROT-MOBILE-EMPTY-TAB-001
 * @level unit
 * @req UX-LIBTAB-01[parrot]
 * @req UX-WAIT-04[parrot]
 * @why Chris, 2026-11-16: "when a user's library is empty we decided that the library page couldn't be opened but on
 *   parrot it currently can, it should be the same behaviour on both apps. also the button should be greyed out so it
 *   doesn't look like a bug". The real MainScreen with the real shared tab bar and pager: while the account has no
 *   library, or its library has no album, the Library tab is greyed out, marked disabled, a
 *   tap or a swipe does not open it and Home's "See all" opens nothing; the first album (a new library version) opens
 *   it again with no restart. Chris, 2026-11-16: "if library is greyed out when empty, then the playlist menu should
 *   also be greyed out and unaccissible": the Playlists tab follows the Library tab. Chris, 2026-11-18, on a test phone: "I can't
 *   click the library and playlists buttons on the bottom menu, but they are not greyed out at all so it's very
 *   confusing and looks like a bug": greyed out is the idle colour at half opacity (as on desktop and TV), never the
 *   theme's slightly darker dim colour. Chris, 2026-11-18: the empty library shows before the library has loaded:
 *   while the album list of the open library version is not read yet, the tabs stay open (UX-WAIT-04).
 */
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";

const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-EMPTY-TAB-001] ${step}`, JSON.stringify(detail));

const state = vi.hoisted(() => ({
  library: { status: "ready", version: 1 } as { status: string; version: number },
  albums: [] as unknown[] | null,
  /** Whether the album list was read for the library version open now (the real hook's `answered`). */
  answered: true,
  seeAll: null as null | ((view: "albums" | "artists") => void),
}));

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
vi.mock("lucide-react-native", () => Object.fromEntries(["House", "LibraryBig", "ListMusic", "Settings"].map((name) => [name, `Icon:${name}`])));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@space/mobile-shell/theme", () => ({
  UNAVAILABLE_LOOK: { opacity: 0.4 },
  useMobileShellTheme: () => ({ colors: { accent: "#40dd8f", textMuted: "#b6bace", textDim: "#555" }, font: { family: { sans: "Inter" } } }),
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@space/mobile-shell/components", async () => ({
  MobileTabPager: (await vi.importActual<typeof import("../../../../packages/mobile-shell/src/components/mobile-tab-pager")>(
    "../../../../packages/mobile-shell/src/components/mobile-tab-pager"
  )).MobileTabPager,
  MobileFounderNoticeHost: () => null,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("../src/screens/sky", () => ({ ParrotSky: ({ children }: { children?: unknown }) => createElement("ParrotSky", null, children as never) }));
vi.mock("../src/screens/HomeScreen", () => ({
  HomeScreen: ({ onSeeAll }: { onSeeAll: (view: "albums" | "artists") => void }) => {
    state.seeAll = onSeeAll;
    return createElement("HomeScreen");
  },
}));
vi.mock("../src/screens/LibraryScreen", () => ({ LibraryScreen: "LibraryScreen" }));
vi.mock("../src/screens/PlaylistsView", () => ({ PlaylistsView: "PlaylistsView" }));
vi.mock("../src/screens/SettingsScreen", () => ({ SettingsScreen: "SettingsScreen" }));
vi.mock("../src/screens/NowPlayingBar", () => ({ NowPlayingBar: "NowPlayingBar" }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ library: state.library }) }));
// The albums the library's current version holds (the real hook reruns `listAlbums` on each new version).
vi.mock("../src/state/useQuery", () => ({
  useQuery: () => ({ data: state.library.status === "ready" ? state.albums : null, error: null, loading: !state.answered, answered: state.answered }),
}));
vi.mock("../src/lib/library", () => ({ listAlbums: async () => state.albums }));

import { MainScreen } from "../src/screens/MainScreen";

const hosts = (root: ReactTestInstance, match: (node: ReactTestInstance) => boolean) => root.findAll((node) => typeof node.type === "string" && match(node));
const navTab = (tree: ReactTestRenderer, id: "library" | "playlists" = "library") => {
  const tab = hosts(tree.root, (node) => node.props.testID === `tab-${id}`)[0]!;
  const label = hosts(tab, (node) => String(node.type) === "Text")[0]!;
  // Greyed out: the whole tab (icon and label) at half opacity, in the idle colour, never the dim one.
  const greyed =
    JSON.stringify(tab.props.style).includes('"opacity":0.5') && JSON.stringify(label.props.style).includes("#b6bace") && !JSON.stringify(label.props.style).includes("#555");
  const seen = { disabled: tab.props.disabled === true, a11yDisabled: tab.props.accessibilityState?.disabled === true, greyed };
  log(`${id} tab`, seen);
  return { tab, seen };
};
const selected = (tree: ReactTestRenderer) =>
  hosts(tree.root, (node) => node.props.accessibilityRole === "tab" && node.props.accessibilityState?.selected === true).map((node) => node.props.testID);
const pagerPages = (tree: ReactTestRenderer) => hosts(tree.root, (node) => node.props.testID === "tab-pager")[0]!;
const render = async () => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(MainScreen, { navigation: { navigate: () => undefined }, route: {} } as never));
  });
  return tree;
};
const rerender = async (tree: ReactTestRenderer) => {
  await act(async () => tree.update(createElement(MainScreen, { navigation: { navigate: () => undefined }, route: {} } as never)));
};

describe("PARROT-MOBILE-EMPTY-TAB-001 the phone's Library tab while the library is empty", () => {
  beforeAll(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestIdleCallback", () => 0);
    vi.stubGlobal("cancelIdleCallback", () => undefined);
  });

  it("an opened library with no album: Library and Playlists greyed out, disabled (React Native ignores a tap), a swipe and See all keep Home", async () => {
    state.library = { status: "ready", version: 1 };
    state.albums = [];
    const tree = await render();
    expect(navTab(tree).seen).toEqual({ disabled: true, a11yDisabled: true, greyed: true });
    expect(navTab(tree, "playlists").seen).toEqual({ disabled: true, a11yDisabled: true, greyed: true });
    await act(async () => state.seeAll?.("albums"));
    // Two open pages, Home and Settings: the second page swiped to is Settings, never the Library or Playlists.
    await act(async () => pagerPages(tree).props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0 } } }));
    log("after see all", { selected: selected(tree) });
    expect(selected(tree)).toEqual(["tab-home"]);
    expect(tree.root.findAll((node) => String(node.type) === "LibraryScreen")).toHaveLength(0);
    await act(async () => pagerPages(tree).props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 390 } } }));
    expect(selected(tree)).toEqual(["tab-settings"]);
    expect(tree.root.findAll((node) => String(node.type) === "PlaylistsView")).toHaveLength(0);
  });

  it("no library on this account yet: Library and Playlists are greyed out too", async () => {
    state.library = { status: "missing", version: 0 };
    state.albums = null;
    const tree = await render();
    expect(navTab(tree).seen).toEqual({ disabled: true, a11yDisabled: true, greyed: true });
    expect(navTab(tree, "playlists").seen).toEqual({ disabled: true, a11yDisabled: true, greyed: true });
  });

  it("still opening: the tabs stay open (the library is not known empty)", async () => {
    state.library = { status: "loading", version: 0 };
    state.albums = null;
    const tree = await render();
    expect(navTab(tree).seen).toEqual({ disabled: false, a11yDisabled: false, greyed: false });
    expect(navTab(tree, "playlists").seen).toEqual({ disabled: false, a11yDisabled: false, greyed: false });
  });

  it("@req UX-WAIT-04 opened but its albums not read yet: the tabs stay open (not known empty)", async () => {
    state.library = { status: "ready", version: 1 };
    state.albums = [];
    state.answered = false;
    const tree = await render();
    const seen = { library: navTab(tree).seen, playlists: navTab(tree, "playlists").seen };
    state.answered = true;
    log("ready, unanswered", seen);
    expect(seen.library).toEqual({ disabled: false, a11yDisabled: false, greyed: false });
    expect(seen.playlists).toEqual({ disabled: false, a11yDisabled: false, greyed: false });
  });

  it.each(["library", "playlists"] as const)("the first album lands: the %s tab opens, with no restart", async (id) => {
    state.library = { status: "ready", version: 1 };
    state.albums = [];
    const tree = await render();
    expect(navTab(tree, id).seen.disabled).toBe(true);
    state.library = { status: "ready", version: 2 };
    state.albums = [{ id: "al-meltway", title: "Meltway" }];
    await rerender(tree);
    const { tab, seen } = navTab(tree, id);
    expect(seen).toEqual({ disabled: false, a11yDisabled: false, greyed: false });
    await act(async () => tab.props.onPress());
    expect(selected(tree)).toEqual([`tab-${id}`]);
    expect(tree.root.findAll((node) => String(node.type) === (id === "library" ? "LibraryScreen" : "PlaylistsView")).length).toBeGreaterThan(0);
  });
});
