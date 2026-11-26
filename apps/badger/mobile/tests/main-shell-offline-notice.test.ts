/**
 * @test-id MOBILE-SHELL-OFFLINE-NOTICE-001
 * @level unit
 * @req UX-NOTICE-02[badger-mobile] @req UX-NOTICE-01[badger-mobile] @req LIB-SYNC-13[badger-mobile]
 * @req ACCT-UNPAID-05[badger-mobile] @req UX-NOTICE-08[badger-mobile]
 * @why Chris 2026-11-13 (design feedback on a dev build that could not reach its server): the phone showed a big red
 *   "Offline" box above every page plus the line "Offline mode: using cached media library." under it, about a quarter
 *   of the screen for as long as it stayed offline. Offline is a normal state (downloads and the saved library work
 *   without internet), so it now says so once in a notice that floats over the page and leaves after the standard
 *   time, and a small sign stays on the tab bar while offline. Nothing in the page moves. When the connection returns
 *   the sign goes and nothing else is shown. Real screen, real queue and real translations; the frame is a stand-in
 *   that renders the active page, the overlay and the tab bar's badge side by side; fake timers for the auto-dismiss.
 *   Chris 2026-11-26 (ACCT-UNPAID-05, UX-NOTICE-08): the unpaid sign sits in the same tab bar slot, beside the offline
 *   or update sign, so the tab pages show it without covering their titles.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import type * as I18nModule from "@space/mobile-shell/i18n";
import { NOTICE_TIMINGS } from "@space/notify-core/kinds";
import { announceNewDevice } from "../src/lib/pairing/newDevice";
import { MainShellScreen } from "../src/screens/MainShellScreen";

const NOTICE_DURATION_MS = NOTICE_TIMINGS.headsUpMs;

type LoadStatus =
  | { kind: "ready" }
  | { kind: "offline"; reason: "network" | "sync_error"; pendingOps: number; cacheVersion: number; lastError: string };

const state = vi.hoisted(() => ({
  loadStatus: { kind: "ready" } as LoadStatus,
  /** The store's `syncState` (LIB-SYNC-13); typed loosely, the screen passes it through. */
  syncState: { kind: "idle" } as Record<string, unknown> & { kind: string },
  reloads: 0,
  refreshes: 0,
  focused: true,
  access: null as { state: string; paidUntil: string | null; wipeAt: string | null } | null,
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
    // The frame's contract: pages in the pager, `overlay` floating beside them, `tabBarBadge` on the tab bar.
    MobileShellFrame: (props: {
      activeTab: string;
      overlay?: ReactNode;
      tabBarBadge?: ReactNode;
      children: (tabId: string) => ReactNode;
    }) =>
      createElement(
        "Frame",
        null,
        createElement("Pager", null, props.children(props.activeTab)),
        props.overlay ? createElement("OverlaySlot", null, props.overlay) : null,
        createElement("TabBar", null, props.tabBarBadge ?? null),
      ),
    MobileNoticeToast: (props: Record<string, unknown>) => createElement("NoticeToast", props),
    MobileOfflineIndicator: (props: Record<string, unknown>) => createElement("OfflineIndicator", props),
    MobileSyncIndicator: (props: Record<string, unknown>) => createElement("SyncIndicator", props),
    SkyCover: passthrough,
    SkyRegion: passthrough,
  };
});
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: null, user: state.access ? { access: state.access } : null }) }));
// The real sign is tested in mobile-shell; here only where the shell puts it matters.
vi.mock("@space/mobile-shell/unpaid-access-sign", () => ({
  UnpaidAccessSign: (props: Record<string, unknown>) => createElement("UnpaidSign", props),
}));
vi.mock("../src/store/library", () => ({
  useLibraryData: () => ({ media: [] }),
  useLibraryStatus: () => ({
    loadStatus: state.loadStatus,
    syncState: state.syncState,
    reload: () => {
      state.reloads += 1;
    },
    refresh: async () => {
      state.refreshes += 1;
    },
  }),
}));
vi.mock("../src/lib/pairing/deviceWatch", () => ({
  checkForNewDevices: async () => [],
  markDeviceSeen: async () => undefined,
}));
vi.mock("../src/screens/HomeScreen", () => ({ HomeScreen: () => createElement("HomeScreen") }));
vi.mock("../src/screens/LibraryScreen", () => ({ LibraryScreen: () => null }));
// The Playlists tab (#2220) renders this panel; the real one pulls react-native modules this stand-in shell cannot load.
vi.mock("../src/components/PlaylistsPanel", () => ({ PlaylistsPanel: () => null }));
// The phone Search overlay (UX-PHONE-12) pulls react-native-fs and the real shell components, which plain node cannot load.
vi.mock("../src/components/PhoneSearch", () => ({ PhoneSearch: () => null }));
vi.mock("../src/screens/SettingsScreen", () => ({ SettingsScreen: () => createElement("SettingsScreen") }));
// The header bell (MOBILE-SHELL-NOTICE-HISTORY-001) and its device storage load native modules plain node cannot load.
vi.mock("@space/mobile-shell/notice-bell", () => ({ MobileNoticeBell: () => null }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));

