/**
 * One episode's audio analysis for shared-audio skip detection (META-SKIP-04): the first and last 10 minutes are
 * decoded to 11025 Hz mono 16-bit samples, fingerprinted (`chromaprintRaw`) and scanned for silences, and the
 * result is stored per episode (`media_skip_analysis`, kind {@link SKIP_AUDIO_ANALYSIS_KIND}) so the show can be
 * matched again whenever an episode is added, without decoding the others.
 *
 * The decode runs the bundled mpv (`--ao=pcm`): the bundled ffmpeg has no PCM encoder and no raw audio muxer
 * (`packages/media-deps/src/features.ts`), and mpv ships on every OS Badger desktop runs on. It runs at the lowest
 * CPU priority and writes into the caller's work dir.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { setPriority } from "node:os";
import { join as joinPath } from "node:path";
import { CHROMAPRINT_SAMPLE_RATE, chromaprintRaw, chromaprintRawAsync } from "./chromaprint";
import type { SkipEpisodeAudio } from "./match";

/** Seconds decoded at each end of an episode (the benchmark's window). */
export const SKIP_AUDIO_WINDOW_SECONDS = 600;
/** `media_skip_analysis.kind` of an episode's stored analysis. */
export const SKIP_AUDIO_ANALYSIS_KIND = "chromaprint-v1";

/** ffmpeg `silencedetect=noise=-50dB:duration=0.33` on 16-bit samples: |sample| < 10^(-50/20) * 32767. */
const SILENCE_AMPLITUDE = 10 ** (-50 / 20) * 32767;
const SILENCE_MIN_SAMPLES = Math.ceil(0.33 * CHROMAPRINT_SAMPLE_RATE);

export type SkipAudioAnalysisPayload = {
  version: 1;
  durationSeconds: number;
  tailOffsetSeconds: number;
  /** Little-endian uint32 sub-fingerprints, base64. */
  head: string;
  tail: string;
  /** Silences of at least 0.33 s below -50 dBFS in both windows, absolute seconds. */
  silences: Array<[number, number]>;
};

/** Silences of at least 0.33 s in `samples` (which start at `offsetSeconds`), absolute seconds rounded to ms. */
export const findSilences = (samples: Int16Array, offsetSeconds: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  let runStart = -1;
  const close = (end: number) => {
    if (runStart >= 0 && end - runStart >= SILENCE_MIN_SAMPLES) {
      const at = (i: number) => Math.round((offsetSeconds + i / CHROMAPRINT_SAMPLE_RATE) * 1000) / 1000;
      out.push([at(runStart), at(end)]);
    }
    runStart = -1;
  };
  for (let i = 0; i < samples.length; i++) {
    const quiet = Math.abs(samples[i]!) < SILENCE_AMPLITUDE;
    if (quiet && runStart < 0) runStart = i;
    else if (!quiet && runStart >= 0) close(i);
  }
  close(samples.length);
  return out;
};

const toBase64 = (fp: Uint32Array) => {
  const bytes = Buffer.alloc(fp.length * 4);
  for (let i = 0; i < fp.length; i++) bytes.writeUInt32LE(fp[i]!, i * 4);
  return bytes.toString("base64");
};

const fromBase64 = (text: string) => {
  const bytes = Buffer.from(text, "base64");
  const fp = new Uint32Array(bytes.length >> 2);
  for (let i = 0; i < fp.length; i++) fp[i] = bytes.readUInt32LE(i * 4);
  return fp;
};

/** Fingerprints and silences of an episode's two decoded windows. */
export const buildSkipAudioAnalysis = (input: {
  durationSeconds: number;
  head: Int16Array;
  tail: Int16Array;
  tailOffsetSeconds: number;
}): SkipAudioAnalysisPayload => {
  const silences = [...findSilences(input.head, 0), ...findSilences(input.tail, input.tailOffsetSeconds)].sort(
    (a, b) => a[0] - b[0]
  );
  return {
    version: 1,
    durationSeconds: input.durationSeconds,
    tailOffsetSeconds: input.tailOffsetSeconds,
    head: toBase64(chromaprintRaw(input.head)),
    tail: toBase64(chromaprintRaw(input.tail)),
    silences,
  };
};

/** `buildSkipAudioAnalysis` giving the event loop turns while it fingerprints (MPV-PREV-07); same payload. */
export const buildSkipAudioAnalysisAsync = async (input: {
  durationSeconds: number;
  head: Int16Array;
  tail: Int16Array;
  tailOffsetSeconds: number;
  signal?: AbortSignal;
}): Promise<SkipAudioAnalysisPayload> => {
  const cancelled = () => {
    if (input.signal?.aborted) throw new Error("CANCELLED");
  };
  cancelled();
  const silences = [...findSilences(input.head, 0), ...findSilences(input.tail, input.tailOffsetSeconds)].sort(
    (a, b) => a[0] - b[0]
  );
  return {
    version: 1,
    durationSeconds: input.durationSeconds,
    tailOffsetSeconds: input.tailOffsetSeconds,
    head: toBase64(await chromaprintRawAsync(input.head, input.signal)),
    tail: toBase64(await chromaprintRawAsync(input.tail, input.signal)),
    silences,
  };
};

