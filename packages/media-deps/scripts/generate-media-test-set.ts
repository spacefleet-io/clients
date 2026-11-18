#!/usr/bin/env bun
/**
 * Writes the media format test set (REL-DEPS-11, `src/mediaTestSet.ts`) and its `expectations.json`.
 *
 * Needs a full-featured ffmpeg + ffprobe on PATH (test tooling, never shipped): libx264, libx265, libsvtav1,
 * libvpx, libopus, libvorbis, libmp3lame, libwebp and the experimental dca/truehd/mlp encoders. The system ffmpeg of
 * a rolling distro or Homebrew's `ffmpeg` qualify. Downloads five FATE samples (pinned by sha256) once.
 *
 * Every written file is checked with ffprobe against the fixture's expectation (codec, size, channels, sample rate,
 * demuxer), so a wrong recipe fails here rather than on the phone. Existing outputs are kept; `--force` rewrites.
 *
 *   bun packages/media-deps/scripts/generate-media-test-set.ts [--out DIR] [--force] [--only id,id]
 *
 * Default output: packages/media-deps/cache/media-test-set/ (gitignored: the set is regenerated, never committed).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  MEDIA_TEST_SET,
  MEDIA_TEST_SET_UNCOVERED,
  MEDIA_TEST_SET_VERSION,
  type MediaTestExpectationEntry,
  type MediaTestExpectationsFile,
  type MediaTestFixture,
  type MediaTestProbed,
  type MediaTestStep,
} from "../src/mediaTestSet";
import { writeSyntheticPgs } from "../src/syntheticMedia";
import { parseArgs } from "./_args";

const DEFAULT_OUT = resolve(import.meta.dir, "../cache/media-test-set");
const LOG = "[media-test-set]";

/** lavf demuxer names that differ from their configure component name. */
const LAVF_NAME: Record<string, string> = {
  mpegps: "mpeg",
  image_jpeg_pipe: "jpeg_pipe",
  image_png_pipe: "png_pipe",
  image_webp_pipe: "webp_pipe",
  image_bmp_pipe: "bmp_pipe",
};

type ProbeStream = { codec_type: string; codec_name: string; width?: number; height?: number; channels?: number; sample_rate?: string; nb_read_frames?: string };
type Probe = { streams: ProbeStream[]; format: { format_name: string; duration?: string } };

