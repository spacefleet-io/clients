/**
 * @test-id PARROT-MOBILE-HOME-001
 * @level unit
 * @req PAR-HOME-01[parrot]
 * @req PAR-NAV-02[parrot]
 * @req PAR-NAV-04[parrot]
 * @req UX-WAIT-02[parrot]
 * @req PAR-EMPTY-01[parrot]
 * @req UX-WAIT-04[parrot]
 * @why The phone opens on Home (PAR-NAV-02) and its Home is the desktop's (PAR-HOME-01): "Jump back in" on the album
 *   last played on this phone with "artist · year · N songs", Resume and Shuffle and the wave; "Recently played"
 *   newest first; "Your artists" most played first; each "See all" opening the library's album or artist list; and,
 *   before anything is played, "Start listening" with Play over the library's albums. An empty or missing library shows
 *   the shared empty-library screen (PAR-EMPTY-01). Screens are called as functions against a mocked React Native,
 *   with translation keys standing for the texts. Home has no page title: the tab bar names the page (PAR-NAV-04).
 *   Chris, 2026-11-18: the empty library showed before the library had loaded; it waits for the album list of the
 *   open library, and until then Home shows the app's loading screen, "Loading library…" (UX-WAIT-04).
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ListeningHistory } from "@space/parrot-core";

const state = vi.hoisted(() => ({
  data: null as null | { albums: unknown[]; artists: unknown[]; songs: unknown[] },
  history: { version: 1, albums: [], artistPlays: {} } as ListeningHistory,
  played: [] as unknown[],
  libraryStatus: "ready" as string,
  /** Whether the query answered for the library version open now (the real hook's `answered`). */
  answered: true,
  /** The native player's state Home polls; null = nothing queued. */
  player: null as null | Record<string, unknown>,
  toggles: [] as string[],
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-HOME-001] ${step}`, JSON.stringify(detail));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useEffect = (fn: () => void | (() => void)) => void fn();
  const useState = <T,>(initial: T) => [initial, () => undefined];
  const useCallback = <T,>(fn: T) => fn;
  return { ...actual, default: { ...actual, useRef, useEffect, useLayoutEffect: useEffect, useState, useCallback }, useRef, useEffect, useLayoutEffect: useEffect, useState, useCallback };
});
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  FlatList: "FlatList",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(["House", "LibraryBig", "ListMusic", "Search", "Settings", "Pause", "Play", "Shuffle"].map((name) => [name, `Icon:${name}`]))
);
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }), useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: "SkyCover", useSkyScroll: () => ({}), MobileTabPager: "MobileTabPager", MobileFounderNoticeHost: "MobileFounderNoticeHost", MobileLibraryLoading: "MobileLibraryLoading" }));
vi.mock("../src/screens/EmptyLibrary", () => ({ EmptyLibrary: "EmptyLibrary" }));
vi.mock("@space/mobile-shell/render-boundary", () => ({ guardRenderItem: (_name: string, render: unknown) => render }));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; time?: string }) =>
      options?.time !== undefined ? `${key}@${options.time}` : options?.count === undefined ? key : `${key}#${options.count}`,
    i18n: { language: "en" },
  }),
}));
vi.mock("@space/mobile-shell/tab-bar", () => ({ MobileTabBar: "MobileTabBar" }));
vi.mock("../src/screens/art", () => ({ HomeWave: "HomeWave", ParrotArt: "ParrotArt" }));
vi.mock("../src/screens/AlbumGrid", () => ({ AlbumTile: "AlbumTile" }));
vi.mock("../src/screens/ui", () => ({ ErrorText: "ErrorText" }));
vi.mock("../src/screens/sky", () => ({ ParrotSky: "ParrotSky" }));
vi.mock("../src/screens/LibraryScreen", () => ({ LibraryScreen: "LibraryScreen" }));
vi.mock("../src/screens/PlaylistsView", () => ({ PlaylistsView: "PlaylistsView" }));
vi.mock("../src/screens/SettingsScreen", () => ({ SettingsScreen: "SettingsScreen" }));
vi.mock("../src/screens/NowPlayingBar", () => ({ NowPlayingBar: "NowPlayingBar" }));
vi.mock("../src/screens/PhoneSearch", () => ({ PhoneSearch: "PhoneSearch" }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ library: { status: state.libraryStatus, error: null, version: 1 } }) }));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 9 }));
vi.mock("../src/state/useQuery", () => ({ useQuery: () => ({ data: state.data, error: null, loading: !state.answered, answered: state.answered }) }));
vi.mock("../src/state/usePlay", () => ({
  usePlay: () => ({ play: async (...args: unknown[]) => void state.played.push(args), starting: null, error: null }),
}));
vi.mock("../src/state/usePlayerState", () => ({ usePlayerState: () => state.player, useNowPlaying: () => null }));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: { play: async () => void state.toggles.push("play"), pause: async () => void state.toggles.push("pause") },
  showsPause: (s: { playWhenReady: boolean; suppressed: boolean; state: string }) => s.playWhenReady && !s.suppressed && s.state !== "ended",
}));
vi.mock("../src/state/history", () => ({ useListeningHistory: () => state.history }));
vi.mock("../src/lib/library", () => ({ listAlbums: async () => [], listArtists: async () => [], listSongs: async () => [] }));

