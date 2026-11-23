/**
 * @test-id TV-CONTINUE-HERO-001
 * @level component
 * @why Home's Continue watching card in the v2 TV redesign (Chris 2026-11-12 (chat): "your tv client redesign is good,
 *   you can implement it"): the amber eyebrow, the title, "year · length · N min left", the amber bar, then Resume (the
 *   remote's first focus, named after the point it resumes at), Start over and Details, the whole card in one focus
 *   guide, so UP from the row below lands back on them. The poster's colours glow softly behind the card. Without a film length
 *   (a show, or details not loaded) the line falls back to "year · N% watched" and the button to a plain "Resume".
 *
 * TV-HOME-HERO-FOCUS-001 (UX-TV-05: Resume is focused first). On the Apple TV "sejour" (2026-11-13, suite run at
 * 6770cbb77), every case that opened Home with a title in progress waited 90 s with the focus on the Home tab: Resume
 * only had `hasTVPreferredFocus`, and UIKit's own focus update when Home finishes appearing moved the focus to the top
 * tabs (TV-SHELL-FOCUS-002, already handled for the first poster card when there is no hero). Resume now takes the focus
 * back once Home has appeared, and once more when UIKit's update lands right after that request.
 *
 * Rendered with react-test-renderer: react-native is replaced by host-element stand-ins, the navigation, the pills and
 * texts by named stand-ins, the library by a fake that answers the film's details.
 *
 * @bugfix @regression-proof
 * @req UX-TV-05[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import en from "../../../../../../packages/mobile-shell/src/i18n/en.json";
import type { MediaRow } from "@space/shared/libraryTypes";
import { heroText, resumeClock, TvContinueHero } from "./TvContinueHero";

const ctl = vi.hoisted(() => ({
  duration: null as number | null,
  detailsCalls: [] as unknown[][],
}));
const nav = vi.hoisted(() => ({ listeners: [] as ((event: { data: { closing: boolean } }) => void)[] }));

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Image: host("Image"),
    TVFocusGuideView: host("TVFocusGuideView"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Platform: { OS: "ios" },
    useWindowDimensions: () => ({ width: 960, height: 540 }),
  };
});
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    addListener: (_name: string, listener: (event: { data: { closing: boolean } }) => void) => {
      nav.listeners.push(listener);
      return () => nav.listeners.splice(nav.listeners.indexOf(listener), 1);
    },
  }),
}));
vi.mock("lucide-react-native", () => ({ Info: "InfoIcon", Play: "PlayIcon", RotateCcw: "RotateIcon" }));
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: "SkyCover" }));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key) }),
}));
vi.mock("../../lib/useMediaImage", () => ({ useMediaImage: (path: string | null) => (path ? `https://img/${path}` : null) }));
vi.mock("../../components/MediaArtwork", () => ({ MediaArtwork: "MediaArtwork" }));
vi.mock("../../lib/phoneHome", () => ({ unitDurationSeconds: () => ctl.duration }));
/** One actions object, as the real store gives. */
const actions = vi.hoisted(() => ({
  getMediaDetails: async (...args: unknown[]) => {
    ctl.detailsCalls.push(args);
    return {};
  },
}));
vi.mock("../../store/library", () => ({ useLibraryActions: () => actions }));
vi.mock("../lib/tvScale", () => ({ useTvScale: () => 1, useTvStyles: <T,>(styles: T) => styles }));
vi.mock("../ui/TvPillButton", () => ({ TvPillButton: "TvPillButton" }));
vi.mock("../ui/TvText", () => ({ TvTitle: "TvTitle", TvBody: "TvBody", TvEyebrow: "TvEyebrow" }));

const t = (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key);

const film = (patch: Partial<MediaRow> = {}): MediaRow =>
  ({ id: "m1", type: "movie", title: "The General", year: "1926", progressPct: 53, posterPath: "/p.jpg", genres: [], ...patch }) as MediaRow;

const isType = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, number | string>;

