/**
 * @test-id TV-HOME-LIBRARY-LAYOUT-001
 * @level component
 * @why The v2 TV redesign (Chris 2026-11-12 (chat): "your tv client redesign is good, you can implement it"): Home is the
 *   Continue watching card (Resume has the focus) and ONE "Recently added" row on the sky; without a title in progress the
 *   first poster takes the focus. The Library has the Movies / TV shows switch at the left and the sort chip at the right
 *   of one line, then eight captioned posters across at the screen margin, with no title, count or focused-title line.
 *   Playlists is its own top-bar section, not a Library tab (Chris 2026-11-13, as on the phone): one chip per playlist
 *   over that playlist's grid (UX-TV-37). An empty library shows the freestanding Badger. TV-SCALE-HOME-001 (UX-TV-13):
 *   on an Apple TV (1920x1080 points) both screens are the 960x540 design at twice the size. The remote's moves are
 *   pinned through the focus guides: each band (bar, chips, grid) is one full-width `TVFocusGuideView` with `autoFocus`,
 *   so UP and DOWN go band to band and land on the last focused control of the band (the first at first).
 *   Rendered with react-test-renderer: react-native is replaced by host-element stand-ins, the library by fakes; the
 *   shared chips (`TvSegmented`, `TvChip`) are the real ones.
 *
 * @req UX-TV-05[badger-tv]
 * @req UX-TV-09[badger-tv]
 * @req UX-TV-11[badger-tv]
 * @req UX-TV-18[badger-tv]
 * @req UX-TV-37[badger-tv]
 * @req UX-TV-13[badger-tv]
 * @req UX-TV-14[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRow, PlaylistRow } from "@space/shared/libraryTypes";
import { TV_LIBRARY_COLUMNS, TV_LIBRARY_GAP_X, TV_LIBRARY_GAP_Y, TV_SCREEN_X, tvHomeCardWidth, tvLibraryCardWidth } from "../lib/layout";
import { homeRows, TvHomeScreen } from "./TvHomeScreen";
import { nextLibrarySort, TvLibraryScreen } from "./TvLibraryScreen";
import { TvPlaylistsScreen, tvPlaylistName, tvPlaylistOrder, tvPlaylistTitles } from "./TvPlaylistsScreen";

const ctl = vi.hoisted(() => ({
  media: [] as unknown[],
  playlists: [] as unknown[],
  playlistItems: {} as Record<string, string[]>,
  window: { width: 960, height: 540 },
  loading: false,
  reload: (() => undefined) as () => void,
  navigate: (() => undefined) as (...args: unknown[]) => void,
  settings: { libraryView: { movie: { sortBy: "name", sortDirection: "asc" }, tv: { sortBy: "name", sortDirection: "asc" } } } as Record<string, unknown>,
  updateSettings: (() => undefined) as (patch: unknown) => void,
  playerParams: (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>,
  /** What the library store reports: the load error line and the load status (UX-TV-14). */
  error: null as string | null,
  loadStatus: { kind: "ready" } as { kind: string },
}));

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    ScrollView: host("ScrollView"),
    FlatList: host("FlatList"),
    TVFocusGuideView: host("TVFocusGuideView"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    useWindowDimensions: () => ctl.window,
  };
});
vi.mock("lucide-react-native", () => ({
  Film: "FilmIcon",
  Tv: "TvIcon",
  ArrowDownUp: "SortIcon",
  ChevronDown: "ChevronDownIcon",
}));
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: "SkyCover", useSkyScroll: () => ({}) }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: (...args: unknown[]) => ctl.navigate(...args) }) }));
/** One actions object for the whole run, as the real store gives: a new one per render would refetch forever. */
const libraryActions = vi.hoisted(() => ({
  getMediaDetails: async () => null,
  listPlaylistItems: async (id: string) => ctl.playlistItems[id] ?? [],
}));
vi.mock("../../store/library", () => ({
  useLibraryData: () => ({ media: ctl.media, playlists: ctl.playlists }),
  useLibraryStatus: () => ({ loading: ctl.loading, error: ctl.error, loadStatus: ctl.loadStatus, reload: ctl.reload }),
  useLibraryActions: () => libraryActions,
}));
vi.mock("../../lib/resume", () => ({ getLastPlayedEpisodeId: async () => null }));
vi.mock("../../lib/useFavoriteIds", () => ({ useFavoriteIds: () => new Set<string>() }));
vi.mock("../../lib/appSettings", () => ({ useAppSettings: () => [ctl.settings, (patch: unknown) => ctl.updateSettings(patch)] }));
vi.mock("../../lib/libraryScreenState", () => ({
  selectLibraryItems: ({ media, tab }: { media: readonly MediaRow[]; tab: string }) => media.filter((item) => item.type === tab),
}));
vi.mock("../components/TvFocusable", () => ({ TvFocusable: "TvFocusable", FOCUS_SCALE: 1.05 }));
vi.mock("../components/TvPosterCard", () => ({ TvPosterCard: "TvPosterCard" }));
vi.mock("../components/TvRail", () => ({ TvRail: "TvRail" }));
vi.mock("../components/TvContinueHero", () => ({ TvContinueHero: "TvContinueHero" }));
vi.mock("../components/TvEmptyLibrary", () => ({ TvEmptyLibrary: "TvEmptyLibrary" }));
vi.mock("../lib/continueStart", () => ({ continuePlayerParams: (...args: unknown[]) => ctl.playerParams(...args) }));

