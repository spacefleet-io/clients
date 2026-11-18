import { describe, expect, it, vi } from "vitest";

const createUserStorageTunnelClientMock = vi.fn((_options: unknown) => ({
  createSession: vi.fn(),
  sendFrame: vi.fn(),
  startSession: vi.fn(),
  endSession: vi.fn(),
  uploadObject: vi.fn(),
  downloadObject: vi.fn(),
  downloadObjectToSink: vi.fn(),
}));

vi.mock("@space/shared/storageTunnel", () => ({
  createUserStorageTunnelClient: createUserStorageTunnelClientMock,
}));

vi.mock("../src/main/apiHost", () => ({
  getApiBaseUrl: () => "http://localhost:3000",
}));

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// On failure, dump the recorded mock invocations so the actual config passed
// to createUserStorageTunnelClient is visible without a local repro.
const dumpTunnelSnapshot = (label: string) => {
  try {
    console.error(`=== [main-api-storage-tunnel:${label}] snapshot ===`);
    console.error(`createUserStorageTunnelClient call count=${createUserStorageTunnelClientMock.mock.calls.length}`);
    console.error(
      `recorded calls:\n${JSON.stringify(createUserStorageTunnelClientMock.mock.calls, null, 2)}`
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("desktop main tunnel client config", () => {
  it("enables ws-stream download preference", async () => {
    console.info(`[main-api-storage-tunnel:setup] importing src/main/api to trigger client construction`);
    await import("../src/main/api");
    console.info(
      `[main-api-storage-tunnel:assert] createUserStorageTunnelClient called ${createUserStorageTunnelClientMock.mock.calls.length}x; first arg=${JSON.stringify(createUserStorageTunnelClientMock.mock.calls[0]?.[0])}`
    );
    const firstArg = createUserStorageTunnelClientMock.mock.calls[0]?.[0] as
      | { preferWsDownloadStream?: unknown }
      | undefined;
    if (!firstArg || firstArg.preferWsDownloadStream !== true)
      dumpTunnelSnapshot("ws-stream-download-pref");
    expect(createUserStorageTunnelClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preferWsDownloadStream: true,
      })
    );
  });
});