const render = async (item: MediaRow, onAction = vi.fn()) => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<TvContinueHero item={item} onAction={onAction} />);
  });
  return { tree, onAction };
};

beforeEach(() => {
  ctl.duration = null;
  ctl.detailsCalls = [];
  nav.listeners.length = 0;
});

describe("Continue watching card text (UX-TV-05)", () => {
  it("@req UX-TV-05 the resume point is a clock: m:ss under an hour, h:mm:ss past it, none without a length", () => {
    expect(resumeClock(53, 4680)).toBe("41:20");
    expect(resumeClock(50, 7400)).toBe("1:01:40");
    expect(resumeClock(0, 600)).toBe("0:00");
    expect(resumeClock(140, 600)).toBe("10:00");
    expect(resumeClock(50, null)).toBeNull();
    expect(resumeClock(50, 0)).toBeNull();
  });

  it("@req UX-TV-05 with the film's length: year · length · minutes left, and Resume names the point", () => {
    const text = heroText({ year: "1926", progressPct: 53 }, 4680, t);
    console.info("[TV-CONTINUE-HERO-001] text", JSON.stringify(text));
    expect(text.meta).toBe('1926 · tvShell.details.runtimeHours{"hours":1,"minutes":18} · home.hero.minutesLeft{"count":37}');
    expect(text.resume).toBe('tvShell.home.resumeAt{"time":"41:20"}');
    expect(heroText({ year: null, progressPct: 50 }, 2400, t).meta).toBe('tvShell.details.runtimeMinutes{"minutes":40} · home.hero.minutesLeft{"count":20}');
  });

  it("@req UX-TV-05 the minutes-left words resolve in the real English texts, never the raw key", async () => {
    // An Android TV box, 2026-11-13: the card read "2015 · 2 min · home.hero.minutesLeft" because the plural
    // key was called with `minutes` instead of i18next's `count`.
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
    const real = i18n.t.bind(i18n) as unknown as typeof t;
    const one = heroText({ year: "2015", progressPct: 99 }, 6000, real).meta;
    const many = heroText({ year: "2015", progressPct: 35 }, 4680, real).meta;
    console.info("[TV-CONTINUE-HERO-001] english", JSON.stringify({ one, many }));
    expect(one).toBe("2015 · 1 h 40 min · 1 min left");
    expect(many).toBe("2015 · 1 h 18 min · 51 min left");
    expect(`${one} ${many}`).not.toContain("home.hero");
  });

  it("@req UX-TV-05 without a length: year · percent watched, and a plain Resume", () => {
    expect(heroText({ year: "2019", progressPct: 20.4 }, null, t)).toEqual({
      meta: '2019 · tvShell.home.percentWatched{"percent":20}',
      resume: "tvShell.home.resume",
    });
  });
});

