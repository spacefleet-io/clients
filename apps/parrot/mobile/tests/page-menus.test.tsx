/**
 * @test-id PARROT-MOBILE-PAGE-MENUS-001
 * @level unit
 * @bugfix
 * @req PAR-PLAY-05[parrot]
 * @req PAR-NAV-05[parrot]
 * @req PAR-LOOK-05[parrot]
 * @req PAR-LIB-03[parrot]
 * @req PAR-PL-02[parrot]
 * @req UX-SHEET-01[parrot]
 * @why Chris, 2026-11-21: the Now playing "…" opened a white system alert (Go to album, Go to artist, Add to playlist)
 *   that no tap outside or Back closed, and the artist page had a bare bin one tap from deleting every album of the
 *   artist. Now the player's "…" opens the song sheet every song row opens (the app's own bottom sheet), with Go to
 *   album and Go to artist; the artist page and the playlist page have a "…" opening the album page's actions sheet,
 *   Delete last and in red, still asking before it deletes. No page shows a bare bin any more. Screens are called as
 *   functions against a mocked React Native; the sheets themselves are PARROT-MOBILE-PLAYLIST-EDITOR-001's.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-PAGE-MENUS-001] phase=${phase}`, JSON.stringify(detail));

type Action = { id: string; label: string; testID: string; destructive?: boolean; icon: unknown; onSelect: () => void };
const fake = vi.hoisted(() => ({
  calls: [] as string[],
  alerts: [] as unknown[],
  navigated: [] as unknown[],
  wentBack: 0,
  song: null as null | { song: Record<string, unknown>; place: unknown; links: { onGoToAlbum?: () => void; onGoToArtist?: () => void } | undefined },
  sheet: null as null | { title: string; actions: Action[]; testID: string },
  player: null as null | Record<string, unknown>,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useEffect = (fn: () => void | (() => void)) => void fn();
  const useState = <T,>(initial: T | (() => T)) => [typeof initial === "function" ? (initial as () => T)() : initial, () => undefined];
  const useCallback = <T,>(fn: T) => fn;
  const useMemo = <T,>(fn: () => T) => fn();
  const hooks = { useRef, useEffect, useLayoutEffect: useEffect, useState, useCallback, useMemo };
  return { ...actual, default: { ...actual, ...hooks }, ...hooks };
});
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  // The bug: the player's menu was a system alert. Any alert a page opens by itself is recorded and fails the menu tests.
  Alert: { alert: (...args: unknown[]) => void fake.alerts.push(args) },
  Animated: { Value: class {}, View: "AnimatedView", timing: () => ({ start: () => undefined }) },
  Easing: { in: (f: unknown) => f, out: (f: unknown) => f, cubic: () => 0 },
  FlatList: "FlatList",
  Image: "Image",
  Linking: { openURL: async () => undefined },
  Modal: "Modal",
  Platform: { OS: "android" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle", Defs: "Defs", LinearGradient: "LinearGradient", Rect: "Rect", Stop: "Stop" }));
vi.mock("react-native-gesture-handler", () => ({ GestureDetector: "GestureDetector" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@space/mobile-shell/bottom-sheet", () => ({ MobileBottomSheet: "MobileBottomSheet", MobileSheetScrollView: "ScrollView", useMobileDismissPan: () => () => ({}) }));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    ["ArrowDownToLine","ArrowLeft","ArrowRight","ArrowUpDown","Cast","ChevronDown","CircleCheck","Disc3","Download","Ellipsis","FileAudio","Globe","Heart","HeartOff","House","Info","LibraryBig","ListEnd","ListMusic","ListPlus","ListStart","ListX","LoaderCircle","Lock","LogOut","Mail","Mic","MicVocal","Pause","Pencil","Play","Plus","Repeat","Repeat1","RotateCcw","RotateCw","Search","Settings","ShieldCheck","Shuffle","SkipBack","SkipForward","SlidersHorizontal","Trash2","UserRound","Users","Volume","Volume2","X"].map((name) => [name, `Icon:${name}`])
  )
);
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: (...args: unknown[]) => void fake.navigated.push(args), goBack: () => void (fake.wentBack += 1) }),
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: "SkyCover", useSkyScroll: () => ({}) }));
vi.mock("@space/mobile-shell/render-boundary", () => ({ guardRenderItem: (_name: string, render: unknown) => render }));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: { canShowOutputSwitcher: async () => false },
  showsPause: (s: { playWhenReady: boolean }) => s.playWhenReady,
}));
vi.mock("@space/mobile-media-volume", () => ({ useMediaVolume: () => ({ level: null }), VolumeSlider: "VolumeSlider" }));
vi.mock("../src/lib/playback", () => ({ setPlaybackShuffle: async () => undefined }));
vi.mock("../src/state/usePlayerState", () => ({ usePlayerState: () => fake.player, useNowPlaying: () => null }));
vi.mock("../src/state/useUpNext", () => ({ useUpNext: () => [] }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ library: { status: "ready", version: 1 }, localChanges: 0 }) }));
vi.mock("../src/state/useQuery", () => ({ useQuery: () => ({ data: [], loading: false, error: null }) }));
vi.mock("../src/state/usePlay", () => ({ usePlay: () => ({ play: async () => undefined, starting: null, error: null }) }));
vi.mock("../src/lib/library", () => ({ listArtistAlbums: async () => [], readArtistPicture: async () => null, listPlaylistSongs: async () => [] }));
vi.mock("../src/lib/picturesWaiting", () => ({ artistPicturesWaiting: { has: () => false, onChange: () => () => undefined } }));
vi.mock("../src/state/manage", () => ({
  useManage: () => ({ remove: (target: { kind: string; id: string }, title: string, onDeleted?: () => void) => {
    fake.calls.push(`delete:${target.kind}:${target.id}:${title}`);
    onDeleted?.();
  } }),
}));
vi.mock("../src/state/playlistEditor", () => ({
  usePlaylistEditor: () => ({
    playlists: [{ id: "pl-mix", name: "Linnet Park mix", trackIds: [], trackCount: 0 }],
    liked: () => false,
    toggleLike: () => undefined,
    toggleKeep: (kind: string, id: string) => void fake.calls.push(`keep:${kind}:${id}`),
    openSong: (song: Record<string, unknown>, place: unknown, links: NonNullable<typeof fake.song>["links"]) => void (fake.song = { song, place, links }),
    openActions: (title: string, actions: Action[], testID: string) => void (fake.sheet = { title, actions, testID }),
    addToPlaylist: (song: { id: string }) => void fake.calls.push(`add-to-playlist:${song.id}`),
    renamePlaylist: (playlist: { id: string }) => void fake.calls.push(`rename:${playlist.id}`),
    deletePlaylist: (playlist: { id: string }, onDeleted?: () => void) => {
      fake.calls.push(`delete-playlist:${playlist.id}`);
      onDeleted?.();
    },
  }),
}));
vi.mock("../src/screens/kept", () => ({ useKept: () => ({ state: () => "off", entry: () => undefined }), useOfflineReach: () => null, KeepButton: "KeepButton", KeptLine: "KeptLine" }));
vi.mock("../src/screens/sky", () => ({ ParrotSky: "ParrotSky", PLAYER_TINT: "tint" }));
vi.mock("../src/screens/art", () => ({ ParrotArt: "ParrotArt", WaveSeek: "WaveSeek" }));
vi.mock("../src/screens/PlayerLyrics", () => ({ PlayerLyrics: "PlayerLyrics" }));
vi.mock("../src/screens/AlbumGrid", () => ({ AlbumGrid: "AlbumGrid" }));
vi.mock("../src/screens/shimmer", () => ({ Shimmer: "Shimmer" }));
vi.mock("../src/screens/pageBack", () => ({ PageBackButton: "PageBackButton", usePageTop: () => 100 }));
vi.mock("../src/screens/SongListRow", () => ({ SongListRow: "SongListRow", songRowNames: () => [] }));

import { PlayerScreen } from "../src/screens/PlayerScreen";
import { ArtistScreen } from "../src/screens/ArtistScreen";
import { PlaylistScreen } from "../src/screens/PlaylistScreen";
import { nowPlayingTitles } from "../src/lib/nowPlaying";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    for (const key of ["children", "header", "ListHeaderComponent", "actions"]) all(element.props?.[key], match, out);
  }
  return out;
};
const byTestId = (tree: unknown, id: string) => all(tree, (el) => el.props?.testID === id)[0];
/** Every button a page shows with a bin on it, outside any sheet. */
const bareBins = (tree: unknown) => all(tree, (el) => el.props?.icon === "Icon:Trash2").map((el) => el.props.testID);
const press = (tree: unknown, id: string) => {
  const node = byTestId(tree, id);
  expect(node, id).toBeTruthy();
  (node!.props.onPress as () => void)();
};

