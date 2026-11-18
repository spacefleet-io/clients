import { describe, expect, it } from "vitest";
import { createInMemoryMobilePlatformBridge, createAsyncStoragePlatformBridge } from "../src/platform";

// On assertion failure, dump enough host/app state to diagnose offline (per the
// "Tests log generously" rule: tests must self-diagnose, never recommend manual
// repro). try/catch so a dump failure can never mask the real assertion.
const dumpPlatformSnapshot = async (
  label: string,
  ctx: {
    state?: unknown;
    snapshots?: unknown[];
    backing?: Map<string, string>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [platform:${label}] snapshot ===`);
    if (ctx.state !== undefined) {
      console.error(`apiHost state:\n${JSON.stringify(ctx.state, null, 2)}`);
    }
    if (ctx.snapshots !== undefined) {
      console.error(`subscribe snapshots (${ctx.snapshots.length})=${JSON.stringify(ctx.snapshots)}`);
    }
    if (ctx.backing !== undefined) {
      console.error(`storage backing=${JSON.stringify(Object.fromEntries(ctx.backing), null, 2)}`);
    }
    if (ctx.extra !== undefined) {
      console.error(`extra=${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("mobile platform bridge — in-memory adapter", () => {
  it("returns default host state", async () => {
    console.info(`[platform:in-memory-default] creating bridge with defaultApiBaseUrl=https://api.example.test/`);
    const bridge = createInMemoryMobilePlatformBridge({
      defaultApiBaseUrl: "https://api.example.test/",
    });

    const state = await bridge.apiHost.get();
    console.info(`[platform:in-memory-default] resolved host state=${JSON.stringify(state)}`);
    try {
      expect(state).toMatchObject({
        apiBaseUrl: "https://api.example.test",
        customApiBaseUrl: null,
        defaultApiBaseUrl: "https://api.example.test",
      });
    } catch (err) {
      await dumpPlatformSnapshot("in-memory-default", { state });
      throw err;
    }
  });

  it("persists and notifies host updates", async () => {
    console.info(`[platform:in-memory-notify] creating in-memory bridge`);
    const bridge = createInMemoryMobilePlatformBridge();
    const snapshots: string[] = [];

    const off = bridge.apiHost.subscribe?.((state) => snapshots.push(state.apiBaseUrl));
    console.info(`[platform:in-memory-notify] subscribed; setting apiBaseUrl=https://api.custom.test/`);

    await bridge.apiHost.set({ apiBaseUrl: "https://api.custom.test/" });

    const state = await bridge.apiHost.get();
    console.info(
      `[platform:in-memory-notify] after-set state=${JSON.stringify(state)} snapshots=${JSON.stringify(snapshots)}`,
    );
    try {
      expect(state).toMatchObject({
        apiBaseUrl: "https://api.custom.test",
        customApiBaseUrl: "https://api.custom.test",
      });
      expect(snapshots).toEqual(["https://api.custom.test"]);
    } catch (err) {
      await dumpPlatformSnapshot("in-memory-notify", { state, snapshots });
      throw err;
    }

    off?.();
  });

  it("clears custom host when set to null", async () => {
    console.info(`[platform:in-memory-clear] creating in-memory bridge`);
    const bridge = createInMemoryMobilePlatformBridge();

    console.info(`[platform:in-memory-clear] set custom https://custom.test then set null`);
    await bridge.apiHost.set({ apiBaseUrl: "https://custom.test" });
    await bridge.apiHost.set({ apiBaseUrl: null });

    const state = await bridge.apiHost.get();
    console.info(`[platform:in-memory-clear] cleared state=${JSON.stringify(state)}`);
    try {
      expect(state.customApiBaseUrl).toBeNull();
      expect(state.apiBaseUrl).toBe(state.defaultApiBaseUrl);
    } catch (err) {
      await dumpPlatformSnapshot("in-memory-clear", { state });
      throw err;
    }
  });

  it("returns default app name and version", async () => {
    console.info(`[platform:in-memory-app-default] creating in-memory bridge`);
    const bridge = createInMemoryMobilePlatformBridge();
    const [name, version] = await Promise.all([bridge.app.getName(), bridge.app.getVersion()]);
    console.info(`[platform:in-memory-app-default] name=${name} version=${version}`);
    try {
      expect(name).toBe("SpaceFleet Mobile");
      expect(version).toBe("0.0.0-dev");
    } catch (err) {
      await dumpPlatformSnapshot("in-memory-app-default", { extra: { name, version } });
      throw err;
    }
  });

  it("returns custom app name and version", async () => {
    console.info(`[platform:in-memory-app-custom] creating bridge appName=SpaceBadger appVersion=1.2.3`);
    const bridge = createInMemoryMobilePlatformBridge({
      appName: "SpaceBadger",
      appVersion: "1.2.3",
    });
    const [name, version] = await Promise.all([bridge.app.getName(), bridge.app.getVersion()]);
    console.info(`[platform:in-memory-app-custom] name=${name} version=${version}`);
    try {
      expect(name).toBe("SpaceBadger");
      expect(version).toBe("1.2.3");
    } catch (err) {
      await dumpPlatformSnapshot("in-memory-app-custom", { extra: { name, version } });
      throw err;
    }
  });
});

describe("mobile platform bridge — async storage adapter", () => {
  const createFakeStorage = () => {
    const backing = new Map<string, string>();
    return {
      getItem: async (key: string) => backing.get(key) ?? null,
      setItem: async (key: string, value: string) => { backing.set(key, value); },
      removeItem: async (key: string) => { backing.delete(key); },
      _backing: backing,
    };
  };

  it("returns default host when storage is empty", async () => {
    console.info(`[platform:async-empty-default] creating async-storage bridge with empty storage`);
    const storage = createFakeStorage();
    const bridge = createAsyncStoragePlatformBridge({
      asyncStorage: storage,
      defaultApiBaseUrl: "https://api.default.test",
    });

    const state = await bridge.apiHost.get();
    console.info(`[platform:async-empty-default] resolved state=${JSON.stringify(state)}`);
    try {
      expect(state.apiBaseUrl).toBe("https://api.default.test");
      expect(state.customApiBaseUrl).toBeNull();
    } catch (err) {
      await dumpPlatformSnapshot("async-empty-default", { state, backing: storage._backing });
      throw err;
    }
  });

  it("reads persisted host from storage on first access", async () => {
    console.info(`[platform:async-read-persisted] seeding storage spacefleet.mobile.apiHost=https://stored.test`);
    const storage = createFakeStorage();
    storage._backing.set("spacefleet.mobile.apiHost", "https://stored.test");

    const bridge = createAsyncStoragePlatformBridge({ asyncStorage: storage });

    const state = await bridge.apiHost.get();
    console.info(`[platform:async-read-persisted] resolved state=${JSON.stringify(state)}`);
    try {
      expect(state.apiBaseUrl).toBe("https://stored.test");
      expect(state.customApiBaseUrl).toBe("https://stored.test");
    } catch (err) {
      await dumpPlatformSnapshot("async-read-persisted", { state, backing: storage._backing });
      throw err;
    }
  });

  it("persists set calls to storage", async () => {
    console.info(`[platform:async-persist-set] creating async-storage bridge`);
    const storage = createFakeStorage();
    const bridge = createAsyncStoragePlatformBridge({ asyncStorage: storage });

    console.info(`[platform:async-persist-set] setting apiBaseUrl=https://new.test/`);
    await bridge.apiHost.set({ apiBaseUrl: "https://new.test/" });

    const persisted = storage._backing.get("spacefleet.mobile.apiHost");
    console.info(`[platform:async-persist-set] persisted value=${JSON.stringify(persisted)}`);
    try {
      expect(persisted).toBe("https://new.test");
    } catch (err) {
      await dumpPlatformSnapshot("async-persist-set", { backing: storage._backing });
      throw err;
    }
  });

  it("removes storage entry when clearing custom host", async () => {
    console.info(`[platform:async-clear-entry] creating async-storage bridge`);
    const storage = createFakeStorage();
    const bridge = createAsyncStoragePlatformBridge({ asyncStorage: storage });

    console.info(`[platform:async-clear-entry] set custom https://temp.test then set null`);
    await bridge.apiHost.set({ apiBaseUrl: "https://temp.test" });
    await bridge.apiHost.set({ apiBaseUrl: null });

    const hasEntry = storage._backing.has("spacefleet.mobile.apiHost");
    console.info(`[platform:async-clear-entry] storage has apiHost entry=${hasEntry}`);
    try {
      expect(hasEntry).toBe(false);
    } catch (err) {
      await dumpPlatformSnapshot("async-clear-entry", { backing: storage._backing });
      throw err;
    }
  });
});
