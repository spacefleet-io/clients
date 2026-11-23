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
 *   intro lookup, and there is no separate "fetch" action any more. Chris 2026-11-20 (PAR-META-18): "Look it up again"
 *   is gone; the fields that name something autocomplete together. With "Pinkin Park" (typo) and "Numb" standing,
 *   typing "mete" in Album lists Meteora by Linkin Park first under "Fits this song", tagged "in your library", the
 *   lookup's answers after the library's and "Only “mete”" below; while our music library is still being asked a
 *   shimmer row says "Still asking…" (PAR-META-20: never "nothing found"), and a failed ask says why in one line while
 *   the library's results stay. Picking fills every field it knows, each changed one marked with its old value struck
 *   through and a ↺ to put it back, under "Filled in from Meteora" with Undo; nothing is saved before Save. The Lyrics
 *   section (PAR-LYR-05) reads the song's words as the form opens, asks at once for a song never looked up, shimmers
 *   while it waits, then shows the first lines, or "No lyrics found" / the failure with "Search again"; an album counts
 *   its songs with words and offers "Look for the missing ones". Delete asks first, naming how many songs go, deletes
 *   only on yes, and says why when it could not. The real ManageProvider and its lookups hook are mounted against a
 *   mocked React Native; the ranking (@space/parrot-core editSuggest) is the real one, the library and the lookup
 *   service are canned.
 * @covers apps/parrot/mobile/src/state/manage.tsx
 * @covers apps/parrot/mobile/src/state/editLookups.ts
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
  /** The library the autocomplete ranks against. */
  suggestLibrary: null as unknown,
  /** The lookup's `musicSuggest` answer: a value, a promise of one, or an Error that fails it. */
  suggestAnswer: null as unknown,
  /** Every `musicSuggest` question, in order. */
  suggestAsked: [] as unknown[],
  /** Covers asked for a pick, by lookup id. */
  coversAsked: [] as string[],
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
vi.mock("lucide-react-native", () => ({ ImagePlus: () => null, RotateCcw: () => null, RotateCw: () => null }));
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
vi.mock("../src/lib/lookup", () => ({
  lookupClient: async () => ({
    musicSuggest: async (question: unknown) => {
      fake.suggestAsked.push(question);
      const answer = await fake.suggestAnswer;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  }),
}));
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
  readSuggestLibrary: async () => {
    fake.calls.push("suggest-library");
    return fake.suggestLibrary;
  },
  fetchSuggestionCover: async (coverId: string) => {
    fake.coversAsked.push(coverId);
    return { kind: "file", bytes: new Uint8Array([7, 7, 7]), mime: "image/jpeg" };
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
import { SUGGEST_ASK_DELAY_MS } from "../src/state/editLookups";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MELTWAY = { kind: "album" as const, id: "al-meltway", title: "meltway", coverKey: null };
const NOOK = { kind: "track" as const, id: "tr-nook", title: "Nook" };
const meltwayAsTagged = { kind: "album", edit: { title: "meltway", albumArtist: "linnet park", year: null, genre: "Rock" } };

// Chris's example (PAR-META-18): the song as tagged, artist with a typo, on a live album.
const NUMB = { kind: "track" as const, id: "tr-numb-live", title: "Numb" };
const numbAsTagged = { kind: "track", edit: { title: "Numb", artist: "Pinkin Park", album: "Live in Texas", number: 5, disc: 1, year: null, genre: "Nu metal" } };
const suggestLibrary = {
  artists: [
    { id: "ar-lp", name: "Linkin Park" },
    { id: "ar-pinkin", name: "Pinkin Park" },
    { id: "ar-bonobo", name: "Bonobo" },
  ],
  albums: [
    { id: "al-meteora", title: "Meteora", artist: "Linkin Park", year: 2003, kind: "studio", musicId: "rg-meteora" },
    { id: "al-live", title: "Live in Texas", artist: "Pinkin Park", year: null, kind: "live", musicId: null },
    { id: "al-shower", title: "Meteor Shower", artist: "Bonobo", year: 2019, kind: "studio", musicId: null },
  ],
  tracks: [
    { id: "tr-numb", title: "Numb", artist: "Linkin Park", albumId: "al-meteora", album: "Meteora", number: 13, disc: 1, year: 2003 },
    { id: "tr-numb-live", title: "Numb", artist: "Pinkin Park", albumId: "al-live", album: "Live in Texas", number: 5, disc: 1, year: null },
    { id: "tr-kiara", title: "Kiara", artist: "Bonobo", albumId: "al-shower", album: "Meteor Shower", number: 2, disc: 1, year: 2019 },
  ],
};
// What our music library answers for "mete" (canned `music_suggest` results).
const meteAnswer = {
  results: [
    {
      kind: "song",
      artist: { id: "mb-lp", name: "Linkin Park" },
      album: { id: "rg-meteora-20", title: "Meteora 20th Anniversary Edition", year: 2023, kind: "studio", trackNumber: 13, disc: 1 },
      song: { id: "rec-numb", title: "Numb", durationMs: 185000 },
      fits: { title: true, artist: true, album: true },
    },
    {
      kind: "album",
      artist: { id: "mb-yy", name: "Years & Years" },
      album: { id: "rg-meteorite", title: "Meteorite", year: 2015, kind: "studio", trackNumber: null, disc: null },
      song: null,
      fits: { title: false, artist: false, album: true },
    },
  ],
};

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
/** The suggestion rows of one section as "name | tag | about". */
const rows = (section: string) =>
  byTestId(section).flatMap((view) =>
    view
      .findAll((node) => node.props.testID === "manage-suggest-row" && typeof node.type === "string")
      .map((row) =>
        row
          .findAll((node) => (node.type as string) === "Text")
          .map((node) => node.props.children)
          .join(" | ")
      )
  );
/** Taps the suggestion named `name`. */
const pick = async (name: string) => {
  const row = byTestId("manage-suggest-row").find((node) => String(node.props.accessibilityLabel).startsWith(`${name},`));
  expect(row, name).toBeDefined();
  await act(async () => row!.props.onPress());
  await flush();
};
/** Waits out the typing pause after which our music library is asked. */
const pause = () =>
  act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, SUGGEST_ASK_DELAY_MS + 50);
    await promise;
  });

