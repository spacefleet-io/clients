/**
 * @test-id MOBILE-LIBRARY-PAGE-NAME-001
 * @level unit
 *
 * UX-NAME-02 / UX-PHONE-02: the page that lists the user's movies and shows is called "Library" (French "Bibliothèque").
 * On the phone the bottom tab label (`MainShellScreen`) names it and the page (`LibraryScreen`) has no header of its own;
 * the TV reads the same `nav.library`. The test renders both real screens with react-test-renderer and the real translation files (their
 * children, store and native modules are stubbed) and reads the words they put on screen, in each language.
 */
import { createElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { changeLanguage, initI18n } from "@space/mobile-shell/i18n";
import { LibraryScreen } from "../src/screens/LibraryScreen";
import { MainShellScreen } from "../src/screens/MainShellScreen";

type TabProp = { id: string; label: string };
const shell = vi.hoisted(() => {
  // Metro turns `require("../assets/x.webp")` into an image reference; plain node would try to parse the bytes as JS.
  // `require.extensions` is node's loader table (`Module._extensions`).
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m) => {
    m.exports = 1;
  };
  const tabs: TabProp[] = [];
  return { tabs };
});

vi.mock("react-native", () => {
  const host = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  return {
    View: host("View"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    Pressable: host("Pressable"),
    StyleSheet: { create: <T>(styles: T): T => styles, hairlineWidth: 1, absoluteFillObject: {} },
    useWindowDimensions: () => ({ width: 390, height: 800 }),
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: "ios", select: <T>(spec: { ios?: T; default?: T }) => spec.ios ?? spec.default },
  };
});
// The shell package ships its own copy of React, so react-i18next's hook cannot run inside this app's renderer; the
// real i18next instance and the real en/fr files stay, only the hook is bound to them directly.
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: actual.getCurrentLanguage() } }) };
});
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }), useIsFocused: () => true }));
vi.mock("lucide-react-native", () => {
  const icon = () => null;
  return { Home: icon, LibraryBig: icon, Settings: icon, Film: icon, ListVideo: icon, ArrowDownWideNarrow: icon, Search: icon, Tv: icon, X: icon, ListFilter: icon, ArrowDownUp: icon, SlidersHorizontal: icon };
});
vi.mock("react-native-svg", () => ({ default: "Svg", Defs: "Defs", LinearGradient: "LinearGradient", Rect: "Rect", Stop: "Stop" }));
// The shared sheet's drags load gesture-handler's native code; the library header renders without it.
vi.mock("@space/mobile-shell/bottom-sheet", () => ({
  MobileBottomSheet: () => null,
  MobileSheetScrollView: "ScrollView",
  useMobileSheetClose: () => (after?: () => void) => after?.(),
}));
vi.mock("@space/mobile-shell/components", () => {
  const passthrough = (props: { children?: ReactNode }) => createElement("Region", null, props.children);
  return {
    MobileShellFrame: (props: { tabs: TabProp[]; children: (tabId: string) => ReactNode }) => {
      shell.tabs = props.tabs;
      return createElement("Frame", null, props.children("home"));
    },
    MobileOfflineIndicator: () => null,
    MobileNoticeToast: () => null,
    MobileEmptyState: () => null,
    SkyCover: passthrough,
    SkyRegion: passthrough,
  };
});
vi.mock("@space/mobile-shell/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/theme")>();
  return { ...actual, useMobileShellTheme: () => actual.defaultMobileShellTheme };
});
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: null }) }));
vi.mock("../src/store/library", () => ({
  useLibraryData: () => ({ media: [] }),
  useLibraryStatus: () => ({ loadStatus: { kind: "ready" }, syncState: { kind: "idle" }, loading: false, error: null, reload: () => undefined, refresh: () => undefined }),
  useLibraryActions: () => ({ getLibraryExtras: async () => null }),
}));
vi.mock("../src/lib/pairing/deviceWatch", () => ({ checkForNewDevices: async () => undefined, markDeviceSeen: async () => undefined }));
vi.mock("../src/lib/pairing/newDevice", () => ({
  newDeviceKey: () => "",
  newDeviceMessage: () => "",
  subscribeNewDevice: () => () => undefined,
  subscribeOpenDevices: () => () => undefined,
}));
vi.mock("../src/screens/HomeScreen", () => ({ HomeScreen: () => null }));
vi.mock("../src/screens/SettingsScreen", () => ({ SettingsScreen: () => null }));
vi.mock("../src/components/PosterGrid", () => ({ PosterGrid: () => null }));
vi.mock("../src/components/PlaylistsPanel", () => ({ PlaylistsPanel: () => null }));
// The phone Search overlay (UX-PHONE-12) pulls react-native-fs and the real shell components, which plain node cannot load.
vi.mock("../src/components/PhoneSearch", () => ({ PhoneSearch: () => null }));
vi.mock("../src/components/PosterCard", () => ({ RIPPLE: {} }));
vi.mock("../src/components/usePickerSheet", () => ({ usePickerSheet: () => ({ visible: false }) }));
vi.mock("../src/lib/usePullToRefresh", () => ({ usePullToRefresh: () => ({}) }));
vi.mock("../src/lib/downloads/downloadsStore", () => ({ useDownloadedMediaIds: () => new Set<string>() }));
vi.mock("../src/lib/appSettings", () => ({
  useAppSettings: () => [{ libraryView: { movie: { view: "posters" }, tv: { view: "posters" } } }],
}));
vi.mock("../src/lib/libraryExtras", () => ({ EMPTY_LIBRARY_EXTRAS: { castByMediaId: new Map() }, fetchLibraryExtras: () => undefined }));
vi.mock("../src/lib/libraryScreenState", () => ({
  libraryFiltersReducer: (state: unknown) => state,
  selectLibraryItems: () => [],
  availableGenreIds: () => [],
  updateLibraryTabPrefs: () => undefined,
}));
vi.mock("../src/lib/genreLabels", () => ({ genreLabelKey: () => undefined }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ error: () => undefined }) }));

const render = (element: ReactElement) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
};

const text = (node: ReactTestInstance): string => node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");

/** The headings the Library page prints: none, the tab bar names the page (UX-PHONE-02). */
const libraryHeaders = (): number => {
  const tree = render(createElement(LibraryScreen, { active: true }));
  return tree.root.findAll((n) => n.props.accessibilityRole === "header" && typeof n.type === "string").length;
};

/** The label the bottom bar shows on the tab that opens the Library page. */
const libraryTabLabel = (): string => {
  render(createElement(MainShellScreen));
  return shell.tabs.find((tab) => tab.id === "library")?.label ?? "(no library tab)";
};

describe("the media page is called Library", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await initI18n("en");
  });

  /** @req UX-PHONE-02 @req UX-NAME-02[badger-mobile,badger-tv] */
  it("the bottom tab reads Library in English and the page has no title", async () => {
    await changeLanguage("en");
    const names = { tab: libraryTabLabel(), headers: libraryHeaders() };
    console.info(`UX-PHONE-02 en: ${JSON.stringify(names)}`);
    expect(names).toEqual({ tab: "Library", headers: 0 });
  });

  /** @req UX-PHONE-02 @req UX-NAME-02[badger-mobile,badger-tv] */
  it("the bottom tab reads Bibliothèque in French", async () => {
    await changeLanguage("fr");
    expect(libraryTabLabel()).toBe("Bibliothèque");
  });
});