const run = (cwd: string, cmd: string, args: string[]): string => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${LOG} ${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stderr}`);
  return r.stdout;
};

const stepOutputs = (step: MediaTestStep): string[] => {
  if ("ffmpeg" in step) return [step.ffmpeg[step.ffmpeg.length - 1]!];
  if ("text" in step) return [step.text.path];
  if ("pgs" in step) return [step.pgs.path];
  return [step.fetch.path];
};

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const runStep = async (out: string, step: MediaTestStep): Promise<void> => {
  for (const file of stepOutputs(step)) mkdirSync(dirname(join(out, file)), { recursive: true });
  if ("ffmpeg" in step) {
    console.info(`${LOG} ffmpeg -> ${stepOutputs(step)[0]}`);
    run(out, "ffmpeg", ["-y", "-hide_banner", "-nostdin", "-loglevel", "error", ...step.ffmpeg]);
  } else if ("text" in step) {
    writeFileSync(join(out, step.text.path), step.text.body);
  } else if ("pgs" in step) {
    writeSyntheticPgs(join(out, step.pgs.path), step.pgs);
  } else {
    const path = join(out, step.fetch.path);
    if (!existsSync(path) || sha256(path) !== step.fetch.sha256) {
      console.info(`${LOG} fetch ${step.fetch.url}`);
      const response = await fetch(step.fetch.url);
      if (!response.ok) throw new Error(`${LOG} ${step.fetch.url}: HTTP ${response.status}`);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    }
    const actual = sha256(path);
    if (actual !== step.fetch.sha256) throw new Error(`${LOG} ${step.fetch.url}: sha256 ${actual}, pinned ${step.fetch.sha256}`);
  }
};

const probe = (out: string, file: string, opts: { countFrames: boolean; hls: boolean }): Probe =>
  JSON.parse(
    run(out, "ffprobe", [
      "-v", "error", ...(opts.countFrames ? ["-count_frames"] : []),
      // lavf's hls demuxer refuses the AES key's non-media extension over file:// (the phone fetches it over HTTP).
      ...(opts.hls ? ["-allowed_extensions", "ALL"] : []),
      "-show_entries", "stream=codec_type,codec_name,width,height,channels,sample_rate,nb_read_frames:format=format_name,duration",
      "-of", "json", file,
    ]),
  ) as Probe;

/** ffprobe the written fixture and fail on any mismatch with its expectation. */
const check = (out: string, fixture: MediaTestFixture): MediaTestProbed => {
  const { expect } = fixture;
  const info = probe(out, fixture.file, { countFrames: Boolean(expect.video), hls: expect.transport === "hls" });
  const problems: string[] = [];
  const formats = info.format.format_name.split(",");
  const demuxers = (fixture.covers.demuxer ?? []).filter((name) => name !== "hls" || expect.transport === "hls");
  const own = demuxers.map((name) => LAVF_NAME[name] ?? name);
  if (!expect.subtitle?.sidecar && !own.some((name) => formats.includes(name)) && expect.transport !== "hls") {
    problems.push(`format ${info.format.format_name}, expected one of ${own.join("|")}`);
  }
  const stream = (type: string) => info.streams.find((s) => s.codec_type === type);
  if (expect.video) {
    const s = stream("video");
    if (!s) problems.push("no video stream");
    else {
      if (s.codec_name !== expect.video.codec) problems.push(`video codec ${s.codec_name}, expected ${expect.video.codec}`);
      if (s.width !== expect.video.width || s.height !== expect.video.height) problems.push(`video ${s.width}x${s.height}, expected ${expect.video.width}x${expect.video.height}`);
    }
  }
  if (expect.audio) {
    const s = stream("audio");
    if (!s) problems.push("no audio stream");
    else {
      if (s.codec_name !== expect.audio.codec) problems.push(`audio codec ${s.codec_name}, expected ${expect.audio.codec}`);
      if (s.channels !== expect.audio.channels) problems.push(`audio channels ${s.channels}, expected ${expect.audio.channels}`);
      if (Number(s.sample_rate) !== expect.audio.sampleRate) problems.push(`audio rate ${s.sample_rate}, expected ${expect.audio.sampleRate}`);
    }
  }
  if (expect.subtitle) {
    const subInfo = expect.subtitle.sidecar ? probe(out, expect.subtitle.sidecar, { countFrames: false, hls: false }) : info;
    const s = subInfo.streams.find((x) => x.codec_type === "subtitle");
    if (s?.codec_name !== expect.subtitle.codec) problems.push(`subtitle codec ${s?.codec_name}, expected ${expect.subtitle.codec}`);
    if (expect.subtitle.sidecar) {
      const sidecarFormats = subInfo.format.format_name.split(",");
      if (!own.some((name) => sidecarFormats.includes(name))) problems.push(`sidecar format ${subInfo.format.format_name}, expected one of ${own.join("|")}`);
    }
  }
  if (problems.length) throw new Error(`${LOG} ${fixture.id}: ${problems.join("; ")}\nffprobe: ${JSON.stringify(info)}`);
  const duration = Number(info.format.duration);
  const frames = Number(stream("video")?.nb_read_frames);
  return {
    durationS: expect.image || !Number.isFinite(duration) ? null : Math.round(duration * 1000) / 1000,
    frames: Number.isFinite(frames) ? frames : null,
    lavfFormat: info.format.format_name,
  };
};

const fixtureBytes = (out: string, fixture: MediaTestFixture): number => {
  const sizeOf = (path: string): number => {
    const stat = statSync(path);
    return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0) : stat.size;
  };
  const played = fixture.expect.transport === "hls" ? dirname(fixture.file) : fixture.file;
  return sizeOf(join(out, played)) + (fixture.expect.subtitle?.sidecar ? sizeOf(join(out, fixture.expect.subtitle.sidecar)) : 0);
};

export const generateMediaTestSet = async (opts: { out: string; force: boolean; only?: string[] }): Promise<MediaTestExpectationsFile> => {
  const fixtures = opts.only ? MEDIA_TEST_SET.filter((f) => opts.only!.includes(f.id)) : MEDIA_TEST_SET;
  if (opts.force) rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });
  const ffmpegVersion = run(opts.out, "ffmpeg", ["-hide_banner", "-version"]).split("\n")[0]!;
  console.info(`${LOG} out=${opts.out} fixtures=${fixtures.length} ${ffmpegVersion}`);
  const done = new Set<string>();
  const entries: MediaTestExpectationEntry[] = [];
  for (const fixture of fixtures) {
    const t0 = performance.now();
    for (const step of fixture.build) {
      const key = JSON.stringify(step);
      if (done.has(key)) continue;
      const present = stepOutputs(step).every((file) => existsSync(join(opts.out, file)) && statSync(join(opts.out, file)).size > 0);
      if (!present || "fetch" in step) await runStep(opts.out, step);
      done.add(key);
    }
    const probed = check(opts.out, fixture);
    const { build: _build, ...rest } = fixture;
    const entry: MediaTestExpectationEntry = { ...rest, probed, bytes: fixtureBytes(opts.out, fixture) };
    entries.push(entry);
    console.info(`${LOG} ok ${fixture.id} ${entry.bytes} B duration=${probed.durationS} frames=${probed.frames} format=${probed.lavfFormat} (${Math.round(performance.now() - t0)} ms)`);
  }
  const expectations: MediaTestExpectationsFile = {
    version: MEDIA_TEST_SET_VERSION,
    generatedBy: ffmpegVersion,
    fixtures: entries,
    uncovered: { ...MEDIA_TEST_SET_UNCOVERED },
  };
  writeFileSync(join(opts.out, "expectations.json"), `${JSON.stringify(expectations, null, 2)}\n`);
  return expectations;
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const only = typeof args.only === "string" ? args.only.split(",") : undefined;
  const out = resolve(typeof args.out === "string" ? args.out : DEFAULT_OUT);
  const result = await generateMediaTestSet({ out, force: args.force === true, only });
  const total = result.fixtures.reduce((sum, f) => sum + f.bytes, 0);
  console.info(`${LOG} wrote ${result.fixtures.length} fixtures + expectations.json to ${out}; played bytes ${(total / 1024 / 1024).toFixed(2)} MiB`);
}
