import { describe, expect, it } from "vitest";
import { createInMemoryPlatformBridge } from "../src/platform";

describe("desktop platform bridge in-memory adapter", () => {
  console.info("[platform-bridge:suite] starting in-memory platform bridge tests");

  it("returns default host states", async () => {
    console.info("[platform-bridge:setup] creating bridge with defaultApiBaseUrl=https://api.example.test/");
    const bridge = createInMemoryPlatformBridge({
      defaultApiBaseUrl: "https://api.example.test/",
    });

    const state = await bridge.apiHost.get();
    console.info(`[platform-bridge:test] initial apiHost state=${JSON.stringify(state)}`);

    await expect(bridge.apiHost.get()).resolves.toMatchObject({
      apiBaseUrl: "https://api.example.test",
      customApiBaseUrl: null,
      defaultApiBaseUrl: "https://api.example.test",
    });
  });

  it("persists and notifies host updates", async () => {
    console.info("[platform-bridge:setup] creating bridge with defaults");
    const bridge = createInMemoryPlatformBridge();
    const apiSnapshots: string[] = [];

    console.info("[platform-bridge:setup] subscribing to apiHost changes");
    const offApi = bridge.apiHost.subscribe?.((state) => apiSnapshots.push(state.apiBaseUrl));

    console.info("[platform-bridge:test] setting apiBaseUrl=https://api.custom.test/");
    await bridge.apiHost.set({ apiBaseUrl: "https://api.custom.test/" });

    const finalState = await bridge.apiHost.get();
    console.info(`[platform-bridge:test] final apiHost state=${JSON.stringify(finalState)}`);
    console.info(`[platform-bridge:test] notified apiSnapshots=${JSON.stringify(apiSnapshots)}`);

    await expect(bridge.apiHost.get()).resolves.toMatchObject({
      apiBaseUrl: "https://api.custom.test",
      customApiBaseUrl: "https://api.custom.test",
    });

    expect(apiSnapshots).toEqual(["https://api.custom.test"]);

    offApi?.();
  });
});
