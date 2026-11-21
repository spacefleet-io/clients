/**
 * TV-NEW-DEVICE-NOTICE-001. Chris 2026-11-12 (chat): the "New device added" notice sat between the tabs and the Home
 * rows and pushed the rows down. It now floats in an absolute layer at the top right, outside the tab bar's focus guide
 * and outside the page, so the bar and the page are the same with and without it. It is never the initial focus (Home
 * keeps it); the remote can still reach it. It leaves after `NOTICE_DURATION_MS` (paused while focused), on OK (which
 * opens Settings, where "Your devices" is) or on Back, and whatever ends it marks the device seen.
 * Rendered with react-test-renderer and host-element stand-ins for react-native; fake timers for the auto-dismiss.
 *
 * @req ACCT-PAIR-03[badger-tv] @req UX-NOTICE-01[badger-tv]
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { NOTICE_DURATION_MS } from "@space/mobile-shell/notice-queue";
import { announceNewDevice } from "../../lib/pairing/newDevice";
import { TvMainShell } from "./TvMainShell";

const state = vi.hoisted(() => {
  // Metro turns `require("../../assets/badger-icon.png")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".png"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
  return {
    back: [] as (() => boolean)[],
    seen: [] as (string | null)[],
    // False while another stack screen (the player) covers the shell.
    focused: true,
  };
});

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    // vi.mock factories are hoisted above static imports, so the shared fake loads here.
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    Image: host("Image"),
    TVFocusGuideView: host("TVFocusGuideView"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    BackHandler: {
      addEventListener: (_event: string, listener: () => boolean) => {
        state.back.push(listener);
        return { remove: () => state.back.splice(state.back.indexOf(listener), 1) };
      },
    },
    useTVEventHandler: () => undefined,
    useWindowDimensions: () => ({ width: 1920, height: 1080 }),
  };
});
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => state.focused }));
vi.mock("lucide-react-native", () => ({ Home: "Icon", Library: "Icon", ListVideo: "Icon", Search: "Icon", Settings: "Icon", CloudOff: "Icon", RefreshCw: "Icon" }));
vi.mock("@space/mobile-shell/components", () => ({
  createSkyCoverRegistry: () => ({}),
  createUserInputSignal: () => ({}),
  MobileAppBackdrop: () => null,
  SkyCover: ({ children }: { children: React.ReactNode }) => children,
  SkyCoversProvider: ({ children }: { children: React.ReactNode }) => children,
  SkyRegion: ({ children }: { children: React.ReactNode }) => React.createElement("SkyRegion", null, children),
  useMobileSkyMode: () => "static",
  useSkyRemoteInput: () => undefined,
  formatPendingOpsLabel: (count: number) => `${count} changes`,
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }), translate: (key: string) => key }));
vi.mock("../../components/UnpaidAccessBanner", () => ({ UnpaidAccessBanner: () => null }));
vi.mock("../../lib/pairing/deviceWatch", () => ({
  checkForNewDevices: () => undefined,
  markDeviceSeen: async (sessionId: string | null) => {
    state.seen.push(sessionId);
  },
}));
vi.mock("../../store/auth", () => ({ useAuth: () => ({ token: null }) }));
vi.mock("../../store/library", () => ({
  useLibraryStatus: () => ({ loadStatus: { kind: "ready" }, reload: () => undefined }),
  useLibraryData: () => ({ media: [{ id: "m1" }] }),
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

const log = (step: string, detail: unknown) => console.info(`[TV-NEW-DEVICE-NOTICE-001] ${step}`, JSON.stringify(detail));
const isType = (type: string) => (n: ReactTestInstance) => (n.type as unknown) === type;
const flatStyle = (n: ReactTestInstance) => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
const notice = (tree: ReactTestRenderer) => tree.root.findAll((n) => n.props.testID === "tv-new-device-banner" && isType("Pressable")(n));
/** A subtree as plain data (functions left out), to compare the bar and the page before and after the notice. */
const snapshot = (node: ReactTestInstance | string): unknown =>
  typeof node === "string"
    ? node
    : {
        type: typeof node.type === "string" ? node.type : "component",
        props: Object.fromEntries(Object.entries(node.props).filter(([k, v]) => k !== "children" && typeof v !== "function")),
        children: node.children.map(snapshot),
      };
const layout = (tree: ReactTestRenderer) =>
  JSON.stringify([tree.root.find(isType("TVFocusGuideView")), tree.root.find(isType("SkyRegion"))].map(snapshot));

const DEN_PHONE = { sessionId: "s-phone", deviceName: "Den phone", deviceType: "phone" };
const mounted: ReactTestRenderer[] = [];
const render = () => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<TvMainShell />);
  });
  mounted.push(tree);
  return tree;
};

