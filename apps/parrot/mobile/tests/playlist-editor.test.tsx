/**
 * @test-id PARROT-MOBILE-PLAYLIST-EDITOR-001
 * @level unit
 * @req PAR-PL-02[parrot]
 * @req PAR-PL-03[parrot]
 * @req PAR-PL-04[parrot]
 * @why The phone's song sheet, playlist picker, name dialog and delete confirm make, rename, fill, empty song by song
 *   and delete playlists as in the demo, and the heart puts a song in Liked songs. Each change shows at once (before
 *   the server has it) and a change that could not be saved goes back on screen with "Your playlist change was not
 *   saved". The real PlaylistEditorProvider is mounted against a mocked React Native; the session's save writes the
 *   edit into a fake open library, tells the screens, then waits on a publish the test settles, as lib/saveEdits does.
 *   Every sheet is the shared bottom sheet (UX-SHEET-01, whose tap outside, Back and drag all report `onClose`, tested
 *   by MOBILE-SHELL-BOTTOM-SHEET-001): Chris, 2026-11-21, the Now playing "…" was a system alert that nothing closed;
 *   it is now this song sheet, headed by the title and the artist, with Go to album and Go to artist.
 * @req UX-SHEET-01[parrot]
 * @req PAR-NAV-05[parrot]
 * @req PAR-OFFL-01[parrot]
 * @covers apps/parrot/mobile/src/state/playlistEditor.tsx
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_EN, SHELL_FR } from "@space/parrot-core/shell-strings";
import { applyPlaylistEditsLocally, PARROT_LIKED_PLAYLIST_ID, type KeepCopyChoice, type ParrotPlaylist, type ParrotPlaylistEdit } from "@space/parrot-core";
import { getStorageUnitBase, setStorageUnitBase } from "@space/shared/format";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-PLAYLIST-EDITOR-001] phase=${phase}`, JSON.stringify(detail));

type AlertButton = { text: string; style?: string; onPress?: () => void };
type Publish = { edits: ParrotPlaylistEdit[]; resolve: () => void; reject: (error: Error) => void };

const fake = vi.hoisted(() => ({
  playlists: [] as ParrotPlaylist[],
  localChanges: 0,
  listeners: new Set<() => void>(),
  publishes: [] as Publish[],
  alerts: [] as { title: string; body: string; buttons: AlertButton[] }[],
  uuid: 0,
  /** The interface language the mocked i18n reports; French reads the French shell strings. */
  language: "en" as "en" | "fr",
  keepChoices: [] as KeepCopyChoice[],
  keeps: [] as string[],
}));

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const host = (name: string) => (props: Record<string, unknown>) => react.createElement(name, props, props.children as React.ReactNode);
  return {
    Alert: { alert: (title: string, body: string, buttons: AlertButton[]) => void fake.alerts.push({ title, body, buttons }) },
    // The dialog keeps above the keyboard through the shared KeyboardAvoidingForm (an Android 16 phone here).
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    Platform: { OS: "android", Version: 36 },
    // A closed Modal draws nothing, as on the phone.
    Modal: (props: { visible: boolean; children?: React.ReactNode }) => (props.visible ? react.createElement("Modal", props, props.children) : null),
    Pressable: host("Pressable"),
    ScrollView: host("ScrollView"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    Text: host("Text"),
    TextInput: host("TextInput"),
    View: host("View"),
  };
});
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    ["ArrowDownToLine", "CircleCheck", "Disc3", "FileAudio", "Heart", "HeartOff", "ListEnd", "ListMusic", "ListPlus", "ListX", "MicVocal", "Pencil", "Plus", "Sparkles", "Trash2", "X"].map((name) => [name, () => null])
  )
);
vi.mock("react-native-quick-crypto", () => ({ default: { randomUUID: () => `uuid-${(fake.uuid += 1)}` } }));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({
    i18n: { language: fake.language },
    t: (key: string, values: Record<string, unknown> = {}) => {
      const shell = (fake.language === "fr" ? SHELL_FR : SHELL_EN) as Record<string, string>;
      const text = key.startsWith("shell.") ? (shell[key.slice("shell.".length)] ?? key) : key;
      return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
    },
  }),
}));
vi.mock("@space/mobile-shell/components", () => ({ MobileNoticeBanner: ({ message, tone }: { message: string; tone: string }) => `${tone}:${message}` }));
vi.mock("@space/mobile-shell/render-boundary", () => ({ MobileRenderBoundary: ({ children }: { children: React.ReactNode }) => children }));
// The shared sheet: drawn only while shown; its tap outside, Back and drag all end in `onClose` (MOBILE-SHELL-BOTTOM-SHEET-001).
vi.mock("@space/mobile-shell/bottom-sheet", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    MobileBottomSheet: (props: { visible: boolean; children?: React.ReactNode }) => (props.visible ? react.createElement("MobileBottomSheet", props, props.children) : null),
    MobileSheetScrollView: (props: { children?: React.ReactNode }) => react.createElement("ScrollView", props, props.children),
  };
});
vi.mock("../src/theme", () => ({ colors: { textMuted: "#888", accent: "#0f0", danger: "danger" }, spacing: { xs: 2, sm: 4, md: 8, lg: 16 } }));
vi.mock("../src/lib/kept", () => ({
  keepChoices: async () => fake.keepChoices,
  keepItem: async (kind: string, id: string) => void fake.keeps.push(`keep:${kind}:${id}`),
  unkeepItem: async () => undefined,
}));
vi.mock("../src/screens/kept", () => ({ useKept: () => ({ entry: () => null, holdsSong: () => false, state: () => "off" }) }));
vi.mock("../src/state/manage", () => ({ useManage: () => ({ edit: () => undefined, remove: () => undefined }) }));
vi.mock("../src/lib/library", () => ({
  // As the real one: "Liked songs" is always there, even before the library has it.
  listPlaylists: async () =>
    fake.playlists.some((playlist) => playlist.id === PARROT_LIKED_PLAYLIST_ID)
      ? fake.playlists
      : [{ id: PARROT_LIKED_PLAYLIST_ID, name: "", createdAt: 0, updatedAt: 0, trackIds: [], trackCount: 0 }, ...fake.playlists],
}));
vi.mock("../src/state/session", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const changed = () => {
    fake.localChanges += 1;
    for (const listener of fake.listeners) listener();
  };
  // As lib/saveEdits: the edit is written into the open library and the screens told, then it is published; a failed
  // publish puts the library back as it was and tells the screens again.
  const saveEdits = async (edits: ParrotPlaylistEdit[]) => {
    const before = fake.playlists;
    fake.playlists = applyPlaylistEditsLocally(fake.playlists, edits, 1_000);
    changed();
    try {
      const publish = Promise.withResolvers<void>();
      fake.publishes.push({ edits, resolve: publish.resolve, reject: publish.reject });
      await publish.promise;
    } catch (error) {
      fake.playlists = before;
      changed();
      throw error;
    }
  };
  return {
    useSession: () => {
      const localChanges = react.useSyncExternalStore(
        (listener: () => void) => {
          fake.listeners.add(listener);
          return () => void fake.listeners.delete(listener);
        },
        () => fake.localChanges
      );
      return { library: { status: "ready", version: 5 }, localChanges, saveEdits };
    },
  };
});

