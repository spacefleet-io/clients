/**
 * #145 step 5: offline downloads are exports of the user's own files, so their
 * storage-tunnel sessions must open with purpose `export` — the only purpose an
 * unpaid account may still use.
 */
import { describe, expect, it, vi } from "vitest";
import { createOfflineDownloadObject } from "../src/modules/badger/offlineDownloadDeps";

const SUITE = "badger-offline-export-purpose";

describe("createOfflineDownloadObject", () => {
  it("downloads every offline chunk with session purpose 'export'", async () => {
    console.info(`[${SUITE}:setup] stubbing storage bridge`);
    const payload = new Uint8Array([1, 2, 3]);
    const bridge = { downloadObject: vi.fn(async () => payload) };
    const downloadObject = createOfflineDownloadObject(bridge);

    const result = await downloadObject("token-1", "library/chunks/abc");
    console.info(`[${SUITE}:call] bridge calls=${JSON.stringify(bridge.downloadObject.mock.calls)}`);

    try {
      expect(result).toBe(payload);
      expect(bridge.downloadObject).toHaveBeenCalledTimes(1);
      expect(bridge.downloadObject).toHaveBeenCalledWith("token-1", "library/chunks/abc", { purpose: "export" });
    } catch (err) {
      console.error(`=== [${SUITE}] snapshot === calls=${JSON.stringify(bridge.downloadObject.mock.calls)}`);
      throw err;
    }
  });
});
