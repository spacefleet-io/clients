/**
 * @test-id LIB-FMT-11-INGEST-003
 * @level unit
 * @req LIB-FMT-11
 * @req LIB-FMT-14
 * @why The deps adapter decides `seedChunkKeys` and hands it to `uploadBadgerProducedMedia`, which rebuilds the
 *   ingest-core arguments field by field. The lane proof (2026-11-21) found it dropped the flag: a switched account
 *   then stored random keys (key mode 1) although every unit test of the adapter and of finalize passed. The wrapper
 *   must forward the flag as it got it, and send none when it got none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("../src/core/content/storageBridge", () => ({
  createRuntimeContentStorageBridge: () => ({}),
  createRuntimeMediaStorageTransport: () => ({}),
}));
vi.mock("@space/media-crypto", () => ({ decryptMediaObject: vi.fn(), sealMediaObjectWithPadding: vi.fn() }));
vi.mock("@space/ingest-core/mediaProcessor", () => ({
  configureMediaIngestRuntime: vi.fn(),
  processMediaJob: vi.fn(),
  producePreviewSheets: vi.fn(),
  produceMediaOutputs: vi.fn(),
  uploadEncryptedFile: vi.fn(),
  uploadProducedMedia: async (args: Record<string, unknown>) => {
    h.calls.push(args);
    return { produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] }, uploadedKeys: [] };
  },
}));
vi.mock("@space/desktop-platform", () => ({ getDesktopPlatform: () => ({}) }));

const { uploadBadgerProducedMedia } = await import("../src/modules/badgerIngest");

const BASE = { token: "tok", userId: "u1", jobId: "j1", scope: "source" as const, placementId: "p1", libraryKeyBase64: null };

beforeEach(() => {
  h.calls.length = 0;
});

describe("uploadBadgerProducedMedia seed flag (LIB-FMT-14)", () => {
  it("forwards seedChunkKeys to the ingest upload", async () => {
    await uploadBadgerProducedMedia({ ...BASE, seedChunkKeys: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ placementId: "p1", seedChunkKeys: true });
  });

  it("sends no seed flag when the adapter sent none", async () => {
    await uploadBadgerProducedMedia(BASE);
    expect(h.calls[0]?.seedChunkKeys).toBeUndefined();
  });
});
