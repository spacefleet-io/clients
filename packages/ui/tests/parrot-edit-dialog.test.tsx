// @vitest-environment jsdom
/**
 * @test-id UI-PARROT-EDIT-DIALOG-001
 * @level component (jsdom)
 * @why PAR-LYR-05, PAR-META-18, PAR-META-20: the edit panel carries the lookups. "Look it up again" fills the form and
 *   says so; the Lyrics section shimmers while the words are on their way, shows the first lines once found, and says
 *   "No lyrics found" with "Search again" only after a lookup came back empty, never while one runs; an album counts
 *   its songs with words and offers to look for the missing ones. A cover whose picture is still loading shimmers;
 *   the drawn picture means "no cover" only.
 * @req PAR-LYR-05[parrot]
 * @req PAR-META-18[parrot]
 * @req PAR-META-20[parrot]
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ParrotEditMetadataDialog, type ParrotEditLookUp, type ParrotEditLookUpLabels, type ParrotEditLyrics } from "../src/parrot/manage";
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
};
const lookUpLabels: ParrotEditLookUpLabels = {
  lookUp: "Look it up again",
  lookUpHint: "Parrot fills in what it finds; nothing is saved until you save.",
  lookUpFound: "Filled in what Parrot found. Check it, then save.",
  searching: "Searching…",
  lyrics: "Lyrics",
  lyricsSearching: "Looking for lyrics…",
  lyricsNone: "No lyrics found",
  lyricsSearchAgain: "Search again",
  lyricsFailed: (reason) => `Couldn't look for lyrics: ${reason}`,
  albumLyrics: (found, count) => `${found} of ${count} songs have lyrics`,
  albumLyricsSearch: "Look for the missing ones",
};
const FABLE = { title: "Fable", artist: "Linnet Park", album: "Meltway", number: 7, disc: 1, year: 2003, genre: "Nu metal" };

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

const open = async (props: { lookUp?: ParrotEditLookUp; lyrics?: ParrotEditLyrics; kind?: "track" | "album" }) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ParrotEditMetadataDialog open onOpenChange={() => {}} kind={props.kind ?? "track"} initial={FABLE} labels={labels} lookUp={props.lookUp} lyrics={props.lyrics} lookUpLabels={lookUpLabels} onSubmit={() => {}} />
    )
  );
  return (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
};

describe("[parrot] edit panel lookups", () => {
  it("Look it up again: a hint, then searching (disabled), then what it filled in", async () => {
    const onLookUp = vi.fn();
    let get = await open({ lookUp: { state: "idle", onLookUp } });
    expect(get("manage-look-up-note")?.textContent).toBe(lookUpLabels.lookUpHint);
    await act(async () => get("manage-look-up-button")!.click());
    expect(onLookUp).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    get = await open({ lookUp: { state: "busy", onLookUp } });
    console.info(T, "busy", get("manage-look-up")?.outerHTML);
    expect(get("manage-look-up")?.dataset.state).toBe("busy");
    expect(get("manage-look-up-note")?.textContent).toBe("Searching…");
    expect((get("manage-look-up-button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => root!.unmount());
    get = await open({ lookUp: { state: "found", onLookUp } });
    expect(get("manage-look-up-note")?.textContent).toBe(lookUpLabels.lookUpFound);
    await act(async () => root!.unmount());
    get = await open({ lookUp: { state: "none", message: "Parrot found nothing more for this song.", onLookUp } });
    expect(get("manage-look-up-note")?.textContent).toBe("Parrot found nothing more for this song.");
  });

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