import { HomeScreen } from "../src/screens/HomeScreen";
import { nowPlayingTitles } from "../src/lib/nowPlaying";
import { MainScreen } from "../src/screens/MainScreen";

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
const byTestId = (node: unknown, id: string) => all(node, (el) => el.props?.testID === id)[0];
const texts = (node: unknown) => all(node, (el) => el.type === "Text").map((el) => el.props.children);
// Shelf is a component of HomeScreen's own: render it to reach its title, "See all" and list.
const shelf = (home: Element, id: string) => {
  const element = all(home, (el) => el.props?.testID === id)[0]!;
  return (element.type as (props: unknown) => Element)(element.props);
};

const albums = [
  { id: "alb-ht", title: "Hollow Signal", artistName: "Linnet Park", year: 2000, kind: "album", trackCount: 12, addedAt: 2 },
  { id: "alb-me", title: "Meltway", artistName: "Linnet Park", year: 2003, kind: "album", trackCount: 13, addedAt: 1 },
  { id: "alb-fm", title: "The Turning Tied", artistName: "Fern Minor", year: null, kind: "album", trackCount: 1, addedAt: 3 },
];
const artists = [
  { id: "art-fm", name: "Fern Minor", albumCount: 1, trackCount: 1 },
  { id: "art-lp", name: "Linnet Park", albumCount: 2, trackCount: 3 },
];
const songs = [
  { id: "t-nook", title: "Nook", albumId: "alb-me", artistId: "art-lp", disc: 1, number: 13, durationMs: 185_000 },
  { id: "t-fable", title: "Fable", albumId: "alb-me", artistId: "art-lp", disc: 1, number: 7, durationMs: 162_000 },
  { id: "t-end", title: "At the Gate", albumId: "alb-ht", artistId: "art-lp", disc: 1, number: 8, durationMs: 216_000 },
  { id: "t-rem", title: "Remember the Harbor", albumId: "alb-fm", artistId: "art-fm", disc: 1, number: 1, durationMs: 230_000 },
];