describe("the TV's new device notice floats over the page (TV-NEW-DEVICE-NOTICE-001)", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    state.back = [];
    state.seen = [];
    state.focused = true;
  });
  afterEach(() => {
    act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
    vi.useRealTimers();
  });

  it("sits in an absolute layer outside the bar and the page, never takes the first focus, and leaves after the fixed time", () => {
    const tree = render();
    const before = layout(tree);
    act(() => announceNewDevice(DEN_PHONE));
    const [card] = notice(tree);
    const layer = tree.root.find((n) => isType("View")(n) && n.findAll((c) => c === card).length > 0 && flatStyle(n).position === "absolute");
    log("shown", { layer: flatStyle(layer), pointerEvents: layer.props.pointerEvents, focus: card.props.hasTVPreferredFocus ?? null });
    expect(layout(tree)).toBe(before);
    expect(tree.root.find(isType("TVFocusGuideView")).findAll((n) => n === card)).toHaveLength(0);
    expect(tree.root.find(isType("SkyRegion")).findAll((n) => n === card)).toHaveLength(0);
    expect(flatStyle(layer).position).toBe("absolute");
    expect(layer.props.pointerEvents).toBe("box-none");
    expect(card.props.hasTVPreferredFocus).toBeUndefined();
    expect(card.props.autoFocus).toBeUndefined();
    expect(card.props.accessibilityLabel).toBe("pairing.newDevice.accessibility");

    act(() => void vi.advanceTimersByTime(NOTICE_DURATION_MS - 1));
    expect(notice(tree)).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    log("after timeout", { notices: notice(tree).length, seen: state.seen });
    expect(notice(tree)).toHaveLength(0);
    expect(state.seen).toEqual(["s-phone"]);
    expect(layout(tree)).toBe(before);
  });

  it("stays while the remote is on it, and gets a full period again once focus leaves", () => {
    const tree = render();
    act(() => announceNewDevice(DEN_PHONE));
    act(() => notice(tree)[0].props.onFocus());
    act(() => void vi.advanceTimersByTime(NOTICE_DURATION_MS * 3));
    expect(notice(tree)).toHaveLength(1);
    act(() => notice(tree)[0].props.onBlur());
    act(() => void vi.advanceTimersByTime(NOTICE_DURATION_MS - 1));
    expect(notice(tree)).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    log("after blur + period", { notices: notice(tree).length });
    expect(notice(tree)).toHaveLength(0);
  });

  it("OK opens Settings and dismisses it at once; it is seen", () => {
    const tree = render();
    act(() => announceNewDevice(DEN_PHONE));
    act(() => notice(tree)[0].props.onPress());
    log("opened", { settings: tree.root.findAll(isType("TvSettingsScreen")).length, seen: state.seen });
    expect(notice(tree)).toHaveLength(0);
    expect(tree.root.findAll(isType("TvSettingsScreen"))).toHaveLength(1);
    expect(state.seen).toEqual(["s-phone"]);
  });

  it("Back dismisses it and stays on Home; it is seen", () => {
    const tree = render();
    expect(state.back).toHaveLength(0);
    act(() => announceNewDevice(DEN_PHONE));
    expect(state.back).toHaveLength(1);
    let handled = false;
    act(() => {
      handled = state.back[0]();
    });
    log("back", { handled, notices: notice(tree).length, seen: state.seen });
    expect(handled).toBe(true);
    expect(notice(tree)).toHaveLength(0);
    expect(tree.root.findAll(isType("TvHomeScreen"))).toHaveLength(1);
    expect(state.seen).toEqual(["s-phone"]);
    // Back on Home with no notice goes back to the system again.
    expect(state.back).toHaveLength(0);
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
      tree.update(<TvMainShell />);
    });
    act(() => announceNewDevice(DEN_PHONE));
    act(() => void vi.advanceTimersByTime(NOTICE_DURATION_MS * 3));
    log("player open", { notices: notice(tree).length, seen: state.seen, back: state.back.length });
    expect(notice(tree)).toHaveLength(0);
    expect(state.seen).toEqual([]);

    act(() => {
      state.focused = true;
      tree.update(<TvMainShell />);
    });
    log("player closed", { notices: notice(tree).length, seen: state.seen });
    expect(notice(tree)).toHaveLength(1);
    expect(state.seen).toEqual([]);
    act(() => void vi.advanceTimersByTime(NOTICE_DURATION_MS));
    expect(notice(tree)).toHaveLength(0);
    expect(state.seen).toEqual(["s-phone"]);
  });
});
