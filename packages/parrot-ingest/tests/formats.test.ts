/**
 * @test-id PARROT-INGEST-FORMATS-001
 * @level unit
 * @why PAR-UP-01: Parrot imports audio files only; covers, booklets, logs, cue sheets and lyrics in a ripped
 *      album folder must never be uploaded, and a folder walk must find every song once, in a stable order.
 * @covers packages/parrot-ingest/src/formats.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { findParrotAudioFiles, isParrotAudioFile, PARROT_AUDIO_FORMATS, parrotAudioFormatFor } from "../src/formats";
import { makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-FORMATS-001");

describe("parrot audio formats", () => {
  it("maps each supported extension to its codec, case-insensitively", () => {
    log("supported extensions", Object.keys(PARROT_AUDIO_FORMATS));
    expect(parrotAudioFormatFor("/music/a.mp3")).toEqual({ codec: "mp3", container: "mp3", mime: "audio/mpeg", lossless: false });
    expect(parrotAudioFormatFor("/music/B.FLAC")).toEqual({ codec: "flac", container: "flac", mime: "audio/flac", lossless: true });
    expect(parrotAudioFormatFor("x.M4a")?.codec).toBe("aac");
    expect(parrotAudioFormatFor("x.opus")).toEqual({ codec: "opus", container: "ogg", mime: "audio/ogg", lossless: false });
    expect(parrotAudioFormatFor("x.wav")?.lossless).toBe(true);
    for (const ext of Object.keys(PARROT_AUDIO_FORMATS)) {
      const format = parrotAudioFormatFor(`song${ext}`);
      log(`format for ${ext}`, format);
      expect(format).not.toBeNull();
      expect(format!.mime.startsWith("audio/")).toBe(true);
    }
  });

  it("rejects everything that is not an importable audio file", () => {
    const rejected = ["cover.jpg", "folder.png", "booklet.pdf", "eac.log", "album.cue", "song.lrc", "notes.txt", "song.alac", "song.aiff", "song.wma", "mp3", "noext", "song.mp3.part"];
    for (const name of rejected) {
      log(`isParrotAudioFile(${name})`, isParrotAudioFile(name));
      expect(isParrotAudioFile(name)).toBe(false);
      expect(parrotAudioFormatFor(name)).toBeNull();
    }
  });
});

describe("findParrotAudioFiles", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeTempDir("scan");
    const files = [
      "Linnet Park/Meltway/01 - Forecast.mp3",
      "Linnet Park/Meltway/13 - Nook.flac",
      "Linnet Park/Meltway/cover.jpg",
      "Linnet Park/Meltway/eac.log",
      "Linnet Park/Meltway/Meltway.cue",
      "Linnet Park/Meltway/13 - Nook.lrc",
      "Linnet Park/Hollow Signal/03 - Paperboat.OGG",
      "Linnet Park/Hollow Signal/.hidden.mp3",
      ".Trash/deleted.mp3",
      "loose.wav",
      "readme.txt",
    ];
    for (const rel of files) {
      const full = path.join(root, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, "not really audio");
    }
    log("fixture tree", { root, files });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("walks folders, keeps audio only, skips hidden entries, and sorts", async () => {
    const skipped: Array<[string, string]> = [];
    const found = await findParrotAudioFiles([root], (entry, reason) => skipped.push([entry, reason]));
    log("found", found.map((file) => path.relative(root, file)));
    log("skipped", skipped);
    expect(found.map((file) => path.relative(root, file))).toEqual(
      [
        "Linnet Park/Hollow Signal/03 - Paperboat.OGG",
        "Linnet Park/Meltway/01 - Forecast.mp3",
        "Linnet Park/Meltway/13 - Nook.flac",
        "loose.wav",
      ]
        .map((rel) => path.join(root, rel))
        .sort()
        .map((file) => path.relative(root, file))
    );
    expect(found.every((file) => path.isAbsolute(file))).toBe(true);
    expect(skipped).toEqual([]);
  });

  it("accepts files and overlapping roots, lists each file once, and reports missing roots", async () => {
    const nook = path.join(root, "Linnet Park/Meltway/13 - Nook.flac");
    const missing = path.join(root, "does-not-exist");
    const skipped: Array<[string, string]> = [];
    const found = await findParrotAudioFiles(
      [nook, path.join(root, "Linnet Park/Meltway"), path.join(root, "Linnet Park/Meltway/cover.jpg"), missing],
      (entry, reason) => skipped.push([entry, reason])
    );
    log("found", found);
    log("skipped", skipped);
    expect(found).toEqual([path.join(root, "Linnet Park/Meltway/01 - Forecast.mp3"), nook]);
    expect(skipped.map(([entry]) => entry)).toEqual([missing]);
    expect(skipped[0]![1]).toContain("ENOENT");
  });

  it("reports an unreadable folder and keeps walking", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      log("skipping: chmod does not block reads here");
      return;
    }
    const locked = path.join(root, "Locked");
    await fs.mkdir(locked, { recursive: true });
    await fs.writeFile(path.join(locked, "song.mp3"), "x");
    await fs.chmod(locked, 0o000);
    try {
      const skipped: Array<[string, string]> = [];
      const found = await findParrotAudioFiles([root], (entry, reason) => skipped.push([entry, reason]));
      log("found", found.length);
      log("skipped", skipped);
      expect(skipped.map(([entry]) => entry)).toEqual([locked]);
      expect(found).toContain(path.join(root, "loose.wav"));
      expect(found.some((file) => file.startsWith(locked))).toBe(false);
    } finally {
      await fs.chmod(locked, 0o755);
      await fs.rm(locked, { recursive: true, force: true });
    }
  });

  // @bugfix @regression-proof: a symlink back to an ancestor folder made the walk recurse until the path grew too
  // long, listing every song once per loop level (hundreds of duplicate paths for the import to hash).
  it("walks each real folder once, even through a symlink loop or a second link to the same folder", async () => {
    const loopRoot = await makeTempDir("scan-loop");
    try {
      const album = path.join(loopRoot, "Linnet Park", "Meltway");
      await fs.mkdir(album, { recursive: true });
      await fs.writeFile(path.join(album, "13 - Nook.mp3"), "x");
      try {
        await fs.symlink(loopRoot, path.join(album, "back-to-root"), "dir");
        await fs.symlink(album, path.join(loopRoot, "Meltway shortcut"), "dir");
      } catch (error) {
        log("skipping: cannot create directory symlinks here", String(error));
        return;
      }
      const skipped: Array<[string, string]> = [];
      const found = await findParrotAudioFiles([loopRoot], (entry, reason) => skipped.push([entry, reason]));
      log("found", found);
      log("skipped", skipped);
      expect(found).toHaveLength(1);
      expect(path.basename(found[0]!)).toBe("13 - Nook.mp3");
      expect(skipped).toEqual([]);
    } finally {
      await fs.rm(loopRoot, { recursive: true, force: true });
    }
  });
});