beforeEach(async () => {
  Object.assign(fake, {
    calls: [],
    alerts: [],
    editValues: meltwayAsTagged,
    suggestLibrary,
    suggestAnswer: meteAnswer,
    suggestAsked: [],
    coversAsked: [],
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
      "suggest-library", // typing in Title reads the library for its suggestions, once
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

  it("PAR-META-18 / PAR-META-20: typing “mete” in Album lists Meteora by Linkin Park first, the library's at once, the lookup's after asking", async () => {
    log("start", { case: "suggest-mete" });
    fake.editValues = numbAsTagged;
    await act(async () => manage!.edit(NUMB));
    await flush();
    expect(byTestId("manage-look-up")).toHaveLength(0); // "Look it up again" is gone
    expect(byTestId("manage-suggest")).toHaveLength(0); // no list before typing
    const answer = Promise.withResolvers<unknown>();
    fake.suggestAnswer = answer.promise;
    // Typed letter by letter: one question for the pause, never one per letter.
    for (const text of ["m", "me", "met", "mete"]) await type("album", text);
    await flush();
    log("library", { fits: rows("manage-suggest-fits"), only: rows("manage-suggest-only") });
    expect(fake.suggestAsked).toEqual([]);
    expect(rows("manage-suggest-fits")[0]).toBe(`Meteora | ${SHELL_EN["manage.suggestInLibrary"]} | Linkin Park · 2003 · “Numb” is track 13`);
    expect(texts()).toContain(SHELL_EN["manage.suggestFits"]);
    expect(texts()).toContain("Only “mete”");
    expect(rows("manage-suggest-only")).toEqual([`Meteor Shower | ${SHELL_EN["manage.suggestInLibrary"]} | Bonobo · 2019`]);
    const meteoraDots = one("manage-suggest-fits").findAll((node) => node.props.testID === "manage-suggest-dots" && typeof node.type === "string")[0];
    expect(meteoraDots.props.accessibilityLabel).toBe("Fits: Title, Artist, Album");
    // Still asking: a shimmer row, never "nothing found".
    one("manage-suggest-asking");
    expect(texts()).toContain(SHELL_EN["manage.suggestStillAsking"]);
    expect(byTestId("manage-suggest-failed")).toHaveLength(0);
    await pause();
    log("asked", { asked: fake.suggestAsked });
    expect(fake.suggestAsked).toEqual([{ field: "album", text: "mete", title: "Numb", artist: "Pinkin Park" }]);
    one("manage-suggest-asking");
    await act(async () => answer.resolve(meteAnswer));
    await flush();
    log("answered", { fits: rows("manage-suggest-fits"), only: rows("manage-suggest-only") });
    expect(byTestId("manage-suggest-asking")).toHaveLength(0);
    expect(rows("manage-suggest-fits")).toEqual([
      `Meteora | ${SHELL_EN["manage.suggestInLibrary"]} | Linkin Park · 2003 · “Numb” is track 13`,
      "Meteora 20th Anniversary Edition | Linkin Park · 2023 · “Numb” is track 13",
    ]);
    expect(rows("manage-suggest-only")).toEqual([`Meteor Shower | ${SHELL_EN["manage.suggestInLibrary"]} | Bonobo · 2019`, "Meteorite | Years & Years · 2015"]);
    expect(fake.suggestAsked).toHaveLength(1);
    log("done", { case: "suggest-mete" });
  });

  it("PAR-META-18: picking Meteora fills every field it knows, marked with the old value and ↺; Undo puts the form back; Save saves", async () => {
    log("start", { case: "suggest-pick" });
    fake.editValues = numbAsTagged;
    await act(async () => manage!.edit(NUMB));
    await flush();
    await type("album", "mete");
    await pause();
    await flush();
    await pick("Meteora");
    const values = () => Object.fromEntries(["title", "artist", "album", "number", "disc", "year", "genre"].map((key) => [key, one(`manage-field-${key}`).props.value]));
    log("picked", values());
    expect(values()).toEqual({ title: "Numb", artist: "Linkin Park", album: "Meteora", number: "13", disc: "1", year: "2003", genre: "Nu metal" });
    expect(byTestId("manage-suggest")).toHaveLength(0); // the list closes on a pick
    expect(one("manage-suggest-filled-note").props.children).toBe("Filled in from Meteora. Nothing changes until you save.");
    for (const [key, was] of [["artist", "Pinkin Park"], ["album", "Live in Texas"], ["number", "5"], ["year", ""]]) {
      one(`manage-changed-${key}`);
      expect(one(`manage-was-${key}`).props.children).toBe(was);
    }
    for (const key of ["title", "disc", "genre"]) expect(byTestId(`manage-changed-${key}`)).toHaveLength(0);
    expect(one("manage-restore-artist").props.accessibilityLabel).toBe("Put back “Pinkin Park”");
    expect(fake.calls.filter((call) => call.startsWith("save") || call.startsWith("change"))).toEqual([]); // nothing saved
    // ↺ puts one field back.
    await press("manage-restore-artist");
    expect(one("manage-field-artist").props.value).toBe("Pinkin Park");
    expect(byTestId("manage-changed-artist")).toHaveLength(0);
    one("manage-changed-album");
    // Undo puts the whole form back as it was just before the pick.
    await press("manage-suggest-undo");
    log("undone", values());
    expect(values()).toEqual({ title: "Numb", artist: "Pinkin Park", album: "mete", number: "5", disc: "1", year: "", genre: "Nu metal" });
    expect(byTestId("manage-suggest-filled")).toHaveLength(0);
    for (const key of ["artist", "album", "number", "year"]) expect(byTestId(`manage-changed-${key}`)).toHaveLength(0);
    // Pick again, then Save: the picked details are saved, the genre kept.
    await type("album", "mete");
    await flush();
    await pick("Meteora");
    await press("manage-edit-submit");
    log("saved", { calls: fake.calls });
    expect(fake.calls.filter((call) => call.startsWith("save"))).toEqual([
      `save:${JSON.stringify({ kind: "track", id: "tr-numb-live", edit: { title: "Numb", artist: "Linkin Park", album: "Meteora", number: 13, disc: 1, year: 2003, genre: "Nu metal" } })}:cover=no`,
    ]);
    expect(fake.calls.filter((call) => call === "suggest-library")).toHaveLength(1); // the library is read once per opened dialog
    log("done", { case: "suggest-pick" });
  });

  it("PAR-META-18: in the album dialog a pick fills title, album artist, year and the cover; Undo takes the cover back too", async () => {
    log("start", { case: "suggest-album" });
    fake.editValues = { kind: "album", edit: { title: "meteroa", albumArtist: "Pinkin Park", year: null, genre: "Nu metal" } };
    fake.suggestAnswer = {
      results: [
        { kind: "album", artist: { id: "mb-lp", name: "Linkin Park" }, album: { id: "rg-meteora-20", title: "Meteora 20th Anniversary Edition", year: 2023, kind: "studio", trackNumber: null, disc: null }, song: null, fits: { title: false, artist: true, album: true } },
      ],
    };
    await act(async () => manage!.edit({ kind: "album", id: "al-live", title: "meteroa", coverKey: null }));
    await flush();
    await type("title", "meteora 20");
    await pause();
    await flush();
    log("list", { fits: rows("manage-suggest-fits"), only: rows("manage-suggest-only") });
    expect(fake.suggestAsked).toEqual([{ field: "album", text: "meteora 20", artist: "Pinkin Park" }]);
    expect(texts()).toContain(SHELL_EN["manage.suggestFitsAlbum"]);
    const dots = byTestId("manage-suggest-dots")[0];
    expect(dots.findAll((node) => typeof node.type === "string" && node.props.style !== undefined && node.props.testID === undefined).length).toBe(2); // artist and album only
    await pick("Meteora 20th Anniversary Edition");
    expect(fake.coversAsked).toEqual(["rg-meteora-20"]);
    expect(one("manage-field-title").props.value).toBe("Meteora 20th Anniversary Edition");
    expect(one("manage-field-artist").props.value).toBe("Linkin Park");
    expect(one("manage-field-year").props.value).toBe("2023");
    expect(one("manage-field-genre").props.value).toBe("Nu metal");
    one("manage-cover-preview");
    one("manage-restore-cover");
    await press("manage-suggest-undo");
    expect(one("manage-field-title").props.value).toBe("meteora 20");
    expect(one("manage-field-artist").props.value).toBe("Pinkin Park");
    expect(byTestId("manage-cover-preview")).toHaveLength(0);
    expect(fake.calls.filter((call) => call.startsWith("save"))).toEqual([]);
    log("done", { case: "suggest-album", covers: fake.coversAsked });
  });

  it("PAR-META-18 / PAR-META-20: a failed ask says why in one line and the library's results stay; clearing the field closes the list", async () => {
    log("start", { case: "suggest-failed" });
    fake.editValues = numbAsTagged;
    fake.suggestAnswer = new Error("music lookups are not configured");
    await act(async () => manage!.edit(NUMB));
    await flush();
    await type("album", "mete");
    await flush();
    expect(byTestId("manage-suggest-failed")).toHaveLength(0); // not before the answer
    await pause();
    await flush();
    const failed = one("manage-suggest-failed");
    log("failed", { note: failed.props.children, fits: rows("manage-suggest-fits") });
    expect(failed.props.children).toBe("Could not look it up: music lookups are not configured");
    expect(failed.props.accessibilityRole).toBe("alert");
    expect(byTestId("manage-suggest-asking")).toHaveLength(0);
    expect(rows("manage-suggest-fits")[0]).toBe(`Meteora | ${SHELL_EN["manage.suggestInLibrary"]} | Linkin Park · 2003 · “Numb” is track 13`);
    await type("album", "");
    await flush();
    expect(byTestId("manage-suggest")).toHaveLength(0);
    expect(one("manage-field-album").props.value).toBe("");
    expect(fake.calls.filter((call) => call.startsWith("save"))).toEqual([]);
    log("done", { case: "suggest-failed" });
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
