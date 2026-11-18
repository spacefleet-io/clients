/**
 * @test-id RUNTIME-BADGER-INGEST-DOWNLOAD-PURPOSE-001
 * @level unit
 *
 * Why this exists: the retranscode download is not live playback. Everything that is not live playback takes
 * zero bytes while a silo is saturated and resumes afterwards (STOR-BW-09, Chris 2026-10-16); without a
 * purpose the session defaulted to `playback`, so a free user's retranscode was refused 503
 * `free_playback_refused`. It must open an `export` session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  downloads: [] as Array<{ objectKey: string; options: unknown }>,
}));

vi.mock("../src/core/content/storageBridge", () => ({
  createRuntimeContentStorageBridge: () => ({
    downloadObject: async (_token: string, objectKey: string, options?: unknown) => {
      h.downloads.push({ objectKey, options });
      return new Uint8Array([1, 2, 3]);
    },
  }),
  createRuntimeMediaStorageTransport: () => ({}),
}));
vi.mock("@space/media-crypto", () => ({
  decryptMediaObject: async () => Buffer.from([9]),
}));
vi.mock("@space/ingest-core/mediaProcessor", () => ({
  configureMediaIngestRuntime: vi.fn(),
  processMediaJob: vi.fn(),
  produceMediaOutputs: vi.fn(),
  uploadProducedMedia: vi.fn(),
}));
vi.mock("@space/desktop-platform", () => ({ getDesktopPlatform: () => ({}) }));

const { downloadAndDecryptBadgerObject } = await import("../src/modules/badgerIngest");

beforeEach(() => {
  h.downloads.length = 0;
});

describe("retranscode source read (STOR-BW-09)", () => {
  it("opens an export session", async () => {
    await downloadAndDecryptBadgerObject("tok", "media/p1/source", "a2V5");
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]?.options).toMatchObject({ purpose: "export" });
  });
});
