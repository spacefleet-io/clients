import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getApiBaseUrl,
  getCustomApiBaseUrl,
  getDefaultApiBaseUrl,
  getResolvedDefaultApiBaseUrl,
  initializeApiBaseUrl,
  serverPickerAllowed,
  setCustomApiBaseUrl,
} from "../src/main/apiHost";

let root = "";

// Dump-on-failure: surface the resolved URLs and the env vars that drive them,
// so a resolution mismatch is diagnosable without rerun. Wrapped in try/catch
// so a dump failure can never mask the real assertion.
const dumpApiHostSnapshot = (label: string) => {
  try {
    const env = {
      SF_USER_DATA_PATH: process.env.SF_USER_DATA_PATH,
      SF_API_BASE_URL: process.env.SF_API_BASE_URL,
      SF_DEV_SERVER_URL: process.env.SF_DEV_SERVER_URL,
    };
    console.error(`=== [api-host:${label}] snapshot ===`);
    console.error(`env=${JSON.stringify(env, null, 2)}`);
    console.error(
      `resolved: apiBase=${JSON.stringify(getApiBaseUrl())} default=${JSON.stringify(getDefaultApiBaseUrl())} resolvedDefault=${JSON.stringify(getResolvedDefaultApiBaseUrl())} custom=${JSON.stringify(getCustomApiBaseUrl())}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desktop-api-host-"));
  console.info(`[api-host:setup] userData root=${root}; clearing SF_API_BASE_URL`);
  process.env.SF_USER_DATA_PATH = root;
  delete process.env.SF_API_BASE_URL;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
  delete process.env.SF_API_BASE_URL;
  delete process.env.SF_DEV_SERVER_URL;
  vi.unstubAllEnvs();
});

describe("desktop api host config", () => {
  it("uses default base URL without overrides", () => {
    const apiBase = getApiBaseUrl();
    const def = getDefaultApiBaseUrl();
    const custom = getCustomApiBaseUrl();
    console.info(`[api-host:no-override] apiBase=${apiBase} default=${def} custom=${JSON.stringify(custom)}`);
    if (apiBase !== def || custom !== null) {
      dumpApiHostSnapshot("no-override");
    }
    expect(getApiBaseUrl()).toBe(getDefaultApiBaseUrl());
    expect(getCustomApiBaseUrl()).toBeNull();
  });

  it("uses local api by default in dev mode", () => {
    process.env.SF_DEV_SERVER_URL = "http://localhost:3007";
    const resolvedDefault = getResolvedDefaultApiBaseUrl();
    const apiBase = getApiBaseUrl();
    console.info(`[api-host:dev-mode] devServer=${process.env.SF_DEV_SERVER_URL} resolvedDefault=${resolvedDefault} apiBase=${apiBase}`);
    if (resolvedDefault !== "http://127.0.0.1:3000" || apiBase !== "http://127.0.0.1:3000") {
      dumpApiHostSnapshot("dev-mode");
    }
    expect(getResolvedDefaultApiBaseUrl()).toBe("http://127.0.0.1:3000");
    expect(getApiBaseUrl()).toBe("http://127.0.0.1:3000");
  });

  it("persists normalized custom URL", () => {
    console.info(`[api-host:persist-custom] setting custom URL from bare host`);
    const result = setCustomApiBaseUrl("api.dev.spacebadger.io");
    console.info(`[api-host:persist-custom] normalized=${result.customApiBaseUrl} apiBase=${getApiBaseUrl()}`);
    if (result.customApiBaseUrl !== "https://api.dev.spacebadger.io" || getApiBaseUrl() !== "https://api.dev.spacebadger.io") {
      dumpApiHostSnapshot("persist-custom");
    }
    expect(result.customApiBaseUrl).toBe("https://api.dev.spacebadger.io");
    expect(getApiBaseUrl()).toBe("https://api.dev.spacebadger.io");
  });

  it("prefers env override", () => {
    process.env.SF_API_BASE_URL = "https://api.override.spacebadger.io/";
    console.info(`[api-host:env-override] SF_API_BASE_URL=${process.env.SF_API_BASE_URL}`);
    const resolved = initializeApiBaseUrl();
    console.info(`[api-host:env-override] resolved=${resolved}`);
    if (resolved !== "https://api.override.spacebadger.io") {
      dumpApiHostSnapshot("env-override");
    }
    expect(resolved).toBe("https://api.override.spacebadger.io");
  });
});

// @req ACCT-AUTH-09[badger-desktop]
describe("server picker: development builds only", () => {
  const stubRelease = () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SF_DEV_TICKET_KEY", "");
  };
  const writeStaleConfig = () => {
    const path = join(root, "runtime-config.json");
    writeFileSync(path, JSON.stringify({ customApiBaseUrl: "http://192.168.0.20:3000" }), "utf8");
    return path;
  };

  it("a release build ignores a stored custom server (stale from an old dev install) and uses the production API", () => {
    const path = writeStaleConfig();
    stubRelease();
    console.info(`[api-host:release-ignores-stored] picker=${serverPickerAllowed()} stored=${readFileSync(path, "utf8")}`);
    const custom = getCustomApiBaseUrl();
    const apiBase = getApiBaseUrl();
    const initialized = initializeApiBaseUrl();
    console.info(`[api-host:release-ignores-stored] custom=${JSON.stringify(custom)} apiBase=${apiBase} initialized=${initialized} env=${process.env.SF_API_BASE_URL}`);
    if (apiBase !== "https://api.spacefleet.io") dumpApiHostSnapshot("release-ignores-stored");
    expect(serverPickerAllowed()).toBe(false);
    expect(custom).toBeNull();
    expect(apiBase).toBe("https://api.spacefleet.io");
    expect(initialized).toBe("https://api.spacefleet.io");
    expect(process.env.SF_API_BASE_URL).toBe("https://api.spacefleet.io");
  });

  it("a release build refuses to store a server: the setter leaves the config untouched and answers the production API", () => {
    const path = writeStaleConfig();
    const before = readFileSync(path, "utf8");
    stubRelease();
    const result = setCustomApiBaseUrl("api.elsewhere.example");
    console.info(`[api-host:release-set-refused] result=${JSON.stringify(result)} config=${readFileSync(path, "utf8")}`);
    expect(result).toEqual({ apiBaseUrl: "https://api.spacefleet.io", customApiBaseUrl: null });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(getApiBaseUrl()).toBe("https://api.spacefleet.io");
  });

  it("a dev build and a build:test build keep the picker and honour the stored server", () => {
    for (const env of [{ DEV: true, flag: "" }, { DEV: false, flag: "1" }]) {
      writeStaleConfig();
      delete process.env.SF_API_BASE_URL;
      vi.stubEnv("DEV", env.DEV);
      vi.stubEnv("VITE_SF_DEV_TICKET_KEY", env.flag);
      console.info(`[api-host:dev-keeps-picker] env=${JSON.stringify(env)} picker=${serverPickerAllowed()} custom=${getCustomApiBaseUrl()}`);
      expect(serverPickerAllowed()).toBe(true);
      expect(getCustomApiBaseUrl()).toBe("http://192.168.0.20:3000");
      expect(getApiBaseUrl()).toBe("http://192.168.0.20:3000");
    }
  });
});
