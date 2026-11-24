/**
 * @test-id PARROT-MOBILE-ARTIST-PAGE-001
 * @level unit
 * @req PAR-LOOK-06[parrot]
 * @req PAR-LIB-03[parrot]
 * @req UX-A11Y-05[parrot]
 * @why Chris, 2026-11-21 (chat, morning review): of the three artist page drafts he picked A (the photo edge to edge, the
 *   ARTIST chip, the name and counts over the fade, a big Play, round Shuffle / Save offline / Play next / More),
 *   with no Overview tab ("no point next to Albums and Songs"): two tabs, Albums first and open, and the Albums tab is
 *   draft B's discography timeline (newest first, each release with its own Play, a row of years to jump down a long
 *   one) instead of a two-column grid. Delete is only in the More sheet, last and red, and asks first. The screen is
 *   called as a function against a mocked React Native, its own components expanded, with the library reads faked.
 * @covers apps/parrot/mobile/src/screens/ArtistScreen.tsx
 * @covers apps/parrot/mobile/src/screens/artist/Discography.tsx
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-ARTIST-PAGE-001] phase=${phase}`, JSON.stringify(detail));

type Action = { id: string; label: string; testID: string; destructive?: boolean; icon: unknown; onSelect: () => void };
const fake = vi.hoisted(() => ({
  albums: [] as Record<string, unknown>[],
  songs: [] as Record<string, unknown>[],
  picture: null as null | Record<string, unknown>,
  /** The tab the page's state holds; the mocked useState hands it out in place of the first tab. */
  tab: null as null | string,
  calls: [] as string[],
  played: [] as { ids: string[]; index: number }[],
  wentBack: 0,
  sheet: null as null | { title: string; actions: Action[]; testID: string },
  setTab: [] as unknown[],
  /** The hero's measured height the page's state holds (its onLayout), in place of the 280 least height. */
  heroHeight: null as null | number,
  /** The phone's text size (useWindowDimensions().fontScale). */
  fontScale: 1,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useEffect = () => undefined;
  const useState = <T,>(initial: T) => [
    initial === "albums" && fake.tab ? fake.tab : initial === 280 && fake.heroHeight ? fake.heroHeight : initial,
    (next: unknown) => void fake.setTab.push(next),
  ];
  const useMemo = <T,>(fn: () => T) => fn();
  const useCallback = <T,>(fn: T) => fn;
  const hooks = { useRef, useEffect, useState, useMemo, useCallback };
  return { ...actual, default: { ...actual, ...hooks }, ...hooks };
});
vi.mock("react-native", () => ({
  Linking: { openURL: async () => undefined },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: fake.fontScale }),
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Defs: "Defs", LinearGradient: "LinearGradient", Rect: "Rect", Stop: "Stop" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    ["ArrowDownToLine", "ArrowLeft", "ChevronLeft", "CircleCheck", "Ellipsis", "ListEnd", "ListPlus", "ListStart", "Play", "Shuffle", "Trash2"].map((name) => [name, `Icon:${name}`])
  )
);
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: () => undefined, goBack: () => void (fake.wentBack += 1) }),
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
// The real rail (Discography's year row, UX-PHONE-09) without the barrel's native modules (reanimated).
vi.mock("@space/mobile-shell/components", async () => ({
  MobileRailScroll: (await vi.importActual<typeof import("../../../../packages/mobile-shell/src/components/mobile-rail")>("../../../../packages/mobile-shell/src/components/mobile-rail")).MobileRailScroll,
  MobileSkeletonPulse: "Shimmer",
}));
vi.mock("../src/state/session", () => ({ useSession: () => ({ library: { status: "ready", version: 1 } }) }));
vi.mock("../src/state/useQuery", () => ({
  useQuery: (load: () => unknown) => {
    const source = String(load);
    const data = source.includes("listArtistAlbums") ? fake.albums : source.includes("readArtistPicture") ? fake.picture : fake.songs;
    return { data, loading: false, error: null };
  },
}));
vi.mock("../src/lib/library", () => ({ listArtistAlbums: async () => [], listSongs: async () => [], readArtistPicture: async () => null }));
vi.mock("../src/lib/picturesWaiting", () => ({ artistPicturesWaiting: { has: () => false, onChange: () => () => undefined } }));
vi.mock("../src/state/usePlay", () => ({
  usePlay: () => ({
    play: async (list: { id: string }[], index: number) => void fake.played.push({ ids: list.map((song) => song.id), index }),
    queue: async () => undefined,
    starting: null,
    error: null,
  }),
}));
vi.mock("../src/state/usePlayerState", () => ({ useNowPlaying: () => null }));
vi.mock("../src/state/manage", () => ({
  useManage: () => ({
    remove: (target: { kind: string; id: string }, title: string, onDeleted?: () => void) => {
      fake.calls.push(`delete:${target.kind}:${target.id}:${title}`);
      onDeleted?.();
    },
  }),
}));
vi.mock("../src/state/playlistEditor", () => ({
  usePlaylistEditor: () => ({
    toggleKeep: (kind: string, id: string) => void fake.calls.push(`keep:${kind}:${id}`),
    openActions: (title: string, actions: Action[], testID: string) => void (fake.sheet = { title, actions, testID }),
    openSong: () => undefined,
    addToPlaylist: () => undefined,
  }),
}));
vi.mock("../src/screens/kept", () => ({ useKept: () => ({ entry: () => undefined }), useOfflineReach: () => null }));
vi.mock("../src/screens/sky", () => ({ ParrotSky: "ParrotSky" }));
vi.mock("../src/screens/art", () => ({ ParrotArt: "ParrotArt" }));
vi.mock("../src/screens/ui", () => ({ ErrorText: "ErrorText" }));
vi.mock("../src/screens/pageBack", () => ({ PageBackButton: "PageBackButton", PAGE_BACK_ROW: 60, usePageTop: () => 60 }));
vi.mock("../src/screens/SongListRow", () => ({ SongListRow: "SongListRow" }));

