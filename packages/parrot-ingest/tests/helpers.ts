import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, promises as fs, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Greppable test logging: every line carries the test id, then the message and each detail (labels as plain text). */
export const testLog = (testId: string) => (message: string, ...details: unknown[]) => {
  const shown = details.map((detail) =>
    typeof detail === "string" ? detail : JSON.stringify(detail, (_key, value) => (value instanceof Uint8Array ? `<${value.length} bytes>` : value)) ?? String(detail)
  );
  console.log([`[${testId}] ${message}`, ...shown].join(" "));
};

export const makeTempDir = async (label: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), `parrot-ingest-${label}-`));

export type AudioFixtureTags = {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  track?: string;
  disc?: string;
  date?: string;
  /** "1": the iTunes compilation flag. */
  compilation?: string;
  /** A picture file embedded as the front cover (MP3 and FLAC only). */
  picture?: string;
};

/**
 * The committed media fixtures, one file per ffmpeg command. CI runs these suites with the ffmpeg the apps ship
 * (the CI media-deps script), a playback build that has no `sine` source and no FLAC, Vorbis, Opus, ALAC or WAV
 * writer, so it cannot make them. A command's file is found by a hash of its arguments, each input file (`-i`)
 * replaced by the hash of its bytes, and the output's extension.
 */
const FIXTURE_STORE = path.join(import.meta.dir, "fixtures", "media");

/**
 * Writes `file` as `ffmpeg ...args file` would, from the committed store. A command the store does not hold yet is
 * run once with the ffmpeg on PATH (SF_FIXTURE_FFMPEG overrides it), which needs a full build, and its output is added
 * to the store to be committed.
 */
export const ffmpegFixture = (file: string, args: readonly string[], log?: (m: string, d?: unknown) => void) => {
  const keyed = args.map((arg, i) => (args[i - 1] === "-i" && existsSync(arg) ? `sha256:${createHash("sha256").update(readFileSync(arg)).digest("hex")}` : arg));
  const ext = path.extname(file).toLowerCase();
  const key = createHash("sha256").update(JSON.stringify({ ext, args: keyed })).digest("hex").slice(0, 24);
  const stored = path.join(FIXTURE_STORE, `${key}${ext}`);
  log?.("ffmpeg fixture", { args: args.join(" "), stored: path.basename(stored) });
  if (existsSync(stored)) {
    copyFileSync(stored, file);
    return file;
  }
  const ffmpeg = process.env.SF_FIXTURE_FFMPEG ?? "ffmpeg";
  try {
    execFileSync(ffmpeg, [...args, file], { stdio: ["ignore", "inherit", "inherit"] });
  } catch (error) {
    throw new Error(
      `media fixture ${path.relative(process.cwd(), stored)} is not committed and ${ffmpeg} could not make it (${String(error)}). ` +
        "Run the suite once with a full ffmpeg on PATH (or SF_FIXTURE_FFMPEG), then commit the new files in tests/fixtures/media."
    );
  }
  mkdirSync(FIXTURE_STORE, { recursive: true });
  copyFileSync(file, stored);
  console.log(`[parrot-ingest fixtures] recorded ${path.relative(process.cwd(), stored)}: commit it`);
  return file;
};

/** Draws a `size`×`size` JPEG of one colour with ffmpeg; returns its path. */
export const makeCoverPicture = (file: string, color = "red", size = 64) =>
  ffmpegFixture(file, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}x${size}`, "-frames:v", "1"]);

const ENCODERS: Record<string, string[]> = {
  ".mp3": ["-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "3"],
  ".flac": ["-c:a", "flac"],
  ".ogg": ["-c:a", "libvorbis"],
  ".opus": ["-c:a", "libopus"],
  ".m4a": ["-c:a", "aac"],
  ".wav": ["-c:a", "pcm_s16le"],
};

/**
 * Encodes a short sine tone with ffmpeg into `file`, tagged with `tags`; returns the file path. `encoder` overrides
 * the codec the extension picks (e.g. `["-c:a", "alac"]` for an Apple Lossless `.m4a`).
 */
export const makeAudioFixture = (
  file: string,
  tags: AudioFixtureTags = {},
  seconds = 1,
  log?: (m: string, d?: unknown) => void,
  encoder = ENCODERS[path.extname(file).toLowerCase()]
) => {
  if (!encoder) throw new Error(`no fixture encoder for ${file}`);
  const metadata: string[] = [];
  const add = (key: string, value: string | undefined) => {
    if (value !== undefined) metadata.push("-metadata", `${key}=${value}`);
  };
  add("title", tags.title);
  add("artist", tags.artist);
  add("album_artist", tags.albumArtist);
  add("album", tags.album);
  add("track", tags.track);
  add("disc", tags.disc);
  add("date", tags.date);
  add("compilation", tags.compilation);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    ...(tags.picture ? ["-i", tags.picture, "-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic", "-metadata:s:v", "comment=Cover (front)"] : []),
    "-ac",
    "1",
    "-ar",
    "44100",
    ...metadata,
    ...encoder,
  ];
  return ffmpegFixture(file, args, log);
};