beforeEach(() => {
  Object.assign(fake, { calls: [], alerts: [], navigated: [], wentBack: 0, song: null, sheet: null, player: null });
});

describe("PARROT-MOBILE-PAGE-MENUS-001 the Now playing \"…\"", () => {
  it("opens the app's song sheet with the title, the artist and the way to the album and the artist, never a system alert", () => {
    log("start", { case: "player-menu" });
    nowPlayingTitles.set("t2", { title: "Drift", artist: "Nova", album: "Low Orbit", albumId: "al-lo", artistId: "ar-n" });
    fake.player = { mediaId: "t2", positionMs: 1_000, durationMs: 200_000, playWhenReady: true, playing: true, shuffle: false, repeat: "off", error: null };
    const screen = (PlayerScreen as unknown as () => unknown)();
    press(screen, "player-menu");
    log("opened", { alerts: fake.alerts.length, song: fake.song?.song, links: Object.keys(fake.song?.links ?? {}) });
    expect(fake.alerts).toEqual([]);
    expect(fake.song).toBeTruthy();
    expect(fake.song!.song).toEqual({ id: "t2", title: "Drift", artist: "Nova" });
    expect(fake.song!.place).toBeUndefined();
    fake.song!.links!.onGoToAlbum!();
    fake.song!.links!.onGoToArtist!();
    log("routed", { navigated: fake.navigated });
    expect(fake.navigated).toEqual([
      ["Album", { albumId: "al-lo", title: "Low Orbit", artistName: "Nova", cover: undefined }],
      ["Artist", { artistId: "ar-n", name: "Nova" }],
    ]);
  });

  it("leaves Go to album and Go to artist out when the song has neither", () => {
    log("start", { case: "player-menu-unknown" });
    nowPlayingTitles.set("t3", { title: "Loose", artist: "", album: "", albumId: "" });
    fake.player = { mediaId: "t3", positionMs: 0, durationMs: 0, playWhenReady: false, playing: false, shuffle: false, repeat: "off", error: null };
    press((PlayerScreen as unknown as () => unknown)(), "player-menu");
    log("opened", { links: fake.song?.links });
    expect(fake.alerts).toEqual([]);
    expect(fake.song!.links?.onGoToAlbum).toBeUndefined();
    expect(fake.song!.links?.onGoToArtist).toBeUndefined();
  });
});

