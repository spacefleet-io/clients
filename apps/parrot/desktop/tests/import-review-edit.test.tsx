// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-IMPORT-EDIT-001
 * @level integration (real ImportReview dialog, real translator and matching helpers; `window.parrot` mocked)
 * @why Walk 2026-11-12: the import dropped what the review showed (a looked-up cover not applied, a compilation's
 *   songs landing under "Various Artists"). v3 (Chris 2026-11-21): albums show at once from the files' tags, each looks
 *   itself up on its own and can be imported as is; names, numbers and the cover are changed in place. The review
 *   must hand the import exactly what it showed.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicAlbum } from "@space/shared/api";
import ImportReview, { parrotFileAlbums, parrotImportSlots } from "../src/renderer/src/ImportReview";
import { translator } from "../src/renderer/src/i18n";
import type { ParrotImportAlbumMatch, ParrotImportMatchedAlbum, ParrotImportPicture, ParrotImportScan, ParrotImportSelection, ParrotScanEntry } from "../src/shared/ipc";
import type { ParrotImportUnidentifiedFile } from "@space/parrot-core";

const SUITE = "[parrot-import-edit]";
const LINNET_PARK = { id: "5e1c0a2d-4b7f-4c3a-9d21-7a6b3c9e0f15", name: "Linnet Park" };
const VARIOUS = { id: "89ad4ac3-39f7-470e-963a-56509c546377", name: "Various Artists" };
const COVER = "data:image/jpeg;base64,/9j/";

const album = (id: string, title: string, year: number, artist: MusicAlbum["artist"], titles: string[]): MusicAlbum => ({
  id,
  title,
  year,
  kind: "Album",
  artist,
  tracks: titles.map((name, index) => ({ disc: 1, number: index + 1, title: name, durationMs: 180_000, id: `${id.slice(0, 30)}${String(index).padStart(6, "0")}` })),
});
const hollowSignal = album("2a0981fb-9593-3019-864b-ce934d97a16e", "Hollow Signal", 2000, LINNET_PARK, ["Paperboat", "One Step Farther", "Near You"]);
const minutes = album("1f7a1ae9-8d3a-3d2b-9a8f-cb5c7b6c7b6c", "Minutes to Daybreak", 2007, LINNET_PARK, ["Woken", "Given Way", "Leave Out All the Salt", "Bend It Out", "Shadow of the Pier", "What I've Kept"]);
const clockworkers = album("3c5e5f3b-4a5d-3c2e-9f1a-0b1c2d3e4f50", "Clockworkers: The Album", 2007, VARIOUS, ["What I've Kept", "Before the Lights Go"]);
const meltway = album("5c4c7b54-4a25-3d18-b1f1-7d3a9f8b4f0b", "Meltway", 2003, LINNET_PARK, ["Forecast", "Don't Linger", "Somewhere I Wander", "Hiding From You", "Hit the Gravel", "Easier to Swim", "Fable"]);

const entry = (file: string, patch: Partial<ParrotScanEntry>): ParrotScanEntry => ({
  file,
  size: 1_000_000,
  artist: "Unknown artist",
  album: "Unknown album",
  title: file,
  disc: 1,
  number: 0,
  durationMs: 180_000,
  ...patch,
});
const scanOf = (entries: ParrotScanEntry[]): ParrotImportScan => ({
  folders: ["/music"],
  entries,
  albums: parrotFileAlbums(entries).length,
  artists: 1,
  totalBytes: entries.length * 1_000_000,
  unreadable: [],
});
/** A lookup that answers each album with the found albums and unplaced files among its own files. */
const lookupOf =
  (found: ParrotImportMatchedAlbum[], unidentified: ParrotImportUnidentifiedFile[] = []) =>
  (files: string[]): ParrotImportAlbumMatch => ({
    kind: "found",
    albums: found.flatMap((match) => {
      const mine = match.files.filter((placed) => files.includes(placed.file));
      return mine.length ? [{ ...match, files: mine }] : [];
    }),
    unidentified: unidentified.filter((file) => files.includes(file.file)),
  });

