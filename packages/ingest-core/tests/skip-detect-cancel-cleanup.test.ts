/**
 * @test-id INGEST-SKIP-CANCEL-CLEANUP-001
 * @level integration
 * @why Imports always go first (MPV-PREV-07): a catch-up video gives way by killing its decode (ffmpeg for the
 *      pictures, mpv for the sound) mid-run. The kill must leave no partial pictures or sound files behind, and the
 *      next run of that step must start clean and give the same result as a run that was never cut. Real ffmpeg and
 *      real mpv on a generated clip; the kill is the one the runtime sends (cancel, SIGKILL).
 * @covers packages/ingest-core/src/previewSheets.ts: generateSkipPicture
 * @covers packages/ingest-core/src/skipDetect/audio.ts: analyzeSkipAudio
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFfmpegTask } from "@space/ffmpeg";
import { requireMediaBinary } from "@space/media-deps";
import { generateSkipPicture } from "../src/previewSheets";
import { analyzeSkipAudio } from "../src/skipDetect";

const SUITE = "skip-detect-cancel-cleanup";
const which = (name: string): string | null => {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
};
const ffmpegAvailable = requireMediaBinary("ffmpeg", which("ffmpeg") !== null);
const mpvPath = which("mpv");
const THREADS = { input: ["-threads", "2"], output: ["-threads", "1"] };
const DURATION = 900;
// mpv from the system next to the shipped ffmpeg bundle on PATH: keep the bundle's libraries away from it.
const MPV_ENV = { ...process.env, LD_LIBRARY_PATH: "" };

/** Every file and directory left under `dir` (relative paths). */
const leftovers = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];

/** The runtime's preview runner (`runFfmpegWithSignal`): an abort cancels the ffmpeg task. */
const runner = (signal?: AbortSignal, onSpawn?: () => void) => async (args: string[]) => {
  const task = createFfmpegTask(args, { progress: { enabled: false }, onSpawn });
  const kill = () => task.cancel();
  signal?.addEventListener("abort", kill, { once: true });
  try {
    return await task.promise;
  } catch (error) {
    if (signal?.aborted) throw new Error("CANCELLED");
    throw error;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
};

describe.skipIf(!ffmpegAvailable)("a killed skip decode leaves nothing behind and the next run starts clean", () => {
  let root = "";
  let clip = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sf-skip-cancel-"));
    clip = join(root, "clip.mkv");
    // The shipped ffmpeg has no audio source filter: a raw 8 kHz tone (warbling, so it is not silence) from here.
    const rate = 8000;
    const tone = new Int16Array(rate * DURATION);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.round(8000 * Math.sin((2 * Math.PI * (440 + 40 * Math.sin(i / 3000)) * i) / rate));
    const wav = join(root, "tone.wav");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + tone.byteLength, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(tone.byteLength, 40);
    writeFileSync(wav, Buffer.concat([header, Buffer.from(tone.buffer)]));
    // 15 minutes, small and fast to decode: both picture windows and both sound windows exist.
    execFileSync("ffmpeg", [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=c=gray:s=192x108:r=5:d=${DURATION}`,
      "-i", wav,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-g", "50", "-c:a", "aac", "-shortest", clip,
    ]);
    console.info(`[${SUITE}:setup] root=${root}`);
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** @req MPV-PREV-07 */
  it("pictures: a decode killed mid-run leaves no pictures, and the next run matches an uncut one", async () => {
    const workDir = join(root, "pictures");
    const abort = new AbortController();
    // Killed once ffmpeg has written pictures, so there is something partial to clean up.
    let writtenAtKill = 0;
    const killOnceWriting = () => {
      const poll = setInterval(() => {
        writtenAtKill = leftovers(workDir).filter((name) => name.endsWith(".png")).length;
        if (writtenAtKill === 0) return;
        clearInterval(poll);
        abort.abort();
      }, 10);
    };
    const cut = generateSkipPicture({
      inputPath: clip,
      workDir,
      durationSeconds: DURATION,
      threads: THREADS,
      run: runner(abort.signal, killOnceWriting),
      signal: abort.signal,
    });
    await expect(cut).rejects.toThrow("CANCELLED");
    console.info(`[${SUITE}:pictures] pictures at kill=${writtenAtKill} after kill leftovers=${JSON.stringify(leftovers(workDir))}`);
    expect(writtenAtKill).toBeGreaterThan(0);
    expect(leftovers(workDir)).toEqual([]);

    const again = await generateSkipPicture({ inputPath: clip, workDir, durationSeconds: DURATION, threads: THREADS, run: runner() });
    const fresh = await generateSkipPicture({
      inputPath: clip,
      workDir: join(root, "pictures-fresh"),
      durationSeconds: DURATION,
      threads: THREADS,
      run: runner(),
    });
    console.info(`[${SUITE}:pictures] rerun=${JSON.stringify({ head: again.head?.hashes.length, tail: again.tail.hashes.length })}`);
    expect(again).toEqual(fresh);
    expect(leftovers(workDir)).toEqual([]);
  }, 120_000);

  /** @req MPV-PREV-07 */
  it.skipIf(!mpvPath)("sound: a decode killed mid-run leaves no sound files, and the next run matches an uncut one", async () => {
    const workDir = join(root, "sound");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 150);
    const cut = analyzeSkipAudio({ mpvPath: mpvPath!, env: MPV_ENV, inputPath: clip, durationSeconds: DURATION, workDir, signal: abort.signal });
    await expect(cut).rejects.toThrow("CANCELLED");
    console.info(`[${SUITE}:sound] after kill exists=${existsSync(workDir)} leftovers=${JSON.stringify(leftovers(workDir))}`);
    expect(existsSync(workDir)).toBe(false);

    const again = await analyzeSkipAudio({ mpvPath: mpvPath!, env: MPV_ENV, inputPath: clip, durationSeconds: DURATION, workDir });
    const fresh = await analyzeSkipAudio({ mpvPath: mpvPath!, env: MPV_ENV, inputPath: clip, durationSeconds: DURATION, workDir: join(root, "sound-fresh") });
    expect(again).toEqual(fresh);
    expect(existsSync(workDir)).toBe(false);
  }, 120_000);
});