describe("PARROT-MOBILE-PAGE-MENUS-001 the artist page", () => {
  it("has a \"…\" and no bare bin; its sheet ends with Delete in red, which asks before it deletes and then leaves", () => {
    log("start", { case: "artist-menu" });
    const screen = (ArtistScreen as unknown as (props: unknown) => unknown)({ route: { params: { artistId: "ar-n", name: "Nova" } } });
    log("page", { bins: bareBins(screen) });
    expect(bareBins(screen)).toEqual([]);
    expect(byTestId(screen, "artist-delete")).toBeUndefined();
    expect(byTestId(screen, "artist-more")!.props.icon).toBe("Icon:Ellipsis");
    press(screen, "artist-more");
    const sheet = fake.sheet!;
    log("sheet", { title: sheet.title, testID: sheet.testID, actions: sheet.actions.map((a) => [a.id, a.testID, a.destructive]) });
    expect(sheet).toMatchObject({ title: "Nova", testID: "artist-menu" });
    expect(sheet.actions.at(-1)).toMatchObject({ id: "delete", testID: "artist-menu-delete", destructive: true, icon: "Icon:Trash2", label: "shell.manage.delete" });
    sheet.actions.at(-1)!.onSelect();
    // manage.remove is the existing confirm (PARROT-MOBILE-MANAGE-001): it asks, deletes, then runs onDeleted.
    expect(fake.calls).toEqual(["delete:artist:ar-n:Nova"]);
    expect(fake.wentBack).toBe(1);
  });
});

describe("PARROT-MOBILE-PAGE-MENUS-001 the playlist page", () => {
  const render = (playlistId: string) =>
    (PlaylistScreen as unknown as (props: unknown) => unknown)({
      route: { params: { playlistId, name: "Linnet Park mix" } },
      navigation: { navigate: () => undefined, goBack: () => void (fake.wentBack += 1) },
    });

  it("keeps the keep button, and moves Rename and Delete into its \"…\", Delete last and in red", () => {
    log("start", { case: "playlist-menu" });
    const screen = render("pl-mix");
    log("page", { bins: bareBins(screen) });
    expect(bareBins(screen)).toEqual([]);
    expect(byTestId(screen, "playlist-keep")).toBeTruthy();
    expect(byTestId(screen, "playlist-rename")).toBeUndefined();
    press(screen, "playlist-more");
    const sheet = fake.sheet!;
    log("sheet", { actions: sheet.actions.map((a) => [a.id, a.destructive]) });
    expect(sheet.testID).toBe("playlist-menu");
    expect(sheet.actions.map((action) => action.testID)).toEqual(["playlist-menu-rename", "playlist-menu-delete"]);
    expect(sheet.actions.at(-1)).toMatchObject({ destructive: true, icon: "Icon:Trash2" });
    for (const action of sheet.actions) action.onSelect();
    expect(fake.calls).toEqual(["rename:pl-mix", "delete-playlist:pl-mix"]);
    expect(fake.wentBack).toBe(1);
  });

  it("shows no \"…\" on Liked songs, which can be neither renamed nor deleted", () => {
    const screen = render("liked-songs");
    expect(byTestId(screen, "playlist-more")).toBeUndefined();
    expect(bareBins(screen)).toEqual([]);
  });
});
