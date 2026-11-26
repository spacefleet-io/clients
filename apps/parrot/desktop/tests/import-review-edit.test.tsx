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

  // @req PAR-META-23
  it("proposes the clean-ups of a file album's names, imports the cleaned names, and each one undoes on its own", async () => {
    const songs = ["Chrome Horizon", "Wildfire", "Static Bloom"].map((name, index) =>
      entry(`/music/yt/${index}.m4a`, { artist: "Neon Pulse AI", album: "Midnight Synthetic (Full Album)", title: `Neon Pulse AI - ${name} (Official Audio) | synthwave`, number: index + 1 }),
    );
    await show(scanOf(songs), () => ({ kind: "found", albums: [], unidentified: songs.map((song) => ({ file: song.file, reason: "no-match" as const })) }));
    const rows = () => byTestId("import-cleanup").map((row) => [row.dataset.rule, row.textContent?.replace(/(Undo|Redo)$/u, ""), row.dataset.undone ?? null]);
    expect(rows()).toEqual([
      ["artist-prefix", 'Took "Neon Pulse AI - " off the start of 3 song names', null],
      ["shared-suffix", 'Took "| synthwave" off the end of 3 song names', null],
      ["video-tail", 'Took "(Official Audio)" off the end of 3 song names', null],
      ["full-album", 'Took "(Full Album)" off the album name', null],
    ]);
    const titles = () => byTestId("import-song-title").map((input) => (input as HTMLInputElement).value);
    expect(titles()).toEqual(["Chrome Horizon", "Wildfire", "Static Bloom"]);
    expect((byTestId("import-field-album")[0] as HTMLInputElement).value).toBe("Midnight Synthetic");
    expect(albumRow("Midnight Synthetic")).toBeTruthy();

    // Undo the artist and the album name: only those come back; the other two stay off.
    const undo = (rule: string) => click(byTestId("import-cleanup").find((row) => row.dataset.rule === rule)?.querySelector('[data-testid="import-cleanup-undo"]'));
    await undo("artist-prefix");
    await undo("full-album");
    expect(titles()).toEqual(["Neon Pulse AI - Chrome Horizon", "Neon Pulse AI - Wildfire", "Neon Pulse AI - Static Bloom"]);
    expect(rows().map(([rule, , off]) => [rule, off])).toEqual([["artist-prefix", "true"], ["shared-suffix", null], ["video-tail", null], ["full-album", "true"]]);

    // Redo puts a clean-up back.
    await undo("full-album");
    expect((byTestId("import-field-album")[0] as HTMLInputElement).value).toBe("Midnight Synthetic");
    const selection = await confirmImport();
    expect(selection.map((item) => [item.title, item.album])).toEqual([
      ["Neon Pulse AI - Chrome Horizon", "Midnight Synthetic"],
      ["Neon Pulse AI - Wildfire", "Midnight Synthetic"],
      ["Neon Pulse AI - Static Bloom", "Midnight Synthetic"],
    ]);
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

  // Chris 2026-11-26 (~/Musique/artishaw): one folder, one album, but two songs the metadata spells otherwise ("The Man
  // I Love" listed as "A Man I Love") showed as two more albums to "Check", and Import went on regardless.
  const ARTIE = { id: "a1b2c3d4-0000-4000-8000-000000000001", name: "Artie Shaw" };
  const dancing = album("7547c058-5441-4336-a77d-ed0ed5d95808", "Dancing on the Ceiling", 2002, ARTIE, [
    "Dancing on the Ceiling",
    "A Man I Love",
    "Special Delivery Stomp",
    "Summit Ridge Drive",
    "Cross Your Heart",
    "Just Floating' Along",
  ]);
  const orchestra = album("a4aae208-e73c-4cb3-8903-ab8ef611f6e2", "Artie Shaw and his Orchestra", 1990, ARTIE, ["Begin the Beguine", "The Man I Love", "Frenesi", "Star Dust", "Nightmare", "Traffic Jam"]);
  const blues = album("ab511f36-885c-4656-8350-74030603ef0d", "Blues in the Night", 1995, ARTIE, ["Blues in the Night", "Just Floatin' Along", "Skylark", "Moonray", "Hep Hep", "Frenesi"]);
  const artishaw = () => {
    const song = (title: string, number: number) => entry(`/music/artishaw/${title}.m4a`, { artist: "Artie Shaw and His Gramercy Five", album: "Dancing on the Ceiling", title, number });
    const sure = [song("Dancing on the Ceiling", 1), song("Special Delivery Stomp", 3), song("Summit Ridge Drive", 4), song("Cross Your Heart", 5)];
    const manILove = song("The Man I Love", 0);
    const floatin = song("Just Floatin' Along", 0);
    const found: ParrotImportMatchedAlbum[] = [
      { album: dancing, cover: COVER, tracklistKnown: true, files: sure.map((one) => ({ file: one.file, disc: 1, number: one.number, sure: true })) },
      { album: orchestra, cover: null, tracklistKnown: true, files: [{ file: manILove.file, disc: 1, number: 2, sure: false }] },
      { album: blues, cover: null, tracklistKnown: true, files: [{ file: floatin.file, disc: 1, number: 2, sure: false }] },
    ];
    return { songs: [...sure, manILove, floatin], manILove, floatin, lookup: lookupOf(found) };
  };
  const detailAlbum = () => byTestId("import-album-detail")[0]?.dataset.album;

  // @bugfix @regression-proof
  // @req PAR-UP-10
  it("[PARROT-DESKTOP-IMPORT-EDIT-001] Import waits on every Check; 'Check 2 albums' walks to each, and Looks right / Not this album answer it", async () => {
    const { songs, manILove, floatin, lookup } = artishaw();
    await show(scanOf(songs), lookup);
    const rows = () => byTestId("import-review-album").map((row) => `${row.dataset.album}${row.querySelector('[data-testid="import-album-check"]') ? " (check)" : ""}`);
    console.info(SUITE, "[PARROT-DESKTOP-IMPORT-EDIT-001] gated", rows());
    expect(rows()).toEqual(["Dancing on the Ceiling", "Artie Shaw and his Orchestra (check)", "Blues in the Night (check)"]);
    // Import is off and the review says what to do; the amber button walks the checks.
    expect(byTestId("import-review-confirm")[0]).toHaveProperty("disabled", true);
    expect(byTestId("import-review-to-check")[0]?.textContent).toBe("2 albums need a look before you import: open each and choose Looks right or Not this album.");
    expect(byTestId("import-review-walk")[0]?.textContent).toBe("Check 2 albums");

    await click(byTestId("import-review-walk")[0]);
    expect(detailAlbum()).toBe("Artie Shaw and his Orchestra");
    expect(byTestId("import-match-check")).toHaveLength(1);
    await click(byTestId("import-review-walk")[0]);
    expect(detailAlbum()).toBe("Blues in the Night");
    await click(byTestId("import-review-walk")[0]);
    expect(detailAlbum()).toBe("Artie Shaw and his Orchestra");

    // "Looks right" answers this one and shows the next.
    await click(byTestId("import-match-confirm")[0]);
    console.info(SUITE, "[PARROT-DESKTOP-IMPORT-EDIT-001] after Looks right", rows(), detailAlbum());
    expect(detailAlbum()).toBe("Blues in the Night");
    expect(byTestId("import-review-walk")[0]?.textContent).toBe("Check 1 album");
    expect(byTestId("import-review-confirm")[0]).toHaveProperty("disabled", true);
    // "Not this album" answers the last: Import turns on.
    await click(byTestId("import-match-clear")[0]);
    expect(byTestId("import-review-walk")).toHaveLength(0);
    expect(byTestId("import-review-to-check")).toHaveLength(0);
    expect(byTestId("import-review-confirm")[0]).toHaveProperty("disabled", false);

    const selection = new Map((await confirmImport()).map((item) => [item.file, item]));
    expect(selection.get(manILove.file)).toMatchObject({ album: "Artie Shaw and his Orchestra", number: 2 });
    expect(selection.get(floatin.file)).toMatchObject({ title: "Just Floatin' Along", unidentified: true });
  });

  // @bugfix @regression-proof
  // @req PAR-UP-10
  it("[PARROT-DESKTOP-IMPORT-EDIT-001] an unticked Check does not hold Import", async () => {
    const { songs, manILove, floatin, lookup } = artishaw();
    await show(scanOf(songs), lookup);
    await click(albumRow("Artie Shaw and his Orchestra")?.querySelector('[data-testid="import-review-album-check"]'));
    await click(albumRow("Blues in the Night")?.querySelector('[data-testid="import-review-album-check"]'));
    expect(byTestId("import-review-walk")).toHaveLength(0);
    const selection = await confirmImport();
    expect(selection.map((item) => item.file)).not.toContain(manILove.file);
    expect(selection.map((item) => item.file)).not.toContain(floatin.file);
  });

  // @bugfix @regression-proof
  // @req PAR-UP-10
  // @req PAR-UP-05
  it("[PARROT-DESKTOP-IMPORT-EDIT-001] picking from the search an album already in the review merges the two: one card, the stray card gone", async () => {
    const { songs, manILove, lookup } = artishaw();
    await show(scanOf(songs), lookup);
    await click(albumRow("Artie Shaw and his Orchestra"));
    window.parrot.searchImportAlbums = vi.fn(async () => ({ kind: "found" as const, results: [{ album: dancing, cover: COVER }] }));
    await click(byTestId("import-match-search-submit")[0]);
    const result = byTestId("import-match-result")[0];
    await click(result?.querySelector("button"));
    const rows = byTestId("import-review-album").map((row) => [row.dataset.album, row.querySelector('[data-testid="import-album-incomplete"]')?.textContent ?? "whole"]);
    console.info(SUITE, "[PARROT-DESKTOP-IMPORT-EDIT-001] after merge", rows);
    expect(rows).toEqual([
      ["Dancing on the Ceiling", "5 of 6 tracks"],
      ["Blues in the Night", "1 of 6 tracks"],
    ]);
    expect(detailAlbum()).toBe("Dancing on the Ceiling");
    // The rest through the dialog's own albums: "Move here" on Dancing on the Ceiling, offered open on the Check.
    await click(byTestId("import-review-walk")[0]);
    expect(detailAlbum()).toBe("Blues in the Night");
    expect((byTestId("import-match-search")[0] as HTMLDetailsElement).open).toBe(true);
    const here = byTestId("import-match-here-result");
    expect(here.map((one) => [one.dataset.album, one.textContent])).toEqual([["Dancing on the Ceiling", "Move hereDancing on the Ceiling5 of 6 tracks"]]);
    await click(here[0]?.querySelector("button"));
    expect(byTestId("import-review-album").map((row) => [row.dataset.album, row.querySelector('[data-testid="import-album-incomplete"]')?.textContent ?? "whole"])).toEqual([["Dancing on the Ceiling", "whole"]]);
    expect(byTestId("import-review-walk")).toHaveLength(0);

    const selection = new Map((await confirmImport()).map((item) => [item.file, item]));
    expect(selection.get(manILove.file)).toMatchObject({ title: "A Man I Love", album: "Dancing on the Ceiling", number: 2 });
    expect([...selection.values()].map((item) => item.number).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const item of selection.values()) expect(item).toMatchObject({ album: "Dancing on the Ceiling", albumMusicId: dancing.id });
  });

  // @bugfix @regression-proof
  // @req PAR-UP-05
  it("[PARROT-DESKTOP-IMPORT-EDIT-001] Select always applies: a song no track fits still joins the picked album, with no number", async () => {
    const odd = entry("/music/Odd/Untitled.mp3", { artist: "Linnet Park", album: "Odd Tapes", title: "Untitled", number: 0 });
    await show(scanOf([odd]), () => ({ kind: "found", albums: [], unidentified: [{ file: odd.file, reason: "no-match" }] }));
    expect(albumRow("Odd Tapes")?.dataset.state).toBe("notfound");
    window.parrot.searchImportAlbums = vi.fn(async () => ({ kind: "found" as const, results: [{ album: meltway, cover: null }] }));
    await click(byTestId("import-match-search-submit")[0]);
    await click(byTestId("import-match-result")[0]?.querySelector("button"));
    console.info(SUITE, "[PARROT-DESKTOP-IMPORT-EDIT-001] after Select", byTestId("import-review-album").map((row) => row.dataset.album));
    expect(byTestId("import-review-album").map((row) => row.dataset.album)).toEqual(["Meltway"]);
    const [item] = await confirmImport();
    expect(item).toMatchObject({ title: "Untitled", album: "Meltway", albumMusicId: meltway.id });
    expect(item?.number).toBeUndefined();
    expect(item?.unidentified).toBeUndefined();
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
