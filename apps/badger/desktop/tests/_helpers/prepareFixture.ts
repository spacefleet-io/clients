/**
 * Generic helper to remux a checked-in fixture MKV into a temp copy with
 * caller-specified audio / subtitle / chapter layout overrides.
 *
 * Why this exists
 * ---------------
 * The checked-in Saltmarsh MKV fixtures (and similar small MKVs) preserve
 * subtitle stream metadata (title, language, disposition) but their actual
 * subtitle packets are empty — `ffprobe` shows
 * `TAG:DURATION=00:00:00.000000000` on each subtitle stream and ffmpeg
 * extraction produces a 0-byte SRT.
 *
 * mpv refuses to load empty external subtitle files — its log emits
 * `Can not open external file …`. That makes mpv-side `track-list`
 * assertions of subtitle presence (e.g. `pipeline-smoke` test 3,
 * `playback-e2e` test 1) impossible to satisfy with the raw fixture.
 *
 * This helper remuxes an arbitrary source MKV with the requested layout,
 * filling any subtitle streams with a small real SRT payload so mpv loads
 * them. The output keeps the source filename so ingest-side title parsing
 * remains stable.
 *
 * If `layout` is omitted, the function performs a remux-only pass that
 * preserves the original metadata as-is. This is useful for callers that
 * need a writable temp copy without altering the stream layout.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const DEFAULT_SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "Subtitle line 1",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,000",
  "Subtitle line 2",
  "",
  "3",
  "00:00:07,000 --> 00:00:09,000",
  "Subtitle line 3",
  "",
].join("\n");

const FORCED_SRT = [
  "1",
  "00:00:02,000 --> 00:00:04,000",
  "Forced",
  "",
].join("\n");

const ISO639_2_TO_3: Record<string, string> = {
  en: "eng",
  eng: "eng",
  fr: "fre",
  fre: "fre",
  fra: "fre",
  es: "spa",
  spa: "spa",
  de: "ger",
  ger: "ger",
  deu: "ger",
};

const toIso639_2 = (lang: string) => ISO639_2_TO_3[lang.toLowerCase()] ?? lang;

export type FixtureLayout = {
  audio?: Array<{ codec: string; channels: number; language: string; label?: string }>;
  subtitles?: Array<{ codec: string; language: string; content?: string; forced?: boolean }>;
  chapters?: Array<{ startSeconds: number; title?: string }>;
};

/**
 * Remux `sourcePath` into a temporary file at the same basename. When
 * `layout` is provided, the audio / subtitle / chapter layout is overridden;
 * any subtitle entries without explicit `content` get a small default SRT
 * payload so mpv can load them. When `layout` is omitted, the source
 * metadata is preserved (remux only).
 *
 * The output path is returned. Caller is responsible for cleaning up the
 * containing temp directory if needed (it lives under `os.tmpdir()`).
 */
export const prepareFixture = async (
  sourcePath: string,
  layout?: FixtureLayout,
): Promise<string> => {
  const tmpDir = await mkdtemp(join(tmpdir(), "sf-fixture-"));
  const outPath = join(tmpDir, basename(sourcePath));

  // Remux-only path — preserve everything the source already has.
  if (!layout) {
    const args = [
      "-y",
      "-v", "error",
      "-i", sourcePath,
      "-map", "0",
      "-c", "copy",
      outPath,
    ];
    execFileSync("ffmpeg", args, { encoding: "utf8", timeout: 60_000 });
    return outPath;
  }

  const ffmpegArgs: string[] = ["-y", "-v", "error", "-i", sourcePath];

  // Materialize each requested subtitle stream to a temp .srt input so we
  // can guarantee non-empty payloads for mpv consumption.
  const subtitleInputPaths: string[] = [];
  const subtitles = layout.subtitles ?? [];
  await Promise.all(
    subtitles.map(async (sub, idx) => {
      const path = join(tmpDir, `sub-${idx}.srt`);
      const payload = sub.content ?? (sub.forced ? FORCED_SRT : DEFAULT_SRT);
      await writeFile(path, payload, "utf8");
      subtitleInputPaths.push(path);
    }),
  );
  for (const path of subtitleInputPaths) {
    ffmpegArgs.push("-i", path);
  }

  // Optional chapters via ffmetadata input.
  const chapters = layout.chapters ?? [];
  let chapterInputIndex = -1;
  if (chapters.length > 0) {
    const metaPath = join(tmpDir, "chapters.ffmetadata");
    const lines = [";FFMETADATA1"];
    for (let i = 0; i < chapters.length; i += 1) {
      const start = Math.round(chapters[i].startSeconds * 1000);
      const end =
        i + 1 < chapters.length
          ? Math.round(chapters[i + 1].startSeconds * 1000)
          : start + 1000;
      lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${start}`, `END=${end}`);
      if (chapters[i].title) lines.push(`title=${chapters[i].title}`);
    }
    await writeFile(metaPath, `${lines.join("\n")}\n`, "utf8");
    chapterInputIndex = 1 + subtitleInputPaths.length;
    ffmpegArgs.push("-i", metaPath);
  }

  // Map streams: video from source, audio from source (one-to-one with
  // requested audio entries), then each subtitle from its dedicated input.
  ffmpegArgs.push("-map", "0:v:0");
  const audio = layout.audio ?? [];
  for (let i = 0; i < audio.length; i += 1) {
    ffmpegArgs.push("-map", `0:a:${i}?`);
  }
  for (let i = 0; i < subtitleInputPaths.length; i += 1) {
    ffmpegArgs.push("-map", `${1 + i}:0`);
  }
  if (chapterInputIndex >= 0) {
    ffmpegArgs.push("-map_chapters", String(chapterInputIndex));
  }

  // Codec selection — copy video and audio, transcode subtitles to SRT.
  ffmpegArgs.push("-c:v", "copy");
  if (audio.length > 0) ffmpegArgs.push("-c:a", "copy");
  if (subtitleInputPaths.length > 0) ffmpegArgs.push("-c:s", "srt");

  // Audio metadata (language + optional label).
  for (let i = 0; i < audio.length; i += 1) {
    ffmpegArgs.push(`-metadata:s:a:${i}`, `language=${toIso639_2(audio[i].language)}`);
    if (audio[i].label) {
      ffmpegArgs.push(`-metadata:s:a:${i}`, `title=${audio[i].label}`);
    }
  }

  // Subtitle metadata + dispositions.
  for (let i = 0; i < subtitles.length; i += 1) {
    const sub = subtitles[i];
    ffmpegArgs.push(`-metadata:s:s:${i}`, `language=${toIso639_2(sub.language)}`);
    if (sub.forced) {
      ffmpegArgs.push(`-disposition:s:${i}`, "forced+default");
    }
  }

  ffmpegArgs.push(outPath);
  execFileSync("ffmpeg", ffmpegArgs, { encoding: "utf8", timeout: 60_000 });
  return outPath;
};