const row = (id: string, type: "movie" | "tv", patch: Partial<MediaRow> = {}): MediaRow =>
  ({
    id,
    type,
    title: id,
    year: null,
    genres: [],
    progressPct: 0,
    lastWatchedAt: null,
    addedAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  }) as MediaRow;

const playlist = (id: string, name: string, slug: string | null = null): PlaylistRow => ({
  id,
  name,
  slug,
  isSystem: slug !== null,
  createdAt: "2026-10-01T00:00:00.000Z",
});

const MEDIA = [
  row("m1", "movie", { progressPct: 40, lastWatchedAt: "2026-10-27T20:00:00.000Z" }),
  row("m2", "movie", { year: "2019" }),
  row("s1", "tv"),
  row("s2", "tv", { progressPct: 20, lastWatchedAt: "2026-10-20T20:00:00.000Z" }),
];

const PLAYLISTS = [playlist("p-road", "Road trip"), playlist("p-watch", "Watchlist", "watchlist"), playlist("p-fav", "Favorites", "favorites"), playlist("p-art", "Art house")];

const render = (element: React.ReactElement, media: readonly MediaRow[] = MEDIA): ReactTestRenderer => {
  ctl.media = [...media];
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
};

const isType = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, number | string>;
const childElements = (node: ReactTestInstance) => node.children.filter((child): child is ReactTestInstance => typeof child !== "string");
const textOf = (node: ReactTestInstance): string =>
  node.findAll((n) => isType(n, "Text")).map((n) => [n.props.children].flat().filter((c) => typeof c === "string").join("")).join(" ");
/** The focusable controls inside a node, in the order the remote meets them (left to right, top to bottom). */
const focusOrder = (node: ReactTestInstance) => node.findAll((n) => isType(n, "TvFocusable")).map((n) => n.props.testID as string);
/** The full-width focus bands of the Library, top to bottom. */
const bands = (tree: ReactTestRenderer) => tree.root.findAll((n) => isType(n, "TVFocusGuideView"));

beforeEach(() => {
  ctl.loading = false;
  ctl.error = null;
  ctl.loadStatus = { kind: "ready" };
  ctl.playlists = [];
  ctl.playlistItems = {};
  ctl.reload = vi.fn();
  ctl.navigate = vi.fn();
  ctl.updateSettings = vi.fn();
  ctl.playerParams = vi.fn(async () => ({ mediaId: "m1", episodeId: null, startAt: "resume" }));
});

