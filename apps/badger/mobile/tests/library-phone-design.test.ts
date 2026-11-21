/**
 * @test-id MOBILE-LIBRARY-PHONE-DESIGN-001
 * @level unit
 *
 * UX-PHONE-06: the phone's Library page is drawn as the validated mockup (`phone-library`): the Movies / TV shows
 * switch with the film and tv icons and a solid yellow selected tab (Playlists is its own bottom tab, UX-PHONE-07), with the
 * desktop library row's Filter and Sort buttons beside it (draft layout A, the default) and no view buttons and no search
 * field (UX-PHONE-12: the bar's Search); a three-column poster grid whose cards show the
 * watch progress bar and a check on watched titles. The real screen and the real `PosterCard` render with react-test-renderer
 * (store, children and native modules stubbed); icons render as host elements named after the lucide icon.
 */
import { createElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import type { MediaRow } from "@space/shared/libraryTypes";
import { LibraryScreen } from "../src/screens/LibraryScreen";
import { PosterCard } from "../src/components/PosterCard";
import { theme } from "../src/theme/theme";

const state = vi.hoisted(() => {
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m) => {
    m.exports = 1;
  };
  return { view: "posters" as string, grid: [] as Record<string, unknown>[], downloaded: false };
});

vi.mock("react-native", () => {
  const host = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  return {
    View: host("View"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    Pressable: host("Pressable"),
    Image: host("Image"),
    StyleSheet: { create: <T>(styles: T): T => styles, hairlineWidth: 1, absoluteFillObject: {} },
    useWindowDimensions: () => ({ width: 390, height: 800 }),
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: "android", select: <T>(spec: { android?: T; default?: T }) => spec.android ?? spec.default },
  };
});
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: actual.getCurrentLanguage() } }) };
});
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }), useIsFocused: () => true }));
vi.mock("lucide-react-native", () => {
  const names = ["Film", "Tv", "ListVideo", "ListPlus", "Search", "X", "ArrowDownWideNarrow", "SlidersHorizontal", "LayoutGrid", "List", "Rows3", "ArrowDownToLine", "Check", "ListFilter", "ArrowDownUp"];
  return Object.fromEntries(names.map((name) => [name, (props: Record<string, unknown>) => createElement(`icon:${name}`, props)]));
});
vi.mock("react-native-svg", () => ({ default: "Svg", Defs: "Defs", LinearGradient: "LinearGradient", Rect: "Rect", Stop: "Stop" }));
// The shared sheet's drags load gesture-handler's native code; the library header renders without it.
vi.mock("@space/mobile-shell/bottom-sheet", () => ({
  MobileBottomSheet: () => null,
  MobileSheetScrollView: "ScrollView",
  useMobileSheetClose: () => (after?: () => void) => after?.(),
}));
vi.mock("@space/mobile-shell/components", () => {
  const passthrough = (props: { children?: ReactNode; style?: unknown }) => createElement("Region", { style: props.style }, props.children);
  return { MobileEmptyState: () => null, SkyCover: passthrough, SkyRegion: passthrough };
});
vi.mock("../src/store/library", () => ({
  useLibraryData: () => ({ media: [] }),
  useLibraryStatus: () => ({ loading: false, error: null, refresh: () => undefined }),
  useLibraryActions: () => ({ getLibraryExtras: async () => null }),
}));
vi.mock("../src/lib/useLibraryOnline", () => ({ useLibraryOnline: () => true }));
vi.mock("../src/components/PosterGrid", () => ({
  PosterGrid: (props: Record<string, unknown>) => {
    state.grid.push(props);
    return createElement("PosterGrid");
  },
}));
vi.mock("../src/components/PlaylistsPanel", () => ({ PlaylistsPanel: () => null }));
vi.mock("../src/components/IconButton", () => ({
  IconButton: (props: { label: string; children?: ReactNode }) => createElement("IconButton", props, props.children),
}));
vi.mock("../src/components/usePickerSheet", () => ({ usePickerSheet: () => ({ visible: false, open: () => undefined }) }));
vi.mock("../src/lib/usePullToRefresh", () => ({ usePullToRefresh: () => ({}) }));
vi.mock("../src/lib/downloads/downloadsStore", () => ({
  useDownloadedMediaIds: () => new Set<string>(),
  useIsMediaDownloaded: () => state.downloaded,
}));
vi.mock("../src/lib/useMediaImage", () => ({ useMediaImage: () => "https://img.test/poster.jpg" }));
vi.mock("../src/components/MediaArtwork", () => ({ MediaArtwork: () => null }));
vi.mock("../src/lib/imageLog", () => ({ logImageError: () => () => undefined }));
vi.mock("../src/lib/appSettings", () => ({
  useAppSettings: () => [{ libraryView: { movie: { view: state.view }, tv: { view: state.view } } }],
}));
vi.mock("../src/lib/libraryExtras", () => ({ EMPTY_LIBRARY_EXTRAS: { castByMediaId: new Map() }, fetchLibraryExtras: () => undefined }));
vi.mock("../src/lib/libraryScreenState", () => ({
  EMPTY_LIBRARY_FILTERS: { query: "", genres: [], actors: [], downloadedOnly: false },
  libraryFiltersReducer: (s: unknown) => s,
  selectLibraryItems: () => [],
  availableGenreIds: () => [],
  updateLibraryTabPrefs: () => undefined,
  countActiveLibraryFilters: () => 0,
  hasActiveLibraryFilters: () => false,
}));
vi.mock("../src/lib/genreLabels", () => ({ genreLabelKey: () => undefined }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ error: () => undefined, info: () => undefined }) }));