import { PlaylistEditorProvider, usePlaylistEditor, type PlaylistEditor } from "../src/state/playlistEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOOK = { id: "tr-nook", title: "Nook" };
const AT_THE_GATE = { id: "tr-at-the-gate", title: "At the Gate" };
const FABLE = { id: "tr-fable", title: "Fable" };

let editor: PlaylistEditor | null = null;
const Grab = () => {
  editor = usePlaylistEditor();
  return null;
};
const ed = () => {
  if (!editor) throw new Error("editor not mounted");
  return editor;
};

let tree: ReactTestRenderer;
const flush = async () => {
  for (let tick = 0; tick < 5; tick += 1) await act(async () => undefined);
};
const byTestId = (id: string): ReactTestInstance[] => tree.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const one = (id: string) => {
  const found = byTestId(id);
  expect(found, id).toHaveLength(1);
  return found[0]!;
};
const labels = (id: string) => byTestId(id).map((node) => node.props.accessibilityLabel as string);
const press = async (node: ReactTestInstance) => {
  await act(async () => node.props.onPress());
  await flush();
};
const typeName = async (name: string) => act(async () => one("playlist-name-input").props.onChangeText(name));
const notice = () => byTestId("playlist-notice").map((node) => node.findAll(() => true).flatMap((child) => child.children).filter((c) => typeof c === "string")).flat();
const run = async (call: () => void) => {
  await act(async () => call());
  await flush();
};
/** Settles the oldest publish still waiting. */
const settle = async (error?: Error) => {
  const publish = fake.publishes.shift();
  if (!publish) throw new Error("no publish waiting");
  log(error ? "publish-failed" : "published", { edits: publish.edits });
  await act(async () => (error ? publish.reject(error) : publish.resolve()));
  await flush();
};
const named = (name: string) => fake.playlists.find((playlist) => playlist.name === name);

