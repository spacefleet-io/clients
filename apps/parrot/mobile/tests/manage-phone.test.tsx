/**
 * @test-id PARROT-MOBILE-MANAGE-001
 * @level unit
 * @req PAR-META-16[parrot]
 * @req PAR-META-18[parrot]
 * @req PAR-LYR-05[parrot]
 * @req PAR-META-20[parrot]
 * @req PAR-LIB-03[parrot]
 * @why The phone's Edit and Delete do what the desktop's do. Edit opens the form filled with the library's details and
 *   saves the typed ones as one library change. Chris 2026-11-16: the form looks things up on its own, like Badger's
 *   intro lookup, and there is no separate "fetch" action any more. "Look it up again" (PAR-META-18) says "Looking up…",
 *   fills the form with what our music library found, the differing fields marked, and saves only on Save; with no
 *   match or a failure it says so in the row. The Lyrics section (PAR-LYR-05) reads the song's words as the form opens,
 *   asks at once for a song never looked up, shimmers while it waits (PAR-META-20: loading never looks like "none"),
 *   then shows the first lines, or "No lyrics found" / the failure with "Search again"; an album counts its songs with
 *   words and offers "Look for the missing ones". Delete asks first, naming how many songs go, deletes only on yes, and
 *   says why when it could not. The real ManageProvider is mounted against a mocked React Native; the library calls
 *   behind it (storage first, then the snapshot) are the shared, separately tested ones.
 * @covers apps/parrot/mobile/src/state/manage.tsx
 */
