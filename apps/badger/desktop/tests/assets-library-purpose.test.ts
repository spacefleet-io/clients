// @vitest-environment jsdom
/**
 * @test-id DESKTOP-ASSETS-LIBRARY-PURPOSE-001
 * @level unit
 * @req STOR-BW-09
 *
 * Poster/backdrop reads are library data: they keep flowing at silo saturation, so they open a `library`
 * session (never `export`, which is held at saturation, and never `playback`, which an unpaid account is refused).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ objectKey: string; purpose: unknown }>,
}));

vi.mock("@/api", () => ({
  downloadStorageObjectViaTunnel: async (_token: string, objectKey: string, options?: { purpose?: unknown }) => {
    h.calls.push({ objectKey, purpose: options?.purpose });
    return new Uint8Array([1, 2, 3]);
  },
  getMetadataImageUrl: vi.fn(),
  uploadStorageObjectViaTunnel: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({
  decryptBase64ToBytes: async () => new Uint8Array([1]),
  encryptBytesToBase64: vi.fn(),
}));

import { clearAssetCaches, getDecryptedAssetUrl } from "../src/renderer/src/lib/assets";

beforeEach(() => {
  h.calls.length = 0;
  clearAssetCaches();
  URL.createObjectURL = vi.fn(() => "blob:poster");
});

describe("desktop poster/backdrop reads (@req STOR-BW-09)", () => {
  it("open a library session", async () => {
    await getDecryptedAssetUrl("tok", "a2V5", "asset:image/png::library/assets/poster-1");
    expect(h.calls).toEqual([{ objectKey: "library/assets/poster-1", purpose: "library" }]);
  });
});
