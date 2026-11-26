/**
 * @test-id MOBILE-NEW-DEVICE-NOTICE-OVERLAY-001
 * @level unit
 * @req ACCT-PAIR-03[badger-mobile] @req UX-NOTICE-01[badger-mobile] @req UX-NOTICE-04[badger-mobile] @req UX-NOTICE-11[badger-mobile]
 * @why Chris 2026-11-12 (chat): the "New device added" notice sat above the Settings title (and Home's rows) and pushed
 *   the page down. It now floats over the page: `MainShellScreen` hands it to the frame's `overlay`, never to a page. It
 *   leaves after `NOTICE_DURATION_MS`, at once when tapped (which opens Settings, where "Your devices" is) or closed,
 *   and whatever ends it marks the device seen. Real screen, real queue and real translations; the frame is a stand-in
 *   that renders the active page and the overlay side by side, fake timers for the auto-dismiss. The notice is also kept
 *   in the bell's history (UX-NOTICE-04) of the signed-in user, once per device however often it is announced
 *   (UX-NOTICE-11), and the entry's button opens the device list like the notice.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import type * as I18nModule from "@space/mobile-shell/i18n";
import type { NoticeHistory } from "@space/notify-core/history";
import { NOTICE_TIMINGS } from "@space/notify-core/kinds";
import { announceNewDevice } from "../src/lib/pairing/newDevice";
import { MainShellScreen } from "../src/screens/MainShellScreen";

const NOTICE_DURATION_MS = NOTICE_TIMINGS.headsUpMs;

const state = vi.hoisted(() => ({
  frame: { activeTab: "", overlay: null as ReactNode },
  seen: [] as (string | null)[],
  // False while another stack screen (the player) covers the shell.
  focused: true,
  user: null as { id: string } | null,
  bell: null as { history: NoticeHistory | null; onOpenTarget?: (target: string) => void } | null,
  stored: new Map<string, string>(),
}));

vi.mock("react-native", async () => {
  const host = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  return {
    // vi.mock factories are hoisted above static imports, so the shared fake loads here.
    ...(await import("./setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: actual.getCurrentLanguage() } }) };
});
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => state.focused, useNavigation: () => ({ navigate: () => undefined }) }));
vi.mock("@space/mobile-shell/account-news", () => ({ useAccountNews: () => undefined }));
vi.mock("lucide-react-native", () => ({ Home: "Icon", LibraryBig: "Icon", ListVideo: "Icon", Search: "Icon", Settings: "Icon" }));
vi.mock("@space/mobile-shell/components", () => {
  const passthrough = (props: { children?: ReactNode }) => createElement("Region", null, props.children);
  return {
    // The frame's contract: pages in the pager, `overlay` beside them (MOBILE-SHELL-NOTICE-OVERLAY-001 pins the real one).
    MobileShellFrame: (props: { activeTab: string; overlay?: ReactNode; header?: ReactNode; children: (tabId: string) => ReactNode }) => {
      state.frame = { activeTab: props.activeTab, overlay: props.overlay ?? null };
      return createElement(
        "Frame",
        null,
        props.header ? createElement("HeaderSlot", null, props.header) : null,
        createElement("Pager", null, props.children(props.activeTab)),
        props.overlay ? createElement("OverlaySlot", null, props.overlay) : null,
      );
    },
    MobileNoticeToast: (props: Record<string, unknown>) => createElement("NoticeToast", props),
    MobileOfflineIndicator: () => null,
    SkyCover: passthrough,
    SkyRegion: passthrough,
  };
});
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: null, user: state.user }) }));
// The bell's own drawing is MOBILE-SHELL-NOTICE-HISTORY-001; here only the history the screen hands it.
vi.mock("@space/mobile-shell/notice-bell", () => ({
  MobileNoticeBell: (props: { history: NoticeHistory | null; onOpenTarget?: (target: string) => void }) => {
    state.bell = props;
    return null;
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => state.stored.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      state.stored.set(key, value);
    },
  },
}));
// The tab bar's unpaid sign (tested in mobile-shell) loads the real safe-area module, which plain node cannot load.
vi.mock("@space/mobile-shell/unpaid-access-sign", () => ({ UnpaidAccessSign: () => null }));
vi.mock("../src/store/library", () => ({
  useLibraryData: () => ({ media: [] }),
  useLibraryStatus: () => ({ loadStatus: { kind: "ready" }, syncState: { kind: "idle" }, reload: () => undefined }),
}));
vi.mock("../src/lib/pairing/deviceWatch", () => ({
  checkForNewDevices: async () => [],
  markDeviceSeen: async (sessionId: string | null) => {
    state.seen.push(sessionId);
  },
}));
vi.mock("../src/screens/HomeScreen", () => ({ HomeScreen: () => createElement("HomeScreen") }));
vi.mock("../src/screens/LibraryScreen", () => ({ LibraryScreen: () => null }));
vi.mock("../src/components/PlaylistsPanel", () => ({ PlaylistsPanel: () => null }));
// The phone Search overlay (UX-PHONE-12) pulls react-native-fs and the real shell components, which plain node cannot load.
vi.mock("../src/components/PhoneSearch", () => ({ PhoneSearch: () => null }));
vi.mock("../src/screens/SettingsScreen", () => ({ SettingsScreen: () => createElement("SettingsScreen") }));

const log = (step: string, detail: unknown) => console.info(`[MOBILE-NEW-DEVICE-NOTICE-OVERLAY-001] ${step}`, JSON.stringify(detail));

const mounted: ReactTestRenderer[] = [];
const render = () => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(createElement(MainShellScreen));
  });
  mounted.push(tree);
  return tree;
};
const isType = (type: string) => (n: ReactTestInstance) => (n.type as unknown) === type;
const pager = (tree: ReactTestRenderer) => tree.root.find(isType("Pager"));
const notices = (tree: ReactTestRenderer) => tree.root.findAll(isType("NoticeToast"));
/** The page's rendered tree as plain data (functions left out), to compare two moments. */
const snapshot = (node: ReactTestInstance | string): unknown =>
  typeof node === "string"
    ? node
    : {
        type: typeof node.type === "string" ? node.type : "component",
        props: Object.fromEntries(Object.entries(node.props).filter(([k, v]) => k !== "children" && typeof v !== "function")),
        children: node.children.map(snapshot),
      };

