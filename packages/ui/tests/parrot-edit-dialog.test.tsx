// @vitest-environment jsdom
/**
 * @test-id UI-PARROT-EDIT-DIALOG-001
 * @level component (jsdom; the real ranking from @space/parrot-core over an in-memory library and a canned lookup)
 * @why PAR-META-18, PAR-META-20, PAR-LYR-05: the edit panel's fields autocomplete together (draft B2, issue #3273):
 *   typing "mete" in Album with "Pinkin Park" / "Numb" lists Meteora by Linkin Park under "Fits this song" with three
 *   lit dots, the library's results at once and tagged "in your library", the lookup's after a short pause with
 *   "Still asking…" (never "nothing found") meanwhile and one honest line when the lookup fails. ↓/Enter pick, Esc
 *   closes the list changing nothing; a pick fills every field it knows, strikes the old values with ↺, and says
 *   where it came from with Undo; an album pick also takes its cover. The Lyrics section shimmers while the words are
 *   on their way, shows the first lines once found, and says "No lyrics found" with "Search again" only after a
 *   lookup came back empty. A cover whose picture is still loading shimmers; the drawn picture means "no cover" only.
 *   A new album picture can be framed (PAR-META-22): the square moves, and Save sends that framing with the picture.
 * @req PAR-LYR-05[parrot]
 * @req PAR-META-18[parrot]
 * @req PAR-META-20[parrot]
 * @req PAR-META-22[parrot]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { parrotLibrarySuggestions, parrotLookupSuggestions, type ParrotEditFields, type ParrotSuggestLibrary } from "@space/parrot-core";
import type { MusicSuggestion } from "@space/shared/api";
import {
  ParrotEditMetadataDialog,
  type ParrotCoverInput,
  type ParrotEditLyrics,
  type ParrotEditLyricsLabels,
  type ParrotEditSuggest,
  type ParrotEditSuggestLabels,
} from "../src/parrot/manage";
import { ParrotCover } from "../src/parrot/components";

const T = "[ui-parrot-edit-dialog]";
const labels = {
  title: "Edit song",
  cancel: "Cancel",
  submit: "Save",
  changed: "Changed",
  field: { title: "Title", artist: "Artist", album: "Album", albumArtist: "Album artist", number: "Track", disc: "Disc", year: "Year", genre: "Genre", cover: "Cover" },
  coverHint: "Drop a picture",
  coverPick: "Choose…",
  coverFrame: "Frame the cover…",
  frame: {
    title: "Frame the cover",
    hint: "Drag the square",
    preview: "On the album",
    size: ({ width, height, side }: { width: number; height: number; side: number }) => `Picture ${width} × ${height}, kept ${side} × ${side}`,
    centre: "Back to the centre",
    cancel: "Cancel",
    use: "Use this framing",
  },
};
const lyricsLabels: ParrotEditLyricsLabels = {
  lyrics: "Lyrics",
  lyricsSearching: "Looking for lyrics…",
  lyricsNone: "No lyrics found",
  lyricsSearchAgain: "Search again",
  lyricsFailed: (reason) => `Couldn't look for lyrics: ${reason}`,
  albumLyrics: (found, count) => `${found} of ${count} songs have lyrics`,
  albumLyricsSearch: "Look for the missing ones",
  lyricsAdd: "Add lyrics",
  lyricsEdit: "Edit lyrics",
};
const suggestLabels: ParrotEditSuggestLabels = {
  fits: "Fits this song",
  fitsAlbum: "Fits this album",
  only: (text) => `Only “${text}”`,
  inLibrary: "in your library",
  stillAsking: "Still asking…",
  trackOn: (title, number) => `“${title}” is track ${number}`,
  filledFrom: (name) => `Filled in from ${name}. Check it, then save.`,
  undo: "Undo",
  restore: (value) => `Put back ${value}`,
  dots: (fields) => `Fits: ${fields}`,
  failed: (reason) => `Could not look it up: ${reason}`,
};
const FABLE = { title: "Fable", artist: "Linnet Park", album: "Meltway", number: 7, disc: 1, year: 2003, genre: "Nu metal" };
// The example Chris gave (issue #3273): artist typed with a typo, title right, the album wrong.
const NUMB: ParrotEditFields = { title: "Numb", artist: "Pinkin Park", album: "Live in Texas", number: 1, disc: 1, year: 2003, genre: "Nu metal" };

// The library has Meteor Shower (matches "mete" only), not the right album: Meteora comes from the lookup.
const library: ParrotSuggestLibrary = {
  artists: [{ id: "ar-bonobo", name: "Bonobo" }],
  albums: [{ id: "al-shower", title: "Meteor Shower", artist: "Bonobo", year: 2011, kind: "Album", musicId: null }],
  tracks: [{ id: "t-kiara", title: "Kiara", artist: "Bonobo", albumId: "al-shower", album: "Meteor Shower", number: 2, disc: 1, year: null }],
};
const METEORA_SONG: MusicSuggestion = {
  kind: "song",
  artist: { id: "mb-lp", name: "Linkin Park" },
  album: { id: "rg-meteora", title: "Meteora", year: 2003, kind: "Album", trackNumber: 13, disc: 1 },
  song: { id: "rec-numb", title: "Numb", durationMs: 185000 },
  fits: { title: true, artist: true, album: true },
};
const METEORA_ALBUM: MusicSuggestion = { ...METEORA_SONG, kind: "album", album: { ...METEORA_SONG.album!, trackNumber: null, disc: null }, song: null, fits: { title: false, artist: true, album: true } };

/** Lets `ms` pass: on the fake clock when the suite runs on one, else for real. */
const wait = (ms: number) => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(ms) : new Promise((r) => setTimeout(r, ms)));

