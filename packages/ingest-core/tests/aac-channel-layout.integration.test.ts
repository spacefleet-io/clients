/**
 * @test-id INGEST-AAC-LAYOUT-001
 * @level integration
 * @why #1176: a 5.1 sound track whose source layout is 5.1(side) (AC-3, E-AC-3
 *      and DTS sources, or an AAC already written that way) was stored as AAC
 *      with channel configuration 0 (program config element). Chrome's MSE
 *      parser rejects it (`CHUNK_DEMUXER_ERROR_APPEND_FAILED`), so the web
 *      player could not play the track. Every stored track of 1-6 channels must
 *      carry a standard channel configuration (1-6).
 * @covers packages/ingest-core/src/mediaProcessor.ts: encodeDashAudio,
 *      packages/ingest-core/src/aacChannelLayout.ts
 * @risk Requires ffmpeg + ffprobe binaries — skipped when unavailable. Runs on
 *      the SHIPPED media-deps ffmpeg (no `sine` source, no AC-3 encoder): the
 *      sound comes from a wav written here with the layout's channel mask, and
 *      the non-AAC source is that PCM copied into a .mov, which keeps the
 *      layout. Ingest re-encodes every non-AAC track the same way (AC-3, E-AC-3,
 *      DTS or PCM), so PCM stands in for the AC-3 of the report.
 * @bugfix @regression-proof red before the fix: the non-AAC 5.1(side) and the
 *      copied AAC 5.1(side) sources both stored channel configuration 0.
 */
// @req PLAT-WEB-02[badger-web-player]

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFfmpeg, runFfprobe } from "@space/ffmpeg";
import { requireMediaBinary, WAV_CHANNEL_MASKS, writeToneWav } from "@space/media-deps";
import { readAacChannelConfiguration } from "../src/aacChannelLayout";
import { configureMediaIngestRuntime, produceMediaOutputs } from "../src/mediaProcessor";

const SUITE = "aac-channel-layout-integration";

const ffmpegAvailable = requireMediaBinary(
  "ffmpeg",
  await runFfmpeg(["-version"]).then(
    () => true,
    () => false,
  ),
);

describe("stored AAC channel layout (real ffmpeg, #1176)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-aac-layout-"));
    console.info(`[${SUITE}:setup] root=${root}`);
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: () => {
        throw new Error("produceMediaOutputs must not encrypt");
      },
      uploadStorageObject: async () => {
        throw new Error("produceMediaOutputs must not upload");
      },
    });
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] removing root=${root}`);
    rmSync(root, { recursive: true, force: true });
  });

  /** `codec` "aac" encodes the tone as AAC in a .mkv; "pcm" copies it untouched into a .mov (keeps the layout). */
  const makeSource = async (name: string, layout: keyof typeof WAV_CHANNEL_MASKS, codec: "aac" | "pcm") => {
    const path = join(root, `${name}.${codec === "pcm" ? "mov" : "mkv"}`);
    const wav = join(root, `${name}.wav`);
    writeToneWav(wav, { hz: 440, seconds: 3, channelMask: WAV_CHANNEL_MASKS[layout] });
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=160x120:r=24",
      "-i", wav,
      "-t", "3",
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", codec === "pcm" ? "copy" : "aac",
      path,
    ]);
    const probe = await runFfprobe(["-v", "quiet", "-print_format", "json", "-show_streams", path]);
    const audio = probe.streams.find((s) => s.codec_type === "audio");
    console.info(
      `[${SUITE}:fixture] ${name} codec=${audio?.codec_name} channels=${audio?.channels} layout=${audio?.channel_layout}`,
    );
    return path;
  };

  const storedChannelConfiguration = async (inputPath: string, jobId: string) => {
    const logs: string[] = [];
    const result = await produceMediaOutputs({
      userId: "u1",
      jobId,
      inputPath,
      includeSource: true,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: false,
      includeChapters: false,
      onLog: (line) => logs.push(line),
    });
    const audio = result.stateStore.getState().outputs.find((o) => o.id === "audio-0");
    const initPath = audio?.init?.path;
    if (!initPath) {
      console.error(`[${SUITE}:dump] ${jobId} no audio init; outputs=${JSON.stringify(result.stateStore.getState().outputs.map((o) => o.id))}`);
      console.error(`[${SUITE}:dump] last logs:\n${logs.slice(-20).join("\n")}`);
    }
    const init = readFileSync(initPath!);
    const config = readAacChannelConfiguration(init);
    const esds = init.indexOf("esds");
    console.info(
      `[${SUITE}:result] ${jobId} channelConfiguration=${config} esds=${init.subarray(esds, esds + 48).toString("hex")}`,
    );
    return { config, logs };
  };

  it.skipIf(!ffmpegAvailable)(
    "@bugfix @regression-proof stores a non-AAC (PCM) 5.1(side) track as AAC channel configuration 6",
    async () => {
      const source = await makeSource("pcm-side", "5.1(side)", "pcm");
      const { config } = await storedChannelConfiguration(source, "j-pcm-side");
      expect(config).toBe(6);
    },
    120_000,
  );

  it.skipIf(!ffmpegAvailable)(
    "@bugfix @regression-proof re-encodes a copied AAC 5.1(side) track (configuration 0) to configuration 6, its layout read from the program config element",
    async () => {
      const source = await makeSource("aac-side", "5.1(side)", "aac");
      const { config, logs } = await storedChannelConfiguration(source, "j-aac-side");
      expect(config).toBe(6);
      expect(logs.some((line) => line.includes("copied AAC has channel configuration 0"))).toBe(true);
      // The shipped ffprobe (FFmpeg 8) names no layout for a configuration-0 AAC: the PCE is what says 5.1(side).
      expect(logs.some((line) => line.includes("program config element 5.1(side)"))).toBe(true);
    },
    120_000,
  );

  it.skipIf(!ffmpegAvailable)(
    "copies a stereo AAC track untouched",
    async () => {
      const source = await makeSource("aac-stereo", "stereo", "aac");
      const { config, logs } = await storedChannelConfiguration(source, "j-aac-stereo");
      expect(config).toBe(2);
      expect(logs.some((line) => line.includes("re-encoding"))).toBe(false);
    },
    120_000,
  );

  it.skipIf(!ffmpegAvailable)(
    "keeps a 2.1 track's LFE: no remix into 3.0 (configuration 3), stored as it is pending INGS-AUDIO-01",
    async () => {
      const source = await makeSource("pcm-2.1", "2.1", "pcm");
      const { config } = await storedChannelConfiguration(source, "j-pcm-2.1");
      expect(config).toBe(0);
    },
    120_000,
  );
});