describe("TV Home: the Continue watching card and one row (TV-BADGER-HOME-LIBRARY-001)", () => {
  it("@req UX-TV-05 opens on the card for the last title started, then only Recently added; Resume has the focus, no poster does", () => {
    const tree = render(<TvHomeScreen />);
    const scroll = tree.root.find((node) => isType(node, "ScrollView"));
    const children = childElements(scroll);
    console.info("[UX-TV-05] home children", JSON.stringify(children.map((child) => String(child.type))));
    expect(isType(children[0], "TvContinueHero")).toBe(true);
    expect(children[0].props.item.id).toBe("m1");
    const rails = tree.root.findAll((node) => isType(node, "TvRail"));
    expect(rails.map((rail) => rail.props.title)).toEqual(["home.sections.recentlyAdded"]);
    // s2 is also in progress, but there is no Continue watching row any more: the card is the only one.
    expect(rails[0].props.preferredFocusIndex).toBeNull();
    expect(rails[0].props.cardWidth).toBe(tvHomeCardWidth(1));
    expect(rails[0].props.cardWidth).toBe(107);
    // The watched check and the bar inside started posters.
    expect(rails[0].props.showProgress).toBe(true);
  });

  it("@req UX-TV-05 without a title in progress shows no card, and the first poster of Recently added takes the focus", () => {
    const tree = render(<TvHomeScreen />, MEDIA.map((item) => ({ ...item, progressPct: 0, lastWatchedAt: null })));
    expect(tree.root.findAll((node) => isType(node, "TvContinueHero"))).toHaveLength(0);
    const rails = tree.root.findAll((node) => isType(node, "TvRail"));
    console.info("[UX-TV-05] no-hero rails", JSON.stringify(rails.map((rail) => [rail.props.title, rail.props.preferredFocusIndex])));
    expect(rails).toHaveLength(1);
    expect(rails[0].props.preferredFocusIndex).toBe(0);
  });

  it("@req UX-TV-05 homeRows keeps only a Recently added row with titles", () => {
    const a = row("a", "movie");
    const rails = homeRows([
      { id: "continueWatching", titleKey: "c", items: [a], showProgress: true },
      { id: "recent", titleKey: "r", items: [a], showProgress: false },
      { id: "movies", titleKey: "m", items: [a], showProgress: false },
      { id: "favorites", titleKey: "f", items: [a], showProgress: false },
    ] as never);
    expect(rails.map((rail) => rail.id)).toEqual(["recent"]);
    expect(homeRows([{ id: "recent", titleKey: "r", items: [], showProgress: false }] as never)).toEqual([]);
  });

  it("@req UX-TV-05 Details opens the title page; Resume and Start over open the player at that point", async () => {
    const tree = render(<TvHomeScreen />);
    const hero = tree.root.find((node) => isType(node, "TvContinueHero"));
    act(() => hero.props.onAction("details", hero.props.item));
    expect(ctl.navigate).toHaveBeenCalledWith("MediaDetails", { mediaId: "m1" });
    for (const action of ["resume", "startOver"] as const) {
      await act(async () => hero.props.onAction(action, hero.props.item));
      expect(ctl.playerParams).toHaveBeenLastCalledWith(hero.props.item, action, expect.any(Function), expect.any(Function));
    }
    expect(ctl.navigate).toHaveBeenCalledWith("Player", { mediaId: "m1", episodeId: null, startAt: "resume" });
  });

  it("@req UX-TV-05 falls back to the title page when the player cannot be set up", async () => {
    ctl.playerParams = vi.fn(async () => {
      throw new Error("offline");
    });
    const tree = render(<TvHomeScreen />);
    const hero = tree.root.find((node) => isType(node, "TvContinueHero"));
    await act(async () => hero.props.onAction("resume", hero.props.item));
    expect(ctl.navigate).toHaveBeenCalledWith("MediaDetails", { mediaId: "m1" });
  });

  // TV-HOME-OFFLINE-LINE-001: on the Android TV emulator (2026-11-13) a red "Offline mode: using cached media library."
  // line sat above the card and pushed it down, beside the top bar's offline notice that already says so.
  it("@req UX-TV-14 offline, Home shows no error line above the card: the top bar's notice alone says it", () => {
    ctl.error = "Offline mode: using cached media library.";
    ctl.loadStatus = { kind: "offline" };
    const tree = render(<TvHomeScreen />);
    const children = childElements(tree.root.find((node) => isType(node, "ScrollView")));
    console.info("[TV-HOME-OFFLINE-LINE-001] offline children", JSON.stringify(children.map((child) => String(child.type))));
    expect(isType(children[0], "TvContinueHero")).toBe(true);
    expect(textOf(tree.root)).not.toContain("Offline mode");
  });

  it("a load error that is not offline still shows its line above the card", () => {
    ctl.error = "Library failed to load";
    ctl.loadStatus = { kind: "error" };
    const tree = render(<TvHomeScreen />);
    const children = childElements(tree.root.find((node) => isType(node, "ScrollView")));
    expect(isType(children[0], "Text")).toBe(true);
    expect(textOf(children[0])).toBe("Library failed to load");
  });
});