describe("Continue watching card (UX-TV-05)", () => {
  it("@req UX-TV-05 Resume, Start over and Details sit in one auto-focus guide, Resume first and focused", async () => {
    ctl.duration = 4680;
    const { tree, onAction } = await render(film());
    const guide = tree.root.find((node) => isType(node, "TVFocusGuideView"));
    expect(guide.props.autoFocus).toBe(true);
    const pills = guide.findAll((node) => isType(node, "TvPillButton"));
    console.info("[TV-CONTINUE-HERO-001] pills", JSON.stringify(pills.map((pill) => [pill.props.testID, pill.props.label, pill.props.hasTVPreferredFocus ?? false])));
    expect(pills.map((pill) => pill.props.testID)).toEqual(["tv-home-resume", "tv-home-startover", "tv-home-details"]);
    expect(pills.map((pill) => Boolean(pill.props.hasTVPreferredFocus))).toEqual([true, false, false]);
    expect(pills[0].props.variant).toBe("primary");
    expect(pills[0].props.label).toBe('tvShell.home.resumeAt{"time":"41:20"}');
    expect(ctl.detailsCalls).toEqual([["m1", { chunks: false }]]);
    expect(tree.root.findByProps({ testID: "tv-home-hero-meta" }).props.children).toBe(
      '1926 · tvShell.details.runtimeHours{"hours":1,"minutes":18} · home.hero.minutesLeft{"count":37}'
    );
    for (const [index, action] of (["resume", "startOver", "details"] as const).entries()) {
      act(() => pills[index].props.onPress());
      expect(onAction).toHaveBeenLastCalledWith(action, expect.objectContaining({ id: "m1" }));
    }
  });

  it("@req UX-TV-05 the poster glows softly behind the card, and the bar shows how far the title is watched", async () => {
    const { tree } = await render(film());
    const glow = tree.root.findByProps({ testID: "tv-home-hero-glow" });
    expect(glow.props.source).toEqual({ uri: "https://img//p.jpg" });
    expect(glow.props.blurRadius).toBe(40);
    const track = tree.root.find((node) => isType(node, "View") && node.props.accessibilityLabel === 'tvShell.home.percentWatched{"percent":53}');
    const fill = track.children[0] as ReactTestInstance;
    expect(flat(fill.props.style).width).toBe("53%");
  });

  // UX-HOME-04 (Chris 2026-11-19, a still of the YouTube promo video): a hard vertical line about 45 %
  // across the card, where the dark side stopped against the glow. The glow was a 550 dp box pinned to the right;
  // React Native's `blurRadius` blurs only inside an image's box, so the box's left edge showed as a line.
  it("@bugfix @regression-proof @req UX-HOME-04[badger-tv] no edge of the glow lies inside the card; an eased scrim over it does the fading", async () => {
    const { tree } = await render(film());
    const card = tree.root.findByProps({ testID: "tv-home-hero" });
    const glow = tree.root.findByProps({ testID: "tv-home-hero-glow" });
    const box = flat(glow.props.style);
    console.info("[UX-HOME-04 tv] glow box", JSON.stringify(box));
    expect(box.width).toBeUndefined();
    expect(box.height).toBeUndefined();
    for (const side of ["left", "right", "top", "bottom"] as const) expect(box[side], side).toBeLessThan(0);

    const scrim = tree.root.findByProps({ testID: "tv-home-hero-scrim" });
    const layers = card.children.filter((child): child is ReactTestInstance => typeof child !== "string");
    expect(layers.indexOf(scrim), "scrim over the glow").toBe(layers.indexOf(glow) + 1);
    expect(flat(card.props.style).backgroundColor).toBe("transparent");
    const gradient = String(flat(scrim.props.style).experimental_backgroundImage);
    const stops = [...gradient.matchAll(/rgba\(36, 38, 56, ([\d.]+)\) (\d+)%/g)].map((match) => [Number(match[2]), Number(match[1])]);
    console.info("[UX-HOME-04 tv] scrim stops", JSON.stringify(stops));
    expect(stops[0]).toEqual([0, 0.96]);
    expect(stops.at(-1)![0]).toBe(100);
    for (const [index, [at, alpha]] of stops.entries()) {
      if (index === 0) continue;
      const [prevAt, prevAlpha] = stops[index - 1]!;
      expect(at).toBeGreaterThan(prevAt!);
      expect(alpha).toBeLessThanOrEqual(prevAlpha!);
      // No step steeper than 1.5 alpha points per percent of the card: nowhere does the fade turn into a line.
      expect((prevAlpha! - alpha) / (at - prevAt!)).toBeLessThanOrEqual(0.015);
    }
  });

  it("@req UX-TV-05 a show asks for no film length and keeps the percent and a plain Resume; no poster, no glow", async () => {
    const { tree } = await render(film({ id: "s1", type: "tv", year: "2015", progressPct: 20, posterPath: null }));
    expect(ctl.detailsCalls).toEqual([]);
    expect(tree.root.findByProps({ testID: "tv-home-resume" }).props.label).toBe("tvShell.home.resume");
    expect(tree.root.findByProps({ testID: "tv-home-hero-meta" }).props.children).toBe('2015 · tvShell.home.percentWatched{"percent":20}');
    expect(tree.root.findAllByProps({ testID: "tv-home-hero-glow" })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: "tv-home-hero-scrim" })).toHaveLength(0);
    expect(flat(tree.root.findByProps({ testID: "tv-home-hero" }).props.style).backgroundColor).toBe("rgba(36, 38, 56, 0.78)");
  });
});

