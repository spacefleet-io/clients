/**
 * @test-id PARROT-MOBILE-ALBUM-ACTIONS-001
 * @level unit
 * @req PAR-LOOK-05[parrot]
 * @req PAR-CARD-01[parrot]
 * @req PAR-META-16[parrot]
 * @req PAR-META-18[parrot]
 * @req PAR-LIB-03[parrot]
 * @req PAR-NAV-05[parrot]
 * @why The phone's album page shows the design's Play, Shuffle, heart and "…" under the title. The "…" lists the
 *   album card's shared actions (parrot-core's `parrotCardActionList`) without Play and Shuffle, in the same order as
 *   the desktop and the web player (Edit among them, PAR-META-16; no separate fetch action any more, the edit dialog
 *   looks the album up itself, PAR-META-18), then Keep on this phone and last Delete (PAR-LIB-03); no keep button is
 *   left beside the title. Play next
 *   and Add to queue reach the phone player's queue without starting the album over. The screen is called as a function against a mocked React Native; the native queue is tried on a
 *   device.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { SHELL_FR } from "@space/parrot-core/shell-strings";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-ALBUM-ACTIONS-001] phase=${phase}`, JSON.stringify(detail));

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  sheet: null as null | { title: string; testID: string; actions: { id: string; label: string; testID: string; onSelect: () => void }[] },
  liked: new Set<string>(),
  kept: false,
  navigated: [] as unknown[],
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, default: actual };
});
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  FlatList: "FlatList",
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: (...args: unknown[]) => fake.navigated.push(args) }) }));
vi.mock("lucide-react-native", () => ({
  ArrowDownToLine: "Icon:ArrowDownToLine",
  CircleCheck: "Icon:CircleCheck",
  Disc3: "Icon:Disc3",
  Ellipsis: "Icon:Ellipsis",
  FileText: "Icon:FileText",
  Heart: "Icon:Heart",
  ListEnd: "Icon:ListEnd",
  ListPlus: "Icon:ListPlus",
  ListStart: "Icon:ListStart",
  MicVocal: "Icon:MicVocal",
  Pencil: "Icon:Pencil",
  Play: "Icon:Play",
  Shuffle: "Icon:Shuffle",
  Sparkles: "Icon:Sparkles",
  Trash2: "Icon:Trash2",
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith("shell.") ? ((SHELL_FR as Record<string, string>)[key.slice("shell.".length)] ?? key) : key),
  }),
}));
vi.mock("../src/state/useQuery", () => ({
  useQuery: () => ({
    loading: false,
    error: null,
    data: [
      { id: "t1", title: "Liftoff", albumId: "al-lo", artistId: "ar-n", artistName: "Nova", number: 1 },
      { id: "t2", title: "Apogee", albumId: "al-lo", artistId: "ar-n", artistName: "Nova", number: 2 },
    ],
  }),
}));
vi.mock("../src/state/usePlay", () => ({
  usePlay: () => ({
    starting: null,
    error: null,
    play: async (tracks: { id: string }[], index: number, _album: unknown, options: { shuffle?: boolean } = {}) =>
      void fake.calls.push(`play:${tracks.map((track) => track.id).join(",")}@${index}${options.shuffle ? ":shuffle" : ""}`),
    queue: async (tracks: { id: string }[], where: string) => void fake.calls.push(`queue-${where}:${tracks.map((track) => track.id).join(",")}`),
  }),
}));
vi.mock("../src/state/usePlayerState", () => ({ useNowPlaying: () => null }));
vi.mock("../src/state/playlistEditor", () => ({
  usePlaylistEditor: () => ({
    allLiked: (ids: string[]) => ids.length > 0 && ids.every((id) => fake.liked.has(id)),
    toggleLikeAll: (ids: string[]) => void fake.calls.push(`like-all:${ids.join(",")}`),
    addToPlaylist: (song: { id: string; trackIds?: string[] }) => void fake.calls.push(`add-to-playlist:${song.id}:${song.trackIds?.join(",")}`),
    toggleKeep: (kind: string, id: string) => void fake.calls.push(`keep:${kind}:${id}`),
    openSong: () => undefined,
    openActions: (title: string, actions: NonNullable<typeof fake.sheet>["actions"], testID: string) => void (fake.sheet = { title, actions, testID }),
  }),
}));
vi.mock("../src/screens/kept", () => ({
  KeptLine: "KeptLine",
  useOfflineReach: () => null,
  useKept: () => ({ entry: () => (fake.kept ? { done: 2, total: 2, bytes: 1 } : null), state: () => "off" }),
}));
vi.mock("../src/screens/art", () => ({ ParrotArt: "ParrotArt" }));
vi.mock("../src/screens/equalizer", () => ({ PlayingBadge: "PlayingBadge" }));
vi.mock("../src/screens/SongListRow", () => ({ SongListRow: "SongListRow", MissingSongRow: "MissingSongRow" }));
vi.mock("../src/screens/sky", () => ({ ParrotSky: ({ children }: { children: unknown }) => children }));
vi.mock("../src/screens/pageBack", () => ({ PageBackButton: "PageBackButton", usePageTop: () => 120 }));
vi.mock("../src/lib/library", () => ({ listAlbumTracks: async () => [], listAlbumTracklist: async () => null, albumHeader: async () => null }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ library: { status: "ready", error: null, version: 3 } }) }));
vi.mock("../src/state/manage", () => ({
  useManage: () => ({
    edit: (item: { kind: string; id: string; title: string }) => void fake.calls.push(`edit:${item.kind}:${item.id}:${item.title}`),
    remove: (target: { kind: string; id: string }, title: string) => void fake.calls.push(`delete:${target.kind}:${target.id}:${title}`),
  }),
}));
vi.mock("@space/mobile-shell/components", () => ({}));
vi.mock("@space/mobile-shell/render-boundary", () => ({ guardRenderItem: (_name: string, render: unknown) => render }));

import { AlbumScreen } from "../src/screens/AlbumScreen";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
    all(element.props?.ListHeaderComponent, match, out);
  }
  return out;
};
const byTestId = (tree: unknown, id: string) => all(tree, (el) => el.props?.testID === id)[0];

const render = () =>
  (AlbumScreen as unknown as (props: unknown) => unknown)({
    route: { params: { albumId: "al-lo", title: "Low Orbit", artistName: "Nova", cover: null } },
    navigation: {},
  });

describe("PARROT-MOBILE-ALBUM-ACTIONS-001 album page action row", () => {
  it("shows Play, Shuffle, heart and … under the title, with no keep button beside it", () => {
    log("start", { case: "row" });
    fake.calls = [];
    const tree = render();
    for (const id of ["album-play", "album-shuffle", "album-like", "album-more"]) expect(byTestId(tree, id), id).toBeTruthy();
    expect(byTestId(tree, "album-keep")).toBeUndefined();
    (byTestId(tree, "album-play")!.props.onPress as () => void)();
    (byTestId(tree, "album-shuffle")!.props.onPress as () => void)();
    (byTestId(tree, "album-like")!.props.onPress as () => void)();
    expect(fake.calls[0]).toBe("play:t1,t2@0");
    expect(fake.calls[1]).toMatch(/^play:t1,t2@[01]:shuffle$/);
    expect(fake.calls[2]).toBe("like-all:t1,t2");
    expect(byTestId(tree, "album-like")!.props.label).toBe(SHELL_FR["playlists.like"]);
    log("done", { case: "row", calls: fake.calls });
  });

  it("fills the heart green when every song is liked", () => {
    log("start", { case: "heart" });
    fake.liked = new Set(["t1", "t2"]);
    const heart = byTestId(render(), "album-like")!;
    expect(heart.props.label).toBe(SHELL_FR["playlists.unlike"]);
    expect(heart.props.icon).not.toBe("Icon:Heart");
    fake.liked = new Set(["t1"]);
    expect(byTestId(render(), "album-like")!.props.icon).toBe("Icon:Heart");
    log("done", { case: "heart" });
  });

  it("lists the card's actions without Play and Shuffle, then Keep last, and runs each", () => {
    log("start", { case: "menu" });
    fake.calls = [];
    fake.kept = false;
    (byTestId(render(), "album-more")!.props.onPress as () => void)();
    const sheet = fake.sheet!;
    expect(sheet.testID).toBe("album-menu");
    expect(sheet.title).toBe("Low Orbit");
    expect(sheet.actions.map((action) => action.id)).toEqual(["play-next", "add-to-queue", "go-to-artist", "add-to-playlist", "edit", "keep", "delete"]);
    expect(sheet.actions.map((action) => action.label)).toEqual([
      SHELL_FR["card.playNext"],
      SHELL_FR["card.addToQueue"],
      SHELL_FR["card.goToArtist"],
      SHELL_FR["card.addToPlaylist"],
      SHELL_FR["manage.edit"],
      "parrot.kept.keep",
      SHELL_FR["manage.delete"],
    ]);
    for (const action of sheet.actions) action.onSelect();
    expect(fake.calls).toEqual([
      "queue-next:t1,t2",
      "queue-end:t1,t2",
      "add-to-playlist:al-lo:t1,t2",
      "edit:album:al-lo:Low Orbit",
      "keep:album:al-lo",
      "delete:album:al-lo:Low Orbit",
    ]);
    expect(fake.navigated).toEqual([["Artist", { artistId: "ar-n", name: "Nova" }]]);
    fake.kept = true;
    (byTestId(render(), "album-more")!.props.onPress as () => void)();
    expect(fake.sheet!.actions.at(-2)).toMatchObject({ label: "parrot.kept.remove", testID: "album-menu-unkeep" });
    expect(fake.sheet!.actions.at(-1)).toMatchObject({ testID: "album-menu-delete", icon: "Icon:Trash2" });
    log("done", { case: "menu", calls: fake.calls });
  });

  // Chris, 2026-11-15 (issue #2508): on the album page the artist's name could not be tapped.
  it("the artist's name under the title opens the artist's page", () => {
    log("start", { case: "artist-link" });
    fake.navigated = [];
    const link = byTestId(render(), "album-artist-link");
    expect(link).toBeTruthy();
    expect(link!.props.disabled).toBe(false);
    (link!.props.onPress as () => void)();
    expect(fake.navigated).toEqual([["Artist", { artistId: "ar-n", name: "Nova" }]]);
    log("done", { case: "artist-link", navigated: fake.navigated });
  });
});