import { ARTIST_TABS, ArtistScreen } from "../src/screens/ArtistScreen";
import { YEAR_JUMP_FROM } from "../src/screens/artist/Discography";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
/** The tree as the page draws it: the page's own components (hero, discography, song rows) called in place. */
const expand = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  const element = node as Element;
  if (typeof element.type === "function") return expand((element.type as (props: unknown) => unknown)(element.props));
  return { ...element, props: { ...element.props, children: expand(element.props?.children) } };
};
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
  }
  return out;
};
const byTestId = (tree: unknown, id: string) => all(tree, (el) => el.props?.testID === id);
const texts = (tree: unknown) => all(tree, (el) => el.type === "Text").flatMap((el) => [el.props.children].flat().filter((child) => typeof child === "string" || typeof child === "number"));
const render = (name = "King Gizzard & The Lizard Wizard") =>
  expand((ArtistScreen as unknown as (props: unknown) => unknown)({ route: { params: { artistId: "ar-kg", name } }, navigation: { goBack: () => void (fake.wentBack += 1) } }));

/** `count` albums, oldest first as `listArtistAlbums` returns them, two songs each; two albums a year. */
const library = (count: number) => {
  fake.albums = Array.from({ length: count }, (_, index) => ({
    id: `al-${index}`,
    title: `Album ${index}`,
    artistName: "Artist",
    year: 2010 + Math.floor(index / 2),
    kind: "album",
    trackCount: 2,
    coverObjectKey: null,
    coverThumbObjectKey: null,
  }));
  fake.songs = fake.albums.flatMap((album) =>
    [1, 2].map((number) => ({ id: `${album.id}-t${number}`, albumId: album.id, title: `Song ${number}`, albumTitle: album.title, disc: 1, number, durationMs: 200_000 }))
  );
};

beforeEach(() => {
  Object.assign(fake, { albums: [], songs: [], picture: null, tab: null, calls: [], played: [], wentBack: 0, sheet: null, setTab: [], heroHeight: null, fontScale: 1 });
});

