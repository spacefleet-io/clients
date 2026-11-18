import { beforeEach, describe, expect, it, vi } from "vitest";

const apiState = vi.hoisted(() => ({
  apiBaseUrl: "/api",
}));

vi.mock("@space/shared/api", () => ({
  apiRequest: vi.fn(),
  setApiClientType: vi.fn(),
  setApiBaseUrl: (value: string) => {
    apiState.apiBaseUrl = value.endsWith("/") ? value.slice(0, -1) : value;
  },
  getApiBaseUrl: () => apiState.apiBaseUrl,
}));

vi.mock("@space/shared/storageTunnel", () => ({
  createUserStorageTunnelClient: ({
    getApiBaseUrl,
  }: {
    getApiBaseUrl: () => string;
    preferWsDownloadStream: boolean;
  }) => ({
    createSession: async () => ({ apiBaseUrl: getApiBaseUrl() }),
    sendFrame: vi.fn(),
    uploadObject: vi.fn(),
    downloadObject: vi.fn(),
  }),
}));

// On a base-url mismatch, dump the mock api state + resolved session so a
// stale-base regression (the @bugfix this pins) is diagnosable from the log.
const dumpStorageBaseSnapshot = (label: string, session: unknown) => {
  try {
    console.error(`=== [renderer-api-storage-base:${label}] snapshot ===`);
    console.error(`apiState.apiBaseUrl=${JSON.stringify(apiState.apiBaseUrl)}`);
    console.error(`session=${JSON.stringify(session)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("renderer api storage tunnel base url", () => {
  beforeEach(() => {
    apiState.apiBaseUrl = "/api";
    console.info(`[renderer-api-storage-base:setup] reset apiState.apiBaseUrl=${apiState.apiBaseUrl}`);
  });

  it("[@bugfix][@regression-proof] uses current configured api base for storage tunnel session", async () => {
    const api = await import("../src/renderer/src/api");
    console.info(`[renderer-api-storage-base:configure] setApiBaseUrl(https://api.dev.spacebadger.io)`);
    api.setApiBaseUrl("https://api.dev.spacebadger.io");
    console.info(`[renderer-api-storage-base:configure] apiState.apiBaseUrl=${apiState.apiBaseUrl}`);

    const session = await api.createStorageTunnelSession("token", "assets/demo.txt");
    console.info(`[renderer-api-storage-base:session] resolved session=${JSON.stringify(session)}`);
    if ((session as { apiBaseUrl?: string })?.apiBaseUrl !== "https://api.dev.spacebadger.io") {
      dumpStorageBaseSnapshot("session-base", session);
    }
    expect(session).toMatchObject({ apiBaseUrl: "https://api.dev.spacebadger.io" });
  });
});
