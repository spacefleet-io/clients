/**
 * TV-SHELL-TOPROW-001 (UX-TV-14). On the Apple TV "Séjour" (2026-11-08) the library could not be reached for a moment:
 * the phone's offline banner filled a wide box between the tabs and the rows, with the API address in it, and UP from the
 * rows never reached the tabs. tvOS moves the focus only to what lies straight above, and the centred tabs are narrower
 * than the rows (the same cause as TV-RAIL-FOCUS-001). The top row is now a full-width `TVFocusGuideView` with
 * `autoFocus`, and the offline notice is one small focusable button inside it, so nothing sits between the rows and
 * the tabs. Rendered with react-test-renderer: react-native is replaced by host-element stand-ins.
 *
 * TV-SHELL-TOPBAR-002 (UX-TV-09, UX-TV-36, approved TV design Chris 2026-11-12 (chat)): the Badger icon and name at the left
 * (not focusable), Home, Library, Playlists and Search centred, then the offline notice when there is one and Settings alone at the
 * right end as an icon button.
 * @bugfix @regression-proof
 * @req UX-TV-14[badger-tv]
 * @req UX-TV-01[badger-tv]
 * @req UX-TV-09[badger-tv]
 * @req UX-TV-36[badger-tv]
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { TvMainShell } from "./TvMainShell";
import { currentTvSection, requestTvSection, tvBackLabelKey } from "@space/mobile-shell/tv/tvSection";
import { MobileShellThemeProvider, mergeMobileShellTheme } from "@space/mobile-shell/theme";

const state = vi.hoisted(() => {
  // Metro turns `require("../../assets/badger-icon.png")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".png"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
  return {
    loadStatus: { kind: "ready" } as Record<string, unknown>,
    media: [{ id: "m1" }] as unknown[],
    reload: () => undefined as void,
  };
});

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    Image: host("Image"),
    TVFocusGuideView: host("TVFocusGuideView"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    useTVEventHandler: () => undefined,
    useWindowDimensions: () => ({ width: 1920, height: 1080 }),
  };
});
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("lucide-react-native", () => ({ Home: "Icon", Library: "Icon", ListVideo: "Icon", Search: "Icon", Settings: "Icon", CloudOff: "Icon", RefreshCw: "Icon" }));
vi.mock("@space/mobile-shell/components", () => ({
  createSkyCoverRegistry: () => ({}),
  createUserInputSignal: () => ({}),
  MobileAppBackdrop: () => null,
  SkyCover: ({ children }: { children: React.ReactNode }) => children,
  SkyCoversProvider: ({ children }: { children: React.ReactNode }) => children,
  SkyRegion: ({ children }: { children: React.ReactNode }) => children,
  useMobileSkyMode: () => "static",
  useSkyRemoteInput: () => undefined,
  formatPendingOpsLabel: (count: number) => `${count} changes will sync when reconnected`,
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/pairing/deviceWatch", () => ({ checkForNewDevices: () => undefined, markDeviceSeen: async () => undefined }));
vi.mock("../../lib/pairing/newDevice", () => ({
  newDeviceKey: () => "",
  newDeviceMessage: () => "",
  subscribeNewDevice: () => () => undefined,
  subscribeOpenDevices: () => () => undefined,
}));
vi.mock("../../store/auth", () => ({ useAuth: () => ({ token: null }) }));
vi.mock("../../store/library", () => ({
  useLibraryStatus: () => ({ loadStatus: state.loadStatus, reload: state.reload }),
  useLibraryData: () => ({ media: state.media }),
}));
vi.mock("../../theme/theme", () => ({
  theme: {
    colors: { bg: "#000", accent: "#fa0", text: "#fff", textMuted: "#aaa", danger: "#f88", surfaceRaised: "#222", accentSoft: "#330" },
    font: { family: { display: "x" } },
  },
}));
vi.mock("@space/mobile-shell/tv/useTvMenuKey", () => ({ useTvMenuKeyHold: () => undefined }));
vi.mock("./TvHomeScreen", () => ({ TvHomeScreen: "TvHomeScreen" }));
vi.mock("./TvLibraryScreen", () => ({ TvLibraryScreen: "TvLibraryScreen" }));
vi.mock("./TvPlaylistsScreen", () => ({ TvPlaylistsScreen: "TvPlaylistsScreen" }));
vi.mock("./TvSearchScreen", () => ({ TvSearchScreen: "TvSearchScreen" }));
vi.mock("./TvSettingsScreen", () => ({ TvSettingsScreen: "TvSettingsScreen" }));

/** The app's shell theme, as App.tsx provides it: the top bar reads Badger's name from it (UX-NAME-01). */
const BADGER_THEME = mergeMobileShellTheme({ brandName: "Badger" });
const shell = () => (
  <MobileShellThemeProvider value={BADGER_THEME}>
    <TvMainShell />
  </MobileShellThemeProvider>
);

