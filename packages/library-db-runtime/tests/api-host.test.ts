import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getApiBaseUrl,
  getCustomApiBaseUrl,
  getDefaultApiBaseUrl,
  setCustomApiBaseUrl,
} from "../src/apiHost";

// Suite-id: api-host
// Dumps the resolved api-host state: env overrides, computed api base, custom
// host on disk. Wrapped in try/catch.
const dumpApiHostSnapshot = (label: string) => {
  try {
    console.error(`=== [api-host:${label}] snapshot ===`);
    console.error(
      `env: SF_USER_DATA_PATH=${JSON.stringify(process.env.SF_USER_DATA_PATH)} ` +
        `SF_API_BASE_URL=${JSON.stringify(process.env.SF_API_BASE_URL)}`,
    );
    console.error(`getDefaultApiBaseUrl()=${JSON.stringify(getDefaultApiBaseUrl())}`);
    console.error(`getApiBaseUrl()=${JSON.stringify(getApiBaseUrl())}`);
    console.error(`getCustomApiBaseUrl()=${JSON.stringify(getCustomApiBaseUrl())}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-runtime-"));
  process.env.SF_USER_DATA_PATH = root;
  delete process.env.SF_API_BASE_URL;
  console.info(`[api-host:setup] root=${root} env cleared (SF_API_BASE_URL)`);
});

afterEach(() => {
  console.info(`[api-host:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
  delete process.env.SF_API_BASE_URL;
});

describe("runtime api host", () => {
  it("defaults to production API when no override is set", () => {
    console.info(`[api-host:default] no override set`);
    try {
      expect(getApiBaseUrl()).toBe(getDefaultApiBaseUrl());
      expect(getCustomApiBaseUrl()).toBeNull();
      console.info(`[api-host:default] resolved=${getApiBaseUrl()} custom=null OK`);
    } catch (err) {
      console.error(`[api-host:default] assertion failed`);
      dumpApiHostSnapshot("default-failure");
      throw err;
    }
  });

  it("normalizes and persists custom API host", () => {
    console.info(`[api-host:custom] setting custom api host to bare hostname`);
    try {
      const result = setCustomApiBaseUrl("api.dev.spacebadger.io");
      console.info(`[api-host:custom] setCustomApiBaseUrl returned=${JSON.stringify(result)}`);
      expect(result.customApiBaseUrl).toBe("https://api.dev.spacebadger.io");
      expect(getApiBaseUrl()).toBe("https://api.dev.spacebadger.io");
      console.info(`[api-host:custom] verified resolved api host=${getApiBaseUrl()}`);
    } catch (err) {
      console.error(`[api-host:custom] assertion failed`);
      dumpApiHostSnapshot("custom-failure");
      throw err;
    }
  });

  it("prefers env host", () => {
    process.env.SF_API_BASE_URL = "https://api.override.spacebadger.io/";
    console.info(`[api-host:env] SF_API_BASE_URL set, calling getApiBaseUrl`);
    try {
      const value = getApiBaseUrl();
      console.info(`[api-host:env] getApiBaseUrl returned=${value}`);
      expect(value).toBe("https://api.override.spacebadger.io");
    } catch (err) {
      console.error(`[api-host:env] assertion failed`);
      dumpApiHostSnapshot("env-failure");
      throw err;
    }
  });
});
