/**
 * @test-id PARROT-MOBILE-ALBUM-MISSING-001
 * @level unit
 * @req PAR-LIB-05[parrot]
 * @why Chris, 2026-11-11: the phone's album page lists the album's songs the user does not have, greyed and not
 *   playable, in tracklist order between the owned ones (like Badger's missing episodes); Play, Shuffle, the heart and a
 *   tapped song's queue hold only the owned songs. An album whose tracklist is unknown lists only its songs. The
 *   screen is called as a function against a mocked React Native; the greyed look is tried on a device.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { SHELL_FR } from "@space/parrot-core/shell-strings";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-ALBUM-MISSING-001] phase=${phase}`, JSON.stringify(detail));

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  tracklist: null as null | Array<{ disc: number; number: number; title: string; durationMs: number | null }>,
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
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }) }));
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
// Each library read answers a tag; the query hook hands back that read's data.
vi.mock("../src/lib/library", () => ({
  listAlbumTracks: () => "tracks",
  listAlbumTracklist: () => "tracklist",
  albumHeader: () => "header",
}));
vi.mock("../src/state/useQuery", () => ({
  useQuery: (read: () => string) => {
    const songs = [
      { id: "t2", title: "Apogee", albumId: "al-lo", artistId: "ar-n", artistName: "Nova", disc: 1, number: 2, durationMs: 200_000 },
      { id: "t3", title: "Perigee", albumId: "al-lo", artistId: "ar-n", artistName: "Nova", disc: 1, number: 3, durationMs: 210_000 },
    ];
    const data = { tracks: songs, tracklist: fake.tracklist, header: null }[read()];
    return { loading: false, error: null, data };
  },
}));
vi.mock("../src/state/usePlay", () => ({
  usePlay: () => ({
    starting: null,
    error: null,
    play: async (tracks: { id: string }[], index: number, _album: unknown, options: { shuffle?: boolean } = {}) =>
      void fake.calls.push(`play:${tracks.map((track) => track.id).join(",")}@${index}${options.shuffle ? ":shuffle" : ""}`),
    queue: async () => undefined,
  }),
}));
vi.mock("../src/state/usePlayerState", () => ({ useNowPlaying: () => null }));
vi.mock("../src/state/playlistEditor", () => ({
  usePlaylistEditor: () => ({
    allLiked: () => false,
    toggleLikeAll: (ids: string[]) => void fake.calls.push(`like-all:${ids.join(",")}`),
    openSong: () => undefined,
    openActions: () => undefined,
  }),
}));
vi.mock("../src/screens/kept", () => ({ KeptLine: "KeptLine", useKept: () => ({ entry: () => null, state: () => "off" }), useOfflineReach: () => null }));
vi.mock("../src/screens/art", () => ({ ParrotArt: "ParrotArt" }));
vi.mock("../src/screens/equalizer", () => ({ PlayingBadge: "PlayingBadge" }));
vi.mock("../src/screens/SongListRow", () => ({ SongListRow: "SongListRow", MissingSongRow: "MissingSongRow" }));
vi.mock("../src/screens/sky", () => ({ ParrotSky: ({ children }: { children: unknown }) => children }));
vi.mock("../src/screens/pageBack", () => ({ PageBackButton: "PageBackButton", usePageTop: () => 120 }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ library: { status: "ready", error: null, version: 3 } }) }));
vi.mock("../src/state/manage", () => ({ useManage: () => ({ edit: () => undefined, remove: () => undefined }) }));
vi.mock("@space/mobile-shell/components", () => ({ MobileIconButton: "MobileIconButton" }));
vi.mock("@space/mobile-shell/render-boundary", () => ({ guardRenderItem: (_name: string, render: unknown) => render }));

import { AlbumScreen } from "../src/screens/AlbumScreen";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object" && "props" in node) {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
    all(element.props?.ListHeaderComponent, match, out);
  }
  return out;
};
const byTestId = (tree: unknown, id: string) => all(tree, (el) => el.props?.testID === id)[0];

/** The page, then each FlatList row as its renderItem draws it. */
const renderRows = () => {
  const tree = (AlbumScreen as unknown as (props: unknown) => unknown)({
    route: { params: { albumId: "al-lo", title: "Low Orbit", artistName: "Nova", cover: null } },
    navigation: {},
  });
  const list = all(tree, (el) => el.type === "FlatList")[0]!;
  const data = list.props.data as unknown[];
  const renderItem = list.props.renderItem as (info: { item: unknown; index: number }) => Element;
  return { tree, rows: data.map((item, index) => renderItem({ item, index })) };
};

describe("PARROT-MOBILE-ALBUM-MISSING-001 album page missing songs", () => {
  it("slots the missing songs greyed between the owned ones, with nothing to press", () => {
    fake.tracklist = [
      { disc: 1, number: 1, title: "Liftoff", durationMs: 180_000 },
      { disc: 1, number: 2, title: "Apogee", durationMs: 200_000 },
      { disc: 1, number: 3, title: "Perigee", durationMs: 210_000 },
      { disc: 1, number: 4, title: "Splashdown", durationMs: null },
    ];
    const { rows } = renderRows();
    const shown = rows.map((row) => `${String(row.type)}:${row.props.title}`);
    log("rows", shown);
    expect(shown).toEqual(["MissingSongRow:Liftoff", "SongListRow:Apogee", "SongListRow:Perigee", "MissingSongRow:Splashdown"]);
    const missing = rows.filter((row) => row.type === "MissingSongRow");
    for (const row of missing) {
      expect(row.props.note).toBe(SHELL_FR["library.missingTrack"]);
      expect(row.props.onPress).toBeUndefined();
    }
    expect(missing[0]!.props).toMatchObject({ number: 1, durationMs: 180_000 });
  });

  it("plays, shuffles and hearts only the owned songs; a tapped song plays from its place among them", () => {
    fake.calls = [];
    const { tree, rows } = renderRows();
    (byTestId(tree, "album-play")!.props.onPress as () => void)();
    (byTestId(tree, "album-shuffle")!.props.onPress as () => void)();
    (byTestId(tree, "album-like")!.props.onPress as () => void)();
    (rows.find((row) => row.props.title === "Perigee")!.props.onPress as () => void)();
    log("calls", fake.calls);
    expect(fake.calls[0]).toBe("play:t2,t3@0");
    expect(fake.calls[1]).toMatch(/^play:t2,t3@[01]:shuffle$/);
    expect(fake.calls[2]).toBe("like-all:t2,t3");
    expect(fake.calls[3]).toBe("play:t2,t3@1");
  });

  it("lists only the owned songs when the tracklist is unknown", () => {
    fake.tracklist = null;
    const { rows } = renderRows();
    log("rows without tracklist", rows.map((row) => row.props.title));
    expect(rows.map((row) => [row.type, row.props.title])).toEqual([
      ["SongListRow", "Apogee"],
      ["SongListRow", "Perigee"],
    ]);
  });
});