describe("the phone's Home", () => {
  it("opens first: Home is the active tab and gets its rows' See all", () => {
    const main = MainScreen({ navigation: { navigate: () => undefined }, route: {} } as never) as unknown as Element;
    const bar = all(main, (el) => el.type === "MobileTabBar")[0]!;
    const pager = all(main, (el) => el.type === "MobileTabPager")[0]!;
    const home = (pager.props.children as (tabId: string) => Element)("home");
    log("main", { activeTab: bar.props.activeTab, pagerTab: pager.props.activeTab, home: home.type === HomeScreen });
    expect(bar.props.activeTab).toBe("home");
    expect(pager.props.activeTab).toBe("home");
    expect(home.type).toBe(HomeScreen);
    expect(typeof home.props.onSeeAll).toBe("function");
    expect(typeof home?.props.onSeeAll).toBe("function");
  });

  it("after two Linnet Park albums: Jump back in on the last one, Recently played newest first, Linnet Park first in Your artists", () => {
    state.data = { albums, artists, songs };
    state.history = {
      version: 1,
      albums: [
        { albumId: "alb-me", trackId: "t-nook", positionMs: 78_000, playedAt: 20 },
        { albumId: "alb-ht", trackId: "t-end", positionMs: 30_000, playedAt: 10 },
      ],
      artistPlays: { "art-lp": 4 },
    } as ListeningHistory;
    const seeAll: string[] = [];
    const home = HomeScreen({ onSeeAll: (view) => void seeAll.push(view) }) as unknown as Element;
    // No page title (PAR-NAV-04): the page opens on the Jump back in card.
    const firstShown = [home.props.children].flat().find((child) => child !== null && child !== undefined && child !== false) as Element;
    log("top", { first: firstShown.props.testID, headings: all(home, (el) => el.props?.accessibilityRole === "header").length });
    expect(firstShown.props.testID).toBe("home-jump");
    expect(all(home, (el) => el.props?.accessibilityRole === "header")).toHaveLength(0);
    const jump = byTestId(home, "home-jump")!;
    log("jump", texts(jump));
    expect(texts(jump)).toContain("SHELL.HOME.JUMPBACKIN");
    expect(texts(jump)).toContain("Meltway");
    expect(byTestId(jump, "home-jump-detail")!.props.children).toBe("Linnet Park · 2003 · parrot.library.songs#13");
    expect(texts(byTestId(jump, "home-resume"))).toEqual(["shell.home.resume@1:18"]);
    expect(byTestId(jump, "home-shuffle")).toBeDefined();
    const wave = all(jump, (el) => el.type === "HomeWave")[0]!;
    log("wave", wave.props);
    expect(wave.props.progress).toBeCloseTo(78_000 / 185_000, 5);

    const recent = shelf(home, "home-albums");
    const recentList = all(recent, (el) => el.type === "FlatList")[0]!;
    log("recent", { title: texts(recent)[0], ids: (recentList.props.data as { id: string }[]).map((a) => a.id) });
    expect(texts(recent)[0]).toBe("shell.home.recentlyPlayed");
    expect((recentList.props.data as { title: string }[]).map((a) => a.title)).toEqual(["Meltway", "Hollow Signal"]);

    const yours = shelf(home, "home-artists");
    const artistList = all(yours, (el) => el.type === "FlatList")[0]!;
    log("artists", (artistList.props.data as { name: string }[]).map((a) => a.name));
    expect(texts(yours)[0]).toBe("shell.home.yourArtists");
    expect((artistList.props.data as { name: string }[])[0]?.name).toBe("Linnet Park");

    (byTestId(recent, "home-albums-see-all")!.props.onPress as () => void)();
    (byTestId(yours, "home-artists-see-all")!.props.onPress as () => void)();
    log("see-all", seeAll);
    expect(seeAll).toEqual(["albums", "artists"]);

    // Resume starts Nook at 1:18 in Meltway, in album order.
    (byTestId(jump, "home-resume")!.props.onPress as () => void)();
    const [queue, index, , options] = state.played.at(-1) as [{ title: string }[], number, unknown, { startPositionMs: number }];
    log("resume", { queue: queue.map((s) => s.title), index, options });
    expect(queue.map((s) => s.title)).toEqual(["Fable", "Nook"]);
    expect(queue[index]?.title).toBe("Nook");
    expect(options.startPositionMs).toBe(78_000);
  });

  // @req PAR-HOME-01
  // @bugfix @regression-proof Chris 2026-11-16: the card said "Resume 0:20" while Meltway was playing.
  it("while Meltway plays the card shows Pause and pauses it; paused, Resume names where the song stands and continues it", () => {
    nowPlayingTitles.set("t-nook", { title: "Nook", artist: "Linnet Park", album: "Meltway", albumId: "alb-me" });
    state.data = { albums, artists, songs };
    state.history = { version: 1, albums: [{ albumId: "alb-me", trackId: "t-nook", positionMs: 20_000, playedAt: 20 }], artistPlays: { "art-lp": 1 } } as ListeningHistory;
    state.played = [];
    state.toggles = [];
    const base = { mediaId: "t-nook", positionMs: 92_500, durationMs: 185_000, suppressed: false, state: "ready", index: 0, count: 2 };

    state.player = { ...base, playing: true, playWhenReady: true };
    let jump = byTestId(HomeScreen({ onSeeAll: () => undefined }), "home-jump")!;
    log("playing", { texts: texts(byTestId(jump, "home-resume")), wave: all(jump, (el) => el.type === "HomeWave")[0]?.props });
    expect(texts(byTestId(jump, "home-resume"))).toEqual(["player.controls.pause"]);
    expect(all(jump, (el) => el.type === "HomeWave")[0]!.props.progress).toBeCloseTo(0.5);
    (byTestId(jump, "home-resume")!.props.onPress as () => void)();

    state.player = { ...base, playing: false, playWhenReady: false };
    jump = byTestId(HomeScreen({ onSeeAll: () => undefined }), "home-jump")!;
    log("paused", { texts: texts(byTestId(jump, "home-resume")), toggles: state.toggles });
    expect(texts(byTestId(jump, "home-resume"))).toEqual(["shell.home.resume@1:32"]);
    (byTestId(jump, "home-resume")!.props.onPress as () => void)();

    log("presses", { toggles: state.toggles, played: state.played.length });
    expect(state.toggles).toEqual(["pause", "play"]);
    // Neither press restarts the album from the history's 0:20.
    expect(state.played).toEqual([]);
    state.player = null;
    nowPlayingTitles.clear();
  });

  it("before anything is played here: Start listening with Play on the library's first album, then its albums", () => {
    state.data = { albums, artists, songs };
    state.history = { version: 1, albums: [], artistPlays: {} };
    const home = HomeScreen({ onSeeAll: () => undefined }) as unknown as Element;
    const jump = byTestId(home, "home-jump")!;
    log("start", texts(jump));
    expect(texts(jump)).toContain("SHELL.HOME.STARTLISTENING");
    expect(texts(jump)).toContain("Hollow Signal");
    expect(texts(byTestId(jump, "home-resume"))).toEqual(["player.controls.play"]);
    expect(texts(shelf(home, "home-albums"))[0]).toBe("parrot.library.view.albums");
  });

  it("leaves out a missing year on the card", () => {
    state.data = { albums, artists, songs };
    state.history = { version: 1, albums: [{ albumId: "alb-fm", trackId: "t-rem", positionMs: 0, playedAt: 1 }], artistPlays: { "art-fm": 1 } } as ListeningHistory;
    const home = HomeScreen({ onSeeAll: () => undefined }) as unknown as Element;
    const detail = byTestId(home, "home-jump-detail")!;
    log("no-year", detail.props.children);
    expect(detail.props.children).toBe("Fern Minor · parrot.library.songs#1");
  });

  it("@req PAR-EMPTY-01 an empty or missing library shows the empty-library screen, not a one-line text", () => {
    state.data = { albums: [], artists: [], songs: [] };
    const empty = HomeScreen({ onSeeAll: () => undefined }) as unknown as Element;
    state.libraryStatus = "missing";
    const missing = HomeScreen({ onSeeAll: () => undefined }) as unknown as Element;
    state.libraryStatus = "ready";
    log("empty", { empty: empty.type, missing: missing.type });
    expect(empty.type).toBe("EmptyLibrary");
    expect(missing.type).toBe("EmptyLibrary");
  });

  it("@req UX-WAIT-04 while the library opens: the app's loading screen with \"Loading library…\", no spinner, no title", () => {
    state.libraryStatus = "loading";
    const home = HomeScreen({ onSeeAll: () => undefined }) as unknown as Element;
    state.libraryStatus = "ready";
    log("loading", { type: home.type, props: home.props, spinners: all(home, (el) => el.type === "ActivityIndicator").length });
    expect(home.type).toBe("MobileLibraryLoading");
    expect(home.props).toMatchObject({ app: "parrot", source: 9, label: "parrot.library.loading" });
    expect(all(home, (el) => el.type === "ActivityIndicator")).toHaveLength(0);
    expect(all(home, (el) => el.props?.accessibilityRole === "header")).toHaveLength(0);
  });

  it("@req UX-WAIT-04 opened but its albums not read yet: the loading screen, never the empty library", () => {
    state.answered = false;
    state.data = null;
    const unread = HomeScreen({ onSeeAll: () => undefined }) as unknown as Element;
    // The answer of the library version before (a new version just opened): not a verdict on this one either.
    state.data = { albums: [], artists: [], songs: [] };
    const stale = HomeScreen({ onSeeAll: () => undefined }) as unknown as Element;
    state.answered = true;
    const read = HomeScreen({ onSeeAll: () => undefined }) as unknown as Element;
    log("unanswered", { unread: unread.type, stale: stale.type, read: read.type });
    expect(unread.type).toBe("MobileLibraryLoading");
    expect(stale.type).toBe("MobileLibraryLoading");
    expect(read.type).toBe("EmptyLibrary");
  });
});
