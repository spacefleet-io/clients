/**
 * @test-id MOBILE-MAIN-TABS-001
 * @level unit
 *
 * UX-PHONE-07: the phone's bottom bar has four tabs, Home, Library, Playlists and Settings, in that order, as Parrot's
 * phone (PAR-NAV-02). Playlists is a destination of its own: its tab shows the playlists list (whose rows open the
 * playlist page), and the Library page keeps only its Movies / TV shows switch. Home's "See all" on Favorites opens the
 * Playlists tab. The real `MainShellScreen` renders with react-test-renderer and the real translation files; the shell
 * frame records the tabs it is given and draws the page of the open tab; pages and native modules are stubbed.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, initI18n } from "@space/mobile-shell/i18n";
import { MainShellScreen } from "../src/screens/MainShellScreen";
import type { SeeAllTarget } from "../src/lib/phoneHome";
import { tabBarHalfFits, tabBarHalfWidth } from "../../../../packages/mobile-shell/src/components/mobile-tab-bar-geometry";

/**
 * Each shipped tab label's width in points as the bar draws it (Inter semibold 11 pt, as written), measured on an iOS
 * simulator with the real MobileTabBar (2026-11-20); Android draws the same bundled Inter, and the font file gives the
 * same widths within 0.5 pt. A label not in this table fails the fit test until it is measured.
 */
const BADGER_TAB_LABEL_WIDTHS: Record<string, number> = {
  Home: 31.3,
  Library: 37.7,
  Playlists: 44.7,
  Settings: 44.0,
  Accueil: 40.0,
  Bibliothèque: 67.0,
  Paramètres: 61.3,
  Bibliotheek: 59.7,
  Afspeellijsten: 73.0,
  Instellingen: 62.0,
  Start: 25.7,
  Bibliothek: 53.0,
  Einstellungen: 72.3,
  Inicio: 28.7,
  Biblioteca: 52.7,
  Listas: 31.7,
  Ajustes: 40.3,
};

type TabProp = { id: string; label: string; icon: unknown };
type ActionProp = { id: string; label: string; icon: unknown; after: string; disabled?: boolean; onPress: () => void };
type FrameProps = {
  tabs: TabProp[];
  activeTab: string;
  onTabChange: (id: string) => void;
  disabledTabs: string[];
  tabBarAction?: ActionProp;
  overlay?: ReactNode;
  children: (tabId: string) => ReactNode;
};
const shell = vi.hoisted(() => ({
  frame: null as FrameProps | null,
  onSeeAll: null as ((target: SeeAllTarget) => void) | null,
  media: [] as unknown[],
}));

vi.mock("react-native", () => {
  const host = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  return {
    View: host("View"),
    StyleSheet: { create: <T>(styles: T): T => styles },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
  };
});
// The shell package ships its own copy of React, so react-i18next's hook cannot run inside this app's renderer; the
// real i18next instance and the real translation files stay, only the hook is bound to them directly.
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: actual.getCurrentLanguage() } }) };
});
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("lucide-react-native", () => ({
  Home: "icon:Home",
  LibraryBig: "icon:LibraryBig",
  ListVideo: "icon:ListVideo",
  Search: "icon:Search",
  Settings: "icon:Settings",
}));
vi.mock("@space/mobile-shell/components", () => {
  const passthrough = (props: { children?: ReactNode }) => createElement("Region", null, props.children);
  return {
    MobileShellFrame: (props: FrameProps) => {
      shell.frame = props;
      return createElement("Frame", null, props.overlay, props.children(props.activeTab));
    },
    MobileOfflineBanner: () => null,
    MobileNoticeToast: () => null,
    SkyCover: passthrough,
    SkyRegion: passthrough,
  };
});
vi.mock("@space/mobile-shell/notice-queue", () => ({
  useNoticeQueue: () => ({ current: null, show: () => undefined, setHeld: () => undefined, dismiss: () => undefined }),
}));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: null }) }));
vi.mock("../src/store/library", () => ({
  useLibraryData: () => ({ media: shell.media }),
  useLibraryStatus: () => ({ loadStatus: { kind: "ready" }, reload: () => undefined }),
}));
vi.mock("../src/lib/pairing/deviceWatch", () => ({ checkForNewDevices: async () => undefined, markDeviceSeen: async () => undefined }));
vi.mock("../src/lib/pairing/newDevice", () => ({ newDeviceKey: () => "", newDeviceMessage: () => "", subscribeNewDevice: () => () => undefined }));
vi.mock("../src/lib/pairing/useOpenDevices", () => ({ useOpenDevices: () => ({ devicesRequest: null, openDevices: () => undefined }) }));
vi.mock("../src/components/UnpaidAccessBanner", () => ({ UnpaidAccessBanner: () => null }));
vi.mock("../src/screens/HomeScreen", () => ({
  HomeScreen: (props: { onSeeAll: (target: SeeAllTarget) => void }) => {
    shell.onSeeAll = props.onSeeAll;
    return createElement("HomeScreen");
  },
}));
vi.mock("../src/screens/LibraryScreen", () => ({ LibraryScreen: "LibraryScreen" }));
vi.mock("../src/components/PlaylistsPanel", () => ({ PlaylistsPanel: "PlaylistsPanel" }));
vi.mock("../src/components/PhoneSearch", () => ({ PhoneSearch: "PhoneSearch" }));
vi.mock("../src/screens/SettingsScreen", () => ({ SettingsScreen: "SettingsScreen" }));