describe("Parrot desktop import review: what the import stores", () => {
  let container: HTMLDivElement;
  let root: Root;
  let confirmed: ParrotImportSelection = [];

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      }
    });
  };
  const byTestId = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
  const click = async (element: Element | undefined | null) => {
    expect(element).toBeTruthy();
    await act(async () => (element as HTMLElement).click());
    await flush();
  };
  const typeInto = async (input: HTMLElement | undefined, value: string) => {
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const albumRow = (title: string) => byTestId("import-review-album").find((row) => row.dataset.album === title);

  const show = async (
    scan: ParrotImportScan,
    lookup: (files: string[]) => ParrotImportAlbumMatch | Promise<ParrotImportAlbumMatch>,
    options: { importCover?: (id: string) => Promise<string | null>; pictures?: (files: string[]) => ParrotImportPicture[] } = {},
  ) => {
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        importCover: vi.fn(options.importCover ?? (async () => null)),
        matchImportAlbum: vi.fn(async ({ files }: { id: string; files: string[] }) => lookup(files)),
        stopImportAlbumMatch: vi.fn(async () => undefined),
        importAlbumPictures: vi.fn(async (files: string[]) => options.pictures?.(files) ?? []),
        pickImportCoverImage: vi.fn(async () => null),
        importArtistPhoto: vi.fn(async () => ({ photo: null, credit: null })),
        searchImportAlbums: vi.fn(async () => ({ kind: "found", results: [] })),
        cancelImport: vi.fn(async () => undefined),
        confirmImport: vi.fn(async (selection: ParrotImportSelection) => {
          confirmed = selection;
          return undefined;
        }),
      },
    });
    await act(async () => root.render(<ImportReview t={translator("en")} language="en" scan={scan} onDone={() => undefined} />));
    await flush();
  };
  const confirmImport = async () => {
    await click(byTestId("import-review-confirm")[0]);
    console.info(SUITE, "confirmed", JSON.stringify(confirmed.map(({ tracklist: _tracklist, ...item }) => item)));
    return confirmed;
  };

  beforeEach(() => {
    confirmed = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req PAR-META-04
  // @req PAR-UP-08
  it("hands the import the matched album's cover and release album artist, never a 'Various Artists' tag of a non-compilation", async () => {
    const paperboat = entry("/music/Hollow Signal/01 Paperboat.mp3", { artist: "Linnet Park", album: "Hollow Signal", title: "Paperboat", number: 1 });
    const whatIveDone = entry("/music/Clockworkers/01 What I've Kept.mp3", { artist: "Linnet Park", album: "Clockworkers: The Album", title: "What I've Kept", number: 1 });
    const beforeTheLightsGo = entry("/music/Clockworkers/02 Before the Lights Go.mp3", { artist: "Tin Tin Kites", album: "Clockworkers: The Album", title: "Before the Lights Go", number: 2 });
    await show(
      scanOf([paperboat, whatIveDone, beforeTheLightsGo]),
      lookupOf([
        { album: hollowSignal, cover: COVER, tracklistKnown: true, files: [{ file: paperboat.file, disc: 1, number: 1, sure: true }] },
        { album: minutes, cover: null, tracklistKnown: true, files: [{ file: whatIveDone.file, disc: 1, number: 6, sure: true }] },
        { album: clockworkers, cover: COVER, tracklistKnown: true, files: [{ file: beforeTheLightsGo.file, disc: 1, number: 2, sure: true }] },
      ]),
    );
    // Every album answered: each card says where its names come from, all from our music library here.
    expect(byTestId("import-review-album").map((row) => row.dataset.state)).toEqual(["matched", "matched", "matched"]);
    const selection = new Map((await confirmImport()).map((item) => [item.file, item]));
    expect(selection.get(paperboat.file)).toMatchObject({ album: "Hollow Signal", albumArtist: "Linnet Park", albumArtistMusicId: LINNET_PARK.id, coverId: hollowSignal.id });
    expect(selection.get(whatIveDone.file)).toMatchObject({ artist: "Linnet Park", album: "Minutes to Daybreak", albumArtist: "Linnet Park", number: 6 });
    expect(selection.get(whatIveDone.file)?.coverId).toBeUndefined();
    // A real various-artists compilation keeps "Various Artists" as album artist, and each song its own artist.
    expect(selection.get(beforeTheLightsGo.file)).toMatchObject({ artist: "Tin Tin Kites", albumArtist: "Various Artists", albumArtistMusicId: VARIOUS.id, coverId: clockworkers.id });
    for (const item of selection.values()) expect(item.unidentified).toBeUndefined();
  });

  // @req PAR-UP-08
  it("shows every album at once from its tags; each looks itself up on its own and Import waits for all of them", async () => {
    const paperboat = entry("/music/Hollow Signal/01 Paperboat.mp3", { artist: "Linnet Park", album: "Hollow Signal", title: "Paperboat", number: 1 });
    const fable = entry("/music/Meltway/07 Fable.mp3", { artist: "Linnet Park", album: "Meltway", title: "Fable", number: 7, year: 2003 });
    const stray = entry("/music/Stray/01 Stray Tone.mp3", { artist: "Nobody Known", album: "Stray Tapes", title: "Stray Tone", number: 1 });
    const answers = new Map<string, PromiseWithResolvers<ParrotImportAlbumMatch>>([paperboat, fable, stray].map((song) => [song.file, Promise.withResolvers()]));
    await show(scanOf([paperboat, fable, stray]), (files) => answers.get(files[0]!)!.promise);
    console.info(SUITE, "while looking", byTestId("import-review-album").map((row) => `${row.dataset.album}:${row.dataset.state}`));
    // The tags' albums show at once, each looking up; Import is off and says why.
    expect(byTestId("import-review-album").map((row) => [row.dataset.album, row.dataset.state])).toEqual([
      ["Hollow Signal", "searching"],
      ["Meltway", "searching"],
      ["Stray Tapes", "searching"],
    ]);
    expect(byTestId("import-album-looking")).toHaveLength(3);
    expect(byTestId("import-review-confirm")[0]).toHaveProperty("disabled", true);
    expect(byTestId("import-review-still-looking")[0]?.textContent).toContain("3 albums still looking up");

    // One album answers: only its card changes.
    await act(async () => answers.get(paperboat.file)!.resolve(lookupOf([{ album: hollowSignal, cover: COVER, tracklistKnown: true, files: [{ file: paperboat.file, disc: 1, number: 1, sure: true }] }])([paperboat.file])));
    await flush();
    expect(albumRow("Hollow Signal")?.dataset.state).toBe("matched");
    expect(albumRow("Meltway")?.dataset.state).toBe("searching");

    // "Import as is" on one album stops only that album's lookup.
    await click(albumRow("Meltway")?.querySelector('[data-testid="import-album-as-is"]'));
    expect(window.parrot.stopImportAlbumMatch).toHaveBeenCalledTimes(1);
    expect(albumRow("Meltway")?.dataset.state).toBe("asis");
    expect(albumRow("Meltway")?.querySelector('[data-testid="import-source"]')?.getAttribute("data-source")).toBe("file");
    expect(albumRow("Stray Tapes")?.dataset.state).toBe("searching");
    expect(byTestId("import-review-confirm")[0]).toHaveProperty("disabled", true);
    // The stopped lookup answering late changes nothing.
    await act(async () => answers.get(fable.file)!.resolve({ kind: "stopped" }));
    await flush();
    expect(albumRow("Meltway")?.dataset.state).toBe("asis");

    // An album the lookup finds nothing for goes in as is by itself and never blocks Import.
    await act(async () => answers.get(stray.file)!.resolve({ kind: "found", albums: [], unidentified: [{ file: stray.file, reason: "no-match" }] }));
    await flush();
    expect(albumRow("Stray Tapes")?.dataset.state).toBe("notfound");
    expect(byTestId("import-review-still-looking")).toHaveLength(0);
    expect(byTestId("import-review-confirm")[0]).toHaveProperty("disabled", false);

    const selection = new Map((await confirmImport()).map((item) => [item.file, item]));
    expect(selection.get(paperboat.file)).toMatchObject({ album: "Hollow Signal", coverId: hollowSignal.id });
    // "Import as is" is the user's choice: kept from the tags, not marked to identify later.
    expect(selection.get(fable.file)).toMatchObject({ title: "Fable", artist: "Linnet Park", album: "Meltway", number: 7, disc: 1 });
    expect(selection.get(fable.file)?.unidentified).toBeUndefined();
    // Found nowhere: kept from the tags, marked so Parrot tries again later.
    expect(selection.get(stray.file)).toMatchObject({ title: "Stray Tone", album: "Stray Tapes", unidentified: true });
  });

  // @req PAR-UP-08
  // @req PAR-META-21
  it("an as-is album's names are changed in place: album, artist, year and each song's name", async () => {
    const one = entry("/music/Tape/a.mp3", { artist: "Nobody Known", album: "Tape", title: "First", number: 1 });
    const two = entry("/music/Tape/b.mp3", { artist: "Nobody Known", album: "Tape", title: "Secnod", number: 2 });
    const guest = entry("/music/Tape/c.mp3", { artist: "Guest Singer", albumArtist: "Nobody Known", album: "Tape", title: "Duet", number: 3 });
    await show(scanOf([one, two, guest]), () => ({ kind: "found", albums: [], unidentified: [one, two, guest].map((song) => ({ file: song.file, reason: "no-match" as const })) }));
    expect(byTestId("import-lookup-strip")[0]?.dataset.state).toBe("notfound");
    await typeInto(byTestId("import-field-album")[0], "The Tape");
    await typeInto(byTestId("import-field-artist")[0], "Somebody Known");
    await typeInto(byTestId("import-field-year")[0], "1999");
    await typeInto(byTestId("import-song-title")[1], "Second");
    expect(byTestId("import-song-number").map((cell) => cell.textContent?.trim())).toEqual(["1", "2", "3"]);
    const selection = new Map((await confirmImport()).map((item) => [item.file, item]));
    expect(selection.get(one.file)).toMatchObject({ title: "First", artist: "Somebody Known", albumArtist: "Somebody Known", album: "The Tape", year: 1999, number: 1 });
    expect(selection.get(two.file)).toMatchObject({ title: "Second", album: "The Tape", number: 2 });
    // A guest's own artist stays: the album's artist changes only the songs that carried it.
    expect(selection.get(guest.file)).toMatchObject({ title: "Duet", artist: "Guest Singer", albumArtist: "Somebody Known", number: 3 });
  });

  // @req PAR-META-22
  it("a picture picked from the cover menu goes with the album's songs by its id; the files' own picture asks nothing", async () => {
    const one = entry("/music/Tape/a.mp3", { artist: "Nobody Known", album: "Tape", title: "First", number: 1 });
    const two = entry("/music/Tape/b.mp3", { artist: "Nobody Known", album: "Tape", title: "Second", number: 2 });
    const front: ParrotImportPicture = { id: "picture:front", data: COVER, width: 600, height: 600, files: 2 };
    const back: ParrotImportPicture = { id: "picture:back", data: "data:image/png;base64,iVBOR", width: 1600, height: 900, files: 1 };
    await show(scanOf([one, two]), () => ({ kind: "stopped" }), { pictures: () => [back, front] });
    // The commonest picture shows first; untouched, it is the album's cover already and nothing is sent.
    await click(byTestId("import-cover-button")[0]);
    const choices = byTestId("import-cover-picture");
    console.info(SUITE, "pictures", choices.map((button) => `${button.getAttribute("aria-label")}:${button.getAttribute("aria-checked")}`));
    expect(choices.map((button) => button.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    await click(choices[1]);
    const selection = await confirmImport();
    expect(selection.map((item) => item.coverPicture)).toEqual(["picture:back", "picture:back"]);
    expect(selection.map((item) => item.coverCrop)).toEqual([undefined, undefined]);
  });

  // @req PAR-UP-08
  it("lists the matched albums without waiting for their covers, then draws each cover as it comes (#2509)", async () => {
    const paperboat = entry("/music/Hollow Signal/01 Paperboat.mp3", { artist: "Linnet Park", album: "Hollow Signal", title: "Paperboat", number: 1 });
    const fable = entry("/music/Meltway/07 Fable.mp3", { artist: "Linnet Park", album: "Meltway", title: "Fable", number: 7 });
    const covers = new Map([hollowSignal, meltway].map((found) => [found.id!, Promise.withResolvers<string | null>()]));
    const asked: string[] = [];
    await show(
      scanOf([paperboat, fable]),
      lookupOf([
        { album: meltway, cover: null, tracklistKnown: true, files: [{ file: fable.file, disc: 1, number: 7, sure: true }] },
        { album: hollowSignal, cover: null, tracklistKnown: true, files: [{ file: paperboat.file, disc: 1, number: 1, sure: true }] },
      ]),
      { importCover: (id) => (asked.push(id), covers.get(id)!.promise) },
    );
    const shownCovers = () => [...document.querySelectorAll('[data-testid="import-review-album"] img')].map((img) => img.getAttribute("src"));
    console.info(SUITE, "before covers", asked, byTestId("import-review-album").map((row) => row.dataset.album));
    expect(byTestId("import-review-album").map((row) => row.dataset.state)).toEqual(["matched", "matched"]);
    expect(shownCovers()).toEqual([]);
    expect([...asked].sort()).toEqual([hollowSignal.id, meltway.id].sort());

    await act(async () => covers.get(hollowSignal.id!)!.resolve(COVER));
    await flush();
    console.info(SUITE, "after first cover", shownCovers());
    expect(shownCovers()).toEqual([COVER]);
    await act(async () => covers.get(meltway.id!)!.resolve(null));
    await flush();

    const selection = new Map((await confirmImport()).map((item) => [item.file, item]));
    expect(selection.get(paperboat.file)?.coverId).toBe(hollowSignal.id);
    expect(selection.get(fable.file)?.coverId).toBeUndefined();
  });

  // @req PAR-UP-08
  it("a second album search shows 'Looking up…' while it runs, not the first search's 'No album found'", async () => {
    const paperboat = entry("/music/Hollow Signal/01 Paperboat.mp3", { artist: "Linnet Park", album: "Hollow Signal", title: "Paperboat", number: 1 });
    await show(scanOf([paperboat]), lookupOf([{ album: hollowSignal, cover: COVER, tracklistKnown: true, files: [{ file: paperboat.file, disc: 1, number: 1, sure: true }] }]));
    const submit = () => byTestId("import-match-search-submit")[0];
    await click(submit());
    console.info(SUITE, "first album search answered none", byTestId("import-match-search-none").map((node) => node.textContent));
    expect(byTestId("import-match-search-none")).toHaveLength(1);

    const second = Promise.withResolvers<{ kind: "found"; results: [] }>();
    window.parrot.searchImportAlbums = vi.fn(() => second.promise);
    await click(submit());
    expect(byTestId("import-match-search-none")).toHaveLength(0);
    expect(byTestId("import-match-search-searching")[0]?.textContent).toContain("Looking up…");

    await act(async () => second.resolve({ kind: "found", results: [] }));
    await flush();
    expect(byTestId("import-match-search-searching")).toHaveLength(0);
    expect(byTestId("import-match-search-none")).toHaveLength(1);
  });

  // @req PAR-UP-08
  it("an album search lists its results at once, then asks their covers three at a time and draws each as it comes (#2509)", async () => {
    const paperboat = entry("/music/Hollow Signal/01 Paperboat.mp3", { artist: "Linnet Park", album: "Hollow Signal", title: "Paperboat", number: 1 });
    const results = [meltway, hollowSignal, minutes, clockworkers];
    const covers = new Map(results.map((found) => [found.id!, Promise.withResolvers<string | null>()]));
    const asked: string[] = [];
    await show(scanOf([paperboat]), lookupOf([{ album: hollowSignal, cover: COVER, tracklistKnown: true, files: [{ file: paperboat.file, disc: 1, number: 1, sure: true }] }]), {
      importCover: (id) => (asked.push(id), covers.get(id)!.promise),
    });
    window.parrot.searchImportAlbums = vi.fn(async () => ({ kind: "found" as const, results: results.map((found) => ({ album: found, cover: null })) }));
    await click(byTestId("import-match-search-submit")[0]);
    const resultCovers = () => byTestId("import-match-result").map((row) => row.querySelector("img")?.getAttribute("src") ?? null);
    console.info(SUITE, "search answered", { rows: byTestId("import-match-result").length, asked });
    expect(resultCovers()).toEqual([null, null, null, null]);
    expect(asked).toEqual(results.slice(0, 3).map((found) => found.id));

    await act(async () => covers.get(hollowSignal.id!)!.resolve(COVER));
    await flush();
    expect(resultCovers()).toEqual([null, COVER, null, null]);
    expect(asked).toEqual(results.map((found) => found.id));
  });
});

describe("Parrot desktop import review: albums and numbers from the tags", () => {
  // @req PAR-UP-08
  it("groups songs by album artist (else artist) and album, whatever the case, in the tags' order", () => {
    const albums = parrotFileAlbums([
      entry("/m/b2", { artist: "Linnet Park", album: "Meltway", title: "B", number: 2 }),
      entry("/m/a1", { artist: "linnet park", album: "MELTWAY", title: "A", number: 1 }),
      entry("/m/g", { artist: "Guest", albumArtist: "Linnet Park", album: "Meltway", title: "G", number: 3 }),
      entry("/m/z", { artist: "Aardvark", album: "Zoo", title: "Z", number: 1 }),
    ]);
    expect(albums.map((found) => [found.title, found.files])).toEqual([
      ["Zoo", ["/m/z"]],
      ["Meltway", ["/m/a1", "/m/b2", "/m/g"]],
    ]);
  });

  // @req PAR-UP-08
  it("numbers follow the order: the tags' slots when they are distinct, else 1..n", () => {
    // Dragged order (3, 1, 5): the slots stay 1, 3, 5, handed out in the new order.
    expect(parrotImportSlots([{ disc: 1, number: 3 }, { disc: 1, number: 1 }, { disc: 1, number: 5 }])).toEqual([
      { disc: 1, number: 1 },
      { disc: 1, number: 3 },
      { disc: 1, number: 5 },
    ]);
    expect(parrotImportSlots([{ disc: 1, number: 0 }, { disc: 1, number: 2 }])).toEqual([
      { disc: 1, number: 1 },
      { disc: 1, number: 2 },
    ]);
    expect(parrotImportSlots([{ disc: 1, number: 4 }, { disc: 1, number: 4 }, { disc: 1, number: 1 }])).toEqual([
      { disc: 1, number: 1 },
      { disc: 1, number: 2 },
      { disc: 1, number: 3 },
    ]);
  });
});