beforeEach(async () => {
  Object.assign(fake, { playlists: [], localChanges: 0, publishes: [], alerts: [], uuid: 0, language: "en", keepChoices: [], keeps: [] });
  fake.listeners.clear();
  editor = null;
  await act(async () => {
    tree = create(
      <PlaylistEditorProvider>
        <Grab />
      </PlaylistEditorProvider>
    );
  });
  await flush();
});
afterEach(async () => {
  await act(async () => tree.unmount());
});

describe("the phone's playlist editing", () => {
  it("makes a playlist from the picker with a song in it, shown before the server has it", async () => {
    await run(() => ed().openSong(NOOK));
    expect(byTestId("song-sheet")).toHaveLength(1);
    await press(one("song-add-to"));
    expect(byTestId("playlist-picker")).toHaveLength(1);
    expect(labels("picker-liked")).toEqual(["Liked songs"]);
    await press(one("picker-new"));
    expect(one("playlist-name-submit").props.disabled).toBe(true);
    await typeName("   ");
    expect(one("playlist-name-submit").props.disabled).toBe(true);
    await typeName("Linnet Park mix");
    expect(one("playlist-name-submit").props.disabled).toBe(false);
    await press(one("playlist-name-submit"));
    log("created-unsaved", { playlists: ed().playlists.map((p) => [p.name, p.trackIds]), waiting: fake.publishes.length });
    expect(byTestId("playlist-name-dialog")).toHaveLength(0);
    expect(fake.publishes).toHaveLength(1);
    expect(ed().playlists.find((p) => p.name === "Linnet Park mix")?.trackIds).toEqual([NOOK.id]);
    await settle();
    expect(notice()).toEqual(["info:Added to Linnet Park mix"]);
  });

  it("fills a playlist from the picker, empties it song by song, renames it and deletes it after asking", async () => {
    fake.playlists = applyPlaylistEditsLocally([], [{ kind: "create", id: "pl-mix", name: "Linnet Park mix", trackIds: [NOOK.id] }], 1);
    await run(() => {
      fake.localChanges += 1;
      for (const listener of fake.listeners) listener();
    });
    await run(() => ed().addToPlaylist(AT_THE_GATE));
    expect(labels("picker-playlist")).toEqual(["Linnet Park mix"]);
    await press(one("picker-playlist"));
    expect(ed().playlists.find((p) => p.id === "pl-mix")?.trackIds).toEqual([NOOK.id, AT_THE_GATE.id]);
    await settle();

    // Removing takes out that one entry, from the row's place in the playlist.
    await run(() => ed().openSong(NOOK, { playlistId: "pl-mix", position: 0 }));
    await press(one("song-remove"));
    expect(byTestId("song-sheet")).toHaveLength(0);
    expect(ed().playlists.find((p) => p.id === "pl-mix")?.trackIds).toEqual([AT_THE_GATE.id]);
    await settle();

    // A song sheet off a playlist has no "Remove from this playlist".
    await run(() => ed().openSong(FABLE));
    expect(byTestId("song-remove")).toHaveLength(0);

    await run(() => ed().renamePlaylist({ id: "pl-mix", name: "Linnet Park mix" }));
    expect(one("playlist-name-input").props.value).toBe("Linnet Park mix");
    await typeName("Hollow Signal");
    await press(one("playlist-name-submit"));
    expect(named("Hollow Signal")?.id).toBe("pl-mix");
    await settle();

    let closed = 0;
    await run(() => ed().deletePlaylist({ id: "pl-mix", name: "Hollow Signal" }, () => (closed += 1)));
    expect(fake.alerts).toHaveLength(1);
    const confirm = fake.alerts[0]!;
    log("delete-asked", { title: confirm.title, buttons: confirm.buttons.map((b) => b.text) });
    expect(confirm.title).toContain("Hollow Signal");
    confirm.buttons.find((b) => b.style === "cancel")?.onPress?.();
    expect(fake.publishes).toHaveLength(0);
    await run(() => confirm.buttons.find((b) => b.style === "destructive")!.onPress!());
    expect(closed).toBe(1);
    expect(ed().playlists.some((p) => p.id === "pl-mix")).toBe(false);
    await settle();
    expect(fake.playlists.some((p) => p.id === "pl-mix")).toBe(false);
  });

  it("the heart puts a song in Liked songs at once and takes it out again", async () => {
    expect(ed().liked(NOOK.id)).toBe(false);
    await run(() => ed().toggleLike(NOOK.id));
    expect(ed().liked(NOOK.id)).toBe(true);
    expect(fake.publishes[0]?.edits).toEqual([{ kind: "like", trackId: NOOK.id, liked: true }]);
    await settle();
    expect(ed().playlists.find((p) => p.id === PARROT_LIKED_PLAYLIST_ID)?.trackIds).toEqual([NOOK.id]);

    // The song sheet's heart row says what it will do.
    await run(() => ed().openSong(NOOK));
    expect(labels("song-like")).toEqual(["Remove from Liked songs"]);
    await press(one("song-like"));
    expect(ed().liked(NOOK.id)).toBe(false);
    await settle();

    // Picking "Liked songs" in the picker is a like, never a plain add.
    await run(() => ed().addToPlaylist(AT_THE_GATE));
    await press(one("picker-liked"));
    expect(fake.publishes[0]?.edits).toEqual([{ kind: "like", trackId: AT_THE_GATE.id, liked: true }]);
    await settle();
    expect(ed().liked(AT_THE_GATE.id)).toBe(true);
  });

  it("puts the heart and the lists back and says so when a change could not be saved", async () => {
    await run(() => ed().toggleLike(FABLE.id));
    expect(ed().liked(FABLE.id)).toBe(true);
    await settle(new Error("network down"));
    log("heart-undone", { liked: ed().liked(FABLE.id), notice: notice() });
    expect(ed().liked(FABLE.id)).toBe(false);
    expect(notice()).toEqual(["error:Your playlist change was not saved"]);

    await run(() => ed().newPlaylist());
    await typeName("Meltway");
    await press(one("playlist-name-submit"));
    expect(ed().playlists.some((p) => p.name === "Meltway")).toBe(true);
    await settle(new Error("network down"));
    expect(ed().playlists.some((p) => p.name === "Meltway")).toBe(false);
  });

  // @req STOR-UNIT-02[parrot]
  it("[STOR-UNIT-02-PARROT-MOBILE-01] writes each copy's size in the interface language: \"3,2 Go\" and \"800 Mo\" in French", async () => {
    setStorageUnitBase(1000);
    log("storage-unit-base", { base: getStorageUnitBase() });
    fake.keepChoices = [
      { key: "flac", label: "FLAC", lossless: true, bitrateKbps: null, songs: 12, bytes: 3_200_000_000 },
      { key: "mp3", label: "MP3 320", lossless: false, bitrateKbps: 320, songs: 12, bytes: 800_000_000 },
    ];
    const details = async (language: "en" | "fr") => {
      fake.language = language;
      await run(() => ed().toggleKeep("album", "al-meltway"));
      const rows = byTestId("keep-choice-option").map((row) =>
        row
          .findAll((node) => String(node.type) === "Text")
          .flatMap((node) => node.children)
          .filter((child): child is string => typeof child === "string")
      );
      log(`keep-choice-${language}`, { rows });
      await press(one("keep-choice-cancel"));
      return rows.map((texts) => texts[texts.length - 1]);
    };
    const fr = await details("fr");
    const en = await details("en");
    expect(fr).toEqual(["parrot.library.songs · 3,2 Go", "parrot.library.songs · 800 Mo"]);
    expect(en).toEqual(["parrot.library.songs · 3.2 GB", "parrot.library.songs · 800 MB"]);
  });

  it("[@bugfix player menu] opens the Now playing song sheet: title and artist, the song row's actions with Go to album and Go to artist, closed by Back or a tap outside", async () => {
    const went: string[] = [];
    const links = { onGoToAlbum: () => void went.push("album"), onGoToArtist: () => void went.push("artist") };
    const open = () => run(() => ed().openSong({ id: NOOK.id, title: NOOK.title, artist: "Nova" }, undefined, links));
    const sheet = () => tree.root.findAll((node) => String(node.type) === "MobileBottomSheet" && node.props.visible);
    const rows = () => sheet()[0]!.findAll((node) => typeof node.type === "string" && typeof node.props.testID === "string" && node.props.accessibilityRole === "button").map((node) => node.props.testID as string);

    await open();
    const header = ["song-sheet-title", "song-sheet-artist"].map((id) => one(id).findAll(() => true).flatMap((node) => node.children).filter((c) => typeof c === "string"));
    log("player-sheet", { header, rows: rows() });
    expect(header).toEqual([[NOOK.title], ["Nova"]]);
    // The song row's order, with the way to the album and the artist where the card puts them (before Add to playlist).
    expect(rows()).toEqual(["song-like", "song-go-to-album", "song-go-to-artist", "song-add-to", "song-keep", "song-edit", "song-delete"]);
    expect(fake.alerts).toEqual([]);

    // Back, a tap outside and a drag down all close the shared sheet through its onClose.
    await act(async () => sheet()[0]!.props.onClose());
    expect(sheet()).toHaveLength(0);
    expect(byTestId("song-sheet")).toHaveLength(0);

    await open();
    await press(one("song-go-to-album"));
    expect(sheet()).toHaveLength(0);
    await open();
    await press(one("song-go-to-artist"));
    expect(went).toEqual(["album", "artist"]);

    // Save offline (PAR-OFFL-01) keeps the song itself.
    await open();
    await press(one("song-keep"));
    log("kept", { keeps: fake.keeps });
    expect(sheet()).toHaveLength(0);
    expect(fake.keeps).toEqual([`keep:song:${NOOK.id}`]);

    // Add to playlist goes on to the picker in the same sheet.
    await open();
    await press(one("song-add-to"));
    expect(byTestId("playlist-picker")).toHaveLength(1);

    // A song row's sheet (no links) has neither Go to row.
    await run(() => ed().openSong(FABLE));
    expect(byTestId("song-go-to-album")).toHaveLength(0);
    expect(byTestId("song-go-to-artist")).toHaveLength(0);
    expect(byTestId("song-sheet-artist")).toHaveLength(0);
  });

  it("@req PAR-CARD-02[parrot] a song row's sheet adds the song to Up next; a song already there is not added again and the notice says so", async () => {
    // The fake player's Up next, as `queueTracks` answers: how many songs it added (0: already playing or up next).
    const upNext: string[] = [];
    const onAddToQueue = async () => {
      if (upNext.includes(NOOK.id)) return 0;
      upNext.push(NOOK.id);
      return 1;
    };
    const open = () => run(() => ed().openSong(NOOK, undefined, { onAddToQueue }));
    await open();
    const sheet = tree.root.findAll((node) => String(node.type) === "MobileBottomSheet" && node.props.visible)[0]!;
    const rows = sheet.findAll((node) => typeof node.type === "string" && typeof node.props.testID === "string" && node.props.accessibilityRole === "button").map((node) => node.props.testID as string);
    log("queue-sheet", { rows });
    // Add to queue comes first after the heart, where a card lists it before the go-to and playlist rows.
    expect(rows.slice(0, 3)).toEqual(["song-like", "song-add-to-queue", "song-add-to"]);
    expect(labels("song-add-to-queue")).toEqual([SHELL_EN["card.addToQueue"]]);
    await press(one("song-add-to-queue"));
    log("queued-once", { upNext, notice: notice() });
    expect(byTestId("song-sheet")).toHaveLength(0);
    expect(upNext).toEqual([NOOK.id]);
    expect(notice()).toEqual([]);

    await open();
    await press(one("song-add-to-queue"));
    log("queued-twice", { upNext, notice: notice() });
    expect(upNext).toEqual([NOOK.id]);
    expect(notice()).toEqual(["info:Already in Up next"]);

    // In French the row and the notice read the shared strings.
    fake.language = "fr";
    await open();
    expect(labels("song-add-to-queue")).toEqual([SHELL_FR["card.addToQueue"]]);
    await press(one("song-add-to-queue"));
    expect(notice()).toEqual([`info:${SHELL_FR["card.alreadyInUpNext"]}`]);

    // A sheet opened without a queue (the Now playing song's) has no Add to queue.
    await run(() => ed().openSong(FABLE));
    expect(byTestId("song-add-to-queue")).toHaveLength(0);
  });

  it("draws a page's actions sheet with its destructive row last, and closes it on Back", async () => {
    let deleted = 0;
    const actions = [{ id: "delete", label: "Delete", icon: () => null, destructive: true, onSelect: () => void (deleted += 1), testID: "artist-menu-delete" }];
    await run(() => ed().openActions("Nova", actions, "artist-menu"));
    const label = one("artist-menu-delete").findAll((node) => String(node.type) === "Text")[0]!;
    log("actions", { style: label.props.style });
    expect(JSON.stringify(label.props.style)).toContain("danger");
    expect(byTestId("artist-menu")).toHaveLength(1);
    await act(async () => one("artist-menu").props.onClose());
    expect(byTestId("artist-menu")).toHaveLength(0);
    await run(() => ed().openActions("Nova", actions, "artist-menu"));
    await press(one("artist-menu-delete"));
    expect(deleted).toBe(1);
    expect(byTestId("artist-menu")).toHaveLength(0);
  });
});