import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_EN } from "@space/parrot-core/shell-strings";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-MANAGE-001] phase=${phase}`, JSON.stringify(detail));

type AlertButton = { text: string; style?: string; onPress?: () => void };

type FakeLyrics = { synced: null; plain: string | null; fetched: boolean; notFound?: boolean } | null;

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  alerts: [] as { title: string; body: string; buttons: AlertButton[] }[],
  editValues: null as unknown,
  lookup: null as unknown,
  lookupError: null as Error | null,
  deleteError: null as Error | null,
  saveError: null as Error | null,
  trackCount: 0,
  /** Each song's lyrics row as the library reads it (absent: never looked up). */
  lyrics: {} as Record<string, FakeLyrics>,
  /** What a lyrics lookup finds per song (absent: none); an Error fails it. */
  lyricsFound: {} as Record<string, string | Error>,
  /** Songs asked for lyrics, in order. */
  lyricsAsked: [] as string[],
  /** While set, lyrics lookups wait for it. */
  lyricsGate: null as Promise<void> | null,
  albumTracks: [] as string[],
}));

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const host = (name: string) => (props: Record<string, unknown>) => react.createElement(name, props, props.children as React.ReactNode);
  return {
    Alert: { alert: (title: string, body: string, buttons: AlertButton[]) => void fake.alerts.push({ title, body, buttons }) },
    Image: host("Image"),
    KeyboardAvoidingView: host("KeyboardAvoidingView"),
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
vi.mock("lucide-react-native", () => ({ ImagePlus: () => null, RotateCw: () => null, Search: () => null }));
vi.mock("react-native-image-picker", () => ({ launchImageLibrary: async () => ({ assets: [] }) }));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, values: Record<string, unknown> = {}) => {
      const text = key.startsWith("shell.") ? ((SHELL_EN as Record<string, string>)[key.slice("shell.".length)] ?? key) : key;
      return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
    },
  }),
}));
vi.mock("@space/mobile-shell/components", () => ({ MobileNoticeBanner: ({ message, tone }: { message: string; tone: string }) => `${tone}:${message}` }));
vi.mock("@space/mobile-shell/render-boundary", () => ({ MobileRenderBoundary: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../src/screens/art", () => ({ ParrotArt: () => null }));
vi.mock("../src/screens/shimmer", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { Shimmer: (props: Record<string, unknown>) => react.createElement("Shimmer", props) };
});
vi.mock("../src/theme", () => ({ colors: { textMuted: "#888", accent: "#0f0" }, spacing: { xs: 2, sm: 4, md: 8, lg: 16 } }));
vi.mock("../src/lib/lookup", () => ({ lookupClient: async () => ({ client: "lookup" }) }));
vi.mock("../src/lib/library", async () => {
  const { createParrotLyricsPending } = await vi.importActual<typeof import("@space/parrot-core")>("@space/parrot-core");
  return {
  getEditValues: async (target: { kind: string; id: string }) => {
    fake.calls.push(`values:${target.kind}:${target.id}`);
    return fake.editValues;
  },
  editDetails: async (target: unknown, cover: unknown) => {
    fake.calls.push(`save:${JSON.stringify(target)}:cover=${cover ? "yes" : "no"}`);
    if (fake.saveError) throw fake.saveError;
    return 9;
  },
  fetchMetadata: async (target: { kind: string; id: string }) => {
    fake.calls.push(`lookup:${target.kind}:${target.id}`);
    if (fake.lookupError) throw fake.lookupError;
    return fake.lookup;
  },
  previewDelete: async (target: { kind: string; id: string }) => {
    fake.calls.push(`preview:${target.kind}:${target.id}`);
    return { trackCount: fake.trackCount, albumCount: 1 };
  },
  deleteFromLibrary: async (target: { kind: string; id: string }) => {
    fake.calls.push(`delete:${target.kind}:${target.id}`);
    if (fake.deleteError) throw fake.deleteError;
    return 10;
  },
  readTrackLyrics: async (trackId: string) => fake.lyrics[trackId] ?? null,
  fetchTrackLyrics: async (trackId: string) => {
    fake.lyricsAsked.push(trackId);
    if (fake.lyricsGate) await fake.lyricsGate;
    const found = fake.lyricsFound[trackId];
    if (found instanceof Error) throw found;
    fake.lyrics[trackId] = found ? { synced: null, plain: found, fetched: true } : { synced: null, plain: null, fetched: true, notFound: true };
    return { outcome: found ? "found" : "none", lyrics: fake.lyrics[trackId] };
  },
  lyricsPending: createParrotLyricsPending(),
  listAlbumTracks: async () => fake.albumTracks.map((id) => ({ id })),
  };
});
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    library: { version: 1 },
    changeLibrary: async (what: string, change: () => Promise<number>) => {
      fake.calls.push(`change:${what}`);
      return change();
    },
  }),
}));

import { ManageProvider, useManage, type Manage } from "../src/state/manage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MELTWAY = { kind: "album" as const, id: "al-meltway", title: "meltway", coverKey: null };
const NOOK = { kind: "track" as const, id: "tr-nook", title: "Nook" };
const meltwayAsTagged = { kind: "album", edit: { title: "meltway", albumArtist: "linnet park", year: null, genre: "Rock" } };
const meltwayFound = { kind: "album", edit: { title: "Meltway", albumArtist: "Linnet Park", year: 2003, genre: "Rock" } };

let manage: Manage | null = null;
const Grab = () => {
  manage = useManage();
  return null;
};

let tree: ReactTestRenderer;
const flush = async () => {
  for (let tick = 0; tick < 5; tick += 1) await act(async () => undefined);
};
const byTestId = (id: string): ReactTestInstance[] => tree.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const one = (id: string) => {
  const found = byTestId(id);
  expect(found, id).toHaveLength(1);
  return found[0];
};
const texts = () =>
  tree.root
    // The mocked react-native renders `Text` as a host element named "Text", which React's ElementType does not list.
    .findAll((node) => (node.type as string) === "Text")
    .map((node) => node.props.children)
    .flat()
    .filter((child): child is string => typeof child === "string");
const type = async (field: string, value: string) => act(async () => one(`manage-field-${field}`).props.onChangeText(value));
const press = async (id: string) => {
  await act(async () => one(id).props.onPress());
  await flush();
};

beforeEach(async () => {
  Object.assign(fake, {
    calls: [],
    alerts: [],
    editValues: meltwayAsTagged,
    lookup: null,
    lookupError: null,
    deleteError: null,
    saveError: null,
    trackCount: 13,
    lyrics: { "tr-nook": { synced: null, plain: "I left the porch light on for you", fetched: true } },
    lyricsFound: {},
    lyricsAsked: [],
    lyricsGate: null,
    albumTracks: [],
  });
  await act(async () => {
    tree = create(
      <ManageProvider>
        <Grab />
      </ManageProvider>
    );
  });
});
afterEach(() => act(() => tree.unmount()));

describe("PARROT-MOBILE-MANAGE-001 edit, look up, lyrics and delete on the phone", () => {
  it("PAR-META-16: Edit opens the form with the library's details and saves the typed ones", async () => {
    log("start", { case: "edit" });
    expect(byTestId("manage-edit-dialog")).toHaveLength(0);
    await act(async () => manage!.edit(MELTWAY));
    await flush();
    one("manage-edit-dialog");
    expect(texts()).toContain(SHELL_EN["manage.editTitle.album"]);
    expect(one("manage-field-title").props.value).toBe("meltway");
    expect(one("manage-field-artist").props.value).toBe("linnet park");
    expect(one("manage-field-year").props.value).toBe("");
    expect(byTestId("manage-field-number")).toHaveLength(0); // an album has no track number
    one("manage-cover-pick");
    await type("title", "Meltway");
    await type("artist", "Linnet Park");
    await type("year", "2003");
    expect(texts()).toContain(SHELL_EN["manage.save"]);
    await press("manage-edit-submit");
    log("saved", { calls: fake.calls });
    expect(fake.calls).toEqual([
      "values:album:al-meltway",
      "change:edit",
      `save:${JSON.stringify({ kind: "album", id: "al-meltway", edit: { title: "Meltway", albumArtist: "Linnet Park", year: 2003, genre: "Rock" } })}:cover=no`,
    ]);
    expect(byTestId("manage-edit-dialog")).toHaveLength(0);
    log("done", { case: "edit" });
  });

  it("PAR-META-16: a song's form has its album, track and disc number, and an empty title cannot be saved", async () => {
    log("start", { case: "edit-track" });
    fake.editValues = { kind: "track", edit: { title: "Nook", artist: "linnet park", album: "meltway", number: 13, disc: 1, year: null, genre: null } };
    await act(async () => manage!.edit(NOOK));
    await flush();
    expect(texts()).toContain(SHELL_EN["manage.editTitle.track"]);
    expect(one("manage-field-album").props.value).toBe("meltway");
    expect(one("manage-field-number").props.value).toBe("13");
    expect(one("manage-field-disc").props.value).toBe("1");
    expect(byTestId("manage-cover-pick")).toHaveLength(0);
    await type("title", "  ");
    expect(one("manage-edit-submit").props.disabled).toBe(true);
    await press("manage-edit-cancel");
    expect(byTestId("manage-edit-dialog")).toHaveLength(0);
    expect(fake.calls.filter((call) => call.startsWith("save"))).toEqual([]);
    log("done", { case: "edit-track", calls: fake.calls });
  });

  it("PAR-META-16: a failed save keeps the form open and says why", async () => {
    log("start", { case: "edit-fails" });
    fake.saveError = new Error("library_db_conflict");
    await act(async () => manage!.edit(MELTWAY));
    await flush();
    await press("manage-edit-submit");
    one("manage-edit-dialog");
    expect(one("manage-edit-error").props.children).toBe("Could not save: library_db_conflict");
    log("done", { case: "edit-fails" });
  });

  it("PAR-META-18: Look it up again says Looking up…, then fills the form with what was found, marked, saved only on Save", async () => {
    log("start", { case: "look-up" });
    await act(async () => manage!.edit(MELTWAY));
    await flush();
    expect(one("manage-look-up-note").props.children).toBe(SHELL_EN["manage.lookUpHint"]);
    expect(texts()).toContain(SHELL_EN["manage.lookUp"]);
    const answer = Promise.withResolvers<unknown>();
    fake.lookup = answer.promise;
    await press("manage-look-up-button");
    log("busy", { note: one("manage-look-up-note").props.children });
    expect(one("manage-look-up-note").props.children).toBe(SHELL_EN["manage.searching"]);
    expect(one("manage-look-up-button").props.disabled).toBe(true);
    await act(async () => answer.resolve({ outcome: "found", found: meltwayFound, current: meltwayAsTagged, cover: { kind: "file", bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" } }));
    await flush();
    expect(one("manage-look-up-note").props.children).toBe(SHELL_EN["manage.lookUpFound"]);
    expect(texts()).toContain(SHELL_EN["manage.editTitle.album"]);
    expect(texts()).toContain(SHELL_EN["manage.save"]);
    expect(one("manage-field-title").props.value).toBe("Meltway");
    expect(one("manage-field-artist").props.value).toBe("Linnet Park");
    expect(one("manage-field-year").props.value).toBe("2003");
    for (const key of ["title", "artist", "year"]) one(`manage-changed-${key}`);
    expect(byTestId("manage-changed-genre")).toHaveLength(0); // our library has no genre: the user's stays
    one("manage-cover-preview");
    expect(fake.calls).toEqual(["values:album:al-meltway", "lookup:album:al-meltway"]); // nothing saved yet
    await press("manage-edit-submit");
    log("saved", { calls: fake.calls });
    expect(fake.calls.slice(2)).toEqual([
      "change:edit",
      `save:${JSON.stringify({ kind: "album", id: "al-meltway", edit: { title: "Meltway", albumArtist: "Linnet Park", year: 2003, genre: "Rock" } })}:cover=yes`,
    ]);
    log("done", { case: "look-up" });
  });

  it("PAR-META-18: no better match leaves the form as it was and says so in the row; a failed lookup says why", async () => {
    log("start", { case: "look-up-none" });
    await act(async () => manage!.edit(MELTWAY));
    await flush();
    fake.lookup = { outcome: "none" };
    await press("manage-look-up-button");
    expect(one("manage-look-up-note").props.children).toBe("Nothing better found for meltway.");
    expect(one("manage-field-title").props.value).toBe("meltway");
    expect(byTestId("manage-changed-title")).toHaveLength(0);
    fake.lookupError = new Error("ticket refused");
    await press("manage-look-up-button");
    const note = one("manage-look-up-note");
    expect(note.props.children).toBe("Could not look it up: ticket refused");
    expect(note.props.accessibilityRole).toBe("alert");
    one("manage-edit-dialog");
    expect(fake.calls.filter((call) => call.startsWith("save"))).toEqual([]);
    log("done", { case: "look-up-none", calls: fake.calls });
  });

  it("PAR-LYR-05 / PAR-META-20: a song never looked up is asked at once, shimmering meanwhile, then shows its first lines", async () => {
    log("start", { case: "lyrics-ask" });
    fake.editValues = { kind: "track", edit: { title: "Nook", artist: "linnet park", album: "meltway", number: 13, disc: 1, year: null, genre: null } };
    delete fake.lyrics["tr-nook"];
    fake.lyricsFound["tr-nook"] = "line one\nline two\n\nline three\nline four\nline five";
    const gate = Promise.withResolvers<void>();
    fake.lyricsGate = gate.promise;
    await act(async () => manage!.edit(NOOK));
    await flush();
    log("asking", { asked: fake.lyricsAsked });
    expect(fake.lyricsAsked).toEqual(["tr-nook"]);
    one("manage-lyrics-loading");
    expect(byTestId("manage-lyrics-none")).toHaveLength(0); // loading never looks like "none"
    expect(tree.root.findAll((node) => (node.type as string) === "Shimmer").length).toBeGreaterThan(0);
    expect(texts()).toContain(SHELL_EN["nowPlaying.searchingLyricsTitle"]);
    await act(async () => gate.resolve());
    await flush();
    const found = one("manage-lyrics-found");
    const lines = found.findAll((node) => (node.type as string) === "Text").map((node) => node.props.children);
    log("found", { lines });
    expect(lines).toEqual(["line one", "line two", "line three", "line four"]);
    expect(byTestId("manage-lyrics-search")).toHaveLength(0);
    expect(fake.lyricsAsked).toEqual(["tr-nook"]); // asked once
    log("done", { case: "lyrics-ask" });
  });

  it("PAR-LYR-05: a song with no lyrics says so with Search again; a failed search says why, with Search again", async () => {
    log("start", { case: "lyrics-none" });
    fake.editValues = { kind: "track", edit: { title: "Nook", artist: "linnet park", album: "meltway", number: 13, disc: 1, year: null, genre: null } };
    fake.lyrics["tr-nook"] = { synced: null, plain: null, fetched: true, notFound: true };
    await act(async () => manage!.edit(NOOK));
    await flush();
    expect(fake.lyricsAsked).toEqual([]); // looked up before: not asked again on its own
    const none = one("manage-lyrics-none");
    expect(none.findAll((node) => (node.type as string) === "Text").map((node) => node.props.children)).toContain(SHELL_EN["nowPlaying.noLyricsFoundBody"]);
    expect(texts()).toContain(SHELL_EN["manage.lyricsSearchAgain"]);
    fake.lyricsFound["tr-nook"] = new Error("offline");
    await press("manage-lyrics-search");
    expect(fake.lyricsAsked).toEqual(["tr-nook"]);
    one("manage-lyrics-failed");
    expect(texts()).toContain("Could not look for lyrics: offline");
    one("manage-lyrics-search");
    fake.lyricsFound["tr-nook"] = "found at last";
    await press("manage-lyrics-search");
    one("manage-lyrics-found");
    log("done", { case: "lyrics-none", asked: fake.lyricsAsked });
  });

  it("PAR-LYR-05: an album counts its songs with lyrics, asks for the never-looked-up ones, and looks for the missing ones", async () => {
    log("start", { case: "album-lyrics" });
    fake.albumTracks = ["tr-1", "tr-2", "tr-3"];
    fake.lyrics = { "tr-1": { synced: null, plain: "words", fetched: false }, "tr-3": { synced: null, plain: null, fetched: true, notFound: true } };
    const gate = Promise.withResolvers<void>();
    fake.lyricsGate = gate.promise;
    await act(async () => manage!.edit(MELTWAY));
    await flush();
    expect(fake.lyricsAsked).toEqual(["tr-2"]); // only the one never looked up
    one("manage-lyrics-loading");
    await act(async () => gate.resolve());
    await flush();
    one("manage-lyrics-counted");
    expect(texts()).toContain("Lyrics for 1 of 3 songs.");
    expect(texts()).toContain(SHELL_EN["manage.albumLyricsSearch"]);
    fake.lyricsFound = { "tr-2": "two", "tr-3": "three" };
    await press("manage-lyrics-search");
    log("searched missing", { asked: fake.lyricsAsked });
    expect(fake.lyricsAsked).toEqual(["tr-2", "tr-2", "tr-3"]);
    expect(texts()).toContain("Lyrics for 3 of 3 songs.");
    expect(byTestId("manage-lyrics-search")).toHaveLength(0); // nothing missing: no button
    log("done", { case: "album-lyrics" });
  });

  it("PAR-LIB-03: Delete asks first, naming how many songs go, and deletes only on yes", async () => {
    log("start", { case: "delete" });
    const deleted = vi.fn();
    await act(async () => manage!.remove({ kind: "album", id: "al-meltway" }, "Meltway", deleted));
    await flush();
    expect(fake.alerts).toHaveLength(1);
    const [ask] = fake.alerts;
    expect(ask.title).toBe("Delete Meltway?");
    expect(ask.body).toBe(SHELL_EN["manage.deleteBody.album.other"].replace("{count}", "13"));
    expect(ask.buttons.map((button) => button.text)).toEqual([SHELL_EN["manage.cancel"], SHELL_EN["manage.delete"]]);
    expect(fake.calls).toEqual(["preview:album:al-meltway"]); // asking changes nothing
    ask.buttons[0].onPress?.();
    await flush();
    expect(fake.calls).toEqual(["preview:album:al-meltway"]);
    await act(async () => ask.buttons[1].onPress?.());
    await flush();
    log("deleted", { calls: fake.calls });
    expect(fake.calls).toEqual(["preview:album:al-meltway", "change:delete", "delete:album:al-meltway"]);
    expect(deleted).toHaveBeenCalledTimes(1);
    log("done", { case: "delete" });
  });

  it("PAR-LIB-03: a song's delete names the song; a failed delete says why and leaves the screen where it was", async () => {
    log("start", { case: "delete-fails" });
    fake.trackCount = 1;
    fake.deleteError = new Error("storage refused");
    const deleted = vi.fn();
    await act(async () => manage!.remove({ kind: "track", id: "tr-somewhere" }, "Somewhere I Wander", deleted));
    await flush();
    expect(fake.alerts[0].title).toBe("Delete Somewhere I Wander?");
    expect(fake.alerts[0].body).toBe(SHELL_EN["manage.deleteBody.track"]);
    await act(async () => fake.alerts[0].buttons[1].onPress?.());
    await flush();
    expect(deleted).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).toContain("error:Could not delete: storage refused");
    log("done", { case: "delete-fails", calls: fake.calls });
  });
});
