// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-IMPORT-LYRICS-001
 * @level integration (real ImportReview dialog, real translator and lyrics placement; `window.parrot` mocked)
 * @why Chris 2026-11-27: every drop opens the review, lyrics files included. A drop of lyrics files alone lists one row
 *   per file with the song it goes on and how sure that is; with songs in the drop, each song shows its file on a line
 *   under it and the files placed nowhere wait at the end. A placement the review is not sure of never goes in until
 *   the user picks the song, and the user can always change or remove one.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicAlbum } from "@space/shared/api";
import type { ParrotLibraryTrack } from "@space/parrot-ingest";
import ImportReview, { parrotFileAlbums } from "../src/renderer/src/ImportReview";
import { translator } from "../src/renderer/src/i18n";
import type { ParrotImportAlbumMatch, ParrotImportLyricsChoice, ParrotImportScan, ParrotScanEntry } from "../src/shared/ipc";

const SUITE = "[parrot-import-lyrics]";
const LINNET_PARK = { id: "5e1c0a2d-4b7f-4c3a-9d21-7a6b3c9e0f15", name: "Linnet Park" };
const hollowSignal: MusicAlbum = {
  id: "2a0981fb-9593-3019-864b-ce934d97a16e",
  title: "Hollow Signal",
  year: 2000,
  kind: "Album",
  artist: LINNET_PARK,
  tracks: ["Paperboat", "One Step Farther", "Near You"].map((title, index) => ({ disc: 1, number: index + 1, title, durationMs: 180_000, id: `2a0981fb-9593-3019-864b-ce934d${String(index).padStart(6, "0")}` })),
};

const track = (id: string, title: string, albumTitle: string): ParrotLibraryTrack => ({
  id,
  title,
  albumId: `album-${albumTitle}`,
  albumTitle,
  artistId: "artist-linnet",
  artistName: "Linnet Park",
  disc: 1,
  number: null,
  durationMs: 180_000,
  fileId: null,
  mime: null,
  sizeBytes: null,
  gainDb: null,
  peak: null,
  albumGainDb: null,
  albumPeak: null,
  unidentified: false,
  year: null,
  genre: null,
  lossless: false,
  hasLyrics: false,
});
const LIBRARY = [track("t-paperboat", "Paperboat", "Hollow Signal"), track("t-near", "Near You", "Hollow Signal"), track("t-forecast", "Forecast", "Meltway")];

const entry = (file: string, title: string, number: number): ParrotScanEntry => ({
  file,
  size: 1_000_000,
  artist: "Linnet Park",
  album: "Hollow Signal",
  title,
  disc: 1,
  number,
  durationMs: 180_000,
});
const scanOf = (entries: ParrotScanEntry[], lyrics: ParrotImportScan["lyrics"]): ParrotImportScan => ({
  folders: ["/drop"],
  entries,
  albums: parrotFileAlbums(entries).length,
  artists: entries.length ? 1 : 0,
  totalBytes: entries.length * 1_000_000,
  unreadable: [],
  lyrics,
});

