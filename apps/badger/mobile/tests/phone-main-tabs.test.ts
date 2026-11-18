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

type TabProp = { id: string; label: string; icon: unknown };
type FrameProps = { tabs: TabProp[]; activeTab: string; onTabChange: (id: string) => void; disabledTabs: string[]; children: (tabId: string) => ReactNode };
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
  return { ...actual, useTranslation: () => ({ t: actual.translate }) };
});
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("lucide-react-native", () => ({ Home: "icon:Home", LibraryBig: "icon:LibraryBig", ListVideo: "icon:ListVideo", Settings: "icon:Settings" }));
vi.mock("@space/mobile-shell/components", () => {
  const passthrough = (props: { children?: ReactNode }) => createElement("Region", null, props.children);
  return {
    MobileShellFrame: (props: FrameProps) => {
      shell.frame = props;
      return createElement("Frame", null, props.children(props.activeTab));
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
});
