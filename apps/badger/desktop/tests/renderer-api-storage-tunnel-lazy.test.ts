import { describe, expect, it, vi } from "vitest";

// Issue #25: the storage tunnel client (@space/shared/storageTunnel, ~43 KiB) is
// only used after login, so api.ts must not load it at module scope (that put it
// in the startup entry chunk). It loads on the first tunnel call, once.

const tunnelState = vi.hoisted(() => ({ moduleLoads: 0, clientsCreated: 0 }));

vi.mock("@space/shared/api", () => ({
  apiRequest: vi.fn(),
  setApiClientType: vi.fn(),
  setApiBaseUrl: vi.fn(),
  getApiBaseUrl: () => "/api",
}));

vi.mock("@space/shared/storageTunnel", () => {
  tunnelState.moduleLoads += 1;
  console.info(`[renderer-api-storage-tunnel-lazy:loader] storageTunnel module loaded (loads=${tunnelState.moduleLoads})`);
  return {
    createUserStorageTunnelClient: () => {
      tunnelState.clientsCreated += 1;
      return {
        createSession: async (_token: string, objectKey?: string) => ({ sessionId: `s-${objectKey ?? "none"}` }),
        sendFrame: async () => ({ ok: true }),
        uploadObject: async () => ({ ok: true }),
        downloadObject: async () => new Uint8Array(),
      };
    },
  };
});

describe("renderer api storage tunnel lazy load", () => {
  it("does not load the tunnel module until the first tunnel call, then reuses one client", async () => {
    const api = await import("../src/renderer/src/api");
    console.info(`[renderer-api-storage-tunnel-lazy:import] after api import state=${JSON.stringify(tunnelState)}`);
    expect(tunnelState.moduleLoads).toBe(0);
    expect(tunnelState.clientsCreated).toBe(0);

    const [first, second] = await Promise.all([
      api.createStorageTunnelSession("token", "assets/a.txt"),
      api.sendStorageTunnelFrame("token", "s-1", { type: "ping" }),
    ]);
    await api.downloadStorageObjectViaTunnel("token", "assets/b.txt");
    console.info(
      `[renderer-api-storage-tunnel-lazy:calls] first=${JSON.stringify(first)} second=${JSON.stringify(second)} state=${JSON.stringify(tunnelState)}`,
    );
    expect(first).toEqual({ sessionId: "s-assets/a.txt" });
    expect(second).toEqual({ ok: true });
    expect(tunnelState.moduleLoads).toBe(1);
    expect(tunnelState.clientsCreated).toBe(1);
  });
});