const render = () => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(createElement(MainShellScreen));
  });
  return tree;
};
const frame = (): FrameProps => {
  if (!shell.frame) throw new Error("the shell frame was not drawn");
  return shell.frame;
};
const pages = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => ["HomeScreen", "LibraryScreen", "PlaylistsPanel", "SettingsScreen"].includes(String(n.type))).map((n) => String(n.type));

describe("phone bottom bar: Home, Library, Playlists, Settings (UX-PHONE-07)", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await initI18n("en");
  });
  beforeEach(async () => {
    shell.frame = null;
    shell.onSeeAll = null;
    shell.media = [{ id: "m1" }];
    await changeLanguage("en");
  });

  /** @req UX-PHONE-07 */
  it("has the four tabs in Parrot's order, Playlists with the list-video icon", () => {
    render();
    const tabs = frame().tabs.map(({ id, label, icon }) => ({ id, label, icon }));
    console.info(`[MOBILE-MAIN-TABS-001] tabs ${JSON.stringify(tabs)}`);
    expect(tabs).toEqual([
      { id: "home", label: "Home", icon: "icon:Home" },
      { id: "library", label: "Library", icon: "icon:LibraryBig" },
      { id: "playlists", label: "Playlists", icon: "icon:ListVideo" },
      { id: "settings", label: "Settings", icon: "icon:Settings" },
    ]);
  });

  /** @req UX-PHONE-07 */
  it.each([
    ["fr", "Playlists"],
    ["de", "Playlists"],
    ["es", "Listas"],
    ["nl", "Afspeellijsten"],
  ])("names the Playlists tab in %s", async (language, label) => {
    await changeLanguage(language);
    render();
    expect(frame().tabs.find((tab) => tab.id === "playlists")?.label).toBe(label);
  });

  /** @req UX-PHONE-07 */
  it("the Playlists tab shows the playlists list; the Library tab shows the Library page, not the playlists", () => {
    const tree = render();
    expect(pages(tree)).toEqual(["HomeScreen"]);
    act(() => frame().onTabChange("playlists"));
    expect(frame().activeTab).toBe("playlists");
    expect(pages(tree)).toEqual(["PlaylistsPanel"]);
    act(() => frame().onTabChange("library"));
    expect(pages(tree)).toEqual(["LibraryScreen"]);
    act(() => frame().onTabChange("settings"));
    expect(pages(tree)).toEqual(["SettingsScreen"]);
  });

  /**
   * @req UX-PHONE-07 @req UX-LIBTAB-01[badger-mobile]
   * Chris, 2026-11-16: "if library is greyed out when empty, then the playlist menu should also be greyed out and
   * unaccissible".
   */
  it("an account with no media greys out Library and Playlists; an open Playlists tab goes back to Home", () => {
    const tree = render();
    act(() => frame().onTabChange("playlists"));
    expect(pages(tree)).toEqual(["PlaylistsPanel"]);
    shell.media = [];
    act(() => tree.update(createElement(MainShellScreen)));
    console.info("[MOBILE-MAIN-TABS-001] empty", JSON.stringify({ disabled: frame().disabledTabs, active: frame().activeTab }));
    expect(frame().disabledTabs).toEqual(["library", "playlists"]);
    expect(frame().activeTab).toBe("home");
    expect(pages(tree)).toEqual(["HomeScreen"]);
  });

  /** @req UX-LIBTAB-01[badger-mobile] */
  it("the first title turns Library and Playlists back on, with no restart", () => {
    shell.media = [];
    const tree = render();
    expect(frame().disabledTabs).toEqual(["library", "playlists"]);
    shell.media = [{ id: "m1" }];
    act(() => tree.update(createElement(MainShellScreen)));
    expect(frame().disabledTabs).toEqual([]);
    act(() => frame().onTabChange("playlists"));
    expect(pages(tree)).toEqual(["PlaylistsPanel"]);
  });

  /** @req UX-PHONE-01 @req UX-PHONE-07 */
  it("Home's See all opens the Playlists tab for Favorites and the Library on its scope for the other rows", () => {
    const tree = render();
    act(() => shell.onSeeAll?.({ tab: "playlists" }));
    expect(frame().activeTab).toBe("playlists");
    expect(pages(tree)).toEqual(["PlaylistsPanel"]);
    act(() => shell.onSeeAll?.({ tab: "library", scope: "tv" }));
    expect(frame().activeTab).toBe("library");
    expect(tree.root.find((n) => String(n.type) === "LibraryScreen").props.scopeRequest).toEqual({ scope: "tv" });
  });

  /**
   * @req UX-PHONE-12
   * Chris, 2026-11-19: "the main menu should have a search button in the center (between library and playlists).
   * Swiping right and left goes straight from library to playlists of course."
   */
  it("a Search button stands between Library and Playlists; it is not a tab (the pager never stops on it) and opens the search", () => {
    const tree = render();
    const action = frame().tabBarAction;
    console.info("[MOBILE-MAIN-TABS-001] action", JSON.stringify({ id: action?.id, label: action?.label, after: action?.after, disabled: action?.disabled }));
    expect(action).toMatchObject({ id: "search", label: "Search", icon: "icon:Search", after: "library", disabled: false });
    expect(frame().tabs.map((tab) => tab.id)).toEqual(["home", "library", "playlists", "settings"]);
    const search = () => tree.root.find((n) => String(n.type) === "PhoneSearch");
    expect(search().props.visible).toBe(false);
    act(() => frame().onTabChange("library"));
    act(() => frame().tabBarAction!.onPress());
    expect(search().props.visible).toBe(true);
    expect(frame().activeTab).toBe("library");
    act(() => search().props.onClose());
    expect(search().props.visible).toBe(false);
  });

  /** @req UX-PHONE-12 @req UX-LIBTAB-01[badger-mobile] */
  it("the Search button is greyed out while the library is empty, and named in the UI language", async () => {
    shell.media = [];
    render();
    expect(frame().tabBarAction?.disabled).toBe(true);
    await changeLanguage("fr");
    shell.media = [{ id: "m1" }];
    render();
    expect(frame().tabBarAction).toMatchObject({ label: "Rechercher", disabled: false });
  });

  /**
   * @req UX-PHONE-12 @req UX-PHONE-11
   * Main, 2026-11-20 (review of 9c1e5a5fe): the circle stays exactly at the screen's centre, each half holds its two
   * tabs split by label width with about 8 pt between labels, and nothing ends in "…" on a 360 dp phone.
   */
  it.each(["en", "fr", "nl", "de", "es"])("every %s tab label fits its half of the bar at 360 and 375 wide, 8 pt apart", async (language) => {
    await changeLanguage(language);
    render();
    const action = frame().tabBarAction!;
    const labels = frame().tabs.map((tab) => tab.label);
    const after = frame().tabs.findIndex((tab) => tab.id === action.after) + 1;
    const width = (label: string) => {
      const measured = BADGER_TAB_LABEL_WIDTHS[label];
      if (measured === undefined) throw new Error(`no measured width for "${label}": measure it on a phone and add it to BADGER_TAB_LABEL_WIDTHS`);
      return measured;
    };
    for (const phone of [360, 375]) {
      for (const half of [labels.slice(0, after), labels.slice(after)]) {
        const widths = half.map(width);
        console.info(`[MOBILE-MAIN-TABS-001] ${language} ${phone}: ${half.join(" + ")} = ${widths.join(" + ")} in ${tabBarHalfWidth(phone)}`);
        expect(tabBarHalfFits(phone, widths), `${language} ${phone}: ${half.join(" + ")}`).toBe(true);
      }
    }
  });

  it("the fit check catches a label that is too long for its half", () => {
    expect(tabBarHalfFits(360, [73, 62])).toBe(true); // Dutch "Afspeellijsten" + "Instellingen"
    expect(tabBarHalfFits(360, [73, 72.3])).toBe(false);
  });
});