describe("TV empty library (TV-BADGER-HOME-LIBRARY-001)", () => {
  it.each([
    ["Home", () => <TvHomeScreen />],
    ["Library", () => <TvLibraryScreen />],
  ])("@req UX-TV-18 %s shows the empty library, whose Check again reloads; nothing while the first load runs", (_name, screen) => {
    const tree = render(screen(), []);
    const empty = tree.root.findAll((node) => isType(node, "TvEmptyLibrary"));
    expect(empty).toHaveLength(1);
    expect(tree.root.findAll((node) => isType(node, "ScrollView") || isType(node, "FlatList"))).toHaveLength(0);
    empty[0].props.onCheckAgain();
    expect(ctl.reload).toHaveBeenCalledTimes(1);
    ctl.loading = true;
    const loading = render(screen(), []);
    expect(loading.root.findAll((node) => isType(node, "TvEmptyLibrary"))).toHaveLength(0);
  });
});

describe("TV Library: switch, sort and grid (TV-BADGER-HOME-LIBRARY-001)", () => {
  it("@req UX-TV-09 no title or focused-title line: the bar band holds Movies, TV shows then the sort chip, then the grid band", () => {
    const tree = render(<TvLibraryScreen />);
    expect(tree.root.findAll((node) => isType(node, "Text") && node.props.accessibilityRole === "header")).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: "tv-library-focused" })).toHaveLength(0);
    const [bar, grid] = bands(tree);
    expect(bar.props.autoFocus).toBe(true);
    expect(grid.props.autoFocus).toBe(true);
    console.info("[UX-TV-09] bar focus order", JSON.stringify(focusOrder(bar)));
    // Playlists is a top-bar section of its own (UX-TV-37), not a third choice of the switch.
    expect(focusOrder(bar)).toEqual(["tv-library-scope-movie", "tv-library-scope-tv", "tv-library-sort"]);
    expect(tree.root.findAllByProps({ testID: "tv-library-scope-playlists" })).toHaveLength(0);
    // Switch at the left, sort at the right of the same line.
    expect(flat(bar.props.style).flexDirection).toBe("row");
    expect(flat(bar.props.style).justifyContent).toBe("space-between");
    // DOWN from the bar reaches the grid's band, which holds the list.
    expect(grid.findAll((node) => isType(node, "FlatList"))).toHaveLength(1);
    // The Movies choice is the chosen one when the screen opens.
    expect(tree.root.findByProps({ testID: "tv-library-scope-movie" }).props.accessibilityState).toEqual({ checked: true });
  });

  it("@req UX-TV-09 the sort chip shows the order with the sort icon and a chevron", () => {
    const tree = render(<TvLibraryScreen />);
    const sort = tree.root.findByProps({ testID: "tv-library-sort" });
    expect(sort.props.accessibilityLabel).toBe("library.sheet.sortBy: library.sort.name");
    expect(sort.findAll((node) => isType(node, "SortIcon"))).toHaveLength(1);
    expect(sort.findAll((node) => isType(node, "ChevronDownIcon"))).toHaveLength(1);
    expect(textOf(sort)).toBe("library.sort.name");
  });

  it("@req UX-TV-11 eight captioned posters across at the screen margin, with the watch state and no type badge", () => {
    const tree = render(<TvLibraryScreen />);
    const list = tree.root.findByProps({ testID: "tv-library-panel" }).find((node) => isType(node, "FlatList"));
    const content = flat(list.props.contentContainerStyle);
    let cell!: ReactTestRenderer;
    act(() => {
      cell = create(list.props.renderItem({ item: MEDIA[0] }));
    });
    const card = cell.root.find((node) => isType(node, "TvPosterCard"));
    const cardWidth = tvLibraryCardWidth(960, 1);
    const rowWidth = TV_LIBRARY_COLUMNS * cardWidth + (TV_LIBRARY_COLUMNS - 1) * TV_LIBRARY_GAP_X;
    console.info("[UX-TV-11] grid", JSON.stringify({ content, cardWidth, rowWidth }));
    expect(list.props.numColumns).toBe(8);
    expect(content.paddingHorizontal).toBe(TV_SCREEN_X);
    expect(content.gap).toBe(TV_LIBRARY_GAP_Y);
    expect(flat(list.props.columnWrapperStyle).gap).toBe(TV_LIBRARY_GAP_X);
    expect(card.props.width).toBe(cardWidth);
    expect(cardWidth).toBe(96);
    expect(rowWidth).toBeLessThanOrEqual(960 - TV_SCREEN_X * 2);
    expect(card.props.showProgress).toBe(true);
    expect(card.props.showType).toBeUndefined();
  });

  it("@req UX-TV-09 OK on TV shows selects that tab and the grid lists the shows", () => {
    const tree = render(<TvLibraryScreen />);
    const ids = () => (tree.root.find((node) => isType(node, "FlatList")).props.data as MediaRow[]).map((item) => item.id);
    const checked = (tab: string) => tree.root.findByProps({ testID: `tv-library-scope-${tab}` }).props.accessibilityState.checked;
    expect(ids()).toEqual(["m1", "m2"]);
    act(() => tree.root.findByProps({ testID: "tv-library-scope-tv" }).props.onPress());
    expect(ids()).toEqual(["s1", "s2"]);
    expect(checked("tv")).toBe(true);
    expect(checked("movie")).toBe(false);
  });

  it("@req UX-TV-09 OK on the sort chip moves to the next order: name, newest added, newest release", () => {
    const tree = render(<TvLibraryScreen />);
    act(() => tree.root.findByProps({ testID: "tv-library-sort" }).props.onPress());
    expect(ctl.updateSettings).toHaveBeenCalledWith({
      libraryView: { movie: { sortBy: "added", sortDirection: "desc" }, tv: { sortBy: "name", sortDirection: "asc" } },
    });
    expect([nextLibrarySort("name"), nextLibrarySort("added"), nextLibrarySort("release")]).toEqual([
      { sortBy: "added", sortDirection: "desc" },
      { sortBy: "release", sortDirection: "desc" },
      { sortBy: "name", sortDirection: "asc" },
    ]);
  });

  it("@req UX-TV-09 a tab with no titles says so instead of an empty grid", () => {
    const tree = render(<TvLibraryScreen />, [row("m1", "movie")]);
    act(() => tree.root.findByProps({ testID: "tv-library-scope-tv" }).props.onPress());
    expect(textOf(tree.root.findByProps({ testID: "tv-library-tab-empty" }))).toBe("library.empty.noShows");
  });
});