/** The stored payload as the matcher's input; null when it is not a version-1 analysis. */
export const skipEpisodeAudioFromPayload = (
  episode: { id: string; season: number; episode: number },
  payload: unknown
): SkipEpisodeAudio | null => {
  const p = payload as Partial<SkipAudioAnalysisPayload> | null;
  if (!p || p.version !== 1 || typeof p.head !== "string" || typeof p.tail !== "string") return null;
  if (typeof p.durationSeconds !== "number" || typeof p.tailOffsetSeconds !== "number") return null;
  return {
    ...episode,
    durationSeconds: p.durationSeconds,
    head: fromBase64(p.head),
    tail: fromBase64(p.tail),
    tailOffsetSeconds: p.tailOffsetSeconds,
    silences: Array.isArray(p.silences) ? p.silences : [],
  };
};

/** Decode `lengthSeconds` of the first audio track from `startSeconds` to 11025 Hz mono s16 with mpv. */
const decodeWindow = async (args: {
  mpvPath: string;
  inputPath: string;
  startSeconds: number;
  lengthSeconds: number;
  outPath: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}): Promise<Int16Array> => {
  const mpvArgs = [
    "--no-config",
    "--msg-level=all=warn",
    "--vo=null",
    "--vid=no",
    "--sid=no",
    "--aid=1",
    "--hr-seek=yes",
    "--ao=pcm",
    `--ao-pcm-file=${args.outPath}`,
    "--ao-pcm-waveheader=no",
    "--audio-channels=mono",
    `--audio-samplerate=${CHROMAPRINT_SAMPLE_RATE}`,
    "--audio-format=s16",
    `--start=${args.startSeconds.toFixed(3)}`,
    `--length=${args.lengthSeconds.toFixed(3)}`,
    "--",
    args.inputPath,
  ];
  // Never start a decode for a pass that was already told to give way (MPV-PREV-07).
  if (args.signal?.aborted) throw new Error("CANCELLED");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(args.mpvPath, mpvArgs, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: args.env ?? process.env,
  });
  if (child.pid !== undefined) {
    try {
      setPriority(child.pid, 19);
    } catch {
      // Lowering priority is best effort (some sandboxes refuse it); the decode is short either way.
    }
  }
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const onAbort = () => child.kill("SIGKILL");
  args.signal?.addEventListener("abort", onAbort, { once: true });
  // An abort that landed between the check above and the spawn: the listener never fires for it.
  if (args.signal?.aborted) onAbort();
  child.on("error", (err) => {
    args.signal?.removeEventListener("abort", onAbort);
    reject(err);
  });
  child.on("close", (code) => {
    args.signal?.removeEventListener("abort", onAbort);
    if (args.signal?.aborted) return reject(new Error("CANCELLED"));
    if (stderr.trim()) args.onLog?.(`[skip-detect] mpv: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
    if (code !== 0) return reject(new Error(`SKIP_AUDIO_DECODE_FAILED code=${code}`));
    resolve();
  });
  await promise;
  const raw = await fs.readFile(args.outPath);
  await fs.rm(args.outPath, { force: true });
  return new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1).slice();
};

/**
 * Decode and analyse both ends of a local media file. `workDir` is created and removed. Throws when the file has
 * no audio or the decode fails.
 */
export const analyzeSkipAudio = async (args: {
  mpvPath: string;
  inputPath: string;
  durationSeconds: number;
  workDir: string;
  /** mpv's environment (the platform layer's launch env, which puts the bundle's libraries on the search path). */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}): Promise<SkipAudioAnalysisPayload> => {
  await fs.mkdir(args.workDir, { recursive: true });
  try {
    const startedAt = Date.now();
    const length = Math.min(SKIP_AUDIO_WINDOW_SECONDS, args.durationSeconds);
    const tailOffsetSeconds = Math.max(0, args.durationSeconds - SKIP_AUDIO_WINDOW_SECONDS);
    const head = await decodeWindow({ ...args, startSeconds: 0, lengthSeconds: length, outPath: joinPath(args.workDir, "head.pcm") });
    const tail = await decodeWindow({
      ...args,
      startSeconds: tailOffsetSeconds,
      lengthSeconds: length,
      outPath: joinPath(args.workDir, "tail.pcm"),
    });
    if (head.length < CHROMAPRINT_SAMPLE_RATE || tail.length < CHROMAPRINT_SAMPLE_RATE) {
      throw new Error(`SKIP_AUDIO_TOO_SHORT head=${head.length} tail=${tail.length}`);
    }
    const decodedAt = Date.now();
    const payload = await buildSkipAudioAnalysisAsync({
      durationSeconds: args.durationSeconds,
      head,
      tail,
      tailOffsetSeconds,
      signal: args.signal,
    });
    args.onLog?.(
      `[skip-detect] analysed decodeMs=${decodedAt - startedAt} fingerprintMs=${Date.now() - decodedAt} headSamples=${head.length} tailSamples=${tail.length} silences=${payload.silences.length}`
    );
    return payload;
  } finally {
    await fs.rm(args.workDir, { recursive: true, force: true });
  }
};
