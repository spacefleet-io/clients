/**
 * @test-id INGEST-NVENC-SCALE-CUDA-001
 * @level integration
 * @why Ultimate stress (issue #25), NVIDIA test machine (RTX 5090): an add-quality 720p
 *      job died with `h264_nvenc` + `scale_cuda`:
 *        "Impossible to convert between the formats supported by the filter
 *         'Parsed_scale_cuda_0' and the filter 'auto_scale_0'".
 *      Root cause: the NVENC recipe ended `-vf scale_cuda=-2:H … -pix_fmt
 *      yuv420p`. `-pix_fmt` on the OUTPUT appends a software `format=yuv420p`
 *      sink after `scale_cuda`, whose frames are CUDA surfaces → ffmpeg
 *      auto-inserts a CPU `scale` that cannot convert hw frames. #36 only
 *      masked it (hardware encode throws → silent libx264 retry) and its probe
 *      never exercised the filter chain, so the probe kept saying "nvenc ok".
 *
 *      These tests run REAL ffmpeg on the REAL GPU (no mocks) and assert the
 *      hardware path itself works: no `[fallback]` log line, the variant is
 *      produced by h264_nvenc/hevc_nvenc, as 8-bit 4:2:0 at the target height —
 *      for 8-bit / 10-bit / 4:4:4 / 4:2:2 sources and codecs NVDEC cannot
 *      decode (software-decode → upload path).
 * @covers packages/ingest-core/src/mediaProcessor.ts: buildVideoEncoderArgs
 *         (nvenc), probeHardwareEncoder, encodeDashVideoWithFallback
 * @risk Needs ffmpeg with *_nvenc + scale_cuda AND a working NVIDIA GPU.
 *       Skipped LOUDLY (console.warn) otherwise so CI without a GPU stays green.
 * @bugfix @regression-proof red on the unfixed recipe (PR #43, TDD first
 *      version): every raw row failed with "Impossible to convert between the
 *      formats supported by the filter 'Parsed_scale_cuda_0' and the filter
 *      'auto_scale_0'", 4:4:4 H.264 with "graph -1 input from stream 0:0",
 *      and the pipeline rows logged `[fallback]`; green after dropping the
 *      output `-pix_fmt` and routing frames through `hwupload,scale_cuda`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobState } from "@space/content-core";
import { runFfmpeg, runFfprobe } from "@space/ffmpeg";
import {
  buildVideoEncoderArgs,
  configureMediaIngestRuntime,
  produceMediaOutputs,
  resetEncoderProbeCache,
} from "../src/mediaProcessor";

const SUITE = "nvenc-scale-cuda-integration";

// ---------------------------------------------------------------------------
// Capability gate: a real NVENC + scale_cuda encode must work on this host.
// ---------------------------------------------------------------------------
const detectNvidia = async (): Promise<{ ok: boolean; reason: string }> => {
  try {
    await runFfmpeg(["-version"]);
  } catch (err) {
    return { ok: false, reason: `ffmpeg unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    // Deliberately the *plain* encoder (no scale_cuda): the gate must say
    // "this host has a working NVIDIA GPU", independent of the bug under test.
    await runFfmpeg(
      ["-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=10:d=1", "-frames:v", "3", "-c:v", "h264_nvenc", "-f", "null", "-"],
      { timeoutMs: 20_000 },
    );
    return { ok: true, reason: "plain h264_nvenc test encode succeeded" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `no working NVENC on this host: ${msg.split("\n").slice(-2).join(" | ")}` };
  }
};

const gpu = await detectNvidia();
if (!gpu.ok) {
  console.warn(
    `[${SUITE}:SKIPPED] ⚠⚠⚠ NVENC integration tests SKIPPED — ${gpu.reason}. ` +
      `This regression suite only proves anything on an NVIDIA host.`,
  );
} else {
  console.info(`[${SUITE}:gate] NVIDIA path enabled — ${gpu.reason}`);
}

const FIXTURE_BASE = join(homedir(), ".cache", "sf-ultimate-fixtures", "_base");
const realBases = ["h264-720s.mkv", "hevc-720s.mkv", "h264-1200s.mkv", "hevc-1200s.mkv"]
  .map((name) => ({ name, path: join(FIXTURE_BASE, name) }))
  .filter((entry) => existsSync(entry.path));
console.info(
  `[${SUITE}:gate] real fixture bases found: ${realBases.map((b) => b.name).join(", ") || "none (synthetic matrix only)"}`,
);

type Synthetic = { label: string; codecArgs: string[]; pixFmt: string };
// Each entry is a source shape that used (or could) trip the hw chain:
//  - 10-bit / 4:2:2: NVDEC H.264 cannot decode these → software frames reach the filter graph.
//  - 4:4:4: output must still be 8-bit 4:2:0 for broad playback.
const SYNTHETIC: Synthetic[] = [
  { label: "h264-8bit-420", codecArgs: ["-c:v", "libx264", "-preset", "ultrafast"], pixFmt: "yuv420p" },
  { label: "h264-10bit-420", codecArgs: ["-c:v", "libx264", "-preset", "ultrafast"], pixFmt: "yuv420p10le" },
  { label: "h264-10bit-422", codecArgs: ["-c:v", "libx264", "-preset", "ultrafast"], pixFmt: "yuv422p10le" },
  { label: "h264-8bit-444", codecArgs: ["-c:v", "libx264", "-preset", "ultrafast"], pixFmt: "yuv444p" },
  { label: "hevc-8bit-420", codecArgs: ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error"], pixFmt: "yuv420p" },
  { label: "hevc-10bit-420", codecArgs: ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error"], pixFmt: "yuv420p10le" },
  { label: "hevc-8bit-444", codecArgs: ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error"], pixFmt: "yuv444p" },
  { label: "mpeg4-8bit-420", codecArgs: ["-c:v", "mpeg4"], pixFmt: "yuv420p" },
  { label: "vp9-8bit-420", codecArgs: ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8"], pixFmt: "yuv420p" },
];

const dumpFfmpegFailure = (label: string, args: string[], err: unknown) => {
  console.error(`=== [${SUITE}:${label}] ffmpeg FAILURE ===`);
  console.error(`args: ffmpeg ${args.join(" ")}`);
  console.error(err instanceof Error ? err.message.split("\n").slice(-25).join("\n") : String(err));
};

const probeVideo = async (path: string) => {
  const probe = await runFfprobe(["-v", "error", "-print_format", "json", "-show_streams", "-select_streams", "v:0", path]);
  const stream = probe.streams[0] as Record<string, unknown> | undefined;
  return {
    codec: String(stream?.codec_name ?? ""),
    pixFmt: String(stream?.pix_fmt ?? ""),
    width: Number(stream?.width ?? 0),
    height: Number(stream?.height ?? 0),
  };
};

describe.skipIf(!gpu.ok)("@bugfix @regression-proof nvenc recipe on real ffmpeg + GPU (add-quality 720p)", () => {
  let root = "";
  const sources = new Map<string, string>();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sf-nvenc-scale-cuda-"));
    mkdirSync(join(root, "src"), { recursive: true });
    console.info(`[${SUITE}:setup] root=${root}`);
    for (const synth of SYNTHETIC) {
      const out = join(root, "src", `${synth.label}.mkv`);
      const args = [
        "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=3",
        ...synth.codecArgs, "-pix_fmt", synth.pixFmt, out,
      ];
      console.info(`[${SUITE}:fixture] generating ${synth.label} (${synth.pixFmt})`);
      try {
        await runFfmpeg(args);
      } catch (err) {
        // A missing software encoder (e.g. no libx265 in this ffmpeg) just
        // drops that matrix row — it must not mask the rest.
        console.warn(`[${SUITE}:fixture] cannot generate ${synth.label}: ${err instanceof Error ? err.message.split("\n").slice(-1)[0] : err}`);
        continue;
      }
      sources.set(synth.label, out);
    }
    for (const base of realBases) sources.set(`real:${base.name}`, base.path);
    console.info(`[${SUITE}:setup] source matrix: ${[...sources.keys()].join(", ")}`);
  }, 180_000);

  afterAll(() => {
    console.info(`[${SUITE}:teardown] removing root=${root}`);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // A. The exact argv the product builds, run raw: must succeed and yield an
  //    8-bit 4:2:0 h264 stream at 720p for EVERY source shape.
  // -------------------------------------------------------------------------
  /**
   * @test-id INGEST-NVENC-SCALE-CUDA-002
   * @level integration
   * @why The raw 720p NVENC argv the product builds must negotiate on the GPU
   *      for every source shape (8/10-bit, 4:2:2, 4:4:4, NVDEC-undecodable).
   */
  it("nvenc 720p recipe encodes every source shape on the GPU (no filter-negotiation failure)", async () => {
    const failures: string[] = [];
    const { preArgs, encoderArgs } = buildVideoEncoderArgs("nvenc", null, "720p");
    console.info(`[${SUITE}:raw] preArgs=${preArgs.join(" ")}`);
    console.info(`[${SUITE}:raw] encoderArgs=${encoderArgs.join(" ")}`);
    for (const [label, input] of sources) {
      const out = join(root, `raw-${label.replace(/[^\w.-]/g, "_")}.mp4`);
      // Real bases are long; 5 s is plenty to exercise decode → scale → encode.
      const args = ["-y", ...preArgs, "-t", "5", "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", ...encoderArgs, out];
      const started = Date.now();
      try {
        await runFfmpeg(args, { timeoutMs: 60_000 });
        const info = await probeVideo(out);
        console.info(
          `[${SUITE}:raw:${label}] OK in ${Date.now() - started}ms → ${info.codec} ${info.pixFmt} ${info.width}x${info.height} size=${statSync(out).size}`,
        );
        if (info.codec !== "h264" || info.pixFmt !== "yuv420p" || info.height !== 720) {
          failures.push(`${label}: unexpected output ${JSON.stringify(info)}`);
        }
      } catch (err) {
        dumpFfmpegFailure(`raw:${label}`, args, err);
        failures.push(`${label}: ${err instanceof Error ? err.message.split("\n").slice(-3).join(" | ") : String(err)}`);
      }
    }
    expect(failures, `failures:\n${failures.join("\n")}`).toEqual([]);
  }, 600_000);

  /**
   * @test-id INGEST-NVENC-SCALE-CUDA-003
   * @level integration
   * @why The 2160p hevc_nvenc recipe shares the scale_cuda chain; it must
   *      encode 8-bit and 10-bit sources without filter-negotiation failure.
   */
  it("nvenc 2160p (hevc_nvenc) recipe encodes an 8-bit and a 10-bit source", async () => {
    const { preArgs, encoderArgs } = buildVideoEncoderArgs("nvenc", null, "2160p");
    const failures: string[] = [];
    for (const label of ["h264-8bit-420", "hevc-10bit-420"]) {
      const input = sources.get(label);
      if (!input) continue;
      const out = join(root, `raw-2160-${label}.mp4`);
      const args = ["-y", ...preArgs, "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", ...encoderArgs, out];
      try {
        await runFfmpeg(args, { timeoutMs: 90_000 });
        const info = await probeVideo(out);
        console.info(`[${SUITE}:raw2160:${label}] OK → ${info.codec} ${info.pixFmt} ${info.width}x${info.height}`);
        if (info.codec !== "hevc" || info.pixFmt !== "yuv420p" || info.height !== 2160) {
          failures.push(`${label}: unexpected output ${JSON.stringify(info)}`);
        }
      } catch (err) {
        dumpFfmpegFailure(`raw2160:${label}`, args, err);
        failures.push(`${label}: ${err instanceof Error ? err.message.split("\n").slice(-3).join(" | ") : String(err)}`);
      }
    }
    expect(failures, `failures:\n${failures.join("\n")}`).toEqual([]);
  }, 300_000);

  // -------------------------------------------------------------------------
  // B. Through produceMediaOutputs (the add-quality / retranscode code path):
  //    detectEncoder must pick nvenc AND the 720p variant must be produced by
  //    it — a "[fallback]" log line means hardware silently failed (the bug).
  // -------------------------------------------------------------------------
  const pipelineSources = [
    "h264-8bit-420",
    "h264-10bit-420",
    "hevc-10bit-420",
    "h264-8bit-444",
    // Every real ultimate-suite base (h264 + hevc, full length): the exact
    // add-quality job that failed on the NVIDIA test machine.
    ...realBases.map((base) => `real:${base.name}`),
  ];
  const slug = (label: string) => label.replace(/[^\w.-]/g, "_");
  for (const label of pipelineSources) {
    /**
     * @test-id INGEST-NVENC-SCALE-CUDA-004
     * @level integration
     * @why produceMediaOutputs 720p on a real/synthetic source must stay on
     *      nvenc: a `[fallback]` line means the hardware path broke again.
     */
    it(`produceMediaOutputs 720p on ${label} stays on nvenc (no CPU fallback)`, async () => {
      const input = sources.get(label);
      if (!input) {
        console.warn(`[${SUITE}:pipeline:${label}] source not generated (encoder missing) — skipping row`);
        return;
      }
      resetEncoderProbeCache();
      const jobsRoot = join(root, `jobs-${slug(label)}`);
      configureMediaIngestRuntime({
        resolveJobDir: (userId, jobId) => join(jobsRoot, userId, jobId),
        encryptMediaObject: (bytes) => bytes,
        uploadStorageObject: async (_token: string, objectKey: string) => `persisted-${objectKey}`,
        getGpuVendor: async () => "NVIDIA Corporation",
      });
      const logs: string[] = [];
      const out = await produceMediaOutputs({
        userId: "u1",
        jobId: `job-${slug(label)}`,
        inputPath: input,
        includeSource: false,
        includeFallback: false,
        includeAudio: false,
        includeSubtitles: false,
        includeChapters: false,
        targetVariants: ["720p"],
        onLog: (line) => logs.push(line),
      });
      const fallbackLines = logs.filter((line) => line.includes("[fallback]"));
      console.info(
        `[${SUITE}:pipeline:${label}] encoder=${out.encoder} variants=${out.produced.videoFormats.map((f) => f.quality).join(",")} fallbackLines=${fallbackLines.length}`,
      );
      if (fallbackLines.length > 0) {
        console.error(`[${SUITE}:pipeline:${label}] CPU FALLBACK HAPPENED:\n${fallbackLines.join("\n")}`);
        console.error(`[${SUITE}:pipeline:${label}] last ffmpeg logs:\n${logs.slice(-30).join("\n")}`);
      }
      expect(out.encoder).toBe("nvenc");
      expect(fallbackLines).toEqual([]);
      expect(out.produced.videoFormats).toHaveLength(1);
      expect(out.produced.videoFormats[0]?.quality).toBe("720p");

      // The produced init segment must really be 8-bit 4:2:0 h264 @720p.
      const state = out.stateStore.getState() as JobState;
      const variant = state.outputs.find((o) => o.id.startsWith("video-720p"));
      expect(variant?.segments.length).toBeGreaterThan(0);
      const init = variant?.init?.path;
      expect(init && existsSync(init)).toBe(true);
      const seg = variant!.segments[0]!.path;
      const joined = join(root, `joined-${label}.mp4`);
      // (segments are unencrypted on disk at produce time; init + first segment = a playable fMP4)
      writeFileSync(joined, Buffer.concat([readFileSync(init!), readFileSync(seg)]));
      const info = await probeVideo(joined);
      console.info(`[${SUITE}:pipeline:${label}] produced stream → ${JSON.stringify(info)}`);
      expect(info).toMatchObject({ codec: "h264", pixFmt: "yuv420p", height: 720 });
    }, 180_000);
  }

  // -------------------------------------------------------------------------
  // C. The post-ingest add-quality (retranscode) path streams the source to
  //    ffmpeg over stdin (`-i pipe:0`); hardware decode + hwupload must work
  //    there too, with no CPU retry.
  // -------------------------------------------------------------------------
  for (const label of ["h264-8bit-420", "hevc-10bit-420"]) {
    /**
     * @test-id INGEST-NVENC-SCALE-CUDA-005
     * @level integration
     * @why The add-quality retranscode streams the source over `-i pipe:0`;
     *      hardware decode + hwupload must work there with no CPU retry.
     */
    it(`streaming (retranscode, -i pipe:0) 720p on ${label} stays on nvenc (no CPU fallback)`, async () => {
      const input = sources.get(label);
      if (!input) {
        console.warn(`[${SUITE}:stream:${label}] source not generated — skipping row`);
        return;
      }
      // Fragmented MP4 is what the retranscode pipeline feeds (init + segments concatenated).
      const fragmented = join(root, `stream-${label}.mp4`);
      await runFfmpeg(["-y", "-i", input, "-c", "copy", "-movflags", "frag_keyframe+empty_moov+default_base_moof", fragmented]);
      const bytes = readFileSync(fragmented);
      console.info(`[${SUITE}:stream:${label}] fragmented source ${bytes.length} bytes`);
      const open = async function* (): AsyncGenerator<Uint8Array> {
        const step = 256 * 1024;
        for (let offset = 0; offset < bytes.length; offset += step) yield bytes.subarray(offset, offset + step);
      };
      resetEncoderProbeCache();
      const jobsRoot = join(root, `jobs-stream-${slug(label)}`);
      configureMediaIngestRuntime({
        resolveJobDir: (userId, jobId) => join(jobsRoot, userId, jobId),
        encryptMediaObject: (data) => data,
        uploadStorageObject: async (_token: string, objectKey: string) => `persisted-${objectKey}`,
        getGpuVendor: async () => "NVIDIA Corporation",
      });
      const logs: string[] = [];
      const out = await produceMediaOutputs({
        userId: "u1",
        jobId: `job-stream-${slug(label)}`,
        inputPath: "stream",
        inputStream: open(),
        reopenInputStream: open,
        inputDurationSeconds: 3,
        sourceQualityOverride: "1080p",
        includeSource: false,
        includeFallback: false,
        includeAudio: false,
        includeSubtitles: false,
        includeChapters: false,
        targetVariants: ["720p"],
        onLog: (line) => logs.push(line),
      });
      const fallbackLines = logs.filter((line) => line.includes("[fallback]"));
      console.info(`[${SUITE}:stream:${label}] encoder=${out.encoder} fallbackLines=${fallbackLines.length}`);
      if (fallbackLines.length > 0) {
        console.error(`[${SUITE}:stream:${label}] CPU FALLBACK HAPPENED:\n${fallbackLines.join("\n")}\n${logs.slice(-30).join("\n")}`);
      }
      expect(out.encoder).toBe("nvenc");
      expect(fallbackLines).toEqual([]);
      expect(out.produced.videoFormats.map((f) => f.quality)).toEqual(["720p"]);
    }, 120_000);
  }
});