const got = { id: "got", type: "tv", title: "Game of Thrones", year: 2011, progressPct: 0, posterPath: null } as unknown as MediaRow;
const requestTVFocus = vi.fn();

const renderForFocus = () => {
  let tree!: ReactTestRenderer;
  act(() => {
    // Resume is the hero's only host element with a ref, so every node gets the focus stand-in.
    tree = create(<TvContinueHero item={got} onAction={() => undefined} />, { createNodeMock: () => ({ requestTVFocus }) });
  });
  return tree.root.find((node) => node.props.testID === "tv-home-resume");
};
const appear = () => act(() => nav.listeners.slice().forEach((listener) => listener({ data: { closing: false } })));

describe("TvContinueHero: Resume holds the focus once Home has appeared (TV-HOME-HERO-FOCUS-001)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestTVFocus.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("@req UX-TV-05 requests the focus for Resume when Home finishes appearing, and again when UIKit takes it right after", () => {
    const resume = renderForFocus();
    expect(resume.props.hasTVPreferredFocus).toBe(true);
    appear();
    console.info("[TV-HOME-HERO-FOCUS-001] Resume focus requests after Home appeared:", requestTVFocus.mock.calls.length);
    expect(requestTVFocus).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(14);
    });
    act(() => resume.props.onBlur());
    console.info("[TV-HOME-HERO-FOCUS-001] after UIKit's update moved it to the tabs 14 ms later:", requestTVFocus.mock.calls.length);
    expect(requestTVFocus).toHaveBeenCalledTimes(2);
  });

  it("@req UX-TV-05 leaves the user's own move away from Resume alone", () => {
    const resume = renderForFocus();
    appear();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => resume.props.onBlur());
    expect(requestTVFocus).toHaveBeenCalledTimes(1);
  });
});

// TV-HOME-HERO-FOCUS-002 (UX-TV-05, issue #3009; seen again 2026-11-19 on the tvOS simulator, staging 6f316e8fb, fr and
// es): from the first "Recently added" poster, UP left the focus on the rail for good. The guide sat around the three
// buttons only, and they start right of the card's poster: the first poster of the row below lies under the card's
// poster, so tvOS found nothing above it. Every card of the row lies under the card's full width.
describe("TvContinueHero: UP from any card of the row below reaches the buttons (TV-HOME-HERO-FOCUS-002)", () => {
  it("@bugfix @regression-proof @req UX-TV-05 the auto-focus guide spans the whole card, its poster side included", async () => {
    const { tree } = await render(film());
    const guides = tree.root.findAll((node) => isType(node, "TVFocusGuideView"));
    const outer = tree.root.children[0] as ReactTestInstance;
    console.info(
      "[TV-HOME-HERO-FOCUS-002] guides",
      JSON.stringify(guides.map((g) => ({ autoFocus: g.props.autoFocus, testID: g.props.testID, outermost: g === outer })))
    );
    expect(guides).toHaveLength(1);
    const guide = guides[0]!;
    expect(guide.props.autoFocus).toBe(true);
    // The guide is the card's own frame: nothing of the card, the left-hand poster above the row's first card included, lies outside it.
    expect(guide).toBe(outer);
    expect(guide.findAllByProps({ testID: "tv-home-hero" })).toHaveLength(1);
    expect(guide.findAll((node) => isType(node, "MediaArtwork"))).toHaveLength(1);
    expect(guide.findAll((node) => isType(node, "TvPillButton")).map((pill) => pill.props.testID)).toEqual([
      "tv-home-resume",
      "tv-home-startover",
      "tv-home-details",
    ]);
  });
});
