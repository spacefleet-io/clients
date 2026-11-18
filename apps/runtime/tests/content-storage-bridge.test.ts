import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadObjectMock, downloadObjectMock, createSessionMock, sendFrameMock, createClientMock } = vi.hoisted(() => ({
  uploadObjectMock: vi.fn(),
  downloadObjectMock: vi.fn(),
  createSessionMock: vi.fn(),
  sendFrameMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("@space/shared/storageTunnel", () => ({
  createUserStorageTunnelClient: createClientMock.mockImplementation(() => ({
    uploadObject: uploadObjectMock,
    downloadObject: downloadObjectMock,
    createSession: createSessionMock,
    sendFrame: sendFrameMock,
  })),
}));

const dumpBridgeSnapshot = (label: string) => {
  try {
    console.error(`=== [content-storage-bridge:${label}] snapshot ===`);
    console.error(`createClient.calls=${createClientMock.mock.calls.length}`);
    console.error(`uploadObject.calls=${uploadObjectMock.mock.calls.length}`);
    console.error(`uploadObject.lastArgs=${JSON.stringify(uploadObjectMock.mock.lastCall ?? null, null, 2)}`);
    console.error(`downloadObject.calls=${downloadObjectMock.mock.calls.length}`);
    console.error(`downloadObject.lastArgs=${JSON.stringify(downloadObjectMock.mock.lastCall ?? null, null, 2)}`);
    console.error(`createSession.calls=${createSessionMock.mock.calls.length}`);
    console.error(`sendFrame.calls=${sendFrameMock.mock.calls.length}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime content storage bridge [content-storage-bridge]", () => {
  beforeEach(() => {
    console.info(`[content-storage-bridge:before-each] re-installing createClient mock implementation`);
    createClientMock.mockImplementation(() => ({
      uploadObject: uploadObjectMock,
      downloadObject: downloadObjectMock,
      createSession: createSessionMock,
      sendFrame: sendFrameMock,
    }));
  });

  afterEach(() => {
    console.info(`[content-storage-bridge:after-each] resetting all storage mocks + clearing API base URL env vars`);
    uploadObjectMock.mockReset();
    downloadObjectMock.mockReset();
    createSessionMock.mockReset();
    sendFrameMock.mockReset();
    createClientMock.mockReset();
    delete process.env.SPACEFLEET_API_BASE_URL;
    delete process.env.API_BASE_URL;
    delete process.env.SF_API_BASE_URL;
  });

  it("@bugfix @regression-proof normalizes runtime content api base url through one shared helper", async () => {
    console.info(`[content-storage-bridge:resolve-base-url] SPACEFLEET_API_BASE_URL=http://127.0.0.1:3000///`);
    process.env.SPACEFLEET_API_BASE_URL = "http://127.0.0.1:3000///";
    const { resolveRuntimeContentApiBaseUrl } = await import("../src/core/content/storageBridge");
    const resolved = resolveRuntimeContentApiBaseUrl();
    console.info(`[content-storage-bridge:resolve-base-url] resolved=${resolved}`);
    try {
      expect(resolved).toBe("http://127.0.0.1:3000");
    } catch (err) {
      dumpBridgeSnapshot("resolve-base-url-failure");
      throw err;
    }
  });

  it("@bugfix @regression-proof routes badger and parrot storage transport calls through one shared runtime bridge", async () => {
    console.info(`[content-storage-bridge:badger-bridge-routing] arming mocks for obj-1 upload/download/session/frame`);
    uploadObjectMock.mockResolvedValue("objects/obj-1");
    downloadObjectMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    createSessionMock.mockResolvedValue({ sessionId: "sess-1", protocolVersion: 1, createdAt: 1, expiresAt: 2 });
    sendFrameMock.mockResolvedValue({ kind: "upload.ack", sessionId: "sess-1" });

    const { createRuntimeContentStorageBridge } = await import("../src/core/content/storageBridge");
    const bridge = createRuntimeContentStorageBridge("badger");

    try {
      await bridge.uploadObject("token-a", "obj-1", new Uint8Array([1]), { objectNamespace: "library" });
      await bridge.downloadObject("token-a", "obj-1", { downloadId: "dl-1" });
      await bridge.createSession("token-a", "obj-1");
      await bridge.sendFrame("token-a", "sess-1", { kind: "upload.open" });

      console.info(
        `[content-storage-bridge:badger-bridge-routing] createClient.calls=${createClientMock.mock.calls.length} upload.calls=${uploadObjectMock.mock.calls.length}`,
      );
      expect(createClientMock).toHaveBeenCalledTimes(1);
      const bridgeFactoryArgs = createClientMock.mock.calls[0]?.[0] as {
        getApiBaseUrl: () => string;
        getAppId: () => string;
      };
      expect(bridgeFactoryArgs.getAppId()).toBe("badger");
      expect(uploadObjectMock).toHaveBeenCalledWith("token-a", "obj-1", new Uint8Array([1]), { objectNamespace: "library" });
      expect(downloadObjectMock).toHaveBeenCalledWith("token-a", "obj-1", { downloadId: "dl-1" });
      expect(createSessionMock).toHaveBeenCalledWith("token-a", "obj-1");
      expect(sendFrameMock).toHaveBeenCalledWith("token-a", "sess-1", { kind: "upload.open" });
    } catch (err) {
      dumpBridgeSnapshot("badger-bridge-routing-failure");
      throw err;
    }
  });

  it("@bugfix @regression-proof exposes content-adapter-shaped upload and download helpers on top of the shared bridge", async () => {
    console.info(`[content-storage-bridge:adapter-shape] arming mocks for parrot obj-2 upload/download`);
    uploadObjectMock.mockResolvedValue("objects/obj-2");
    downloadObjectMock.mockResolvedValue(new Uint8Array([9, 8, 7]));

    const {
      createRuntimeContentDownloadAdapter,
      createRuntimeContentStorageBridge,
      createRuntimeContentUploadAdapter,
    } = await import("../src/core/content/storageBridge");
    const bridge = createRuntimeContentStorageBridge("parrot");
    const uploadObject = createRuntimeContentUploadAdapter(bridge, "token-b");
    const downloadObject = createRuntimeContentDownloadAdapter(bridge, "token-b", "export");

    try {
      const uploaded = await uploadObject({
        objectKey: "obj-2",
        payload: new Uint8Array([5, 4, 3]),
        objectNamespace: "parrot",
        logicalRef: "/Family/photo.jpg",
        contentType: "image/jpeg",
      });
      const downloaded = await downloadObject("obj-2", "dl-2");
      console.info(
        `[content-storage-bridge:adapter-shape] uploaded=${JSON.stringify(uploaded)} downloaded.length=${downloaded.length}`,
      );

      expect(uploaded).toEqual({
        objectKey: "objects/obj-2",
        sizeBytes: 3,
      });
      expect(downloaded).toEqual(new Uint8Array([9, 8, 7]));
      expect(uploadObjectMock).toHaveBeenCalledWith("token-b", "obj-2", new Uint8Array([5, 4, 3]), {
        objectNamespace: "parrot",
        logicalRef: "/Family/photo.jpg",
        contentType: "image/jpeg",
      });
      expect(downloadObjectMock).toHaveBeenCalledWith("token-b", "obj-2", { downloadId: "dl-2", purpose: "export" });
      // The same adapter bound to `playback` must say so (an unpaid account is refused playback sessions).
      await createRuntimeContentDownloadAdapter(bridge, "token-b", "playback")("obj-2");
      expect(downloadObjectMock).toHaveBeenLastCalledWith("token-b", "obj-2", { purpose: "playback" });
    } catch (err) {
      dumpBridgeSnapshot("adapter-shape-failure");
      throw err;
    }
  });

  it("@bugfix @regression-proof exposes the single media-ingest upload transport on top of the shared bridge", async () => {
    console.info(`[content-storage-bridge:media-ingest] arming uploadObjectMock for obj-3`);
    uploadObjectMock.mockResolvedValue("objects/obj-3");

    const { createRuntimeContentStorageBridge, createRuntimeMediaStorageTransport } = await import(
      "../src/core/content/storageBridge"
    );
    const bridge = createRuntimeContentStorageBridge("badger");
    const transport = createRuntimeMediaStorageTransport(bridge);

    try {
      const uploadedKey = await transport.uploadStorageObject("token-c", "obj-3", new Uint8Array([7, 7]), {
        objectNamespace: "library",
        logicalRef: "/tmp/file.mkv",
        contentType: "video/mp4",
      });
      console.info(`[content-storage-bridge:media-ingest] uploadedKey=${uploadedKey}`);

      expect(uploadedKey).toBe("objects/obj-3");
      expect(uploadObjectMock).toHaveBeenCalledWith("token-c", "obj-3", new Uint8Array([7, 7]), {
        objectNamespace: "library",
        logicalRef: "/tmp/file.mkv",
        contentType: "video/mp4",
      });
    } catch (err) {
      dumpBridgeSnapshot("media-ingest-failure");
      throw err;
    }
  });
});