describe("TV Playlists section (UX-TV-37)", () => {
  const openPlaylists = async () => {
    ctl.playlists = PLAYLISTS;
    ctl.playlistItems = { "p-fav": ["s2", "m2", "gone"], "p-watch": [], "p-art": ["m1"], "p-road": [] };
    const tree = render(<TvPlaylistsScreen />);
    // The chosen playlist's titles are read from the store after the first render.
    await act(async () => undefined);
    return tree;
  };
  const gridIds = (tree: ReactTestRenderer) =>
    (tree.root.findByProps({ testID: "tv-playlists-panel" }).find((node) => isType(node, "FlatList")).props.data as MediaRow[]).map((item) => item.id);

  it("@req UX-TV-37 orders the chips Favorites and Watchlist first, then by name; names the system ones in the screen's language", () => {
    expect(tvPlaylistOrder(PLAYLISTS).map((p) => p.id)).toEqual(["p-fav", "p-watch", "p-art", "p-road"]);
    const t = (key: string) => `t:${key}`;
    expect(PLAYLISTS.map((p) => tvPlaylistName(p, t))).toEqual(["Road trip", "t:playlists.system.watchlist", "t:playlists.system.favorites", "Art house"]);
    expect(tvPlaylistTitles(MEDIA, ["s2", "gone", "m1"]).map((item) => item.id)).toEqual(["s2", "m1"]);
  });

  /** The focusable a playlist chip renders: what the remote focuses and presses. */
  const chip = (tree: ReactTestRenderer, id: string) =>
    tree.root.find((node) => isType(node, "TvFocusable") && node.props.testID === `tv-playlist-${id}`);

  it("@req UX-TV-37 bands top to bottom: chips with the first chosen, then the chosen playlist's grid in its order; no title, switch or sort chip", async () => {
    const tree = await openPlaylists();
    const [chips, grid, ...rest] = bands(tree);
    console.info("[UX-TV-37] bands", JSON.stringify([focusOrder(chips), gridIds(tree)]));
    expect(rest).toHaveLength(0);
    expect(tree.root.findAll((node) => isType(node, "Text") && node.props.accessibilityRole === "header")).toHaveLength(0);
    expect(tree.root.findAll((node) => /^tv-library-(scope|sort)/.test(String(node.props.testID ?? "")))).toHaveLength(0);
    // DOWN from the top bar lands on the chips band; its first focus is the first chip, the chosen one.
    expect(chips.props.autoFocus).toBe(true);
    expect(focusOrder(chips)).toEqual(["tv-playlist-p-fav", "tv-playlist-p-watch", "tv-playlist-p-art", "tv-playlist-p-road"]);
    expect(chip(tree, "p-fav").props.accessibilityState).toEqual({ selected: true });
    // DOWN from a chip lands on the grid's band; UP from the grid comes back to the chips band, above it.
    expect(grid.props.autoFocus).toBe(true);
    expect(grid.findAll((node) => isType(node, "FlatList"))).toHaveLength(1);
    expect(gridIds(tree)).toEqual(["s2", "m2"]);
  });

  it("@req UX-TV-37 RIGHT onto a chip chooses it: the grid shows that playlist, and an empty one says how to fill it", async () => {
    const tree = await openPlaylists();
    await act(async () => chip(tree, "p-art").props.onFocus());
    expect(chip(tree, "p-art").props.accessibilityState).toEqual({ selected: true });
    expect(chip(tree, "p-fav").props.accessibilityState).toEqual({ selected: false });
    expect(gridIds(tree)).toEqual(["m1"]);
    await act(async () => chip(tree, "p-watch").props.onFocus());
    expect(textOf(tree.root.findByProps({ testID: "tv-playlists-empty" }))).toBe("playlists.detail.emptyTitle playlists.detail.emptySubtitle");
    // OK on a poster opens its title page.
    await act(async () => chip(tree, "p-art").props.onPress());
    const list = tree.root.findByProps({ testID: "tv-playlists-panel" }).find((node) => isType(node, "FlatList"));
    let cell!: ReactTestRenderer;
    act(() => {
      cell = create(list.props.renderItem({ item: MEDIA[0] }));
    });
    act(() => cell.root.find((node) => isType(node, "TvPosterCard")).props.onPress("m1"));
    expect(ctl.navigate).toHaveBeenCalledWith("MediaDetails", { mediaId: "m1" });
  });

  it("@req UX-TV-37 an account with no playlist says so instead of chips", () => {
    const tree = render(<TvPlaylistsScreen />);
    expect(textOf(tree.root.findByProps({ testID: "tv-playlists-empty" }))).toBe("playlists.empty.title");
    expect(focusOrder(tree.root)).toEqual([]);
  });

  it("@req UX-TV-37 the TV only reads playlists: no control to create, rename or delete one", async () => {
    const tree = await openPlaylists();
    const all = focusOrder(tree.root);
    expect(all.length).toBe(PLAYLISTS.length);
    expect(all.filter((id) => !/^tv-playlist-/.test(id))).toEqual([]);
  });
});

