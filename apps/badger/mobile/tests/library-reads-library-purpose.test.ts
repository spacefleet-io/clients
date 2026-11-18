/**
 * @test-id MOBILE-LIBRARY-READS-LIBRARY-PURPOSE-001
 * @level unit
 * @req STOR-BW-09
 *
 * Why this exists: library data (manifest, chunks, op payloads) and artwork (posters, backdrops) are exempt from
 * the saturation rules (STOR-BW-09): they keep flowing at a small allowance, while exports and offline downloads
 * get zero bytes. They opened a session without a purpose, i.e. `playback`, so an unpaid account's library sync was
 * refused 402 and a free one's 503 `free_playback_refused`. They must open `library` sessions, never `export`
 * (held at saturation) and never `playback`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { getDecryptedAssetUrl } from "../src/lib/assets";
import { downloadObjectViaTunnel } from "../src/lib/library/transport";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ objectKey: string; purpose: unknown }>,
}));

vi.mock("react-native-fs", () => ({
  default: {
    CachesDirectoryPath: "/cache",
    exists: async () => false,
    mkdir: async () => undefined,
    writeFile: async () => undefined,
  },
}));
vi.mock("react-native-quick-crypto", () => ({
  default: { createHash: () => ({ update: () => ({ digest: () => "digest" }) }) },
}));
vi.mock("react-native/Libraries/Blob/BlobManager", () => ({ default: {} }));
vi.mock("../src/native/LibrarySync", () => ({ buildUploadFrameBlob: vi.fn() }));
vi.mock("../src/lib/crypto", () => ({ decryptBase64ToBytes: async () => new Uint8Array([1]) }));
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    downloadStorageObjectViaTunnel: async (_token: string, objectKey: string, options?: { purpose?: unknown }) => {
      h.calls.push({ objectKey, purpose: options?.purpose });
      return new Uint8Array([1, 2, 3]);
    },
  };
});

beforeEach(() => {
  h.calls.length = 0;
});

describe("mobile library and artwork reads open library sessions (@req STOR-BW-09)", () => {
  it("library manifest, chunk and op reads use purpose library", async () => {
    await downloadObjectViaTunnel("tok", "library/chunks/abc");
    expect(h.calls).toEqual([{ objectKey: "library/chunks/abc", purpose: "library" }]);
  });

  it("poster and backdrop reads use purpose library", async () => {
    await getDecryptedAssetUrl("asset:image/png::library/assets/poster-1", async () => ({ token: "tok", keyBase64: "a2V5" }));
    expect(h.calls).toEqual([{ objectKey: "library/assets/poster-1", purpose: "library" }]);
  });
});
