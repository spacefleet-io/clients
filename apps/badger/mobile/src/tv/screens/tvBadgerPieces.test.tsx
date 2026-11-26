/**
 * @test-id TV-BADGER-PIECES-001
 * @level component
 * @why The Badger design (Chris 2026-11-09) added three TV pieces with their own logic: Search filters the library's
 *   titles (UX-TV-19) with the same matching as every Badger library search; the empty library is the computer's
 *   screen (UX-EMPTY-01) whose "Get Badger for computer" takes the focus and swaps the freestanding badger for a QR code
 *   to the downloads page (UX-TV-18); and Home's Continue watching card opens
 *   the player directly, a film by itself and a show at the episode its Play button would pick (UX-TV-05).
 *   Rendered with react-test-renderer: react-native is replaced by host-element stand-ins.
 *
 * @req UX-TV-05[badger-tv]
 * @req UX-TV-18[badger-tv]
 * @req UX-EMPTY-01[badger-tv]
 * @req UX-TV-19[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { MediaDetails, MediaRow } from "@space/shared/libraryTypes";
import { TvEmptyLibrary } from "../components/TvEmptyLibrary";
import { continuePlayerParams } from "../lib/continueStart";
import { TvSearchScreen, searchTitles } from "./TvSearchScreen";

const ctl = vi.hoisted(() => {
  // Metro turns `require("../../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
  return { language: "fr", picked: null as { id: string } | null };
});

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Image: host("Image"),
    TextInput: host("TextInput"),
    FlatList: host("FlatList"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    useWindowDimensions: () => ({ width: 960, height: 540 }),
  };
});
vi.mock("lucide-react-native", () => ({
  Monitor: "MonitorIcon",
  MonitorDown: "MonitorDownIcon",
  Tv: "TvIcon",
  RefreshCw: "RefreshIcon",
  Headphones: "HeadphonesIcon",
  MonitorSmartphone: "MonitorSmartphoneIcon",
  MousePointerClick: "MousePointerClickIcon",
  Sparkles: "SparklesIcon",
}));
vi.mock("@space/mobile-shell/components", async () => ({
  SkyCover: "SkyCover",
  useSkyScroll: () => ({}),
  // The real shared screen, so the test sees its texts and testIDs; the barrel would pull in every shell component.
  MobileEmptyLibrary: (await import("@space/mobile-shell/empty-library")).MobileEmptyLibrary,
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: ctl.language } }) }));
vi.mock("@space/mobile-shell/pairing-qr", () => ({ QrCode: "QrCode" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }) }));
vi.mock("../../store/library", () => ({ useLibraryData: () => ({ media: [] }) }));
vi.mock("../../theme/theme", () => {
  const anyKey = new Proxy({}, { get: () => "x" });
  return { theme: { colors: anyKey, font: new Proxy({}, { get: () => anyKey }), accentTextHex: "#000" } };
});
vi.mock("@space/mobile-shell/tv/tvScale", () => ({ useTvScale: () => 1, useTvStyles: <T,>(styles: T) => styles }));
vi.mock("@space/mobile-shell/tv/TvFocusable", () => ({ TvFocusable: "TvFocusable" }));
vi.mock("../components/TvPosterCard", () => ({ TvPosterCard: "TvPosterCard" }));
vi.mock("../../lib/playback/episodeSelection", () => ({
  uploadedEpisodeKeys: () => new Set<string>(),
  playEpisode: () => ctl.picked,
}));

const row = (id: string, title: string, type: "movie" | "tv" = "movie") =>
  ({ id, title, type, year: 2020, addedAt: 0, genres: [], backdropPath: `/b-${id}.jpg`, posterPath: `/p-${id}.jpg` }) as unknown as MediaRow;

describe("TV Search titles (UX-TV-19)", () => {
  const media = [row("m1", "Alien"), row("m2", "Aliens"), row("t1", "The Expanse", "tv")];

  it("@req UX-TV-19 finds the titles holding the typed text, ignoring case and spaces around it", () => {
    const found = searchTitles(media, "  ALIEN ").map((item) => item.id);
    console.info("[TV-BADGER-PIECES-001] search", JSON.stringify(found));
    expect(found).toEqual(["m1", "m2"]);
    expect(searchTitles(media, "expanse").map((item) => item.id)).toEqual(["t1"]);
  });

  it("@req UX-TV-19 finds nothing for an empty query or a title not in the library", () => {
    expect(searchTitles(media, "   ")).toEqual([]);
    expect(searchTitles(media, "dune")).toEqual([]);
  });

  it("@req UX-TV-19 opening Search from the top bar puts the focus in the search field", async () => {
    const focus = vi.fn();
    let tree: ReactTestRenderer | null = null;
    await act(async () => {
      tree = create(<TvSearchScreen />, {
        createNodeMock: (element) => {
          const props = element.props;
          const isSearchInput = typeof props === "object" && props !== null && "testID" in props && props.testID === "tv-search-input";
          return isSearchInput ? { focus } : null;
        },
      });
    });
    console.info("[TV-BADGER-PIECES-001] search mounted", JSON.stringify({ focusCalls: focus.mock.calls.length }));
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
    console.info("[TV-BADGER-PIECES-001] search after tick", JSON.stringify({ focusCalls: focus.mock.calls.length }));
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => tree!.unmount());
  });
});

describe("TV empty library (UX-EMPTY-01, UX-TV-18)", () => {
  it("@req UX-EMPTY-01 @req UX-TV-18 the computer's screen; Get Badger for computer is focused first and swaps the badger for a QR to the downloads page", async () => {
    const checks: number[] = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TvEmptyLibrary onCheckAgain={() => checks.push(1)} />);
    });
    const root = renderer!.root;
    const byId = (id: string) => root.findAll((node) => node.props.testID === id && typeof node.type === "string");
    const texts = root.findAll((node) => String(node.type) === "Text").map((node) => node.props.children);
    console.info("[TV-BADGER-PIECES-001] empty texts", JSON.stringify(texts));
    expect(texts).toEqual(
      expect.arrayContaining(["TVSHELL.EMPTY.EYEBROW", "tvShell.empty.title", "tvShell.empty.subtitle", "1. tvShell.empty.step1Title", "3. tvShell.empty.step3Title"])
    );
    expect(byId("empty-library-mascot")).toHaveLength(1);
    expect(byId("empty-library-steps")).toHaveLength(1);
    expect(byId("tv-empty-download")).toHaveLength(0);
    const getDesktop = byId("tv-empty-get-desktop")[0]!;
    expect(getDesktop.props.hasTVPreferredFocus).toBe(true);
    const checkAgain = byId("tv-empty-check-again")[0]!;
    expect(checkAgain.props.hasTVPreferredFocus).toBeFalsy();
    await act(async () => checkAgain.props.onPress());
    expect(checks).toHaveLength(1);

    await act(async () => getDesktop.props.onPress());
    const qr = root.find((node) => String(node.type) === "QrCode");
    console.info("[TV-BADGER-PIECES-001] qr", JSON.stringify(qr.props.payload));
    expect(qr.props.payload).toBe("https://spacebadger.io/fr/downloads");
    expect(byId("tv-empty-download")).toHaveLength(1);
    expect(byId("empty-library-mascot")).toHaveLength(0);
  });
});

describe("Continue watching card player route (UX-TV-05)", () => {
  const noDetails = async () => null;

  it("@req UX-TV-05 a film opens itself at the asked start, with no episode and no lookups", async () => {
    const getDetails = vi.fn(noDetails);
    const params = await continuePlayerParams(row("m1", "Alien"), "startOver", getDetails, async () => null);
    expect(params).toEqual({ mediaId: "m1", backdropPath: "/b-m1.jpg", posterPath: "/p-m1.jpg", startAt: "startOver", episodeId: null });
    expect(getDetails).not.toHaveBeenCalled();
  });

  it("@req UX-TV-05 a show opens the episode its Play button picks, or none when it has no playable episode", async () => {
    ctl.picked = { id: "ep-3" };
    const show = row("t1", "The Expanse", "tv");
    const details = { id: "t1" } as unknown as MediaDetails;
    const resumed = await continuePlayerParams(show, "resume", async () => details, async () => "ep-3");
    console.info("[TV-BADGER-PIECES-001] show", JSON.stringify(resumed));
    expect(resumed).toMatchObject({ mediaId: "t1", startAt: "resume", episodeId: "ep-3" });
    ctl.picked = null;
    expect((await continuePlayerParams(show, "resume", async () => details, async () => null)).episodeId).toBeNull();
  });
});
