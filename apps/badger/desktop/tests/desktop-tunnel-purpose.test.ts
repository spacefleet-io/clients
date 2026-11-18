// @vitest-environment jsdom
/**
 * #145 step 5: the desktop wrappers must carry the tunnel session purpose through to
 * the shared tunnel client — `library` for library data/artwork and `export` for the
 * user's own files (both still allowed once the account is unpaid), `playback` as the default.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageTunnelSession, downloadStorageObjectViaTunnel } from "../src/renderer/src/api";

const client = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({ sessionId: "s1" })),
  downloadObject: vi.fn(async () => new Uint8Array([9])),
}));

vi.mock("@space/shared/storageTunnel", () => ({
  createUserStorageTunnelClient: () => client,
}));

const SUITE = "desktop-tunnel-purpose";

describe("desktop renderer tunnel wrappers (#145)", () => {
  beforeEach(() => {
    client.createSession.mockClear();
    client.downloadObject.mockClear();
  });

  it("forwards purpose 'library' for a library download", async () => {
    console.info(`[${SUITE}:library] downloading with purpose library`);
    await downloadStorageObjectViaTunnel("tok", "library/chunks/abc", { clientType: "desktop", purpose: "library" });
    try {
      expect(client.downloadObject).toHaveBeenCalledTimes(1);
      expect(client.downloadObject).toHaveBeenCalledWith("tok", "library/chunks/abc", {
        clientType: "desktop",
        purpose: "library",
      });
    } catch (err) {
      console.error(`=== [${SUITE}] snapshot === calls=${JSON.stringify(client.downloadObject.mock.calls)}`);
      throw err;
    }
  });

  it("forwards the purpose when opening a raw session", async () => {
    await createStorageTunnelSession("tok", "library/chunks/abc", { purpose: "library" });
    try {
      expect(client.createSession).toHaveBeenCalledWith("tok", "library/chunks/abc", { purpose: "library" });
    } catch (err) {
      console.error(`=== [${SUITE}] snapshot === calls=${JSON.stringify(client.createSession.mock.calls)}`);
      throw err;
    }
  });

  it("forwards purpose 'export' for a user file download", async () => {
    await downloadStorageObjectViaTunnel("tok", "media/seg1", { clientType: "desktop", purpose: "export" });
    expect(client.downloadObject).toHaveBeenCalledWith("tok", "media/seg1", { clientType: "desktop", purpose: "export" });
  });

  it("leaves the purpose unset (client default: playback) when the caller does not ask for one", async () => {
    await downloadStorageObjectViaTunnel("tok", "media/seg1", { clientType: "desktop" });
    expect(client.downloadObject).toHaveBeenCalledWith("tok", "media/seg1", { clientType: "desktop" });
  });
});