const render = () => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(shell());
  });
  return tree;
};
const isType = (type: string) => (n: ReactTestInstance) => (n.type as unknown) === type;
const textOf = (n: ReactTestInstance): string =>
  n.findAll(isType("Text")).map((t) => [t.props.children].flat().join("")).join(" ");

describe("TvMainShell top row (TV-SHELL-TOPROW-001)", () => {
  beforeEach(() => {
    state.loadStatus = { kind: "ready" };
    state.media = [{ id: "m1" }];
    state.reload = vi.fn();
  });

  it("puts the tabs in one full-width focus guide with autoFocus, so UP from any row reaches them", () => {
    const tree = render();
    const guides = tree.root.findAll(isType("TVFocusGuideView"));
    console.info("[TV-SHELL-TOPROW-001] guides", JSON.stringify(guides.map((g) => ({ autoFocus: g.props.autoFocus, role: g.props.accessibilityRole }))));
    expect(guides).toHaveLength(1);
    expect(guides[0].props.autoFocus).toBe(true);
    expect(guides[0].props.accessibilityRole).toBe("tablist");
    expect(guides[0].findAll((n) => n.props.accessibilityRole === "tab" && isType("Pressable")(n))).toHaveLength(5);
    expect(tree.root.findAll((n) => n.props.testID === "tv-offline-notice")).toHaveLength(0);
  });

  it("shows offline as one short retry button inside the top row, with no API address, and OK retries", () => {
    state.loadStatus = {
      kind: "offline",
      reason: "network",
      pendingOps: 0,
      cacheVersion: 1,
      lastError: "Could not reach the API at http://192.168.0.161:3000. If you're using localhost, use your computer's LAN IP instead.",
    };
    const tree = render();
    const [guide] = tree.root.findAll(isType("TVFocusGuideView"));
    const notices = tree.root.findAll((n) => n.props.testID === "tv-offline-notice" && isType("Pressable")(n));
    expect(notices).toHaveLength(1);
    // Inside the guide: the remote reaches it like a tab, and nothing lies between the rows and the tabs.
    expect(guide.findAll((n) => n === notices[0])).toHaveLength(1);
    const text = textOf(notices[0]);
    console.info("[TV-SHELL-TOPROW-001] notice", JSON.stringify({ text, label: notices[0].props.accessibilityLabel }));
    expect(text).toBe("tvShell.offline.network tvShell.offline.retry");
    expect(textOf(tree.root)).not.toContain("192.168.0.161");
    act(() => notices[0].props.onPress());
    expect(state.reload).toHaveBeenCalledTimes(1);
  });

  it("names waiting changes and the sync-failure case in the same button", () => {
    state.loadStatus = { kind: "offline", reason: "sync_error", pendingOps: 3, cacheVersion: 1, lastError: "x" };
    const tree = render();
    const [notice] = tree.root.findAll((n) => n.props.testID === "tv-offline-notice" && isType("Pressable")(n));
    expect(textOf(notice)).toBe("tvShell.offline.syncError 3 tvShell.offline.retry");
    expect(String(notice.props.accessibilityLabel)).toContain("3 changes will sync when reconnected");
  });

  // TV-SHELL-OFFLINE-PILL-001: on the Android TV emulator (2026-11-13) the pill's words drew over its icon and the
  // pill reached over the centred tabs: the pending-changes sentence made it too wide and nothing in it could give way.
  it("@req UX-TV-14 lays the icon, the words, the count and Retry side by side; only the title gives way, ending in …", () => {
    state.loadStatus = { kind: "offline", reason: "sync_error", pendingOps: 3, cacheVersion: 1, lastError: "x" };
    const tree = render();
    const [notice] = tree.root.findAll((n) => n.props.testID === "tv-offline-notice" && isType("Pressable")(n));
    const [row] = childElementsOf(notice);
    const flat = (style: unknown): Record<string, unknown> =>
      typeof style === "function"
        ? flat(style({ focused: false, pressed: false }))
        : Array.isArray(style)
          ? Object.assign({}, ...style.map(flat))
          : ((style || {}) as Record<string, unknown>);
    const pieces = childElementsOf(row);
    const cover = notice.parent as ReactTestInstance;
    console.info(
      "[TV-SHELL-OFFLINE-PILL-001] pill",
      JSON.stringify({
        cover: flat(cover.props.style),
        notice: flat(notice.props.style),
        row: flat(row.props.style),
        pieces: pieces.map((p) => ({ type: String(p.type), testID: p.props.testID, lines: p.props.numberOfLines, style: flat(p.props.style) })),
      }),
    );
    expect(flat(row.props.style).flexDirection).toBe("row");
    expect(pieces.map((p) => String(p.type))).toEqual(["View", "Text", "View", "Text"]);
    const [icon, title, count, retry] = pieces;
    expect(count.props.testID).toBe("tv-offline-pending");
    for (const fixed of [icon, count, retry]) expect(flat(fixed.props.style).flexShrink).toBe(0);
    expect(flat(title.props.style).flexShrink).toBe(1);
    expect(title.props.numberOfLines).toBe(1);
    // Every box from the bar's right side down to the row may shrink, so the pill stays inside its side of the bar.
    for (const box of [cover, notice, row]) expect(flat(box.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 });
  });
});