describe("PARROT-MOBILE-ARTIST-PAGE-001 the tabs", () => {
  it("has just Albums and Songs, Albums first and open; there is no Overview", () => {
    library(3);
    const page = render();
    const tabs = all(page, (el) => el.props?.accessibilityRole === "tab");
    log("tabs", tabs.map((tab) => [tab.props.testID, tab.props.accessibilityState]));
    expect(ARTIST_TABS).toEqual(["albums", "songs"]);
    expect(tabs.map((tab) => tab.props.testID)).toEqual(["artist-tab-albums", "artist-tab-songs"]);
    expect(tabs.map((tab) => (tab.props.accessibilityState as { selected: boolean }).selected)).toEqual([true, false]);
    expect(texts(page).some((text) => /overview/i.test(String(text)))).toBe(false);
    expect(byTestId(page, "artist-discography")).toHaveLength(1);
    expect(byTestId(page, "artist-songs")).toHaveLength(0);
    (tabs[1]!.props.onPress as () => void)();
    expect(fake.setTab).toEqual(["songs"]);
  });

  it("the Songs tab lists every song of the artist and no discography", () => {
    library(3);
    fake.tab = "songs";
    const page = render();
    const rows = all(byTestId(page, "artist-songs"), (el) => el.type === "SongListRow");
    log("songs", { rows: rows.length });
    expect(rows).toHaveLength(6);
    expect(byTestId(page, "artist-discography")).toHaveLength(0);
  });
});

describe("PARROT-MOBILE-ARTIST-PAGE-001 the Albums tab is the discography timeline", () => {
  it("lists King Gizzard's 29 releases newest first, each with its own Play, with a row of years to jump down", () => {
    library(29);
    const page = render();
    const releases = byTestId(page, "artist-release");
    const years = byTestId(page, "artist-year");
    log("timeline", { releases: releases.length, years: years.map((year) => texts(year)[0]) });
    expect(releases.map((release) => release.props.accessibilityLabel)).toEqual(
      [...fake.albums].reverse().map((album) => `${album.title as string}, ${album.year as number}`)
    );
    expect(byTestId(page, "artist-release-play")).toHaveLength(29);
    expect(29).toBeGreaterThanOrEqual(YEAR_JUMP_FROM);
    expect(years.map((year) => texts(year)[0])).toEqual(Array.from({ length: 15 }, (_, index) => 2024 - index));
    // A long discography has its own Songs tab; no song list under the timeline.
    expect(byTestId(page, "artist-discography-songs")).toHaveLength(0);
    (byTestId(page, "artist-release-play")[1]!.props.onPress as () => void)();
    expect(fake.played).toEqual([{ ids: ["al-27-t1", "al-27-t2"], index: 0 }]);
  });

  it("a one-album artist with no photo still reads as a page: the drawn picture with initials, one release, its songs under it", () => {
    library(1);
    const page = render("Lowtide Radio");
    const hero = byTestId(page, "artist-hero");
    const art = all(hero, (el) => el.type === "ParrotArt");
    log("one-album", { art: art.map((el) => el.props.coverKey), heroTexts: texts(hero), releases: byTestId(page, "artist-release").length });
    expect(art).toHaveLength(1);
    expect(art[0]!.props.coverKey).toBeUndefined();
    expect(texts(hero)).toContain("LR");
    expect(byTestId(page, "artist-release")).toHaveLength(1);
    expect(byTestId(page, "artist-year")).toHaveLength(0);
    expect(all(byTestId(page, "artist-discography-songs"), (el) => el.type === "SongListRow")).toHaveLength(2);
  });
});