const LOG = "[MOBILE-LIBRARY-PHONE-DESIGN-001]";
const render = (element: ReactElement) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
};
// A Pressable's style may be a function of its state: read it at rest.
const flat = (style: unknown): Record<string, unknown> =>
  typeof style === "function"
    ? flat(style({ pressed: false }))
    : Array.isArray(style)
      ? Object.assign({}, ...style.flat(Infinity).filter(Boolean).map(flat))
      : ((style as Record<string, unknown>) ?? {});
const icons = (node: ReactTestInstance): string[] =>
  node.findAll((n) => typeof n.type === "string" && n.type.startsWith("icon:")).map((n) => (n.type as string).slice(5));
const text = (node: ReactTestInstance): string => node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");

const row = (patch: Partial<MediaRow>): MediaRow => ({ id: "m1", title: "Metropolis", year: 1927, progressPct: 0, posterPath: "/p.jpg", ...patch }) as MediaRow;

describe("phone Library page follows the validated mockup (UX-PHONE-06)", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await initI18n("en");
  });

  /** @req UX-PHONE-06 @req UX-PHONE-07 */
  it("the switch shows film and tv icons only (no Playlists) and the selected tab is solid yellow with dark text", () => {
    const tree = render(createElement(LibraryScreen, { active: true }));
    const tabs = tree.root.findAll((n) => String(n.type) === "Pressable" && n.props.accessibilityRole === "tab");
    const read = tabs.map((tab) => ({
      label: tab.props.accessibilityLabel,
      selected: tab.props.accessibilityState.selected,
      icons: icons(tab),
      bg: flat(tab.props.style).backgroundColor ?? null,
      text: flat(tab.findByType("Text" as never).props.style).color,
      iconColor: tab.findAll((n) => ["icon:Film", "icon:Tv"].includes(String(n.type)))[0]?.props.color,
      height: flat(tab.props.style).height,
    }));
    console.info(`${LOG} tabs ${JSON.stringify(read)}`);
    expect(read.map((r) => r.label)).toEqual(["Movies", "TV shows"]);
    expect(read.map((r) => r.icons)).toEqual([["Film"], ["Tv"]]);
    expect(tree.root.findAll((n) => n.props.testID === "library-scope-playlists")).toHaveLength(0);
    expect(read[0]).toMatchObject({ label: "Movies", selected: true, bg: theme.colors.accent, text: theme.accentTextHex, iconColor: theme.accentTextHex, height: 34 });
    expect(read[1]).toMatchObject({ selected: false, bg: null, text: theme.colors.textMuted });
  });

  /** @req UX-PHONE-06 @req UX-PHONE-12 @req UX-LIB-04 */
  it("the toolbar is one row, the switch with a Filter and a Sort button: no search field (the bar's Search button searches), no view buttons", () => {
    const tree = render(createElement(LibraryScreen, { active: true }));
    const header = tree.root.find((n) => n.props.testID === "library-header");
    const row = header.findAll((n) => n.props.testID === "library-filter-button")[0]!.parent!;
    expect(row.findAll((n) => n.props.testID === "library-tabs").length).toBeGreaterThan(0);
    expect(row.findAll((n) => n.props.testID === "library-sort-button").length).toBeGreaterThan(0);
    const buttons = header
      .findAll((n) => String(n.type) === "Pressable" && n.props.accessibilityRole === "button")
      .map((b) => ({ testID: b.props.testID, label: b.props.accessibilityLabel, icons: icons(b) }));
    const inputs = tree.root.findAll((n) => String(n.type) === "TextInput");
    console.info(`${LOG} toolbar ${JSON.stringify({ buttons, inputs: inputs.length })}`);
    expect(inputs).toHaveLength(0);
    expect(tree.root.findAll((n) => n.props.testID === "library-search")).toHaveLength(0);
    expect(buttons.map(({ testID, icons }) => ({ testID, icons }))).toEqual([
      { testID: "library-filter-button", icons: ["ListFilter"] },
      { testID: "library-sort-button", icons: ["ArrowDownUp"] },
    ]);
    for (const gone of ["LayoutGrid", "List", "Rows3", "Search"]) expect(icons(tree.root)).not.toContain(gone);
  });

  /** @req UX-PHONE-06 */
  it.each(["posters", "compact", "details"])("a remembered %s view still shows the poster grid, with watch progress", (view) => {
    state.view = view;
    state.grid.length = 0;
    const tree = render(createElement(LibraryScreen, { active: true }));
    console.info(`${LOG} view=${view} grids=${state.grid.length} showProgress=${String(state.grid[0]?.showProgress)}`);
    expect(tree.root.findAll((n) => String(n.type) === "PosterGrid")).toHaveLength(1);
    expect(state.grid.at(-1)?.showProgress).toBe(true);
    state.view = "posters";
  });

  /** @req UX-PHONE-06 */
  it("a poster card draws the mockup's inset progress bar while watching and a yellow check once watched", () => {
    const card = (progressPct: number, downloaded = false) => {
      state.downloaded = downloaded;
      const tree = render(createElement(PosterCard, { item: row({ progressPct }), width: 110, onPress: () => undefined, showProgress: true }));
      const bar = tree.root.findAll((n) => n.props.testID === "poster-progress");
      const check = tree.root.findAll((n) => n.props.testID === "poster-watched");
      const offline = tree.root.findAll((n) => n.props.testID === "poster-downloaded");
      const title = tree.root.findAll((n) => String(n.type) === "Text");
      return {
        bar: bar.length ? flat(bar[0]!.props.style) : null,
        check: check.length ? { style: flat(check[0]!.props.style), icons: icons(check[0]!) } : null,
        offline: offline.length ? flat(offline[0]!.props.style) : null,
        title: flat(title[0]!.props.style),
        year: flat(title[1]!.props.style),
        texts: title.map(text),
      };
    };
    const watching = card(40);
    const watched = card(97, true);
    console.info(`${LOG} card watching=${JSON.stringify(watching)} watched=${JSON.stringify(watched)}`);
    expect(watching.bar).toMatchObject({ left: 8, right: 8, bottom: 8, height: 4, borderRadius: 2 });
    expect(watching.check).toBeNull();
    expect(watching.title).toMatchObject({ fontSize: 14, fontWeight: "600" });
    expect(watching.year).toMatchObject({ fontSize: 12.5, color: theme.colors.textMuted });
    expect(watched.bar).toBeNull();
    expect(watched.check?.icons).toEqual(["Check"]);
    expect(watched.check?.style).toMatchObject({ top: 8, right: 8, width: 24, height: 24, backgroundColor: theme.colors.accent });
    // The offline mark moves to the top-left corner so the watched check keeps the mockup's top-right.
    expect(watched.offline).toMatchObject({ top: 8, left: 8 });
  });
});