describe("TvMainShell top bar (TV-SHELL-TOPBAR-002)", () => {
  beforeEach(() => {
    state.loadStatus = { kind: "ready" };
    state.reload = vi.fn();
  });
  const tabIds = (tree: ReactTestRenderer) =>
    tree.root.findAll((n) => isType("Pressable")(n) && n.props.accessibilityRole === "tab").map((n) => String(n.props.testID));

  it("@req UX-TV-09 @req UX-TV-36 reads Badger at the left, Home, Library, Playlists, Search centred, and Settings alone at the right end, with no language button", () => {
    const tree = render();
    const [guide] = tree.root.findAll(isType("TVFocusGuideView"));
    const [left, centre, right] = childElementsOf(guide);
    console.info("[TV-SHELL-TOPBAR-002] bar", JSON.stringify({ groups: childElementsOf(guide).length, tabs: tabIds(tree) }));
    expect(childElementsOf(guide)).toHaveLength(3);
    expect(tabIds(tree)).toEqual(["tv-nav-home", "tv-nav-library", "tv-nav-playlists", "tv-nav-search", "tv-nav-settings"]);
    // The brand is in the left group and is not something the remote can land on.
    const brand = tree.root.findByProps({ testID: "tv-nav-brand" });
    expect(left.findAll((n) => n === brand)).toHaveLength(1);
    expect(brand.props.accessible).toBe(false);
    expect(brand.findAll(isType("Pressable"))).toHaveLength(0);
    expect(brand.findAll(isType("Image"))).toHaveLength(1);
    expect(textOf(brand)).toBe("Badger");
    expect(textOf(tree.root)).not.toMatch(/language|langue|sprache|taal/i);
    // The browse tabs sit between two equal flexible sides, so they are centred; their labels are spaced capitals.
    expect(flatStyle(left).flex).toBe(1);
    expect(flatStyle(right).flex).toBe(1);
    const tabs = centre.findAll((n) => isType("Pressable")(n) && n.props.accessibilityRole === "tab");
    expect(tabs.map((n) => n.props.testID)).toEqual(["tv-nav-home", "tv-nav-library", "tv-nav-playlists", "tv-nav-search"]);
    expect(tabs.map((n) => n.props.accessibilityLabel)).toEqual(["nav.home", "nav.library", "nav.playlists", "tvShell.nav.search"]);
    const label = flatStyle(tabs[0].findAll(isType("Text"))[0]);
    expect(label.textTransform).toBe("uppercase");
    expect(Number(label.letterSpacing)).toBeGreaterThan(0);
    // Settings is the last thing at the right end: an icon button with no visible text, named for the screen reader.
    const settings = right.find((n) => isType("Pressable")(n) && n.props.testID === "tv-nav-settings");
    const rightFocusables = right.findAll((n) => isType("Pressable")(n));
    expect(rightFocusables[rightFocusables.length - 1]).toBe(settings);
    expect(settings.findAll(isType("Text"))).toHaveLength(0);
    expect(settings.props.accessibilityLabel).toBe("nav.settings");
  });

  it("@req UX-TV-36 marks the open section: its tab is selected and drawn as a filled pill; Settings too when open", () => {
    const tree = render();
    const tab = (id: string) => tree.root.find((n) => isType("Pressable")(n) && n.props.testID === `tv-nav-${id}`);
    const home = tab("home");
    const library = tab("library");
    expect(home.props.accessibilityState).toEqual({ selected: true });
    expect(library.props.accessibilityState).toEqual({ selected: false });
    const style = (n: ReactTestInstance) => Object.assign({}, ...[n.props.style({ focused: false, pressed: false })].flat(Infinity).filter(Boolean));
    expect(style(home).backgroundColor).toBeDefined();
    expect(style(library).backgroundColor).toBeUndefined();
    act(() => tab("settings").props.onPress());
    expect(tab("settings").props.accessibilityState).toEqual({ selected: true });
    expect(tab("home").props.accessibilityState).toEqual({ selected: false });
  });

  it("@req UX-TV-36 a page above the shell picks a tab through requestTvSection, and the shell opens that section", () => {
    const tree = render();
    act(() => requestTvSection("library"));
    expect(tree.root.findAll(isType("TvLibraryScreen"))).toHaveLength(1);
    expect(tree.root.find((n) => isType("Pressable")(n) && n.props.testID === "tv-nav-library").props.accessibilityState).toEqual({ selected: true });
    expect(currentTvSection()).toBe("library");
  });

  it("@req UX-TV-14 puts the offline notice just before Settings, so RIGHT from Search reaches it before Settings", () => {
    state.loadStatus = { kind: "offline", reason: "network", pendingOps: 0, cacheVersion: 1, lastError: "x" };
    const tree = render();
    const focusables = tree.root
      .findAll((n) => isType("Pressable")(n))
      .map((n) => String(n.props.testID));
    console.info("[TV-SHELL-TOPBAR-002] offline order", JSON.stringify(focusables));
    expect(focusables.slice(0, 6)).toEqual(["tv-nav-home", "tv-nav-library", "tv-nav-playlists", "tv-nav-search", "tv-offline-notice", "tv-nav-settings"]);
  });

  it("@req UX-TV-06 OK on a tab opens its section and notes it for a title page's Back button", () => {
    const tree = render();
    expect(currentTvSection()).toBe("home");
    expect(tree.root.findAll(isType("TvHomeScreen"))).toHaveLength(1);
    for (const [id, screen] of [
      ["library", "TvLibraryScreen"],
      ["playlists", "TvPlaylistsScreen"],
      ["search", "TvSearchScreen"],
      ["settings", "TvSettingsScreen"],
    ] as const) {
      act(() => tree.root.findByProps({ testID: `tv-nav-${id}` }).props.onPress());
      console.info("[TV-SHELL-TOPBAR-002] section", id, currentTvSection());
      expect(tree.root.findAll(isType(screen))).toHaveLength(1);
      expect(currentTvSection()).toBe(id);
    }
    // A title opened from Playlists names Playlists on its Back button.
    expect(tvBackLabelKey("playlists")).toBe("tvShell.details.backToPlaylists");
    expect(tvBackLabelKey("library")).toBe("tvShell.details.backToLibrary");
  });
});