const DEN_TV = { sessionId: "s-den", deviceName: "Den TV", deviceType: "tv" };

describe("the phone's new device notice floats over the page (UX-NOTICE-01)", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await initI18n("en");
  });
  beforeEach(() => {
    vi.useFakeTimers();
    state.seen = [];
    state.focused = true;
    state.user = null;
    state.bell = null;
    state.stored.clear();
  });
  afterEach(() => {
    act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
    vi.useRealTimers();
  });

  it("shows over the page without changing it, then leaves after the fixed time and marks the device seen", () => {
    const tree = render();
    const pageBefore = JSON.stringify(snapshot(pager(tree)));
    act(() => announceNewDevice(DEN_TV));
    const [notice] = notices(tree);
    log("shown", { title: notice?.props.title, hint: notice?.props.hint, page: pageBefore });
    expect(notice.props.title).toBe("New device added: Den TV (TV)");
    expect(notice.props.closeLabel).toBe("Dismiss notice");
    expect(JSON.stringify(snapshot(pager(tree)))).toBe(pageBefore);
    expect(pager(tree).findAll(isType("NoticeToast"))).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS - 1);
    });
    expect(notices(tree)).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    log("after timeout", { notices: notices(tree).length, seen: state.seen });
    expect(notices(tree)).toHaveLength(0);
    expect(state.seen).toEqual(["s-den"]);
    expect(JSON.stringify(snapshot(pager(tree)))).toBe(pageBefore);
  });

  it("a tap opens Settings (the device list) and dismisses it at once; it is seen", () => {
    const tree = render();
    act(() => announceNewDevice(DEN_TV));
    expect(state.frame.activeTab).toBe("home");
    act(() => (notices(tree)[0].props.onOpen as () => void)());
    log("opened", { activeTab: state.frame.activeTab, notices: notices(tree).length, seen: state.seen });
    expect(state.frame.activeTab).toBe("settings");
    expect(notices(tree)).toHaveLength(0);
    expect(state.seen).toEqual(["s-den"]);
  });

  it("the cross closes it at once without leaving the page; it is seen and the timer no longer runs", () => {
    const tree = render();
    act(() => announceNewDevice(DEN_TV));
    act(() => (notices(tree)[0].props.onClose as () => void)());
    act(() => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS * 2);
    });
    log("closed", { activeTab: state.frame.activeTab, seen: state.seen });
    expect(notices(tree)).toHaveLength(0);
    expect(state.frame.activeTab).toBe("home");
    expect(state.seen).toEqual(["s-den"]);
  });

  /**
   * @bugfix @regression-proof
   * Closed test 2026-11-13: raised while the player covered the shell, the notice showed behind the player, timed out
   * there and was marked seen, so the user never saw it. It now waits, unseen and without a timer, until the shell is
   * back in front, then shows for the full time.
   */
  it("@bugfix @regression-proof raised while the player is open, it waits unseen and shows once the player closes", () => {
    const tree = render();
    act(() => {
      state.focused = false;
      tree.update(createElement(MainShellScreen));
    });
    act(() => announceNewDevice(DEN_TV));
    act(() => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS * 3);
    });
    log("player open", { notices: notices(tree).length, seen: state.seen });
    expect(notices(tree)).toHaveLength(0);
    expect(state.seen).toEqual([]);

    act(() => {
      state.focused = true;
      tree.update(createElement(MainShellScreen));
    });
    log("player closed", { notices: notices(tree).map((n) => n.props.title), seen: state.seen });
    expect(notices(tree)).toHaveLength(1);
    expect(notices(tree)[0].props.title).toBe("New device added: Den TV (TV)");
    expect(state.seen).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS);
    });
    expect(notices(tree)).toHaveLength(0);
    expect(state.seen).toEqual(["s-den"]);
  });

  it("is kept in the signed-in user's bell history once per device, and the entry's button opens the device list", async () => {
    state.user = { id: "user-1" };
    const tree = render();
    const history = state.bell?.history;
    if (!history) throw new Error("no history handed to the bell");
    await history.ready;
    act(() => announceNewDevice(DEN_TV));
    act(() => announceNewDevice(DEN_TV));
    const entries = history.getAll();
    log("history", entries.map((e) => ({ key: e.key, title: e.title, message: e.message, action: e.action, read: e.read })));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      // The key the account's news gives this sign-in (UX-NOTICE-05), so the two are one entry.
      key: "new-device-s-den",
      scope: "account",
      read: false,
      title: { key: "notify.account.newDevice" },
      message: { key: "notify.account.newDeviceMessage", vars: { name: "Den TV", type: { key: "notify.account.deviceType.tv" } } },
      action: { label: { key: "account.devices.title" }, target: "devices" },
    });
    expect(history.unreadCount()).toBe(1);
    await vi.waitFor(() => expect(state.stored.get("sf.notifications.user-1")).toContain("new-device-s-den"));

    act(() => (notices(tree)[0].props.onClose as () => void)());
    expect(state.frame.activeTab).toBe("home");
    act(() => state.bell?.onOpenTarget?.("devices"));
    log("entry opened", { activeTab: state.frame.activeTab });
    expect(state.frame.activeTab).toBe("settings");
  });
});
