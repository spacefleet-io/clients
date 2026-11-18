// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-IMPORT-EDIT-001
 * @level integration (real ImportReview dialog, real translator and matching helpers; `window.parrot` mocked)
 * @why Walk 2026-11-12: the import dropped what the review showed. Hollow Signal's looked-up cover was not applied,
 *   a Clockworkers compilation's songs matched to Minutes to Daybreak landed under "Various Artists", and a song
 *   identified as Meltway track 7 after typing its names was stored with an empty album. The review now hands the
 *   import the matched album's cover id and album artist, and a song picked with Identify replaces typed names.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicAlbum } from "@space/shared/api";
import ImportReview from "../src/renderer/src/ImportReview";
import { translator } from "../src/renderer/src/i18n";
import type { ParrotImportMatchResult, ParrotImportScan, ParrotImportSelection, ParrotImportSongSearch, ParrotScanEntry } from "../src/shared/ipc";

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
  const type = async (id: string, value: string) => {
    const input = document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const show = async (
    scan: ParrotImportScan,
    match: ParrotImportMatchResult | Promise<ParrotImportMatchResult>,
    songs: ParrotImportSongSearch = { kind: "found", results: [] },
    importCover: (id: string) => Promise<string | null> = async () => null
  ) => {
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        importCover: vi.fn(importCover),
        matchImport: vi.fn(async () => match),
        importArtistPhoto: vi.fn(async () => ({ photo: null, credit: null })),
        searchImportSongs: vi.fn(async () => songs),
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
  // @req PAR-UP-05
  it("hands the import the matched album's cover and release album artist, never a 'Various Artists' tag of a non-compilation", async () => {
    const paperboat = entry("/music/Hollow Signal/01 Paperboat.mp3", { artist: "Linnet Park", album: "Hollow Signal", title: "Paperboat", number: 1 });
    const whatIveDone = entry("/music/Clockworkers/01 What I've Kept.mp3", { artist: "Linnet Park", album: "Clockworkers: The Album", title: "What I've Kept", number: 1 });
    const beforeTheLightsGo = entry("/music/Clockworkers/02 Before the Lights Go.mp3", { artist: "Tin Tin Kites", album: "Clockworkers: The Album", title: "Before the Lights Go", number: 2 });
    const scan: ParrotImportScan = { folders: ["/music"], entries: [paperboat, whatIveDone, beforeTheLightsGo], albums: 2, artists: 2, totalBytes: 3_000_000, unreadable: [] };
    await show(scan, {
      albums: [
        { album: hollowSignal, cover: COVER, tracklistKnown: true, files: [{ file: paperboat.file, disc: 1, number: 1, sure: true }] },
        { album: minutes, cover: null, tracklistKnown: true, files: [{ file: whatIveDone.file, disc: 1, number: 6, sure: true }] },
        { album: clockworkers, cover: COVER, tracklistKnown: true, files: [{ file: beforeTheLightsGo.file, disc: 1, number: 2, sure: true }] },
      ],
      unidentified: [],
    });
    const selection = new Map((await confirmImport()).map((item) => [item.file, item]));
    // The cover the review showed goes with the song; an album the lookup had no cover for asks none.
    expect(selection.get(paperboat.file)).toMatchObject({ album: "Hollow Signal", albumArtist: "Linnet Park", albumArtistMusicId: LINNET_PARK.id, coverId: hollowSignal.id });
    expect(selection.get(whatIveDone.file)).toMatchObject({ artist: "Linnet Park", album: "Minutes to Daybreak", albumArtist: "Linnet Park", number: 6 });
    expect(selection.get(whatIveDone.file)?.coverId).toBeUndefined();
    // A real various-artists compilation keeps "Various Artists" as album artist, and each song its own artist.
    expect(selection.get(beforeTheLightsGo.file)).toMatchObject({ artist: "Tin Tin Kites", albumArtist: "Various Artists", albumArtistMusicId: VARIOUS.id, coverId: clockworkers.id });
  });

  // @req PAR-UP-05
  it("lists the matched albums without waiting for their covers, then draws each cover as it comes (#2509)", async () => {
    const paperboat = entry("/music/Hollow Signal/01 Paperboat.mp3", { artist: "Linnet Park", album: "Hollow Signal", title: "Paperboat", number: 1 });
    const fable = entry("/music/Meltway/07 Fable.mp3", { artist: "Linnet Park", album: "Meltway", title: "Fable", number: 7 });
    const scan: ParrotImportScan = { folders: ["/music"], entries: [paperboat, fable], albums: 2, artists: 1, totalBytes: 2_000_000, unreadable: [] };
    const covers = new Map([hollowSignal, meltway].map((found) => [found.id!, Promise.withResolvers<string | null>()]));
    const asked: string[] = [];
    await show(
      scan,
      {
        albums: [
          { album: meltway, cover: null, tracklistKnown: true, files: [{ file: fable.file, disc: 1, number: 7, sure: true }] },
          { album: hollowSignal, cover: null, tracklistKnown: true, files: [{ file: paperboat.file, disc: 1, number: 1, sure: true }] },
        ],
        unidentified: [],
      },
      undefined,
      (id) => (asked.push(id), covers.get(id)!.promise)
    );
    const shownCovers = () => byTestId("import-match-album").flatMap((row) => [...row.querySelectorAll("img")].map((img) => img.getAttribute("src")));
    // The review opens on the first album while no cover has come; covers are asked a few at a time, in the list's order.
    console.info(SUITE, "before covers", asked, byTestId("import-match-album").map((row) => row.dataset.album));
    expect(byTestId("import-match-album").map((row) => row.dataset.album)).toEqual(["Hollow Signal"]);
    expect(shownCovers()).toEqual([]);
    expect(asked).toEqual([hollowSignal.id, meltway.id]);

    await act(async () => covers.get(hollowSignal.id!)!.resolve(COVER));
    await flush();
    console.info(SUITE, "after first cover", asked);
    expect(shownCovers()).toEqual([COVER]);
    await act(async () => covers.get(meltway.id!)!.resolve(null));
    await flush();

    // The cover that came goes with its songs; an album with none asks none.
    const selection = new Map((await confirmImport()).map((item) => [item.file, item]));
    expect(selection.get(paperboat.file)?.coverId).toBe(hollowSignal.id);
    expect(selection.get(fable.file)?.coverId).toBeUndefined();
  });

  // @req PAR-UP-05
  it("a song picked with Identify replaces the names typed before it, album and track number included", async () => {
    const fable = entry("/music/Linnet Park - Fable.mp3", { title: "Linnet Park - Fable" });
    const scan: ParrotImportScan = { folders: ["/music"], entries: [fable], albums: 1, artists: 1, totalBytes: 1_000_000, unreadable: [] };
    await show(scan, { albums: [], unidentified: [{ file: fable.file, reason: "no-match" }] }, { kind: "found", results: [{ album: meltway, cover: COVER, track: meltway.tracks[6]! }] });
    await click(byTestId("import-unidentified-file")[0]?.querySelector("button"));
    await type("import-review-title", "Fable");
    await type("import-review-artist", "Linnet Park");
    await type("import-review-album", "");
    await click(byTestId("import-file-identify-submit")[0]);
    expect(window.parrot.searchImportSongs).toHaveBeenCalledWith({ artist: "Linnet Park", title: "Fable", album: "" });
    await click(byTestId("import-file-identify-result")[0]?.querySelector("button"));
    expect(byTestId("import-review-album")[0]?.getAttribute("data-album")).toBe("Meltway");
    const [stored] = await confirmImport();
    expect(stored).toMatchObject({ file: fable.file, title: "Fable", artist: "Linnet Park", album: "Meltway", albumArtist: "Linnet Park", year: 2003, number: 7, disc: 1, coverId: meltway.id });
  });

  // @req PAR-UP-05
  it("says 'No match in our music library' only once the matching answered, never while it runs", async () => {
    const fable = entry("/music/Linnet Park - Fable.mp3", { title: "Linnet Park - Fable" });
    const scan: ParrotImportScan = { folders: ["/music"], entries: [fable], albums: 1, artists: 1, totalBytes: 1_000_000, unreadable: [] };
    const matching = Promise.withResolvers<ParrotImportMatchResult>();
    await show(scan, matching.promise);
    // The review is a dialog rendered in a portal, so its words are under document.body, not the root's container.
    const whileMatching = document.body.textContent ?? "";
    console.info(SUITE, "while matching", whileMatching.slice(0, 300));
    expect(byTestId("import-match-looking")).toHaveLength(1);
    expect(whileMatching).not.toContain("No match in our music library");
    await act(async () => matching.resolve({ albums: [], unidentified: [{ file: fable.file, reason: "no-match" }] }));
    await flush();
    console.info(SUITE, "after matching", (document.body.textContent ?? "").slice(0, 300));
    expect(byTestId("import-match-looking")).toHaveLength(0);
    expect(document.body.textContent).toContain("No match in our music library");
  });

  // @req PAR-UP-05
  it("a second Identify search shows 'Looking up…' while it runs, not the first search's 'No song found'", async () => {
    const fable = entry("/music/Linnet Park - Fable.mp3", { title: "Fable", artist: "Linnet Park" });
    const scan: ParrotImportScan = { folders: ["/music"], entries: [fable], albums: 1, artists: 1, totalBytes: 1_000_000, unreadable: [] };
    await show(scan, { albums: [], unidentified: [{ file: fable.file, reason: "no-match" }] }, { kind: "found", results: [] });
    await click(byTestId("import-unidentified-file")[0]?.querySelector("button"));
    await click(byTestId("import-file-identify-submit")[0]);
    console.info(SUITE, "first search answered none", byTestId("import-file-identify-none").map((node) => node.textContent));
    expect(byTestId("import-file-identify-none")).toHaveLength(1);

    const second = Promise.withResolvers<ParrotImportSongSearch>();
    window.parrot.searchImportSongs = vi.fn(() => second.promise);
    await click(byTestId("import-file-identify-submit")[0]);
    console.info(SUITE, "second search running", {
      searching: byTestId("import-file-identify-searching").map((node) => node.textContent),
      none: byTestId("import-file-identify-none").map((node) => node.textContent),
    });
    expect(byTestId("import-file-identify-none")).toHaveLength(0);
    expect(byTestId("import-file-identify-searching")[0]?.textContent).toContain("Looking up…");

    await act(async () => second.resolve({ kind: "found", results: [{ album: meltway, cover: COVER, track: meltway.tracks[6]! }] }));
    await flush();
    expect(byTestId("import-file-identify-searching")).toHaveLength(0);
    expect(byTestId("import-file-identify-result")).toHaveLength(1);
  });

  // @req PAR-UP-05
  it("a second album search shows 'Looking up…' while it runs, not the first search's 'No album found'", async () => {
    const paperboat = entry("/music/Hollow Signal/01 Paperboat.mp3", { artist: "Linnet Park", album: "Hollow Signal", title: "Paperboat", number: 1 });
    const scan: ParrotImportScan = { folders: ["/music"], entries: [paperboat], albums: 1, artists: 1, totalBytes: 1_000_000, unreadable: [] };
    await show(scan, { albums: [{ album: hollowSignal, cover: COVER, tracklistKnown: true, files: [{ file: paperboat.file, disc: 1, number: 1, sure: true }] }], unidentified: [] });
    const submit = () => byTestId("import-match-search-submit")[0];
    console.info(SUITE, "album search fold present", Boolean(submit()));
    await click(submit());
    console.info(SUITE, "first album search answered none", byTestId("import-match-search-none").map((node) => node.textContent));
    expect(byTestId("import-match-search-none")).toHaveLength(1);

    const second = Promise.withResolvers<{ kind: "found"; results: [] }>();
    window.parrot.searchImportAlbums = vi.fn(() => second.promise);
    await click(submit());
    console.info(SUITE, "second album search running", {
      searching: byTestId("import-match-search-searching").map((node) => node.textContent),
      none: byTestId("import-match-search-none").map((node) => node.textContent),
    });
    expect(byTestId("import-match-search-none")).toHaveLength(0);
    expect(byTestId("import-match-search-searching")[0]?.textContent).toContain("Looking up…");

    await act(async () => second.resolve({ kind: "found", results: [] }));
    await flush();
    expect(byTestId("import-match-search-searching")).toHaveLength(0);
    expect(byTestId("import-match-search-none")).toHaveLength(1);
  });

  // @req PAR-UP-05
  it("an album search lists its results at once, then asks their covers three at a time and draws each as it comes (#2509)", async () => {
    const paperboat = entry("/music/Hollow Signal/01 Paperboat.mp3", { artist: "Linnet Park", album: "Hollow Signal", title: "Paperboat", number: 1 });
    const scan: ParrotImportScan = { folders: ["/music"], entries: [paperboat], albums: 1, artists: 1, totalBytes: 1_000_000, unreadable: [] };
    const results = [meltway, hollowSignal, minutes, clockworkers];
    const covers = new Map(results.map((found) => [found.id!, Promise.withResolvers<string | null>()]));
    const asked: string[] = [];
    await show(
      scan,
      { albums: [{ album: hollowSignal, cover: COVER, tracklistKnown: true, files: [{ file: paperboat.file, disc: 1, number: 1, sure: true }] }], unidentified: [] },
      undefined,
      (id) => (asked.push(id), covers.get(id)!.promise)
    );
    window.parrot.searchImportAlbums = vi.fn(async () => ({ kind: "found" as const, results: results.map((found) => ({ album: found, cover: null })) }));
    await click(byTestId("import-match-search-submit")[0]);
    const resultCovers = () => byTestId("import-match-result").map((row) => row.querySelector("img")?.getAttribute("src") ?? null);
    console.info(SUITE, "search answered", { rows: byTestId("import-match-result").length, asked });
    // Every result shows at once with the disc; three covers are asked together, the fourth when one has come.
    expect(resultCovers()).toEqual([null, null, null, null]);
    expect(asked).toEqual(results.slice(0, 3).map((found) => found.id));

    await act(async () => covers.get(hollowSignal.id!)!.resolve(COVER));
    await flush();
    console.info(SUITE, "after one cover", asked);
    expect(resultCovers()).toEqual([null, COVER, null, null]);
    expect(asked).toEqual(results.map((found) => found.id));
  });
});