/** A suggest whose lookup answers only when the test says so. */
const fakeSuggest = (answer: MusicSuggestion[] | Error) => {
  const pending: Array<() => void> = [];
  const asked: string[] = [];
  const cover = vi.fn(async (coverId: string): Promise<ParrotCoverInput | null> => ({ kind: "file", bytes: new Uint8Array([1, 2, 3]), mime: `image/test-${coverId}` }));
  const suggest: ParrotEditSuggest = {
    library: (query) => parrotLibrarySuggestions(library, query),
    lookup: (query) => {
      asked.push(`${query.field}:${query.text}`);
      const { promise, resolve, reject } = Promise.withResolvers<ReturnType<typeof parrotLookupSuggestions>>();
      pending.push(() => (answer instanceof Error ? reject(answer) : resolve(parrotLookupSuggestions(answer, query))));
      return promise;
    },
    cover,
  };
  const answerAll = async () => {
    await act(async () => {
      for (const go of pending.splice(0)) go();
      await wait(0);
    });
  };
  return { suggest, asked, cover, answerAll };
};

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

const open = async (props: {
  lyrics?: ParrotEditLyrics;
  suggest?: ParrotEditSuggest;
  kind?: "track" | "album";
  initial?: ParrotEditFields;
  onSubmit?: (fields: ParrotEditFields, cover: ParrotCoverInput | null) => void;
  onOpenChange?: (open: boolean) => void;
  initialCover?: ParrotCoverInput;
}) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const initial = props.initial ?? FABLE;
  await act(async () =>
    root!.render(
      <ParrotEditMetadataDialog
        open
        onOpenChange={props.onOpenChange ?? (() => {})}
        kind={props.kind ?? "track"}
        initial={initial}
        current={initial}
        labels={labels}
        suggest={props.suggest}
        suggestLabels={props.suggest ? suggestLabels : undefined}
        lyrics={props.lyrics}
        lyricsLabels={lyricsLabels}
        onSubmit={props.onSubmit ?? (() => {})}
        initialCover={props.initialCover}
      />
    )
  );
  return (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
};
const all = (testId: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const input = (key: string) => document.body.querySelector<HTMLInputElement>(`[data-testid="manage-field-${key}"]`)!;

/** Types into a controlled React input the way a user does (the native setter, then an input event). */
const type = async (key: string, text: string) => {
  const el = input(key);
  await act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const key = async (field: string, name: string) => {
  await act(async () => {
    input(field).dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
};
/** Past the pause after the last keystroke, so the lookup is asked. */
const pause = () => act(async () => void (await wait(300)));

describe("[parrot] edit panel: connected autocomplete (PAR-META-18)", () => {
  // The lookup waits for a pause after the last keystroke (a real setTimeout). On the fake clock a slow runner can
  // never let that pause pass between a keystroke and the check that nothing was asked yet.
  beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => void vi.useRealTimers());
  it("@req PAR-META-18 typing mete in Album: library at once, Still asking…, then Meteora fits all three fields", async () => {
    const fake = fakeSuggest([METEORA_SONG, METEORA_ALBUM]);
    const get = await open({ suggest: fake.suggest, initial: NUMB });
    await type("album", "mete");
    // The library's answer is there before any lookup: Meteor Shower, matching only the typed text.
    expect(get("manage-suggest-list")?.dataset.lookup).toBe("asking");
    expect(input("album").getAttribute("aria-expanded")).toBe("true");
    expect(get("manage-suggest-asking")?.textContent).toContain("Still asking…");
    expect(document.body.textContent).not.toMatch(/not found|nothing/i);
    expect(get("manage-suggest-only")?.textContent).toContain("Only “mete”");
    expect(all("manage-suggest-option").map((o) => [o.dataset.scope, o.dataset.inLibrary, o.querySelector('[data-testid="manage-suggest-name"]')?.textContent])).toEqual([
      ["field", "true", "Meteor Showerin your library"],
    ]);
    expect(fake.asked).toEqual([]);
    await pause();
    expect(fake.asked).toEqual(["album:mete"]);
    await fake.answerAll();
    console.info(T, "list", get("manage-suggest-list")?.outerHTML);
    expect(get("manage-suggest-list")?.dataset.lookup).toBe("done");
    expect(get("manage-suggest-asking")).toBeNull();
    expect(get("manage-suggest-fits")?.textContent).toContain("Fits this song");
    const first = all("manage-suggest-option")[0]!;
    expect(first.dataset.scope).toBe("all");
    expect(first.dataset.inLibrary).toBe("false");
    expect(first.querySelector('[data-testid="manage-suggest-name"]')?.textContent).toBe("Meteora");
    expect(first.querySelector("mark")?.textContent).toBe("Mete");
    expect(first.querySelector('[data-testid="manage-suggest-details"]')?.textContent).toBe("Linkin Park · 2003 · “Numb” is track 13");
    expect(first.querySelector<HTMLElement>('[data-testid="manage-suggest-dots"]')?.dataset.fits).toBe("111");
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(input("album").getAttribute("aria-activedescendant")).toBe(first.id);
    // The library's result stays, still in its own section.
    expect(all("manage-suggest-option").some((o) => o.dataset.scope === "field" && o.dataset.inLibrary === "true")).toBe(true);
  });

  it("@req PAR-META-18 Enter picks: every field it knows is filled, old values struck with ↺, Undo, and Save sends them", async () => {
    const fake = fakeSuggest([METEORA_SONG]);
    const onSubmit = vi.fn();
    const get = await open({ suggest: fake.suggest, initial: NUMB, onSubmit });
    await type("album", "mete");
    await pause();
    await fake.answerAll();
    await key("album", "Enter");
    expect(get("manage-suggest-list")).toBeNull();
    expect([input("title").value, input("artist").value, input("album").value, input("number").value, input("disc").value, input("year").value, input("genre").value]).toEqual([
      "Numb",
      "Linkin Park",
      "Meteora",
      "13",
      "1",
      "2003",
      "Nu metal",
    ]);
    expect(get("manage-suggest-filled")?.textContent).toContain("Filled in from Meteora. Check it, then save.");
    expect(get("manage-was-artist")?.textContent).toBe("Pinkin Park");
    expect(get("manage-was-album")?.textContent).toBe("Live in Texas");
    expect(get("manage-was-number")?.textContent).toBe("1");
    expect(get("manage-was-title")).toBeNull();
    expect(get("manage-changed-artist")).not.toBeNull();
    // ↺ puts one field back.
    await act(async () => get("manage-restore-number")!.click());
    expect(input("number").value).toBe("1");
    expect(input("artist").value).toBe("Linkin Park");
    expect(get("manage-was-number")).toBeNull();
    // Undo puts every field back as it was before the pick.
    await act(async () => get("manage-suggest-undo")!.click());
    expect([input("artist").value, input("album").value, input("number").value]).toEqual(["Pinkin Park", "Live in Texas", "1"]);
    expect(get("manage-suggest-filled")).toBeNull();
    expect(get("manage-was-artist")).toBeNull();
    // Pick again with ↓ from a closed list, then Save.
    await type("album", "mete");
    await pause();
    await fake.answerAll();
    await key("album", "Enter");
    await act(async () => get("manage-edit-submit")!.click());
    console.info(T, "saved", JSON.stringify(onSubmit.mock.calls[0]));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ title: "Numb", artist: "Linkin Park", album: "Meteora", number: 13, disc: 1, year: 2003, genre: "Nu metal" });
  });

  it("@req PAR-META-18 ↓/↑ move through the options; Esc closes the list changing nothing, the next Esc closes the dialog", async () => {
    const fake = fakeSuggest([METEORA_SONG, METEORA_ALBUM]);
    const onOpenChange = vi.fn();
    const get = await open({ suggest: fake.suggest, initial: NUMB, onOpenChange });
    await type("album", "mete");
    await pause();
    await fake.answerAll();
    const count = all("manage-suggest-option").length;
    expect(count).toBeGreaterThan(1);
    await key("album", "ArrowDown");
    expect(all("manage-suggest-option")[1]!.getAttribute("aria-selected")).toBe("true");
    await key("album", "ArrowUp");
    await key("album", "ArrowUp");
    expect(all("manage-suggest-option")[count - 1]!.getAttribute("aria-selected")).toBe("true");
    await key("album", "Escape");
    expect(get("manage-suggest-list")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect([input("artist").value, input("album").value, input("number").value]).toEqual(["Pinkin Park", "mete", "1"]);
    expect(get("manage-suggest-filled")).toBeNull();
    // ↓ on a closed list opens it again.
    await key("album", "ArrowDown");
    expect(get("manage-suggest-list")).not.toBeNull();
    await key("album", "Escape");
    await key("album", "Escape");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("@req PAR-META-20 a failing lookup says why in one line and keeps the library's results", async () => {
    const fake = fakeSuggest(new Error("metadata lookup is not configured (501)"));
    const get = await open({ suggest: fake.suggest, initial: NUMB });
    await type("album", "mete");
    await pause();
    await fake.answerAll();
    console.info(T, "failed", get("manage-suggest-list")?.outerHTML);
    expect(get("manage-suggest-list")?.dataset.lookup).toBe("failed");
    expect(get("manage-suggest-failed")?.textContent).toBe("Could not look it up: metadata lookup is not configured (501)");
    expect(get("manage-suggest-asking")).toBeNull();
    expect(all("manage-suggest-option").map((o) => o.dataset.inLibrary)).toEqual(["true"]);
  });

  it("@req PAR-META-18 an answer to an older keystroke is dropped", async () => {
    const fake = fakeSuggest([METEORA_SONG]);
    const get = await open({ suggest: fake.suggest, initial: NUMB });
    await type("album", "mete");
    await pause();
    await type("album", "meteo");
    await fake.answerAll();
    expect(get("manage-suggest-list")?.dataset.lookup).toBe("asking");
    expect(all("manage-suggest-option").every((o) => o.dataset.inLibrary === "true")).toBe(true);
  });

  it("@req PAR-META-18 album dialog: two dots (album, album artist), Fits this album, and a pick takes the cover", async () => {
    const fake = fakeSuggest([METEORA_ALBUM]);
    const get = await open({ suggest: fake.suggest, kind: "album", initial: { title: "Live in Texas", artist: "Pinkin Park", year: null, genre: null } });
    expect(input("album")).toBeNull();
    await type("title", "mete");
    await pause();
    await fake.answerAll();
    expect(get("manage-suggest-fits")?.textContent).toContain("Fits this album");
    const first = all("manage-suggest-option")[0]!;
    expect(first.querySelector('[data-testid="manage-suggest-name"]')?.textContent).toBe("Meteora");
    expect(first.querySelector<HTMLElement>('[data-testid="manage-suggest-dots"]')?.dataset.fits).toBe("11");
    expect(get("manage-changed-cover")).toBeNull();
    await act(async () => first.click());
    await act(async () => void (await wait(0)));
    expect([input("title").value, input("artist").value, input("year").value]).toEqual(["Meteora", "Linkin Park", "2003"]);
    expect(fake.cover).toHaveBeenCalledWith("rg-meteora");
    expect(get("manage-changed-cover")).not.toBeNull();
    // Undo takes the cover back too.
    await act(async () => get("manage-suggest-undo")!.click());
    expect(get("manage-changed-cover")).toBeNull();
    expect(input("title").value).toBe("Live in Texas");
  });

  it("@req PAR-META-18 without suggest the fields are plain inputs", async () => {
    await open({});
    expect(input("album").getAttribute("role")).toBeNull();
    await type("album", "mete");
    expect(document.body.querySelector('[data-testid="manage-suggest-list"]')).toBeNull();
  });
});

describe("[parrot] edit panel lyrics", () => {
  it("lyrics loading shimmer, never 'No lyrics found' or Search again while it runs", async () => {
    const get = await open({ lyrics: { kind: "track", state: { status: "loading" }, onSearchAgain: () => {} } });
    console.info(T, "loading", get("manage-lyrics")?.outerHTML);
    expect(get("manage-lyrics")?.dataset.state).toBe("loading");
    expect(get("manage-lyrics-loading")).not.toBeNull();
    expect(get("manage-lyrics-none")).toBeNull();
    expect(get("manage-lyrics-search")).toBeNull();
  });

  it("found lyrics show their first lines", async () => {
    const get = await open({ lyrics: { kind: "track", state: { status: "found", synced: true, preview: ["I am a lantern in the fog", "A pocket full of pebbles"] }, onSearchAgain: () => {} } });
    expect(get("manage-lyrics-found")?.dataset.synced).toBe("true");
    expect(get("manage-lyrics-found")?.textContent).toContain("I am a lantern in the fog");
    expect(get("manage-lyrics-search")).toBeNull();
  });

  it("none says No lyrics found with Search again; failed says why with Search again", async () => {
    const onSearchAgain = vi.fn();
    let get = await open({ lyrics: { kind: "track", state: { status: "none" }, onSearchAgain } });
    console.info(T, "none", get("manage-lyrics")?.outerHTML);
    expect(get("manage-lyrics-none")?.textContent).toContain("No lyrics found");
    await act(async () => get("manage-lyrics-search")!.click());
    expect(onSearchAgain).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    get = await open({ lyrics: { kind: "track", state: { status: "failed", reason: "offline" }, onSearchAgain } });
    expect(get("manage-lyrics-failed")?.textContent).toContain("Couldn't look for lyrics: offline");
    expect(get("manage-lyrics-search")?.textContent).toContain("Search again");
  });

  it("an album counts its songs with words and offers to look for the missing ones", async () => {
    const onSearchMissing = vi.fn();
    let get = await open({ kind: "album", lyrics: { kind: "album", state: { status: "counted", found: 9, count: 12, missing: 3 }, onSearchMissing } });
    const counted = get("manage-lyrics-counted");
    console.info(T, "album", counted?.outerHTML);
    expect(counted?.dataset.found).toBe("9");
    expect(counted?.dataset.count).toBe("12");
    expect(counted?.textContent).toContain("9 of 12 songs have lyrics");
    await act(async () => get("manage-lyrics-search")!.click());
    expect(onSearchMissing).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    get = await open({ kind: "album", lyrics: { kind: "album", state: { status: "counted", found: 12, count: 12, missing: 0 }, onSearchMissing } });
    expect(get("manage-lyrics-search")).toBeNull();
  });

  it("@req PAR-LYR-10 a song offers Add lyrics when it has none and Edit lyrics when it has some, never while loading", async () => {
    const onEditOwn = vi.fn();
    let get = await open({ lyrics: { kind: "track", state: { status: "none" }, onSearchAgain: () => {}, onEditOwn } });
    console.info(T, "own lyrics: none", get("manage-lyrics-edit")?.textContent);
    expect(get("manage-lyrics-edit")?.textContent).toContain("Add lyrics");
    await act(async () => get("manage-lyrics-edit")!.click());
    expect(onEditOwn).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    get = await open({ lyrics: { kind: "track", state: { status: "found", synced: false, preview: ["Words"] }, onSearchAgain: () => {}, onEditOwn } });
    expect(get("manage-lyrics-edit")?.textContent).toContain("Edit lyrics");
    await act(async () => root!.unmount());
    get = await open({ lyrics: { kind: "track", state: { status: "loading" }, onSearchAgain: () => {}, onEditOwn } });
    expect(get("manage-lyrics-edit")).toBeNull();
  });
});

describe("[parrot] cover loading is not 'no cover'", () => {
  it("drawn only with no cover; loading and fetching shimmer", () => {
    const drawn = renderToStaticMarkup(<ParrotCover seed="al-meltway" label="Meltway" />);
    const loading = renderToStaticMarkup(<ParrotCover seed="al-meltway" label="Meltway" src="https://covers.test/meltway.jpg" />);
    const fetching = renderToStaticMarkup(<ParrotCover seed="al-meltway" label="Meltway" fetching />);
    console.info(T, "covers", { drawn, loading, fetching });
    expect(drawn).toContain('data-cover="drawn"');
    expect(drawn).not.toContain("parrot-cover-fetching");
    expect(loading).toContain('data-cover="loading"');
    expect(loading).toContain('data-testid="parrot-cover-fetching"');
    expect(fetching).toContain('data-cover="fetching"');
    expect(fetching).toContain('data-testid="parrot-cover-fetching"');
  });
});

describe("[parrot] edit panel: framing a new cover (PAR-META-22)", () => {
  it("@req PAR-META-22 a new album picture can be framed: the square moves and Save sends that framing", async () => {
    const saved: (ParrotCoverInput | null)[] = [];
    const get = await open({
      kind: "album",
      initial: { title: "Chrome Horizon", artist: "Neon Pulse AI", year: 2025, genre: null },
      initialCover: { kind: "url", url: "https://example.com/wide.jpg" },
      onSubmit: (_fields, cover) => saved.push(cover),
    });
    expect(get("manage-cover-preview")!.dataset.framed).toBeUndefined();
    await act(async () => get("manage-cover-frame")!.click());
    expect(get("manage-frame")).not.toBeNull();
    // jsdom loads no pictures: give the measuring image its size and fire its load.
    const measuring = get("manage-frame")!.querySelector<HTMLImageElement>("img.hidden")!;
    Object.defineProperty(measuring, "naturalWidth", { value: 1600 });
    Object.defineProperty(measuring, "naturalHeight", { value: 900 });
    await act(async () => measuring.dispatchEvent(new Event("load")));
    expect(get("manage-frame-size")!.textContent).toBe("Picture 1600 × 900, kept 900 × 900");
    expect((get("manage-frame-centre") as HTMLButtonElement).disabled).toBe(true);
    // The arrow keys move the square by 2% of the picture's shorter side (18 px here), from the centre (350, 0).
    await act(async () => get("manage-frame-square")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect((get("manage-frame-centre") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => get("manage-frame-use")!.click());
    expect(get("manage-frame")).toBeNull();
    expect(get("manage-cover-preview")!.dataset.framed).toBe("true");
    await act(async () => get("manage-edit-submit")!.click());
    console.info(T, "saved cover", JSON.stringify(saved));
    expect(saved).toEqual([{ kind: "url", url: "https://example.com/wide.jpg", crop: { left: 332 / 1600, top: 0, size: 1 } }]);
  });

  it("@req PAR-META-22 the frame button shows only for a new picture, not the album's current cover", async () => {
    const get = await open({ kind: "album", initial: { title: "Chrome Horizon", artist: "Neon Pulse AI", year: 2025, genre: null } });
    expect(get("manage-cover-pick")).not.toBeNull();
    expect(get("manage-cover-frame")).toBeNull();
  });
});
