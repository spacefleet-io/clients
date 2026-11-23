/**
 * @test-id MOBILE-HOME-RESUME-001
 * @level component
 * @why Phone walk 2026-11-12: Resume on a show's Continue-watching card opened the title page instead of playing. It
 *   now plays the episode the card names (the last one played) at the saved position, as the TV does. Rendered with
 *   react-test-renderer; the store returns a show with two episodes, the last played being S1 E2.
 */
// @req UX-PHONE-01[badger-mobile]
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
  return { opened: [] as string[], navigated: [] as unknown[] };
});

const show = { id: "s", type: "tv", title: "Show", backdropPath: "/b.jpg", posterPath: "/p.jpg", progressPct: 40 };
const episode = (id: string, n: number) => ({ id, seasonNumber: 1, episodeNumber: n, name: `E${n}` });
const file = (id: string, n: number) => ({ id, season: 1, episode: n });

vi.mock("react-native", () => ({
  Dimensions: { get: () => ({ width: 390, height: 800 }) },
  Image: "Image",
  Linking: { openURL: async (url: string) => void ctl.opened.push(url) },
  Pressable: "Pressable",
  RefreshControl: "RefreshControl",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({
  Download: "DownloadIcon",
  Headphones: "HeadphonesIcon",
  MonitorSmartphone: "MonitorSmartphoneIcon",
  MousePointerClick: "MousePointerClickIcon",
  Sparkles: "SparklesIcon",
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: (...args: unknown[]) => void ctl.navigated.push(args) }),
}));
vi.mock("@space/mobile-shell/components", async () => {
  // The real shared screen, so the test sees its texts and testIDs; the barrel would pull in every shell component.
  const shared = await import("../../../../packages/mobile-shell/src/components/mobile-empty-library");
  return { MobileEmptyLibrary: shared.MobileEmptyLibrary, MobileEmptyLibraryAction: shared.MobileEmptyLibraryAction, useSkyScroll: () => ({}) };
});
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }), getCurrentLanguage: () => "fr" }));
vi.mock("../src/store/library", () => ({
  useLibraryData: () => ({ media: [show] }),
  useLibraryStatus: () => ({ loading: false, error: null, refresh: async () => undefined }),
  useLibraryActions: () => ({
    getMediaDetails: async () => ({
      ...show,
      episodes: [episode("e1", 1), episode("e2", 2)],
      files: [file("f1", 1), file("f2", 2)],
    }),
  }),
}));
vi.mock("../src/lib/resume", () => ({ getLastPlayedEpisodeId: async () => "e2" }));
vi.mock("../src/components/PosterRail", () => ({ PosterRail: "PosterRail" }));
vi.mock("../src/components/Panel", () => ({ Panel: "Panel" }));
vi.mock("../src/components/Skeleton", () => ({ PosterRailSkeleton: "PosterRailSkeleton" }));
vi.mock("../src/components/ContinueHero", () => ({ ContinueHero: "ContinueHero" }));
vi.mock("../src/lib/homeRails", () => ({ homeRailEntries: () => [], selectHomeRails: () => [] }));
vi.mock("../src/lib/phoneHome", () => ({ phoneHomeLayout: () => ({ hero: show, rails: [] }), seeAllTarget: () => ({ tab: "library", scope: "movies" }) }));
vi.mock("../src/lib/useFavoriteIds", () => ({ useFavoriteIds: () => new Set<string>() }));
vi.mock("../src/lib/usePullToRefresh", () => ({
  usePullToRefresh: () => ({ refreshing: false, onRefresh: () => undefined }),
  usePullRefreshScroll: (_pull: unknown, scroll: unknown) => scroll,
}));
vi.mock("../src/theme/theme", () => {
  const anyKey = new Proxy({}, { get: () => "x" });
  return { theme: { colors: anyKey, font: new Proxy({}, { get: () => anyKey }), accentTextHex: "#000" } };
});

import { HomeScreen } from "../src/screens/HomeScreen";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Home's Continue-watching Resume", () => {
  it("@req UX-PHONE-01 on a show plays the last-played episode at its saved position", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(HomeScreen));
    });
    const hero = renderer.root.find((node) => (node.type as unknown) === "ContinueHero");
    await act(async () => {
      hero.props.onResume(show);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    console.info("[MOBILE-HOME-RESUME-001] navigated", JSON.stringify(ctl.navigated));
    expect(ctl.navigated).toEqual([
      ["Player", { mediaId: "s", episodeId: "e2", backdropPath: "/b.jpg", posterPath: "/p.jpg", startAt: "resume" }],
    ]);
  });
});