describe("PARROT-MOBILE-ARTIST-PAGE-001 Delete is only in the More sheet", () => {
  it("shows Shuffle, Save offline, Play next and More under Play, nothing that deletes, and the sheet ends with Delete in red, which asks", () => {
    library(2);
    const page = render("Radiohead");
    const round = all(page, (el) => typeof el.props?.testID === "string" && /^artist-(shuffle|keep|unkeep|play-next|more)$/.test(el.props.testID as string));
    const deleting = all(page, (el) => el.type === "Icon:Trash2" || /delete/i.test(String(el.props?.testID ?? "")) || el.props?.children === "shell.manage.delete");
    log("page", { round: round.map((el) => el.props.testID), deleting: deleting.length });
    expect(round.map((el) => el.props.testID)).toEqual(["artist-shuffle", "artist-keep", "artist-play-next", "artist-more"]);
    expect(deleting).toEqual([]);
    expect(byTestId(page, "artist-play")).toHaveLength(1);

    (round[3]!.props.onPress as () => void)();
    const sheet = fake.sheet!;
    log("sheet", sheet.actions.map((action) => [action.id, action.destructive ?? false]));
    expect(sheet).toMatchObject({ title: "Radiohead", testID: "artist-menu" });
    expect(sheet.actions.filter((action) => action.id === "delete")).toHaveLength(1);
    expect(sheet.actions.at(-1)).toMatchObject({ id: "delete", testID: "artist-menu-delete", destructive: true, icon: "Icon:Trash2" });
    expect(sheet.actions.slice(0, -1).every((action) => !action.destructive)).toBe(true);
    sheet.actions.at(-1)!.onSelect();
    // manage.remove is the existing confirm (PARROT-MOBILE-MANAGE-001): it asks, deletes, then runs onDeleted.
    expect(fake.calls).toEqual(["delete:artist:ar-kg:Radiohead"]);
    expect(fake.wentBack).toBe(1);
  });
});

describe("PARROT-MOBILE-ARTIST-PAGE-001 the name follows the phone's text size", () => {
  it("wraps a long name over at most 3 lines without shrinking it, in a hero that grows to hold it", () => {
    library(1);
    const name = "The Most Extraordinarily Long-Named Philharmonic Orchestra and Chorus of Somewhere";
    const page = render(name);
    const [title] = all(page, (el) => el.type === "Text" && el.props.accessibilityRole === "header" && el.props.children === name);
    const [box] = byTestId(page, "artist-hero-box");
    log("long-name", { title: title?.props, box: box?.props.style });
    expect(title!.props.numberOfLines).toBe(3);
    expect(title!.props.adjustsFontSizeToFit).toBeUndefined();
    expect(title!.props.minimumFontScale).toBeUndefined();
    // A least height, not a fixed one: three lines at a large text size push the photo taller instead of under the back button.
    expect(box!.props.style).toMatchObject({ minHeight: 280 });
    expect((box!.props.style as { height?: number }).height).toBeUndefined();
    expect(typeof box!.props.onLayout).toBe("function");
  });

  it("draws the photo and its fade at the grown hero's height in numbers, so no unfaded strip shows under a 3-line name", () => {
    library(1);
    const name = "Thee Silver Mt. Zion Memorial Orchestra & Tra-La-La Band";
    const [box] = byTestId(render(name), "artist-hero-box");
    // The box measures about 308 at 2x text: the page keeps that as the hero's height.
    (box!.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { height: 307.6 } } });
    expect(fake.setTab).toContain(308);
    fake.heroHeight = 308;
    const [hero] = byTestId(render(name), "artist-hero");
    const [art] = all(hero, (el) => el.type === "ParrotArt");
    const [fade] = byTestId(hero, "artist-hero-fade");
    const [veil] = all(fade, (el) => el.type === "Rect");
    log("grown-hero", { hero: hero?.props.style, art: art?.props.style, fade: [fade?.props.width, fade?.props.height], veil: [veil?.props.width, veil?.props.height] });
    expect(hero!.props.style).toMatchObject({ height: 308 });
    expect(art!.props.style).toMatchObject({ height: 308 });
    // A "100%" fade stayed at the first layout's size on Android; numbers follow the hero.
    expect([fade!.props.width, fade!.props.height]).toEqual([400, 308]);
    expect([veil!.props.width, veil!.props.height]).toEqual([400, 308]);
  });

  it("widens the year rail with the text size so the year never touches the screen edge", () => {
    library(1);
    const railWidth = (scale: number) => {
      fake.fontScale = scale;
      const [rail] = byTestId(render(), "artist-rail-year");
      return Object.assign({}, ...(rail!.props.style as object[])).width as number;
    };
    const widths = [0.85, 1, 1.3, 2].map(railWidth);
    log("rail", { widths });
    // Only the year's own width grows: 14 either side at every size, and the release keeps its room.
    expect(widths).toEqual([56, 56, 64, 84]);
  });
});
