/**
 * Shared helper to remux the checked-in Saltmarsh fixture into a temp copy
 * with real SRT subtitle content on every subtitle stream.
 *
 * Why this exists
 * ---------------
 * The checked-in Saltmarsh MKV fixtures
 * (`packages/ingest-core/fixtures/ingest/video/Saltmarsh - S01E01 - …`,
 *  `… - S01E02 - …`) preserve subtitle stream metadata (title, language,
 *  disposition) but their actual subtitle packets are empty — `ffprobe` shows
 *  `TAG:DURATION=00:00:00.000000000` on each subtitle stream and ffmpeg
 *  extraction produces a 0-byte SRT.
 *
 * mpv refuses to load empty external subtitle files — its log emits
 *  `Can not open external file …`. That makes mpv-side `track-list`
 *  assertions of subtitle presence (e.g. `pipeline-smoke` test 3,
 *  `playback-e2e` test 1) impossible to satisfy with the raw fixture.
 *
 * What this does
 * --------------
 * Remuxes the source MKV with the same 5-track subtitle layout
 *  (3× English, 2× French, with the last one flagged forced+default), but
 *  fills each stream with a small real SRT payload. The output keeps the
 *  source filename so ingest-side title parsing remains stable and library-
 *  db / renderer / OSC continue to pick the same titles + tagging the tests
 *  assert on.
 *
 * The resulting file is comparable in size to the source (the SRT payload
 *  adds <1 KiB), so test runtime cost is unchanged.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const ENGLISH_SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "English subtitle line 1",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,000",
  "English subtitle line 2",
  "",
  "3",
  "00:00:07,000 --> 00:00:09,000",
  "English subtitle line 3",
  "",
].join("\n");

const FRENCH_SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "Sous-titre francais ligne 1",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,000",
  "Sous-titre francais ligne 2",
  "",
].join("\n");

const FRENCH_FORCED_SRT = [
  "1",
  "00:00:02,000 --> 00:00:04,000",
  "Force 1",
  "",
].join("\n");

/**
 * Remux `sourcePath` (the checked-in Saltmarsh fixture MKV) into a
 * temporary file at the same basename, with non-empty subtitle streams.
 *
 * `loops` (default 0) plays the ~10 s source video+audio `loops + 1` times
 * (ffmpeg `-stream_loop`, still a stream copy). Resume tests need it: a
 * resume is offered only at >= 2% AND >= 15 s watched (PLAY-RESUME-01), which
 * a 10 s clip can never reach.
 *
 * The output path is returned. Caller is responsible for cleaning up the
 * containing temp directory if needed (it lives under `os.tmpdir()`).
 */
export const prepareSaltmarshFixture = async (
  sourcePath: string,
  options: { loops?: number } = {},
): Promise<string> => {
  const loops = options.loops ?? 0;
  const tmpDir = await mkdtemp(join(tmpdir(), "sf-fixture-saltmarsh-"));
  const enSrt = join(tmpDir, "en.srt");
  const frSrt = join(tmpDir, "fr.srt");
  const frForcedSrt = join(tmpDir, "fr-forced.srt");
  await Promise.all([
    writeFile(enSrt, ENGLISH_SRT, "utf8"),
    writeFile(frSrt, FRENCH_SRT, "utf8"),
    writeFile(frForcedSrt, FRENCH_FORCED_SRT, "utf8"),
  ]);
  // Keep the source filename so ingest-side title parsing remains stable.
  const outPath = join(tmpDir, basename(sourcePath));
  const ffmpegArgs = [
    "-y",
    "-v", "error",
    ...(loops > 0 ? ["-stream_loop", String(loops)] : []),
    "-i", sourcePath,
    "-i", enSrt,
    "-i", enSrt,
    "-i", enSrt,
    "-i", frSrt,
    "-i", frForcedSrt,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-map", "1:0",
    "-map", "2:0",
    "-map", "3:0",
    "-map", "4:0",
    "-map", "5:0",
    "-c:v", "copy",
    "-c:a", "copy",
    "-c:s", "srt",
    "-metadata:s:s:0", "language=eng",
    "-metadata:s:s:0", "title=English",
    "-metadata:s:s:1", "language=eng",
    "-metadata:s:s:1", "title=English",
    "-metadata:s:s:2", "language=eng",
    "-metadata:s:s:2", "title=English",
    "-metadata:s:s:3", "language=fre",
    "-metadata:s:s:3", "title=French",
    "-metadata:s:s:4", "language=fre",
    "-metadata:s:s:4", "title=French Forced",
    "-disposition:s:4", "forced+default",
    outPath,
  ];
  // argv, no shell: POSIX quoting reaches ffmpeg as literal quotes under cmd.exe on Windows.
  execFileSync("ffmpeg", ffmpegArgs, { encoding: "utf8", timeout: 60_000 });
  return outPath;
};
