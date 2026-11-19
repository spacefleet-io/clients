/**
 * @test-id TV-FOUNDER-NOTICE-001
 * @level unit
 * @req WAIT-FOUND-04[badger-tv]
 * @why Founder launch 2026-11-18: a founder signing in on the TV sees the one-time "🎫 Founder ticket recognised." notice
 *   once, in the shell's floating notice slot (UX-NOTICE-01). Unlike the new-device notice it takes the remote's focus as
 *   it shows, so its timer waits while the user reads it; OK or Back closes it, and however it leaves the TV tells the API
 *   (`POST /account/founder/notice-seen`) so no device shows it again. While the player covers the shell it waits unseen.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { founderWatch } from "@space/mobile-shell/founder";
import { TvMainShell } from "./TvMainShell";

const state = vi.hoisted(() => {
  // Metro turns `require("../../assets/badger-icon.png")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".png"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
  return {
    back: [] as (() => boolean)[],
    focused: true,
    language: "en",
    status: { founder: true, since: "2026-03-03T10:00:00.000Z" as string | null, noticePending: true },
    fetched: [] as string[],
    seen: [] as string[],
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
vi.mock("@space/shared/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFounderStatus: async (token: string) => {
    state.fetched.push(token);
    return state.status;
  },
  markFounderNoticeSeen: async (token: string) => {
    state.seen.push(token);
    return { ok: true };
  },
}));
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
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: state.language } }),
  translate: (key: string) => key,
}));
vi.mock("../../components/UnpaidAccessBanner", () => ({ UnpaidAccessBanner: () => null }));
vi.mock("../../lib/pairing/deviceWatch", () => ({ checkForNewDevices: () => undefined, markDeviceSeen: async () => undefined }));
vi.mock("../../store/auth", () => ({ useAuth: () => ({ token: "tv-tok" }) }));
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
vi.mock("../lib/useTvMenuKey", () => ({ useTvMenuKeyHold: () => undefined }));
vi.mock("./TvHomeScreen", () => ({ TvHomeScreen: "TvHomeScreen" }));
vi.mock("./TvLibraryScreen", () => ({ TvLibraryScreen: "TvLibraryScreen" }));
vi.mock("./TvPlaylistsScreen", () => ({ TvPlaylistsScreen: "TvPlaylistsScreen" }));
vi.mock("./TvSearchScreen", () => ({ TvSearchScreen: "TvSearchScreen" }));
vi.mock("./TvSettingsScreen", () => ({ TvSettingsScreen: "TvSettingsScreen" }));

const log = (step: string, detail: unknown) => console.info(`[TV-FOUNDER-NOTICE-001] ${step}`, JSON.stringify(detail));
const isType = (type: string) => (n: ReactTestInstance) => (n.type as unknown) === type;
const banner = (tree: ReactTestRenderer) => tree.root.findAll((n) => n.props.testID === "tv-founder-banner" && isType("Pressable")(n));
const textOf = (node: ReactTestInstance): string => node.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("|");

const mounted: ReactTestRenderer[] = [];
const render = async () => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<TvMainShell />);
  });
  mounted.push(tree);
  return tree;
};

describe("the TV's founder notice (TV-FOUNDER-NOTICE-001)", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    state.back = [];
    state.focused = true;
    state.language = "en";
    state.status = { founder: true, since: "2026-03-03T10:00:00.000Z", noticePending: true };
    state.fetched = [];
    state.seen = [];
  });
  afterEach(async () => {
    act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
    act(() => founderWatch.reset());
    vi.useRealTimers();
  });

  it("shows once at sign-in, takes the remote's focus, and OK closes it; it is seen", async () => {
    const tree = await render();
    const [card] = banner(tree);
    log("shown", { fetched: state.fetched, text: card && textOf(card), focus: card?.props.hasTVPreferredFocus, label: card?.props.accessibilityLabel });
    expect(state.fetched).toEqual(["tv-tok"]);
    expect(textOf(card)).toBe("🎫 Founder ticket recognised.|Your 30% for life is applied to your plan.|Got it");
    expect(card.props.hasTVPreferredFocus).toBe(true);
    await act(async () => card.props.onPress());
    log("after OK", { banners: banner(tree).length, seen: state.seen, settings: tree.root.findAll(isType("TvSettingsScreen")).length });
    expect(banner(tree)).toHaveLength(0);
    expect(state.seen).toEqual(["tv-tok"]);
    // OK only closes it: the section stays where it was.
    expect(tree.root.findAll(isType("TvSettingsScreen"))).toHaveLength(0);
  });

  it("Back closes it and stays on Home; it is seen", async () => {
    const tree = await render();
    expect(banner(tree)).toHaveLength(1);
    let handled = false;
    await act(async () => {
      handled = state.back.at(-1)!();
    });
    log("after Back", { handled, banners: banner(tree).length, seen: state.seen });
    expect(handled).toBe(true);
    expect(banner(tree)).toHaveLength(0);
    expect(tree.root.findAll(isType("TvHomeScreen"))).toHaveLength(1);
    expect(state.seen).toEqual(["tv-tok"]);
  });

  it("stays while the remote is on it", async () => {
    vi.useFakeTimers();
    const tree = await render();
    act(() => banner(tree)[0].props.onFocus());
    act(() => void vi.advanceTimersByTime(60_000));
    log("after a minute focused", { banners: banner(tree).length, seen: state.seen });
    expect(banner(tree)).toHaveLength(1);
    expect(state.seen).toEqual([]);
  });

  it("reads in the app's language", async () => {
    state.language = "fr";
    const tree = await render();
    log("fr", textOf(banner(tree)[0]));
    expect(textOf(banner(tree)[0])).toBe("🎫 Remise fondateur reconnue.|Vos −30 % à vie s'appliquent à votre offre.|J'ai compris");
  });

  it("shows nothing when the notice was already seen, or for a non-founder", async () => {
    state.status = { founder: true, since: "2026-03-03T10:00:00.000Z", noticePending: false };
    const seen = await render();
    expect(banner(seen)).toHaveLength(0);
    act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
    act(() => founderWatch.reset());
    state.status = { founder: false, since: null, noticePending: false };
    const plain = await render();
    log("no notice", { fetched: state.fetched, banners: banner(plain).length });
    expect(banner(plain)).toHaveLength(0);
    expect(state.seen).toEqual([]);
  });

  it("raised while the player covers the shell, it waits unseen and shows once the player closes", async () => {
    state.focused = false;
    const tree = await render();
    log("covered", { banners: banner(tree).length });
    expect(banner(tree)).toHaveLength(0);
    state.focused = true;
    await act(async () => tree.update(<TvMainShell />));
    log("uncovered", { banners: banner(tree).length, seen: state.seen });
    expect(banner(tree)).toHaveLength(1);
    expect(state.seen).toEqual([]);
  });
});