const log = (step: string, detail: unknown) => console.info(`[MOBILE-SHELL-OFFLINE-NOTICE-001] ${step}`, JSON.stringify(detail));

const OFFLINE: LoadStatus = {
  kind: "offline",
  reason: "network",
  pendingOps: 2,
  cacheVersion: 4,
  lastError: "Could not reach the API at http://192.168.0.161:3000.",
};

const mounted: ReactTestRenderer[] = [];
const render = () => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(createElement(MainShellScreen));
  });
  mounted.push(tree);
  return tree;
};
const rerender = (tree: ReactTestRenderer, loadStatus: LoadStatus) =>
  act(() => {
    state.loadStatus = loadStatus;
    tree.update(createElement(MainShellScreen));
  });
const isType = (type: string) => (n: ReactTestInstance) => (n.type as unknown) === type;
const notices = (tree: ReactTestRenderer) => tree.root.findAll(isType("NoticeToast"));
const indicators = (tree: ReactTestRenderer) => tree.root.findAll(isType("OfflineIndicator"));
/** The page as plain data (functions left out), to prove nothing in it changed. */
const snapshot = (node: ReactTestInstance | string): unknown =>
  typeof node === "string"
    ? node
    : {
        type: typeof node.type === "string" ? node.type : "component",
        props: Object.fromEntries(Object.entries(node.props).filter(([k, v]) => k !== "children" && typeof v !== "function")),
        children: node.children.map(snapshot),
      };
const page = (tree: ReactTestRenderer) => JSON.stringify(snapshot(tree.root.find(isType("Pager"))));
const dump = (label: string, tree: ReactTestRenderer) =>
  log(`dump ${label}`, {
    loadStatus: state.loadStatus,
    notices: notices(tree).map((n) => ({ testID: n.props.testID, title: n.props.title, hint: n.props.hint })),
    indicators: indicators(tree).map((n) => ({ variant: n.props.variant, pendingOps: n.props.pendingOps })),
    page: page(tree),
  });

