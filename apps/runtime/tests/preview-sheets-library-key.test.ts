/**
 * @test-id RUNTIME-PREVIEW-SHEETS-LIBRARY-KEY-001
 * @level integration
 * @why MPV-PREV-02: the preview sheets a real import makes are encrypted with the user's library key. The run is
 *      queued by the source commit and runs after it, outside the import's library-key context; every sheet upload
 *      failed with `media_key_missing` and no import got previews. This drives the production wiring end to end:
 *      `setEngineV2ForBadgerIngest` (modules/index) → source commit → preview runner → ingest-core producer (real
 *      ffmpeg over a generated clip) → badgerIngest's encryptor → storage upload. Only the storage bridge (the
 *      network) and the library DB answers are faked; each uploaded sheet must decrypt with the library key.
 * @covers apps/runtime/src/modules/index.ts: setEngineV2ForBadgerIngest
 * @covers apps/runtime/src/modules/badgerIngest.ts: produceBadgerPreviewSheets
 * @covers apps/runtime/src/modules/badger/steps/previewSheetsAfterCommit.ts: createPreviewSheetsRunner
 * @risk Requires ffmpeg + ffprobe binaries — skipped when unavailable.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFfmpeg } from "@space/ffmpeg";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";
import { createEngineV2, type EngineV2 } from "../src/core/jobs/engineV2";
import type * as StorageBridgeModule from "../src/core/content/storageBridge";
import { __resetBadgerStepDeps, getBadgerStepDeps } from "../src/modules/badger/steps/deps";
import { setEngineV2ForBadgerIngest, setBadgerModuleForTests } from "../src/modules";
import { BadgerModule } from "../src/modules/badger";
import { decryptMediaObject } from "@space/media-crypto";

const SUITE = "preview-sheets-library-key";
const PLACEMENT = "0123456789abcdef0123456789abcdef";

const h = vi.hoisted(() => ({
  uploads: [] as Array<{ key: string; payload: Buffer }>,
}));

// vi.mock is hoisted above the imports: only the network edge of the storage bridge is faked.
vi.mock("../src/core/content/storageBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof StorageBridgeModule>();
  const bridge = {
    uploadObject: async (_token: string, objectKey: string, payload: Uint8Array) => {
      h.uploads.push({ key: objectKey, payload: Buffer.from(payload) });
      return objectKey;
    },
    headObjects: async () => [],
    downloadObject: async () => new Uint8Array(),
    deleteObjects: async () => ({ deleted: 0, reclaimedBytes: 0 }),
  };
  return {
    ...actual,
    createRuntimeContentStorageBridge: () => bridge,
  };
});

const ffmpegAvailable = await runFfmpeg(["-version"]).then(
  () => true,
  () => false,
);

const format = (quality: string, durationSeconds: number): ProducedMedia["videoFormats"][number] => ({
  quality,
  codec: "h264",
  codecString: "avc1.640028",
  initKey: `media/${PLACEMENT}/init-${quality}`,
  initSize: 900,
  durationSeconds,
  totalSize: 10_000,
  chunks: [{ key: `media/${PLACEMENT}/seg-${quality}`, sizeBytes: 9_100, startSeconds: 0 }],
});

describe("preview sheets of a real import are encrypted with the library key (MPV-PREV-02)", () => {
  let root = "";
  let engine: EngineV2 | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-preview-key-"));
    process.env.SF_TRANSCODE_DIR = join(root, "transcode");
    h.uploads.length = 0;
    __resetBadgerStepDeps();
  });

  afterEach(async () => {
    setEngineV2ForBadgerIngest(null);
    __resetBadgerStepDeps();
    await engine?.stop();
    engine = null;
    delete process.env.SF_TRANSCODE_DIR;
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.skipIf(!ffmpegAvailable)(
    "@req MPV-PREV-02 a source commit through the production wiring uploads sheets that decrypt with the library key",
    async () => {
      const clip = join(root, "Preview Key Fixture (2026).mkv");
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=2", "-t", "12", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);

      const libraryKey = randomBytes(32).toString("base64");
      const module = new BadgerModule();
      module.setLibraryKey(libraryKey);
      module.setBackendToken("tok");
      module.setBackendUserId("u1");
      const recorded: unknown[][] = [];
      let nextFormatId = 1;
      vi.spyOn(module.libraryDbService, "isOpen").mockReturnValue(true);
      vi.spyOn(module.libraryDbService, "call").mockImplementation(async (method: string, args: unknown[] = []) => {
        if (method === "getMediaDetails") return { id: "m1", title: "Preview Key Fixture", type: "movie" };
        if (method === "linkFileToMedia") return "file-1";
        if (method === "addMediaFormat") return `fmt-${nextFormatId++}`;
        if (method === "getMediaFormatPreviewSheets") return { previewSheets: null };
        if (method === "setMediaFormatPreviewSheets") {
          recorded.push(args);
          return true;
        }
        return null;
      });
      setBadgerModuleForTests(module);
      const warn = vi.spyOn(console, "warn");
      engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
      setEngineV2ForBadgerIngest(engine);

      const result = await getBadgerStepDeps().commit({
        userId: "u1",
        jobId: "j-key",
        mediaId: "m1",
        filename: clip,
        scope: "source",
        sourceQuality: "1080p",
        produced: { videoFormats: [format("1080p", 12), format("360p", 12)], audioTracks: [], subtitleTracks: [] },
        signal: new AbortController().signal,
      });
      console.info(`[${SUITE}:commit] result=${JSON.stringify(result)}`);

      await vi.waitFor(
        () => {
          const failure = warn.mock.calls.find((call) => String(call[0]).startsWith("[preview-sheets] failed"));
          if (failure) throw new Error(`preview run failed: ${failure.map(String).join(" ")}`);
          expect(recorded).toHaveLength(1);
        },
        { timeout: 20_000, interval: 50 },
      );
      console.info(`[${SUITE}:recorded] record=${JSON.stringify(recorded[0])} uploads=${h.uploads.map((u) => u.key).join(",")}`);
      expect(recorded[0]![0]).toBe("fmt-1");
      expect(h.uploads.length).toBeGreaterThan(0);
      for (const upload of h.uploads) {
        const plain = decryptMediaObject(upload.payload, libraryKey);
        // Every sheet is a JPEG once decrypted.
        expect(plain.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      }
    },
    30_000,
  );
});
