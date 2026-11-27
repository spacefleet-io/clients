/**
 * @test-id PARROT-INGEST-SCAN-001
 * @level unit
 * @why PAR-UP-05: the confirm dialog shows what the import would store, read by the importer's own tag reader, and
 *      the import stores the user's edits. Real mp3 files (ffmpeg-made, in tests/fixtures/media) prove the scan reads tags and folder
 *      fallbacks, uploads nothing, and that edits reach the stored track info.
 * @covers packages/parrot-ingest/src/scan.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { applyParrotImportEdit, parrotEditedReader, readParrotTrackInfo, scanParrotImport } from "../src";
import { makeAudioFixture, makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-SCAN-001");

describe("scanParrotImport", () => {
  let root: string;
  let music: string;

  beforeAll(async () => {
    root = await makeTempDir("scan");
    music = path.join(root, "Music");
    const meltway = path.join(music, "Linnet Park", "Meltway");
    const untagged = path.join(music, "Linnet Park", "Hollow Signal");
    await fs.mkdir(meltway, { recursive: true });
    await fs.mkdir(untagged, { recursive: true });
    makeAudioFixture(path.join(meltway, "13 Nook.mp3"), { title: "Nook", artist: "Linnet Park", album: "Meltway", track: "13" }, 1, log);
    makeAudioFixture(path.join(meltway, "07 Fable.mp3"), { title: "Fable", artist: "Linnet Park", album: "Meltway", track: "7" }, 1, log);
    makeAudioFixture(path.join(untagged, "08 At the Gate.mp3"), {}, 1, log);
    await fs.writeFile(path.join(meltway, "broken.mp3"), "not audio");
    await fs.writeFile(path.join(meltway, "notes.txt"), "not a song");
    await fs.writeFile(path.join(meltway, "13 Nook.lrc"), "[ti:Nook]\n[00:01.00] Nook words");
    await fs.writeFile(path.join(untagged, "huge.lrc"), "x".repeat(300 * 1024));
    log("fixtures", { root });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists every song with the tags the import would store, and nothing else", async () => {
    const progress: Array<[number, number]> = [];
    // A file the tag reader throws on is left out and reported, like a failed import would be.
    const readInfo = async (file: string, root?: string) => {
      if (file.endsWith("broken.mp3")) throw new Error("unreadable tags");
      return readParrotTrackInfo(file, root);
    };
    const scan = await scanParrotImport([music], { log, readInfo, onProgress: (done, total) => progress.push([done, total]) });
    log("scan", scan);
    expect(scan.entries.map((entry) => [path.basename(entry.file), entry.artist, entry.album, entry.title])).toEqual([
      ["08 At the Gate.mp3", "Linnet Park", "Hollow Signal", "At the Gate"],
      ["07 Fable.mp3", "Linnet Park", "Meltway", "Fable"],
      ["13 Nook.mp3", "Linnet Park", "Meltway", "Nook"],
    ]);
    expect(scan.albums).toBe(2);
    expect(scan.artists).toBe(1);
    expect(scan.totalBytes).toBe(scan.entries.reduce((sum, entry) => sum + entry.size, 0));
    expect(scan.totalBytes).toBeGreaterThan(0);
    expect(scan.unreadable.map((entry) => path.basename(entry.file))).toEqual(["broken.mp3"]);
    // PAR-UP-01: lyrics files ride along with their text; one too big to be lyrics is named, not read.
    expect(scan.lyrics.map((entry) => [path.basename(entry.file), entry.text ?? entry.error])).toEqual([
      ["huge.lrc", "tooBig"],
      ["13 Nook.lrc", "[ti:Nook]\n[00:01.00] Nook words"],
      ["notes.txt", "not a song"],
    ]);
    expect(progress.at(-1)).toEqual([4, 4]);
  });

  it("keeps the lyrics the user placed as their own, and Remove keeps none from the files", async () => {
    const nook = path.join(music, "Linnet Park", "Meltway", "13 Nook.mp3");
    const info = { ...(await readParrotTrackInfo(nook, music)), lyrics: { synced: "[00:01.00] sidecar", plain: "sidecar" } };
    const placed = applyParrotImportEdit(info, { artist: "", album: "", title: "", lyrics: { synced: null, plain: "Mine" } });
    const removed = applyParrotImportEdit(info, { artist: "", album: "", title: "", lyrics: null });
    const untouched = applyParrotImportEdit(info, { artist: "", album: "", title: "" });
    log("lyrics", { placed: placed.lyrics, removed: removed.lyrics, untouched: untouched.lyrics });
    expect(placed.lyrics).toEqual({ synced: null, plain: "Mine", user: true });
    expect(removed.lyrics).toBeNull();
    expect(untouched.lyrics).toEqual(info.lyrics);
  });

  it("applies the user's edits on top of the tags, blank keeping the tag", async () => {
    const nook = path.join(music, "Linnet Park", "Meltway", "13 Nook.mp3");
    const info = await readParrotTrackInfo(nook, music);
    const edited = applyParrotImportEdit(info, { artist: "LP", album: "", title: "Nook (Live)" });
    log("edited", { artist: edited.artist, albumArtist: edited.albumArtist, album: edited.album, title: edited.title });
    expect(edited).toMatchObject({ artist: "LP", albumArtist: "LP", album: "Meltway", title: "Nook (Live)" });

    const reader = parrotEditedReader(new Map([[nook, { artist: "Linnet Park", album: "Meltway (Demos)", title: "Nook" }]]));
    expect((await reader(nook, music)).album).toBe("Meltway (Demos)");
    const fable = path.join(music, "Linnet Park", "Meltway", "07 Fable.mp3");
    expect((await reader(fable, music)).album).toBe("Meltway");
  });

  it("takes the matched album's year, track number and disc over the tags, absent ones keeping the tag", async () => {
    const nook = path.join(music, "Linnet Park", "Meltway", "13 Nook.mp3");
    const info = await readParrotTrackInfo(nook, music);
    const matched = applyParrotImportEdit(info, { artist: "", album: "Meltway", title: "Nook", year: 2003, number: 13, disc: 1 });
    expect(matched).toMatchObject({ year: 2003, number: 13, disc: 1 });
    const plain = applyParrotImportEdit(info, { artist: "", album: "", title: "" });
    expect(plain).toMatchObject({ year: info.year, number: info.number, disc: info.disc, artist: info.artist });
  });

  // @bugfix walk 2026-11-12: a Clockworkers compilation tagged "Various Artists" matched track by track to Minutes to
  // Midnight landed as "Minutes to Daybreak · Various Artists": the album artist came from the file's tag, never the match.
  it("takes the matched release's album artist over the file's album-artist tag", async () => {
    const fable = path.join(music, "Linnet Park", "Meltway", "07 Fable.mp3");
    const variousArtists = "89ad4ac3-39f7-470e-963a-56509c546377";
    const tagged = { ...(await readParrotTrackInfo(fable, music)), album: "Clockworkers: The Album", albumArtist: "Various Artists", albumArtistMusicId: variousArtists };
    const linnetPark = "5e1c0a2d-4b7f-4c3a-9d21-7a6b3c9e0f15";
    const matched = applyParrotImportEdit(tagged, { artist: "Linnet Park", album: "Minutes to Daybreak", title: "What I've Kept", albumArtist: "Linnet Park", albumArtistMusicId: linnetPark });
    log("matched", { artist: matched.artist, albumArtist: matched.albumArtist, albumArtistMusicId: matched.albumArtistMusicId, album: matched.album });
    expect(matched).toMatchObject({ artist: "Linnet Park", albumArtist: "Linnet Park", albumArtistMusicId: linnetPark, album: "Minutes to Daybreak" });
    // A real various-artists compilation keeps "Various Artists" as its album artist.
    const compilation = applyParrotImportEdit(tagged, { artist: "", album: "", title: "", albumArtist: "Various Artists", albumArtistMusicId: variousArtists });
    expect(compilation).toMatchObject({ artist: "Linnet Park", albumArtist: "Various Artists", albumArtistMusicId: variousArtists });
    // No match: the tag stands.
    expect(applyParrotImportEdit(tagged, { artist: "", album: "", title: "" }).albumArtist).toBe("Various Artists");
  });

  // @bugfix walk 2026-11-12: Hollow Signal showed its looked-up cover in the review but got the drawn placeholder in
  // the library: the import carried no cover. The lookup's cover comes before the file's own picture (PAR-META-04).
  it("gives the song the matched album's lookup cover, over the picture built into the file", async () => {
    const nook = path.join(music, "Linnet Park", "Meltway", "13 Nook.mp3");
    const builtIn = { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" };
    const lookup = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mime: "image/jpeg" };
    const readInfo = async (file: string, root?: string) => ({ ...(await readParrotTrackInfo(file, root)), cover: builtIn });
    const coverId = "5c4c7b54-4a25-3d18-b1f1-7d3a9f8b4f0b";
    const edits = new Map([[nook, { artist: "", album: "Meltway", title: "Nook", coverId }]]);
    expect((await parrotEditedReader(edits, readInfo, new Map([[coverId, lookup]]))(nook, music)).cover).toEqual(lookup);
    // The lookup gave no cover: the file's own picture stays.
    expect((await parrotEditedReader(edits, readInfo, new Map())(nook, music)).cover).toEqual(builtIn);
  });

  // @req PAR-UP-08 @req PAR-META-22
  it("gives the song the picture the review chose, with the square the user framed on it", async () => {
    const nook = path.join(music, "Linnet Park", "Meltway", "13 Nook.mp3");
    const builtIn = { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" };
    const picked = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), mime: "image/webp" };
    const readInfo = async (file: string, root?: string) => ({ ...(await readParrotTrackInfo(file, root)), cover: builtIn });
    const coverCrop = { left: 0.1, top: 0, size: 0.8 };
    const edits = new Map([[nook, { artist: "", album: "Meltway", title: "Nook", coverId: "5c4c7b54-4a25-3d18-b1f1-7d3a9f8b4f0b", coverPicture: "picture:abc", coverCrop }]]);
    const read = await parrotEditedReader(edits, readInfo, new Map([["picture:abc", picked]]))(nook, music);
    expect(read.cover).toEqual(picked);
    expect(read.coverCrop).toEqual(coverCrop);
    // No chosen cover came: the file's own picture stays, at its centre square (the framing was the chosen cover's).
    const fallback = await parrotEditedReader(edits, readInfo, new Map())(nook, music);
    expect(fallback.cover).toEqual(builtIn);
    expect(fallback.coverCrop).toBeUndefined();
  });
});