describe("offline on the phone: a passing notice and a small sign, never a banner (UX-NOTICE-02)", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await initI18n("en");
  });
  beforeEach(() => {
    vi.useFakeTimers();
    state.loadStatus = { kind: "ready" };
    state.reloads = 0;
    state.refreshes = 0;
    state.syncState = { kind: "idle" };
    state.focused = true;
  });
  afterEach(() => {
    act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
    vi.useRealTimers();
  });

  it("going offline floats one notice over the page, which leaves after the standard time; the page never moves", () => {
    const tree = render();
    const pageOnline = page(tree);
    rerender(tree, OFFLINE);
    dump("offline", tree);
    const [notice] = notices(tree);
    expect(notices(tree)).toHaveLength(1);
    expect(notice.props.testID).toBe("offline-notice");
    expect(notice.props.title).toBe("You're offline");
    expect(notice.props.hint).toBe("Your saved media library and downloads stay available.");
    expect(tree.root.find(isType("Pager")).findAll(isType("NoticeToast"))).toHaveLength(0);
    expect(page(tree), "no banner and no offline line in the page").toBe(pageOnline);
    expect(page(tree)).not.toMatch(/offline|cached|http/i);

    act(() => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS - 1);
    });
    expect(notices(tree)).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    dump("after timeout", tree);
    expect(notices(tree)).toHaveLength(0);
    expect(page(tree)).toBe(pageOnline);
  });

  it("while offline a small sign stays on the tab bar, with the waiting changes, and tapping it retries", () => {
    const tree = render();
    expect(indicators(tree)).toHaveLength(0);
    rerender(tree, OFFLINE);
    act(() => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS * 3);
    });
    dump("long offline", tree);
    const [sign] = indicators(tree);
    expect(indicators(tree)).toHaveLength(1);
    expect(tree.root.find(isType("TabBar")).findAll(isType("OfflineIndicator"))).toHaveLength(1);
    expect(sign.props.variant).toBe("network");
    expect(sign.props.pendingOps).toBe(2);
    expect(sign.props).not.toHaveProperty("detail");
    act(() => (sign.props.onRetry as () => void)());
    expect(state.reloads).toBe(1);
  });

  it("re-renders while offline never show the notice again", () => {
    const tree = render();
    rerender(tree, OFFLINE);
    act(() => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS);
    });
    rerender(tree, { ...OFFLINE, pendingOps: 3 });
    rerender(tree, { ...OFFLINE, pendingOps: 3 });
    dump("still offline", tree);
    expect(notices(tree)).toHaveLength(0);
    expect(indicators(tree)[0].props.pendingOps).toBe(3);
  });

  it("when the connection returns the sign goes, a notice still up is taken back, and nothing else shows", () => {
    const tree = render();
    rerender(tree, OFFLINE);
    expect(notices(tree)).toHaveLength(1);
    rerender(tree, { kind: "ready" });
    dump("back online", tree);
    expect(notices(tree)).toHaveLength(0);
    expect(indicators(tree)).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS * 2);
    });
    expect(notices(tree)).toHaveLength(0);
  });

  it("a failed sync with a working connection never says offline", () => {
    const tree = render();
    rerender(tree, { ...OFFLINE, reason: "sync_error" });
    dump("sync error", tree);
    expect(notices(tree)[0].props.title).toBe("Media library sync failed");
    expect(notices(tree)[0].props.hint).toBe("Your saved media library stays on screen.");
    expect(indicators(tree)[0].props.variant).toBe("sync_error");
  });

  it("tapping the notice retries and dismisses it at once", () => {
    const tree = render();
    rerender(tree, OFFLINE);
    act(() => (notices(tree)[0].props.onOpen as () => void)());
    expect(state.reloads).toBe(1);
    expect(notices(tree)).toHaveLength(0);
    expect(indicators(tree)).toHaveLength(1);
  });

  it("shares the one notice slot with the new device notice: one at a time", () => {
    const tree = render();
    rerender(tree, OFFLINE);
    act(() => announceNewDevice({ sessionId: "s-den", deviceName: "Den TV", deviceType: "tv" }));
    expect(notices(tree).map((n) => n.props.testID)).toEqual(["offline-notice"]);
    act(() => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS);
    });
    dump("after offline notice", tree);
    expect(notices(tree).map((n) => n.props.testID)).toEqual(["new-device-notice"]);
  });

  it("LIB-SYNC-13: an updating library shows its sign on the tab bar with the progress; offline still wins", () => {
    state.syncState = { kind: "syncing", source: "start", fromVersion: 10, toVersion: 30, doneVersion: 15, phase: "ops" };
    const tree = render();
    const sync = tree.root.findAll(isType("SyncIndicator"));
    log("syncing", sync.map((n) => n.props.state));
    expect(sync).toHaveLength(1);
    expect(sync[0].props.state).toEqual({ kind: "syncing", progress: 0.25 });
    expect(indicators(tree)).toHaveLength(0);

    rerender(tree, OFFLINE);
    expect(tree.root.findAll(isType("SyncIndicator")), "the offline sign takes the slot").toHaveLength(0);
    expect(indicators(tree)).toHaveLength(1);
  });

  it("LIB-SYNC-13: a failed update's sign retries as a pull; an idle library shows nothing", () => {
    state.syncState = { kind: "failed", source: "foreground", error: "boom" };
    const tree = render();
    act(() => (tree.root.find(isType("SyncIndicator")).props.onRetry as () => void)());
    expect(state.refreshes).toBe(1);

    act(() => {
      state.syncState = { kind: "idle" };
      tree.update(createElement(MainShellScreen));
    });
    expect(tree.root.findAll(isType("SyncIndicator"))).toHaveLength(0);
  });
});

describe("the unpaid sign on the tab pages sits on the tab bar (ACCT-UNPAID-05, UX-NOTICE-08)", () => {
  const UNPAID = { state: "unpaid", paidUntil: "2020-01-01T00:00:00.000Z", wipeAt: "2099-12-16T12:00:00.000Z" };
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await initI18n("en");
  });
  beforeEach(() => {
    state.loadStatus = { kind: "ready" };
    state.syncState = { kind: "idle" };
    state.focused = true;
    state.access = UNPAID;
  });
  afterEach(() => {
    state.access = null;
    for (const tree of mounted.splice(0)) act(() => tree.unmount());
  });
  const tabBar = (tree: ReactTestRenderer) => tree.root.find(isType("TabBar"));

  it("an unpaid account sees the sign in the tab bar's slot, the bare pill, and not in the page", () => {
    const tree = render();
    const signs = tabBar(tree).findAll(isType("UnpaidSign"));
    log("unpaid tab bar", signs.map((n) => n.props));
    expect(signs).toHaveLength(1);
    expect(signs[0].props).toMatchObject({ access: UNPAID, inline: true });
    expect(tree.root.find(isType("Pager")).findAll(isType("UnpaidSign"))).toHaveLength(0);
  });

  it("offline too: both signs share the slot, side by side", () => {
    state.loadStatus = OFFLINE;
    const tree = render();
    expect(tabBar(tree).findAll(isType("UnpaidSign"))).toHaveLength(1);
    expect(tabBar(tree).findAll(isType("OfflineIndicator"))).toHaveLength(1);
  });

  it("a paid or free account, or one not yet known, gets no sign and an empty slot", () => {
    for (const access of [
      { state: "paid", paidUntil: "2099-01-01T00:00:00.000Z", wipeAt: null },
      { state: "free", paidUntil: null, wipeAt: null },
      null,
    ]) {
      state.access = access;
      const tree = render();
      expect(tabBar(tree).children, String(access?.state ?? "unknown")).toHaveLength(0);
    }
  });
});
