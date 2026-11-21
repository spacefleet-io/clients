/**
 * @test-id PARROT-MOBILE-LIBRARY-TABS-001
 * @level unit
 * @req PAR-LOOK-01[parrot]
 * @req PAR-NAV-02[parrot]
 * @req PAR-NAV-04[parrot]
 * @req UX-WAIT-02[parrot]
 * @req UX-WAIT-04[parrot]
 * @req UX-PHONE-12[parrot]
 * @why The approved phone design: a bottom tab bar (the fleet's shared one) with Home, Library, Playlists and
 *   Settings over Parrot's sky, and the bar's centre Search button between Library and Playlists that opens the search
 *   card and is not a page (Chris, 2026-11-19: the swipe goes from Library straight to Playlists); the floating mini
 *   player sits above the tab bar; the Library has no page title (the tab bar names it, PAR-NAV-04) and no search of its
 *   own (the bar's button replaces it), no add-music button (the phone only plays), and Albums / Artists / Songs chips (playlists have
 *   their own tab) over a line with the sort and the count; and the player's header reads "Playing from album" over
 *   the album's name, with the time left as "−m:ss". Screens are called as functions against a mocked React Native,
 *   with translation keys standing for the texts. Chris, 2026-11-18: the empty library showed before the library had
 *   loaded; the Library tab shows the app's loading screen, "Loading library…", until its album list is read.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  now: null as null | { trackId: string; albumId: string | null; album: string | null; playing: boolean },
  player: null as null | Record<string, unknown>,
  libraryStatus: "ready" as string,
  /** What every library query answers (the real hook's shape): one album, read for the open library version. */
  query: { data: [{ id: "al-lo", title: "Low Orbit", artistName: "Nova", year: 2020, kind: "album", trackCount: 9, addedAt: 1 }] as unknown[] | null, error: null, loading: false, answered: true },
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-LIBRARY-TABS-001] ${step}`, JSON.stringify(detail));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useEffect = (fn: () => void | (() => void)) => void fn();
  const useState = <T,>(initial: T | (() => T)) => [typeof initial === "function" ? (initial as () => T)() : initial, () => undefined];
  const useCallback = <T,>(fn: T) => fn;
  const useMemo = <T,>(fn: () => T) => fn();
  const hooks = { useRef, useEffect, useLayoutEffect: useEffect, useState, useCallback, useMemo };
  return { ...actual, default: { ...actual, ...hooks }, ...hooks };
});
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: () => undefined },
  Modal: "Modal",
  ScrollView: "ScrollView",
  Animated: { Value: class {}, View: "AnimatedView", timing: () => ({ start: () => undefined }) },
  Easing: { in: (f: unknown) => f, out: (f: unknown) => f, cubic: () => 0 },
  Platform: { OS: "ios" },
  FlatList: "FlatList",
  Image: "Image",
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle", Defs: "Defs", LinearGradient: "LinearGradient", Rect: "Rect", Stop: "Stop" }));
vi.mock("react-native-gesture-handler", () => ({ GestureDetector: "GestureDetector" }));
vi.mock("@space/mobile-shell/bottom-sheet", () => ({
  MobileBottomSheet: "MobileBottomSheet",
  MobileSheetScrollView: "ScrollView",
  useMobileDismissPan: () => () => ({}),
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    ["House", "LibraryBig", "ListMusic", "Settings", "Pause", "Play", "SkipBack", "SkipForward", "Volume", "Volume2", "ArrowUpDown", "FolderUp", "Search", "X", "Cast", "ChevronDown", "Ellipsis", "Heart", "Mic", "Repeat", "Repeat1", "Shuffle"].map((name) => [name, `Icon:${name}`])
  )
);
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }), useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@space/mobile-shell/components", () => ({ MobileTabPager: "MobileTabPager", SkyCover: "SkyCover", useSkyScroll: () => ({}), MobileFounderNoticeHost: "MobileFounderNoticeHost", MobileLibraryLoading: "MobileLibraryLoading" }));
vi.mock("../src/screens/EmptyLibrary", () => ({ EmptyLibrary: "EmptyLibrary" }));
vi.mock("../src/screens/sky", () => ({ ParrotSky: "ParrotSky", PLAYER_TINT: "tint" }));
vi.mock("../src/screens/HomeScreen", () => ({ HomeScreen: "HomeScreen" }));
vi.mock("../src/screens/PlaylistsView", () => ({ PlaylistsView: "PlaylistsView" }));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}#${options.count}`), i18n: { language: "en" } }),
}));
vi.mock("@space/mobile-shell/tab-bar", () => ({ MobileTabBar: "MobileTabBar" }));
vi.mock("../src/screens/PhoneSearch", () => ({ PhoneSearch: "PhoneSearch" }));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: { canShowOutputSwitcher: async () => false },
  showsPause: (s: { playWhenReady: boolean; suppressed?: boolean }) => s.playWhenReady && !s.suppressed,
}));
vi.mock("@space/mobile-media-volume", () => ({ useMediaVolume: () => ({ level: null }), VolumeSlider: "VolumeSlider" }));
vi.mock("../src/state/usePlayerState", () => ({ useNowPlaying: () => state.now, usePlayerState: () => state.player }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ library: { status: state.libraryStatus, version: 1 }, reloadLibrary: async () => undefined }) }));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 9 }));
vi.mock("../src/state/useQuery", () => ({ useQuery: () => state.query }));
vi.mock("../src/state/usePlay", () => ({ usePlay: () => ({ play: async () => undefined, starting: null, error: null }) }));
vi.mock("../src/lib/library", () => ({ listAlbums: async () => [], listArtists: async () => [], listSongs: async () => [] }));
// The player's shuffle button goes through the queue builder, which drives the native media proxy.
vi.mock("../src/lib/playback", () => ({ setPlaybackShuffle: async () => undefined }));
vi.mock("../src/state/playlistEditor", () => ({
  usePlaylistEditor: () => ({ playlists: [], liked: () => false, toggleLike() {}, openSong() {}, addToPlaylist() {}, newPlaylist() {}, renamePlaylist() {}, deletePlaylist() {} }),
}));
vi.mock("../src/screens/SettingsScreen", () => ({ SettingsScreen: "SettingsScreen" }));
vi.mock("../src/screens/NowPlayingBar", () => ({ NowPlayingBar: "NowPlayingBar" }));
vi.mock("../src/screens/kept", () => ({ useKept: () => ({ entry: () => undefined, state: () => "off", holdsSong: () => false }), useOfflineReach: () => null }));