/**
 * TV-SHELL-EMPTY-LIBRARY-001 (UX-LIBTAB-01, Chris 2026-11-16): "when a user's library is empty we decided that the
 * library page couldn't be opened [...] also the button should be greyed out so it doesn't look like a bug". The TV's
 * Library and Playlists tabs follow the TV's disabled buttons: half opacity, not focusable (the remote skips them),
 * marked disabled; a request for either (a title page's tab) lands on Home; the first title opens them again with no
 * restart. Chris 2026-11-16: "if library is greyed out when empty, then the playlist menu should also be greyed out and
 * unaccissible".
 * @req UX-LIBTAB-01[badger-tv]
 */
describe.each([
  { id: "library", screen: "TvLibraryScreen" },
  { id: "playlists", screen: "TvPlaylistsScreen" },
] as const)("TvMainShell $id tab of an empty library (TV-SHELL-EMPTY-LIBRARY-001)", ({ id, screen }) => {
  beforeEach(() => {
    state.loadStatus = { kind: "ready" };
    state.media = [];
    state.reload = vi.fn();
  });
  const navTab = (tree: ReactTestRenderer) => {
    const tab = tree.root.findAll((n) => isType("Pressable")(n) && n.props.testID === `tv-nav-${id}`)[0];
    const style = typeof tab.props.style === "function" ? tab.props.style({ focused: false, pressed: false }) : tab.props.style;
    const seen = {
      disabled: tab.props.disabled === true,
      focusable: tab.props.focusable !== false,
      a11yDisabled: tab.props.accessibilityState?.disabled === true,
      opacity: Object.assign({}, ...[style].flat(Infinity).filter(Boolean)).opacity ?? 1,
    };
    console.info("[TV-SHELL-EMPTY-LIBRARY-001]", id, "tab", JSON.stringify(seen));
    return seen;
  };

  it("is greyed out, not focusable and disabled while the library is empty; a request for it lands on Home", () => {
    const tree = render();
    expect(navTab(tree)).toEqual({ disabled: true, focusable: false, a11yDisabled: true, opacity: 0.5 });
    act(() => requestTvSection(id));
    expect(tree.root.findAll(isType(screen))).toHaveLength(0);
    expect(tree.root.findAll(isType("TvHomeScreen"))).toHaveLength(1);
    expect(currentTvSection()).toBe("home");
  });

  it("opens as soon as the first title lands, with no restart", () => {
    const tree = render();
    expect(navTab(tree).disabled).toBe(true);
    state.media = [{ id: "m1" }];
    act(() => tree.update(shell()));
    expect(navTab(tree)).toEqual({ disabled: false, focusable: true, a11yDisabled: false, opacity: 1 });
    act(() => tree.root.findByProps({ testID: `tv-nav-${id}` }).props.onPress());
    expect(tree.root.findAll(isType(screen))).toHaveLength(1);
  });
});

const childElementsOf = (n: ReactTestInstance) => n.children.filter((c): c is ReactTestInstance => typeof c !== "string");
const flatStyle = (n: ReactTestInstance) => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