describe("TV Home and library on an Apple TV (TV-SCALE-HOME-001)", () => {
  /** Style numbers that are not lengths, so they stay the same at every scale. */
  const UNSCALED: Record<string, true> = { flex: true, flexGrow: true, flexShrink: true, opacity: true, zIndex: true };
  const at = <T,>(width: number, height: number, read: () => T): T => {
    ctl.window = { width, height };
    try {
      return read();
    } finally {
      ctl.window = { width: 960, height: 540 };
    }
  };
  const home = () => {
    const tree = render(<TvHomeScreen />);
    const scroll = tree.root.find((node) => isType(node, "ScrollView"));
    return {
      content: flat(scroll.props.contentContainerStyle),
      cardWidths: tree.root.findAll((node) => isType(node, "TvRail")).map((rail) => rail.props.cardWidth as number),
    };
  };
  const library = () => {
    const tree = render(<TvLibraryScreen />);
    const list = tree.root.findByProps({ testID: "tv-library-panel" }).find((node) => isType(node, "FlatList"));
    let cell!: ReactTestRenderer;
    act(() => {
      cell = create(list.props.renderItem({ item: MEDIA[0] }));
    });
    return {
      bar: flat(bands(tree)[0].props.style),
      content: flat(list.props.contentContainerStyle),
      columns: list.props.numColumns as number,
      cardWidth: cell.root.find((node) => isType(node, "TvPosterCard")).props.width as number,
    };
  };

  it("@req UX-TV-13 Home's room and card width are the 960x540 ones at twice the size on a 1920x1080-point window", () => {
    const android = at(960, 540, home);
    const apple = at(1920, 1080, home);
    console.info("[TV-SCALE-HOME-001] home", JSON.stringify({ android, apple }));
    expect(android.cardWidths).toEqual([107]);
    expect(apple.cardWidths).toEqual([214]);
    for (const [key, before] of Object.entries(android.content)) {
      if (typeof before !== "number") continue;
      expect(apple.content[key]).toBe(UNSCALED[key] ? before : before * 2);
    }
  });

  it("@req UX-TV-13 the library's bar, room, cards and columns match 960x540 at twice the size on a 1920x1080-point window", () => {
    const android = at(960, 540, library);
    const apple = at(1920, 1080, library);
    console.info("[TV-SCALE-HOME-001] library", JSON.stringify({ android, apple }));
    expect(apple.columns).toBe(android.columns);
    expect(apple.cardWidth).toBe(android.cardWidth * 2);
    for (const part of ["bar", "content"] as const) {
      for (const [key, before] of Object.entries(android[part])) {
        if (typeof before !== "number") continue;
        expect(apple[part][key]).toBe(UNSCALED[key] ? before : before * 2);
      }
    }
  });
});