import { MAIN_TABS, MainScreen } from "../src/screens/MainScreen";
import { CountLine, LIBRARY_SORT, LibraryScreen } from "../src/screens/LibraryScreen";
import { PlayerScreen, remainingLabel } from "../src/screens/PlayerScreen";
import { nowPlayingTitles } from "../src/lib/nowPlaying";
import { Chips, IconButton } from "../src/screens/ui";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
  }
  return out;
};
const texts = (node: unknown) => all(node, (el) => el.type === "Text").map((el) => el.props.children);
const navigation = { navigate: () => undefined, setOptions: (options: Record<string, unknown>) => void state.options.push(options) };

describe("the phone's tabs", () => {
  it("are Home, Library, Playlists and Settings on the shared tab bar over the sky, with the mini player above it", () => {
    const main = MainScreen({ navigation, route: {} } as never) as unknown as Element;
    const order = all(main, (el) => el.type === "NowPlayingBar" || el.type === "MobileTabBar").map((el) => el.type);
    const bar = all(main, (el) => el.type === "MobileTabBar")[0]!;
    const tabs = bar.props.tabs as { id: string; label: string; icon: unknown }[];
    log("main", { order, tabs });
    expect(main.type).toBe("ParrotSky");
    expect(tabs.map((tab) => [tab.id, tab.label, tab.icon])).toEqual([
      ["home", "shell.nav.home", "Icon:House"],
      ["library", "parrot.nav.library", "Icon:LibraryBig"],
      ["playlists", "parrot.nav.playlistsTab", "Icon:ListMusic"],
      ["settings", "parrot.nav.settingsTab", "Icon:Settings"],
    ]);
    expect(MAIN_TABS.map((tab) => tab.id)).toEqual(["home", "library", "playlists", "settings"]);
    expect(bar.props.activeTab).toBe("home");
    expect(order).toEqual(["NowPlayingBar", "MobileTabBar"]);
    expect(bar.props.style).toMatchObject({ position: "relative" });
    // The pages sit in the shared swipe pager (UX-PHONE-09), in tab-bar order; its Home page is the Home screen.
    const pager = all(main, (el) => el.type === "MobileTabPager")[0]!;
    expect(pager.props.tabIds).toEqual(["home", "library", "playlists", "settings"]);
    expect(pager.props.activeTab).toBe("home");
    expect(all((pager.props.children as (id: string) => unknown)("home"), (el) => el.type === "HomeScreen")).toHaveLength(1);
  });

  it("@req UX-PHONE-12 have the Search button in the bar's centre, after Library: it opens the search card and is never a page", () => {
    const main = MainScreen({ navigation, route: {} } as never) as unknown as Element;
    const bar = all(main, (el) => el.type === "MobileTabBar")[0]!;
    const action = bar.props.action as { id: string; label: string; icon: unknown; after: string; disabled: boolean; onPress: () => void };
    const search = all(main, (el) => el.type === "PhoneSearch")[0]!;
    log("search action", { action, search: search.props });
    expect(action).toMatchObject({ id: "search", label: "Search", icon: "Icon:Search", after: "library", disabled: false });
    expect(search.props.visible).toBe(false);
    // Not a page: the swipe goes from Library straight to Playlists.
    const pager = all(main, (el) => el.type === "MobileTabPager")[0]!;
    const tabIds = [pager.props.tabIds].flat().map(String);
    expect(tabIds).not.toContain("search");
    expect(tabIds.indexOf("playlists") - tabIds.indexOf("library")).toBe(1);
  });
});

