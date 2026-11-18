/**
 * @test-id PARROT-INGEST-READTRACK-001
 * @level unit
 * @why PAR-META-02: a song's names come from its embedded tags first, then its file name, then its folders. Real
 *      mp3/flac files (made by ffmpeg, committed in tests/fixtures/media) prove music-metadata's output is mapped to the library's
 *      fields, including the codec facts the upload records.
 * @covers packages/parrot-ingest/src/readTrack.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildParrotTrackOps } from "../src/importer";
import { ARTIST_ID_FILE_TAGS, parseAlbumFolderName, parseTrackFileName, readParrotTrackInfo } from "../src/readTrack";
import { ffmpegFixture, makeAudioFixture, makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-READTRACK-001");

describe("parseTrackFileName", () => {
  it.each([
    ["/m/03 - Paperboat.mp3", 3, null, null, "Paperboat"],
    ["/m/03. Paperboat.mp3", 3, null, null, "Paperboat"],
    ["/m/03 Paperboat.flac", 3, null, null, "Paperboat"],
    ["/m/13_ Nook.flac", 13, null, null, "Nook"],
    ["/m/7) Fable.ogg", 7, null, null, "Fable"],
    ["/m/Nook.mp3", null, null, null, "Nook"],
    ["/m/1979.mp3", null, null, null, "1979"],
    ["/m/  Breaking the Tide  .mp3", null, null, null, "Breaking the Tide"],
    // PAR-META-02: commonly used file names carry the artist, and sometimes the album.
    ["/m/Linnet Park - Fable.mp3", null, "Linnet Park", null, "Fable"],
    ["/m/Dusk Pike - Lowlands - 03 - Velvet Static.mp3", 3, "Dusk Pike", "Lowlands", "Velvet Static"],
    ["/m/Linnet Park - 07 - Fable.mp3", 7, "Linnet Park", null, "Fable"],
    ["/m/01 - Linnet Park - What I've Kept.mp3", 1, "Linnet Park", null, "What I've Kept"],
    ["/m/50 Cent - In da Club.mp3", null, "50 Cent", null, "In da Club"],
    ["/m/Linnet Park – Nook – Live.mp3", null, "Linnet Park", null, "Nook - Live"],
    ["/m/Jun-O - 99 Problems.mp3", null, "Jun-O", null, "99 Problems"],
  ])("%s → number %p, artist %p, album %p, title %p", (file, number, artist, album, title) => {
    const parsed = parseTrackFileName(file);
    log(`parseTrackFileName(${file})`, parsed);
    expect(parsed).toEqual({ number, artist, album, title });
  });
});

describe("parseAlbumFolderName", () => {
  it.each([
    ["Linnet Park - Hollow Signal (2000) [FLAC]", "Linnet Park", "Hollow Signal", 2000],
    ["Hollow Signal (2000)", null, "Hollow Signal", 2000],
    ["Linnet Park - 2003 - Meltway", "Linnet Park", "Meltway", 2003],
    ["Meltway", null, "Meltway", null],
    ["Lowlands [320]", null, "Lowlands", null],
    ["(2000)", null, "(2000)", null],
  ])("%s → artist %p, album %p, year %p", (name, artist, album, year) => {
    const parsed = parseAlbumFolderName(name);
    log(`parseAlbumFolderName(${name})`, parsed);
    expect(parsed).toEqual({ artist, album, year });
  });
});

describe("readParrotTrackInfo", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeTempDir("readtrack");
    log("fixture root", root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const tagged = { title: "Nook", artist: "Linnet Park", album: "Meltway", track: "13/13", disc: "1/1", date: "2003" };

  it("reads mp3 tags and stream facts", async () => {
    const file = makeAudioFixture(path.join(root, "tagged.mp3"), tagged, 2, log);
    log("fixture size", (await fs.stat(file)).size);
    const info = await readParrotTrackInfo(file);
    log("info", info);
    expect(info.file).toBe(file);
    expect(info.title).toBe("Nook");
    expect(info.artist).toBe("Linnet Park");
    expect(info.albumArtist).toBe("Linnet Park");
    expect(info.album).toBe("Meltway");
    expect(info.number).toBe(13);
    expect(info.disc).toBe(1);
    expect(info.year).toBe(2003);
    expect(info.durationMs).toBeGreaterThan(1800);
    expect(info.durationMs).toBeLessThan(2300);
    expect(info.sampleRate).toBe(44100);
    expect(info.bitrateKbps).toBeGreaterThan(0);
    expect(info.format).toEqual({ codec: "mp3", container: "mp3", mime: "audio/mpeg", lossless: false });
  });

  it("reads flac tags, keeps a distinct album artist, and reports lossless", async () => {
    const file = makeAudioFixture(path.join(root, "tagged.flac"), { ...tagged, albumArtist: "Various Artists", disc: "2" }, 1, log);
    const info = await readParrotTrackInfo(file);
    log("info", info);
    expect(info.title).toBe("Nook");
    expect(info.artist).toBe("Linnet Park");
    expect(info.albumArtist).toBe("Various Artists");
    expect(info.album).toBe("Meltway");
    expect(info.number).toBe(13);
    expect(info.disc).toBe(2);
    expect(info.year).toBe(2003);
    expect(info.durationMs).toBeGreaterThan(900);
    expect(info.durationMs).toBeLessThan(1200);
    expect(info.sampleRate).toBe(44100);
    expect(info.format.codec).toBe("flac");
    expect(info.format.mime).toBe("audio/flac");
    expect(info.format.lossless).toBe(true);
  });

  it("marks an Apple Lossless .m4a as ALAC, lossless, with its codec in the MIME type (PAR-FMT-01)", async () => {
    const file = makeAudioFixture(path.join(root, "lossless.m4a"), tagged, 1, log, ["-c:a", "alac"]);
    const info = await readParrotTrackInfo(file);
    log("info", info);
    expect(info.title).toBe("Nook");
    expect(info.format.codec).toBe("alac");
    expect(info.format.container).toBe("mp4");
    expect(info.format.mime).toBe("audio/mp4; codecs=alac");
    expect(info.format.lossless).toBe(true);
  });

  it("keeps an AAC .m4a as lossy AAC", async () => {
    const info = await readParrotTrackInfo(makeAudioFixture(path.join(root, "lossy.m4a"), tagged, 1, log));
    expect(info.format.codec).toBe("aac");
    expect(info.format.mime).toBe("audio/mp4");
    expect(info.format.lossless).toBe(false);
  });

  it("collapses whitespace in tags and treats blank tags as missing", async () => {
    const dir = path.join(root, "Folder Artist", "Folder Album");
    await fs.mkdir(dir, { recursive: true });
    const file = makeAudioFixture(path.join(dir, "05 - From Name.mp3"), { title: "  Nook   (Live) ", artist: "   ", album: "" }, 1, log);
    const info = await readParrotTrackInfo(file);
    log("info", info);
    expect(info.title).toBe("Nook (Live)");
    expect(info.artist).toBe("Folder Artist");
    expect(info.album).toBe("Folder Album");
    expect(info.number).toBe(5);
  });

  it("falls back to file and folder names for an untagged file", async () => {
    const dir = path.join(root, "Linnet Park", "Hollow Signal");
    await fs.mkdir(dir, { recursive: true });
    const file = makeAudioFixture(path.join(dir, "03 - Paperboat.flac"), {}, 1, log);
    const info = await readParrotTrackInfo(file);
    log("info", info);
    expect(info.title).toBe("Paperboat");
    expect(info.number).toBe(3);
    expect(info.disc).toBe(1);
    expect(info.album).toBe("Hollow Signal");
    expect(info.artist).toBe("Linnet Park");
    expect(info.albumArtist).toBe("Linnet Park");
    expect(info.year).toBeNull();
  });

  // @bugfix @regression-proof: an untagged song straight in the picked Music folder showed the user's home folder
  // as its artist and "Musique" as its album (Parrot desktop local QA, 2026-11-07).
  it("never names an album or artist after the picked folder or the folders above it", async () => {
    const home = path.join(root, "user");
    const music = path.join(home, "Musique");
    await fs.mkdir(path.join(music, "Linnet Park", "Hollow Signal"), { recursive: true });
    const loose = makeAudioFixture(path.join(music, "Loose Song.mp3"), {}, 1, log);
    const looseInfo = await readParrotTrackInfo(loose, music);
    log("loose info", looseInfo);
    expect(looseInfo.title).toBe("Loose Song");
    expect(looseInfo.album).toBe("Unknown album");
    expect(looseInfo.artist).toBe("Unknown artist");

    const inAlbum = makeAudioFixture(path.join(music, "Linnet Park", "Hollow Signal", "03 - Paperboat.mp3"), {}, 1, log);
    const inAlbumInfo = await readParrotTrackInfo(inAlbum, music);
    log("in-album info", inAlbumInfo);
    expect(inAlbumInfo.album).toBe("Hollow Signal");
    expect(inAlbumInfo.artist).toBe("Linnet Park");

    // One level down: the album folder counts, the picked folder above it does not name the artist.
    const albumOnly = makeAudioFixture(path.join(music, "Linnet Park", "04 - Points.mp3"), {}, 1, log);
    const albumOnlyInfo = await readParrotTrackInfo(albumOnly, music);
    log("album-only info", albumOnlyInfo);
    expect(albumOnlyInfo.album).toBe("Linnet Park");
    expect(albumOnlyInfo.artist).toBe("Unknown artist");
  });

  // @bugfix @regression-proof: untagged "Linnet Park - Fable.mp3" and "Dusk Pike - Lowlands - 03 - Velvet Static.mp3"
  // showed as Unknown artist with the whole file name as the title (Parrot desktop walk, 2026-11-12).
  it("reads the artist, album, track number and title from an `Artist - Title` file name (PAR-META-02)", async () => {
    const music = path.join(root, "named");
    await fs.mkdir(path.join(music, "Loose"), { recursive: true });
    const fable = await readParrotTrackInfo(makeAudioFixture(path.join(music, "Loose", "Linnet Park - Fable.mp3"), {}, 1, log), path.join(music, "Loose"));
    log("fable", fable);
    expect([fable.artist, fable.albumArtist, fable.album, fable.title, fable.number]).toEqual(["Linnet Park", "Linnet Park", "Unknown album", "Fable", 0]);
    const love = await readParrotTrackInfo(makeAudioFixture(path.join(music, "Loose", "Dusk Pike - Lowlands - 03 - Velvet Static.mp3"), {}, 1, log), music);
    log("velvet static", love);
    expect([love.artist, love.album, love.title, love.number]).toEqual(["Dusk Pike", "Lowlands", "Velvet Static", 3]);
    // A tag still wins over the file name; the file name fills only what the tags lack.
    const tagged = await readParrotTrackInfo(makeAudioFixture(path.join(music, "Loose", "Dusk Pike - One More Wave.mp3"), { title: "One More Wave (Radio Edit)" }, 1, log), music);
    expect([tagged.artist, tagged.title]).toEqual(["Dusk Pike", "One More Wave (Radio Edit)"]);
  });

  it("reads the artist, album and year from an `Artist - Album (Year)` folder name (PAR-META-02)", async () => {
    const dir = path.join(root, "folders", "Linnet Park - Hollow Signal (2000) [FLAC]");
    await fs.mkdir(dir, { recursive: true });
    const info = await readParrotTrackInfo(makeAudioFixture(path.join(dir, "03 - Paperboat.flac"), {}, 1, log), path.join(root, "folders"));
    log("info", info);
    expect([info.artist, info.album, info.year, info.title, info.number]).toEqual(["Linnet Park", "Hollow Signal", 2000, "Paperboat", 3]);
  });

  it("reads the compilation flag and the album artist a compilation is matched by", async () => {
    const file = makeAudioFixture(
      path.join(root, "01 - Linnet Park - What I've Kept.mp3"),
      { title: "What I've Kept", artist: "Linnet Park", albumArtist: "Various Artists", album: "Clockworkers: The Album", compilation: "1" },
      1,
      log
    );
    const info = await readParrotTrackInfo(file);
    log("info", info);
    expect([info.artist, info.albumArtist, info.compilation]).toEqual(["Linnet Park", "Various Artists", true]);
    expect((await readParrotTrackInfo(makeAudioFixture(path.join(root, "plain.mp3"), { title: "Nook", artist: "Linnet Park" }, 1, log))).compilation).toBe(false);
  });

  it("uses the album artist tag as the artist when only it is set", async () => {
    const file = makeAudioFixture(path.join(root, "albumartist-only.mp3"), { title: "Nook", albumArtist: "Linnet Park", album: "Meltway" }, 1, log);
    const info = await readParrotTrackInfo(file);
    log("info", info);
    expect(info.artist).toBe("Linnet Park");
    expect(info.albumArtist).toBe("Linnet Park");
    expect(info.number).toBe(0);
  });

  it("refuses a file that is not a Parrot audio format", async () => {
    const file = path.join(root, "cover.jpg");
    await fs.writeFile(file, "jpeg");
    await expect(readParrotTrackInfo(file)).rejects.toThrow("not an audio file Parrot imports");
  });
  it("reads the file's ReplayGain tags for even volume (PAR-PLAY-03), and none when untagged", async () => {
    const file = path.join(root, "gained.flac");
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1"];
    for (const [key, value] of [
      ["REPLAYGAIN_TRACK_GAIN", "-6.50 dB"],
      ["REPLAYGAIN_TRACK_PEAK", "0.891251"],
      ["REPLAYGAIN_ALBUM_GAIN", "-7.25 dB"],
      ["REPLAYGAIN_ALBUM_PEAK", "0.977237"],
    ]) args.push("-metadata", `${key}=${value}`);
    ffmpegFixture(file, args, log);
    const info = await readParrotTrackInfo(file);
    log("replaygain", info.loudness);
    expect(info.loudness?.gainDb).toBeCloseTo(-6.5, 2);
    expect(info.loudness?.peak).toBeCloseTo(0.891251, 4);
    expect(info.loudness?.albumGainDb).toBeCloseTo(-7.25, 2);
    expect(info.loudness?.albumPeak).toBeCloseTo(0.977237, 4);

    const plain = await readParrotTrackInfo(makeAudioFixture(path.join(root, "plain.flac"), { title: "Plain" }, 1, log));
    expect(plain.loudness).toBeNull();
  });

  // @req PAR-META-15: a file tagged with its artist's id gives the library artist that id at import.
  it("gives the tagged artist id to the imported artist, and none for a credit to several", async () => {
    const LP = "5e1c0a2d-4b7f-4c3a-9d21-7a6b3c9e0f15";
    const JAY = "f82bcf78-5b69-4622-a5ef-73800768d9ac";
    const flac = (name: string, tags: Record<string, string>) => {
      const file = path.join(root, name);
      const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1"];
      for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
      return ffmpegFixture(file, args, log);
    };
    const info = await readParrotTrackInfo(
      flac("tagged.flac", { TITLE: "Nook", ARTIST: "Linnet Park", ALBUMARTIST: "Linnet Park", ALBUM: "Meltway", [ARTIST_ID_FILE_TAGS.artist]: LP, [ARTIST_ID_FILE_TAGS.albumArtist]: LP })
    );
    log("artist id tags", { artistMusicId: info.artistMusicId, albumArtistMusicId: info.albumArtistMusicId });
    expect(info.artistMusicId).toBe(LP);
    expect(info.albumArtistMusicId).toBe(LP);
    const ops = buildParrotTrackOps({ info, fileHash: "a".repeat(64), sizeBytes: 1, chunks: [], now: 1 });
    const artistOps = ops.filter((op) => op.type === "artist.upsert").map((op) => op.payload);
    log("artist ops", artistOps);
    expect(artistOps).toEqual([expect.objectContaining({ name: "Linnet Park", musicId: LP })]);

    const joint = await readParrotTrackInfo(
      flac("tagged-joint.flac", { TITLE: "Nook/Reprise", ARTIST: "Jun-O & Linnet Park", ALBUMARTIST: "Jun-O & Linnet Park", [ARTIST_ID_FILE_TAGS.artist]: `${JAY}; ${LP}` })
    );
    log("joint credit", { artistMusicId: joint.artistMusicId });
    expect(joint.artistMusicId).toBeNull();
    const untagged = await readParrotTrackInfo(makeAudioFixture(path.join(root, "untagged.flac"), { title: "Plain" }, 1, log));
    expect(untagged.artistMusicId).toBeNull();
  });
});
