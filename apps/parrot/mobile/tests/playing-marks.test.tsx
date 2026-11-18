/**
 * @test-id PARROT-MOBILE-PLAYING-MARKS-001
 * @level unit
 * @req PAR-LOOK-01[parrot]
 * @why The approved design marks what plays, and the phone did not: the playing album's tile gets the green ring
 *   and a round green equaliser badge (the mockup's Low Orbit tile), and in the album's song list the playing song's
 *   title turns green with the equaliser in place of its number. The bars bounce while the music plays and stand still
 *   when paused or when the phone asks for less motion, with the same heights and bounce as the web player's and the
 *   desktop's equaliser (@space/ui/parrot CSS). Screens are called as functions against a mocked React Native.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const rn = vi.hoisted(() => ({ loops: 0, reduceMotion: false }));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-PLAYING-MARKS-001] ${step}`, JSON.stringify(detail));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useEffect = (fn: () => void | (() => void)) => void fn();
  // The reduce-motion setting as the phone reports it; other state keeps its first value.
  const useState = <T,>(initial: T) => [initial === false ? (rn.reduceMotion as T) : initial, () => undefined];
  return { ...actual, default: { ...actual, useRef, useEffect, useState }, useRef, useEffect, useState };
});
vi.mock("react-native", () => {
  class Value {
    constructor(public value: number) {}
    setValue(next: number) {
      this.value = next;
    }
    interpolate(config: unknown) {
      return { interpolated: config };
    }
  }
  return {
    AccessibilityInfo: { isReduceMotionEnabled: () => new Promise(() => undefined), addEventListener: () => ({ remove: () => undefined }) },
    ActivityIndicator: "ActivityIndicator",
    Animated: {
      Value,
      View: "AnimatedView",
      timing: () => ({}),
      loop: () => ({
        start: () => void (rn.loops += 1),
        stop: () => undefined,
      }),
    },
    Easing: { linear: (t: number) => t },
    FlatList: "FlatList",
    Image: "Image",
    Pressable: "Pressable",
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    Text: "Text",
    View: "View",
  };
});
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }) }));
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle", Defs: "Defs", LinearGradient: "LinearGradient", Rect: "Rect", Stop: "Stop" }));
vi.mock("lucide-react-native", () => ({ Ellipsis: "Icon:Ellipsis" }));
vi.mock("../src/state/usePlayerState", () => ({ useNowPlaying: () => null, usePlayerState: () => null }));
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: "SkyCover", useSkyScroll: () => ({}) }));

import { colors } from "../src/theme";
import { equalizerKeyframes, PARROT_EQUALIZER, ParrotEqualizer, PlayingBadge } from "../src/screens/equalizer";
import { SongListRow } from "../src/screens/SongListRow";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { AlbumTile } from "../src/screens/AlbumGrid";
import { ParrotArt } from "../src/screens/art";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
  }
  return out;
};
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? (style as Record<string, unknown>) : {};
const texts = (node: unknown) => all(node, (el) => el.type === "Text").map((el) => el.props.children);

const album = {
  id: "al-lo",
  title: "Low Orbit",
  artistName: "Juniper Skies",
  year: 2021,
  coverObjectKey: "assets/large-lo",
  coverThumbObjectKey: "assets/small-lo",
} as never;
const row = { title: "Apogee", subtitle: null, durationMs: 228000, starting: false, disabled: false, accessibilityLabel: "Play Apogee", onPress: () => undefined };

describe("the playing album's tile", () => {
  it("rings the art in green and carries the equaliser badge; other tiles have neither", () => {
    const playing = AlbumTile({ album, size: 160, playing: { animated: true }, onPress: () => undefined });
    const idle = AlbumTile({ album, size: 160, playing: null, onPress: () => undefined });
    const art = all(playing, (el) => el.type === ParrotArt)[0]!;
    const badge = all(playing, (el) => el.type === PlayingBadge)[0];
    log("tile", { art: art.props, badge: badge?.props });
    // The tile shows the small copy of the cover.
    expect(art.props).toMatchObject({ playing: true, coverKey: "assets/small-lo", size: 160 });
    expect(badge?.props).toMatchObject({ size: 160, animated: true });
    expect(all(idle, (el) => el.type === ParrotArt)[0]!.props.playing).toBe(false);
    expect(all(idle, (el) => el.type === PlayingBadge)).toHaveLength(0);
  });

  it("the badge is a green round holding the equaliser", () => {
    const badge = PlayingBadge({ size: 160, animated: false }) as unknown as Element;
    const style = flat(badge.props.style);
    expect(badge.props.testID).toBe("playing-badge");
    expect(style).toMatchObject({ position: "absolute", backgroundColor: colors.accent, width: 29, height: 29, borderRadius: 14.5 });
    expect(all(badge, (el) => el.type === ParrotEqualizer)[0]!.props).toMatchObject({ animated: false, color: colors.accentText });
  });
});

describe("the playing song in a list", () => {
  it("turns its title green and shows the equaliser in place of its number", () => {
    const playing = SongListRow({ ...row, lead: 2, playing: { animated: true } }) as unknown as Element;
    const other = SongListRow({ ...row, lead: 3, playing: null }) as unknown as Element;
    const title = (node: unknown) => all(node, (el) => el.type === "Text" && el.props.children === "Apogee")[0]!;
    log("rows", { playing: texts(playing), other: texts(other) });
    expect(all(playing, (el) => el.type === ParrotEqualizer)[0]!.props.animated).toBe(true);
    expect(texts(playing)).not.toContain(2);
    expect(flat(title(playing).props.style).color).toBe(colors.accent);
    expect(playing.props.accessibilityState).toEqual({ selected: true, disabled: false });

    expect(all(other, (el) => el.type === ParrotEqualizer)).toHaveLength(0);
    expect(texts(other)).toContain(3);
    expect(flat(title(other).props.style).color).toBe(colors.text);
  });

  // @req PAR-OFFL-04[parrot]
  it("offline, a song not on the phone is greyed out with the shared look and does not play; its sheet stays", () => {
    const away = SongListRow({ ...row, lead: 4, playing: null, unavailable: true, onMore: () => undefined }) as unknown as Element;
    const here = SongListRow({ ...row, lead: 5, playing: null, unavailable: false }) as unknown as Element;
    const content = (node: unknown) => all(node, (el) => el.props?.testID === "song-row-content")[0]!;
    log("offline rows", { away: flat(content(away).props.style), here: flat(content(here).props.style) });
    expect(away.props).toMatchObject({ disabled: true, accessibilityState: { selected: false, disabled: true } });
    expect(flat(content(away).props.style)).toMatchObject(UNAVAILABLE_LOOK);
    expect(all(away, (el) => el.props?.testID === "song-more")[0]!.props.disabled).toBeUndefined();
    expect(here.props.disabled).toBe(false);
    expect(flat(content(here).props.style).opacity).toBeUndefined();
  });
});

describe("ParrotEqualizer", () => {
  it("bounces while the music plays, and stands still when paused or with less motion", () => {
    const bars = (node: unknown) => all(node, (el) => el.type === "AnimatedView");
    rn.loops = 0;
    const moving = ParrotEqualizer({ animated: true }) as unknown as Element;
    expect(rn.loops).toBe(1);
    expect(bars(moving).map((bar) => flat(bar.props.style).height)).toEqual([6, 12, 9]);
    expect(bars(moving).every((bar) => Array.isArray(flat(bar.props.style).transform))).toBe(true);

    const still = ParrotEqualizer({ animated: false }) as unknown as Element;
    rn.reduceMotion = true;
    const calm = ParrotEqualizer({ animated: true }) as unknown as Element;
    rn.reduceMotion = false;
    log("loops", { loops: rn.loops });
    expect(rn.loops).toBe(1);
    expect(bars(still).some((bar) => flat(bar.props.style).transform)).toBe(false);
    expect(bars(calm).some((bar) => flat(bar.props.style).transform)).toBe(false);
  });

  it("has the web and desktop equaliser's heights and bounce (@space/ui/parrot CSS)", () => {
    const source = readFileSync(resolve(__dirname, "../../../../packages/ui/src/parrot/components.tsx"), "utf8");
    const css = {
      low: Number(/0%, 100% \{ transform: scaleY\(([\d.]+)\)/.exec(source)?.[1]),
      periodMs: Number(/parrot-eq-bounce (\d+)ms/.exec(source)?.[1]),
      delays: [...source.matchAll(/animation-delay: -(\d+)ms/g)].map((m) => Number(m[1])),
      heights: JSON.parse(/\{(\[[\d, ]+\])\.map\(\(height, i\)/.exec(source)?.[1] ?? "null"),
    };
    log("css", css);
    expect(PARROT_EQUALIZER.low).toBe(css.low);
    expect(PARROT_EQUALIZER.periodMs).toBe(css.periodMs);
    expect([1, 2].map((i) => i * PARROT_EQUALIZER.stepMs)).toEqual(css.delays);
    expect([...PARROT_EQUALIZER.heights]).toEqual(css.heights);
  });

  it("each bar's keyframes run low → full height → low, moved by its head start", () => {
    const low = PARROT_EQUALIZER.low;
    expect(equalizerKeyframes(0)).toEqual({ inputRange: [0, 0.5, 1], outputRange: [low, 1, low] });
    for (const offset of [1 / 3, 2 / 3]) {
      const { inputRange, outputRange } = equalizerKeyframes(offset);
      log("keyframes", { offset, inputRange, outputRange });
      expect(inputRange.every((t, i) => i === 0 || t > inputRange[i - 1]!)).toBe(true);
      expect(inputRange[0]).toBe(0);
      expect(inputRange.at(-1)).toBe(1);
      expect(outputRange[inputRange.findIndex((t) => Math.abs(t - ((1.5 - offset) % 1)) < 1e-9)]).toBe(1);
      expect(outputRange[inputRange.findIndex((t) => Math.abs(t - ((1 - offset) % 1)) < 1e-9)]).toBe(low);
      expect(outputRange[0]).toBeCloseTo(outputRange.at(-1)!);
    }
  });
});
