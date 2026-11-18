/**
 * @test-id INGEST-SILENT-SOURCE-001
 * @level integration
 * @why F3 (ultimate stress, issue #25): a source with NO audio stream (screen
 *      recording, silent film, test clip) used to be rejected with
 *      NO_AUDIO_STREAM after the video was already encoded, leaving a media
 *      row with no formats. Real ffprobe/ffmpeg run over a genuinely silent
 *      clip — no mocks of the media layer — must produce a playable video
 *      format and zero audio tracks.
 * @covers packages/ingest-core/src/mediaProcessor.ts: processMediaJob
 * @risk Requires ffmpeg + ffprobe binaries — skipped when unavailable.
 * @bugfix @regression-proof red on the unfixed guard (PR #42): the generated
 *      `-an` clip failed with `failure=NO_AUDIO_STREAM`; post-fix it produces
 *      one video format with chunks and zero audio tracks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFfmpeg, runFfprobe } from "@space/ffmpeg";
import { requireMediaBinary } from "@space/media-deps";
import { configureMediaIngestRuntime, processMediaJob } from "../src/mediaProcessor";
import type { ProducedMedia } from "../src/mediaProcessor";

const SUITE = "silent-source-ingest-integration";

const ffmpegAvailable = requireMediaBinary(
  "ffmpeg",
  await runFfmpeg(["-version"]).then(
    () => true,
    () => false,
  ),
);

describe("silent source ingest (real ffmpeg)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-silent-ingest-"));
    console.info(`[${SUITE}:setup] root=${root}`);
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] removing root=${root}`);
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!ffmpegAvailable)(
    "@bugfix @regression-proof ingests an audio-less clip into a video format with zero audio tracks",
    async () => {
      const silentClip = join(root, "Ultimate Silent (2019).mkv");
      console.info(`[${SUITE}:fixture] generating silent clip ${silentClip}`);
      await runFfmpeg([
        "-y",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:r=24",
        "-t", "4",
        "-an",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        silentClip,
      ]);
      const probe = await runFfprobe(["-v", "quiet", "-print_format", "json", "-show_streams", silentClip]);
      const audioStreams = probe.streams.filter((s) => s.codec_type === "audio");
      console.info(`[${SUITE}:fixture] streams=${probe.streams.map((s) => s.codec_type).join(",")}`);
      expect(audioStreams).toHaveLength(0);

      const uploaded: string[] = [];
      configureMediaIngestRuntime({
        resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
        encryptMediaObject: (bytes) => bytes,
        uploadStorageObject: async (_token: string, objectKey: string) => {
          uploaded.push(objectKey);
          return `persisted-${objectKey}`;
        },
      });

      const logs: string[] = [];
      let produced: ProducedMedia | undefined;
      let failure: unknown;
      try {
        const result = await processMediaJob({
          token: "token",
          userId: "user-1",
          jobId: "job-silent",
          placementId: "placement-silent",
          inputPath: silentClip,
          includeSource: true,
          includeFallback: false,
          includeAudio: true,
          includeSubtitles: false,
          onLog: (line) => logs.push(line),
        });
        produced = result.produced;
      } catch (err) {
        failure = err;
      }
      console.info(
        `[${SUITE}:result] failure=${failure instanceof Error ? failure.message : "none"} videoFormats=${produced?.videoFormats.length} audioTracks=${produced?.audioTracks.length} uploaded=${uploaded.length}`,
      );
      if (failure || !produced) {
        console.error(`[${SUITE}:dump] last logs:\n${logs.slice(-20).join("\n")}`);
      }
      expect(failure).toBeUndefined();
      expect(produced?.videoFormats).toHaveLength(1);
      expect(produced?.videoFormats[0]?.initKey).toBeTruthy();
      expect(produced?.videoFormats[0]?.chunks.length).toBeGreaterThan(0);
      expect(produced?.audioTracks).toHaveLength(0);
      expect(logs.some((line) => line.includes("no audio streams"))).toBe(true);
    },
    120_000,
  );
});
