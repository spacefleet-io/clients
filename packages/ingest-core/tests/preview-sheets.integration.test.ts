/**
 * @test-id INGEST-PREVIEW-SHEETS-001
 * @level integration
 * @why MPV-PREV-02: after the source commit, the runtime makes the seek-bar
 *      preview pictures on this computer, from the local file: one 160 px wide
 *      picture every 5 seconds, packed 10 x 10 per JPEG sheet, encrypted and
 *      uploaded on the media's placement, and returns the library record.
 *      Real ffprobe/ffmpeg run over a generated clip; only the storage
 *      transport and the cipher are faked (a marker prefix stands in for the
 *      encryption so the test can prove every sheet went through it). A
 *      temporary upload error is retried like a video chunk; a lasting one
 *      throws after reporting every key already stored, so the caller can
 *      release them.
 * @covers packages/ingest-core/src/mediaProcessor.ts: producePreviewSheets
 * @covers packages/ingest-core/src/previewSheets.ts: generatePreviewSheets
 * @risk Requires ffmpeg + ffprobe binaries — skipped when unavailable.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFfmpeg, runFfprobe } from "@space/ffmpeg";
import { requireMediaBinary } from "@space/media-deps";
import { configureMediaIngestRuntime, producePreviewSheets } from "../src/mediaProcessor";

const SUITE = "preview-sheets-integration";
const MARKER = Buffer.from("ENCRYPTED:");

const ffmpegAvailable = requireMediaBinary(
  "ffmpeg",
  await runFfmpeg(["-version"]).then(
    () => true,
    () => false,
  ),
);

type Upload = { key: string; payload: Buffer; placementId: string | undefined };

describe("seek-bar preview sheets at import (real ffmpeg)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-preview-sheets-"));
    console.info(`[${SUITE}:setup] root=${root}`);
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] removing root=${root}`);
    rmSync(root, { recursive: true, force: true });
  });

  /** `failAt` maps an upload attempt number (1-based) to the error that attempt throws. */
  const configure = (uploads: Upload[], failAt: Record<number, Error> = {}) => {
    let attempt = 0;
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: (bytes) => Buffer.concat([MARKER, bytes]),
      uploadStorageObject: async (_token: string, objectKey: string, payload: Uint8Array, options) => {
        attempt += 1;
        const failure = failAt[attempt];
        console.info(`[${SUITE}:upload] attempt=${attempt} key=${objectKey} fail=${failure?.message ?? "no"}`);
        if (failure) throw failure;
        uploads.push({ key: objectKey, payload: Buffer.from(payload), placementId: options?.placementId });
        return `persisted-${objectKey}`;
      },
    });
  };

  const makeClip = async (seconds: number) => {
    const clip = join(root, `Preview Fixture (2026).mkv`);
    // 2.39:1 like the measured film, so the picture height follows the shape (160 x 66).
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=gray:s=478x200:r=2",
      "-t", String(seconds),
      "-an",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "20",
      clip,
    ]);
    const probe = await runFfprobe(["-v", "quiet", "-print_format", "json", "-show_format", clip]);
    const duration = Number(probe.data.format?.duration);
    console.info(`[${SUITE}:fixture] clip=${clip} duration=${duration}`);
    return { clip, duration };
  };

  const jpegSize = async (path: string) => {
    const probe = await runFfprobe(["-v", "quiet", "-print_format", "json", "-show_streams", path]);
    const stream = probe.streams[0];
    return { codec: stream?.codec_name, width: Number(stream?.width), height: Number(stream?.height) };
  };

  it.skipIf(!ffmpegAvailable)(
    "@req MPV-PREV-02 makes ceil(duration/5) pictures in ceil(n/100) encrypted sheets and returns the library record",
    async () => {
      const { clip, duration } = await makeClip(503);
      const uploads: Upload[] = [];
      configure(uploads);
      const logs: string[] = [];
      const reported: string[] = [];
      const workDir = join(root, "previews-job");
      const startedAt = Date.now();
      const previews = await producePreviewSheets({
        token: "token",
        inputPath: clip,
        durationSeconds: duration,
        workDir,
        placementId: "placement-previews",
        onLog: (line) => logs.push(line),
        onSheetUploaded: (key) => reported.push(key),
      });
      console.info(`[${SUITE}:result] ms=${Date.now() - startedAt} previews=${JSON.stringify(previews)}`);
      console.info(`[${SUITE}:logs] ${logs.filter((line) => line.includes("[preview-sheets]")).join("\n")}`);

      const expectedPictures = Math.ceil(duration / 5);
      expect(previews.version).toBe(1);
      expect(previews.intervalSeconds).toBe(5);
      expect(previews.pictureWidth).toBe(160);
      expect(previews.pictureHeight).toBe(66);
      expect(previews.columns).toBe(10);
      expect(previews.rows).toBe(10);
      expect(previews.pictureCount).toBe(expectedPictures);
      expect(previews.sheets.map((sheet) => sheet.firstPicture)).toEqual([0, 100]);
      expect(previews.sheets.map((sheet) => sheet.pictureCount)).toEqual([100, expectedPictures - 100]);
      expect(reported).toEqual(previews.sheets.map((sheet) => sheet.objectKey));
      expect(existsSync(workDir), "work dir removed").toBe(false);

      for (const sheet of previews.sheets) {
        const upload = uploads.find((entry) => `persisted-${entry.key}` === sheet.objectKey);
        console.info(`[${SUITE}:sheet] key=${sheet.objectKey} size=${sheet.sizeBytes} uploaded=${Boolean(upload)}`);
        expect(upload, `sheet ${sheet.objectKey} uploaded`).toBeDefined();
        expect(upload!.placementId).toBe("placement-previews");
        // Went through encryptMediaObject before the transport saw it.
        expect(upload!.payload.subarray(0, MARKER.length).equals(MARKER)).toBe(true);
        const plaintext = upload!.payload.subarray(MARKER.length);
        expect(plaintext[0]).toBe(0xff);
        expect(plaintext[1]).toBe(0xd8);
        // Same convention as video chunks and subtitles: the size the upload reports (the sheet's own bytes).
        expect(sheet.sizeBytes).toBe(plaintext.length);
        const path = join(root, `sheet-${sheet.firstPicture}.jpg`);
        writeFileSync(path, plaintext);
        const size = await jpegSize(path);
        console.info(`[${SUITE}:sheet] decoded=${JSON.stringify(size)} jpegBytes=${plaintext.length}`);
        expect(size.codec).toBe("mjpeg");
        expect(size.width).toBe(160 * 10);
        expect(size.height).toBe(66 * Math.ceil(sheet.pictureCount / 10));
      }
    },
    300_000,
  );

  it.skipIf(!ffmpegAvailable)(
    "@req MPV-PREV-02 retries a temporary sheet upload error like a video chunk",
    async () => {
      const { clip, duration } = await makeClip(503);
      const uploads: Upload[] = [];
      configure(uploads, { 2: new Error("CHUNK_UPLOAD_FAILED_503") });
      const previews = await producePreviewSheets({
        token: "token",
        inputPath: clip,
        durationSeconds: duration,
        workDir: join(root, "previews-retry"),
        onLog: (line) => console.info(`[${SUITE}:retry-log] ${line}`),
      });
      console.info(`[${SUITE}:retry] sheets=${previews.sheets.length} uploads=${uploads.length}`);
      expect(previews.sheets).toHaveLength(2);
      expect(uploads).toHaveLength(2);
    },
    300_000,
  );

  it.skipIf(!ffmpegAvailable)(
    "@req MPV-PREV-02 a lasting upload failure throws after reporting the sheets already stored",
    async () => {
      const { clip, duration } = await makeClip(503);
      const uploads: Upload[] = [];
      configure(uploads, { 2: new Error("UPLOAD_QUOTA_EXCEEDED") });
      const reported: string[] = [];
      const workDir = join(root, "previews-fail");
      let failure: unknown;
      try {
        await producePreviewSheets({
          token: "token",
          inputPath: clip,
          durationSeconds: duration,
          workDir,
          onSheetUploaded: (key) => reported.push(key),
        });
      } catch (err) {
        failure = err;
      }
      console.info(`[${SUITE}:fail] failure=${failure instanceof Error ? failure.message : String(failure)} reported=${JSON.stringify(reported)} uploads=${uploads.length}`);
      expect(failure).toBeInstanceOf(Error);
      expect(reported).toEqual([`persisted-${uploads[0]!.key}`]);
      expect(existsSync(workDir), "work dir removed").toBe(false);
    },
    300_000,
  );
});