describe("Parrot desktop import review: the drop's lyrics files", () => {
  let container: HTMLDivElement;
  let root: Root;
  let confirmed: { files: string[]; lyrics: ParrotImportLyricsChoice[] } | null = null;

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      }
    });
  };
  const byTestId = (id: string, within: ParentNode = document) => [...within.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
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
  const fileRow = (name: string) => byTestId("import-lyrics-file").find((row) => row.dataset.file === name);
  const rows = () => byTestId("import-lyrics-file").map((row) => [row.dataset.file, row.dataset.state, byTestId("import-lyrics-song", row)[0]?.textContent ?? ""]);

  const show = async (scan: ParrotImportScan, lookup: (files: string[]) => ParrotImportAlbumMatch) => {
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        importCover: vi.fn(async () => null),
        matchImportAlbum: vi.fn(async ({ files }: { id: string; files: string[] }) => lookup(files)),
        stopImportAlbumMatch: vi.fn(async () => undefined),
        importAlbumPictures: vi.fn(async () => []),
        pickImportCoverImage: vi.fn(async () => null),
        importArtistPhoto: vi.fn(async () => ({ photo: null, credit: null })),
        searchImportAlbums: vi.fn(async () => ({ kind: "found", results: [] })),
        cancelImport: vi.fn(async () => undefined),
        confirmImport: vi.fn(async (selection: Array<{ file: string }>, lyrics: ParrotImportLyricsChoice[]) => {
          confirmed = { files: selection.map((item) => item.file), lyrics };
          return undefined;
        }),
      },
    });
    await act(async () => root.render(<ImportReview t={translator("en")} language="en" scan={scan} tracks={LIBRARY} onDone={() => undefined} />));
    await flush();
  };
  const confirm = async () => {
    await click(byTestId("import-review-confirm")[0]);
    console.info(SUITE, "confirmed", JSON.stringify(confirmed));
    return confirmed!;
  };

  beforeEach(() => {
    confirmed = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req PAR-LYR-09
  // @req PAR-UP-01
  it("a drop of lyrics files alone: one row per file, unsure ones wait for the user's pick, Change searches the songs", async () => {
    console.info(SUITE, "phase: lyrics-only drop");
    await show(
      scanOf([], [
        { file: "/drop/Linnet Park - Paperboat.lrc", text: "[ar:Linnet Park]\n[al:Hollow Signal]\n[ti:Paperboat]\n[00:01.00]Fold it once\n" },
        { file: "/drop/Near.txt", text: "Near enough to hear\n" },
        { file: "/drop/Nothing like it.txt", text: "Words of no song\n" },
        { file: "/drop/huge.lrc", error: "tooBig" },
      ]),
      () => {
        throw new Error("a drop without songs looks no album up");
      },
    );
    console.info(SUITE, "rows", JSON.stringify(rows()));
    expect(byTestId("import-lyrics-files")).toHaveLength(1);
    expect(rows()).toEqual([
      ["Linnet Park - Paperboat.lrc", "matched", "Linnet Park · Hollow Signal · Paperboat"],
      ["Near.txt", "unsure", "Linnet Park · Hollow Signal · Near You"],
      ["Nothing like it.txt", "none", "Choose the song"],
      ["huge.lrc", "problem", ""],
    ]);
    // Only the sure file counts until the user picks.
    expect(byTestId("import-review-confirm")[0]?.textContent).toBe("Keep 1 lyrics file");

    console.info(SUITE, "phase: the user takes the unsure song and searches one for the unmatched file");
    await click(byTestId("import-lyrics-use", fileRow("Near.txt"))[0]);
    expect(fileRow("Near.txt")?.dataset.state).toBe("chosen");
    await click(byTestId("import-lyrics-change", fileRow("Nothing like it.txt"))[0]);
    await typeInto(byTestId("import-lyrics-search-input")[0], "forec");
    await flush();
    const results = byTestId("import-lyrics-result");
    expect(results.map((result) => result.dataset.song)).toEqual(["track:t-forecast"]);
    await click(results[0]);
    expect(fileRow("Nothing like it.txt")?.dataset.state).toBe("chosen");
    expect(byTestId("import-review-confirm")[0]?.textContent).toBe("Keep 3 lyrics files");

    const { files, lyrics } = await confirm();
    expect(files).toEqual([]);
    expect(lyrics).toEqual([
      { lyricsFile: "/drop/Linnet Park - Paperboat.lrc", song: { trackId: "t-paperboat" } },
      { lyricsFile: "/drop/Near.txt", song: { trackId: "t-near" } },
      { lyricsFile: "/drop/Nothing like it.txt", song: { trackId: "t-forecast" } },
    ]);
  });

  // @req PAR-LYR-09
  it("a mixed folder: each song shows its file under it, the unplaced ones wait at the end, Change and Remove move them", async () => {
    console.info(SUITE, "phase: album with two matching lyrics files and one that fits nothing");
    const paperboat = entry("/drop/Hollow Signal/01 Paperboat.mp3", "Paperboat", 1);
    const farther = entry("/drop/Hollow Signal/02 One Step Farther.mp3", "One Step Farther", 2);
    await show(
      scanOf([paperboat, farther], [
        { file: "/drop/Hollow Signal/01 Paperboat.lrc", text: "[00:01.00]Fold it once\n" },
        { file: "/drop/Hollow Signal/One Step Farther.lrc", text: "[00:02.00]Farther still\n" },
        { file: "/drop/Hollow Signal/liner notes.txt", text: "Recorded in a barn\n" },
      ]),
      (files) => ({
        kind: "found",
        albums: [{ album: hollowSignal, cover: null, tracklistKnown: true, files: files.map((file) => ({ file, disc: 1, number: file === paperboat.file ? 1 : 2, sure: true })) }],
        unidentified: [],
      }),
    );
    const lines = () => byTestId("import-song-lyrics").map((line) => [line.dataset.file, line.dataset.lyrics]);
    console.info(SUITE, "song lines", JSON.stringify(lines()), "to place", JSON.stringify(rows()));
    expect(lines()).toEqual([
      [paperboat.file, "01 Paperboat.lrc"],
      [farther.file, "One Step Farther.lrc"],
    ]);
    expect(byTestId("import-song-lyrics")[0]?.textContent).toContain("Lyrics: 01 Paperboat.lrc");
    expect(byTestId("import-lyrics-to-place")).toHaveLength(1);
    expect(rows()).toEqual([["liner notes.txt", "none", "Choose the song"]]);
    expect(byTestId("import-review-lyrics-count")[0]?.textContent).toBe("2 lyrics files go on songs");

    console.info(SUITE, "phase: Remove sends a file to the end; Change puts the stray file on a library song");
    await click(byTestId("import-song-lyrics-remove", byTestId("import-song-lyrics")[1])[0]);
    expect(lines()).toEqual([[paperboat.file, "01 Paperboat.lrc"]]);
    expect(rows().map(([file]) => file)).toEqual(["One Step Farther.lrc", "liner notes.txt"]);
    await click(byTestId("import-lyrics-change", fileRow("liner notes.txt"))[0]);
    await typeInto(byTestId("import-lyrics-search-input")[0], "near you");
    await flush();
    await click(byTestId("import-lyrics-result").find((result) => result.dataset.song === "track:t-near"));
    expect(rows().map(([file]) => file)).toEqual(["One Step Farther.lrc"]);

    console.info(SUITE, "phase: Change on a song's line moves its file to another song of the import");
    await click(byTestId("import-song-lyrics-change", byTestId("import-song-lyrics")[0])[0]);
    await typeInto(byTestId("import-lyrics-search-input")[0], "farther");
    await flush();
    await click(byTestId("import-lyrics-result").find((result) => result.dataset.song === `file:${farther.file}`));
    expect(lines()).toEqual([[farther.file, "01 Paperboat.lrc"]]);

    const { files, lyrics } = await confirm();
    expect(files).toEqual([paperboat.file, farther.file]);
    expect(lyrics).toEqual([
      { lyricsFile: "/drop/Hollow Signal/01 Paperboat.lrc", song: { file: farther.file } },
      { lyricsFile: "/drop/Hollow Signal/liner notes.txt", song: { trackId: "t-near" } },
    ]);
  });

  // @bugfix @regression-proof: with every song unticked and no lyrics file in the drop, the button read
  // "Keep 0 lyrics files" (parrot-desktop-e2e import-album-match, on staging after 0.1.80).
  // @req PAR-LYR-09 @req PAR-UP-05
  it("a drop with no lyrics files keeps the songs' words on its button, even with every song unticked", async () => {
    const paperboat = entry("/drop/Hollow Signal/01 Paperboat.mp3", "Paperboat", 1);
    await show(scanOf([paperboat], []), (files) => ({
      kind: "found",
      albums: [{ album: hollowSignal, cover: null, tracklistKnown: true, files: files.map((file) => ({ file, disc: 1, number: 1, sure: true })) }],
      unidentified: [],
    }));
    const label = () => byTestId("import-review-confirm")[0]?.textContent;
    console.info(SUITE, "phase: songs only, all ticked", label());
    expect(label()).toBe("Import 1 song");
    await click(byTestId("import-review-all")[0]);
    console.info(SUITE, "phase: every song unticked", label());
    expect(label()).toBe("Import 0 songs");
    expect(byTestId("import-review-confirm")[0]?.hasAttribute("disabled")).toBe(true);
  });

  // @req PAR-LYR-09
  it("a mixed folder with every song unticked says Import 0 songs, not Keep 0 lyrics files", async () => {
    console.info(SUITE, "phase: album with a stray notes file; the All songs box unticks every song");
    const paperboat = entry("/drop/Hollow Signal/01 Paperboat.mp3", "Paperboat", 1);
    const farther = entry("/drop/Hollow Signal/02 One Step Farther.mp3", "One Step Farther", 2);
    await show(scanOf([paperboat, farther], [{ file: "/drop/Hollow Signal/notes.txt", text: "not a song\n" }]), (files) => ({
      kind: "found",
      albums: [{ album: hollowSignal, cover: null, tracklistKnown: true, files: files.map((file) => ({ file, disc: 1, number: file === paperboat.file ? 1 : 2, sure: true })) }],
      unidentified: [],
    }));
    const button = () => byTestId("import-review-confirm")[0] as HTMLButtonElement;
    expect(button().textContent).toBe("Import 2 songs");
    await click(byTestId("import-review-all")[0]);
    console.info(SUITE, "unticked", button().textContent, button().disabled);
    expect(button().textContent).toBe("Import 0 songs");
    expect(button().disabled).toBe(true);

    console.info(SUITE, "phase: a file placed on a library song with no song ticked is what the button keeps");
    await click(byTestId("import-lyrics-change", fileRow("notes.txt"))[0]);
    await typeInto(byTestId("import-lyrics-search-input")[0], "near you");
    await flush();
    await click(byTestId("import-lyrics-result").find((result) => result.dataset.song === "track:t-near"));
    expect(button().textContent).toBe("Keep 1 lyrics file");
    expect(button().disabled).toBe(false);
  });
});