describe("the Library tab", () => {
  it("@req UX-WAIT-04 while the library opens: the app's loading screen with \"Loading library…\", no spinner", () => {
    state.libraryStatus = "loading";
    const opening = LibraryScreen({ active: true, viewRequest: null }) as unknown as Element;
    state.libraryStatus = "ready";
    log("opening", { type: opening.type, props: opening.props });
    expect(opening.type).toBe("MobileLibraryLoading");
    expect(opening.props).toMatchObject({ app: "parrot", source: 9, label: "parrot.library.loading" });
    expect(all(opening, (el) => el.type === "ActivityIndicator")).toHaveLength(0);
  });

  it("@req UX-WAIT-04 opened but its albums not read yet: the loading screen, never the empty library", () => {
    const read = state.query;
    state.query = { ...read, data: [], loading: true, answered: false };
    const unread = LibraryScreen({ active: true, viewRequest: null }) as unknown as Element;
    state.query = { ...read, data: [], answered: true };
    const empty = LibraryScreen({ active: true, viewRequest: null }) as unknown as Element;
    state.query = read;
    log("unanswered", { unread: unread.type, empty: empty.type });
    expect(unread.type).toBe("MobileLibraryLoading");
    expect(empty.type).toBe("EmptyLibrary");
  });

  it("has no page title and no search of its own: Albums / Artists / Songs chips at the top, Albums first, and no Kept offline chip", () => {
    const library = LibraryScreen({ active: true, viewRequest: null }) as unknown as Element;
    const [head, ...rest] = [library.props.children].flat().filter(Boolean) as Element[];
    const headParts = [head!.props.children].flat().filter(Boolean) as Element[];
    log("head", { parts: headParts.map((el) => el.type), headings: all(library, (el) => el.props?.accessibilityRole === "header").length });
    expect(all(library, (el) => el.props?.accessibilityRole === "header")).toHaveLength(0);
    // The first row is the chips (in their side-scroll): nothing above them, no search beside them (UX-PHONE-12).
    expect(headParts.map((el) => el.type)).toEqual(["ScrollView"]);
    expect(all(headParts[0], (el) => el.type === Chips)).toHaveLength(1);
    expect(all(library, (el) => el.type === IconButton)).toHaveLength(0);
    expect(all(library, (el) => el.type === "TextInput")).toHaveLength(0);
    expect(rest.length).toBeGreaterThan(0);
    const chips = all(library, (el) => el.type === Chips)[0]!;
    log("chips", chips.props.options);
    expect(chips.props.value).toBe("albums");
    expect(chips.props.options).toEqual([
      { id: "albums", label: "parrot.library.view.albums" },
      { id: "artists", label: "parrot.library.view.artists" },
      { id: "songs", label: "parrot.library.view.songs" },
    ]);
    const rendered = Chips(chips.props as never) as unknown as Element;
    const selected = all(rendered, (el) => el.type === "Pressable").map((el) => (el.props.accessibilityState as { selected: boolean }).selected);
    expect(selected).toEqual([true, false, false]);
    expect(all(library, (el) => el.props?.testID === "library-chip-kept" || el.props?.testID === "library-add")).toEqual([]);
  });

  it("says how each view is sorted (with the sort mark) and how many it holds", () => {
    for (const view of ["albums", "artists", "songs"] as const) {
      const line = CountLine({ view, count: 248 }) as unknown as Element;
      log("count", { view, texts: texts(line) });
      expect(texts(line)).toEqual([LIBRARY_SORT[view], `parrot.library.${view}#248`]);
      expect(all(line, (el) => el.type === "Icon:ArrowUpDown")).toHaveLength(1);
    }
    expect(texts(CountLine({ view: "songs", count: null }))).toEqual([LIBRARY_SORT.songs]);
  });

  // @req PAR-HOME-01[parrot]
  it("opens on the list Home's \"See all\" asked for: Artists for Your artists", () => {
    const library = LibraryScreen({ active: true, viewRequest: { view: "artists" } }) as unknown as Element;
    const chips = all(library, (el) => el.type === Chips)[0]!;
    log("see-all-artists", { value: chips.props.value });
    expect(chips.props.value).toBe("artists");
  });
});

describe("the player", () => {
  const playing = { mediaId: "t2", positionMs: 61_000, durationMs: 200_000, playWhenReady: true, playing: true, shuffle: true, repeat: "one", error: null };

  it("reads PLAYING FROM ALBUM over the album's name, with the time left", () => {
    nowPlayingTitles.set("t2", { title: "Drift", artist: "Nova", album: "Low Orbit", albumId: "al-lo" });
    state.player = playing;
    const screen = PlayerScreen() as unknown as Element;
    const shown = texts(screen);
    log("player", shown);
    expect(shown.slice(0, 2)).toEqual(["PARROT.PLAYER.PLAYINGFROMALBUM", "Low Orbit"]);
    expect(shown).toContain("\u22122:19");
    expect(all(screen, (el) => el.type === "Icon:Repeat1")).toHaveLength(1);
    expect(all(screen, (el) => el.props?.testID === "player-lyrics" || el.props?.testID === "player-queue")).toHaveLength(2);
    state.player = null;
  });

  it("shows the time left as minus the rest of the song", () => {
    expect(remainingLabel(61_000, 200_000)).toBe("\u22122:19");
    expect(remainingLabel(250_000, 200_000)).toBe("\u22120:00");
  });
});
