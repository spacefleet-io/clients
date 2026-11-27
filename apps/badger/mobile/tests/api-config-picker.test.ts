/**
 * @test-id MOBILE-API-CONFIG-PICKER-001
 * @level unit
 * The server picker (choosing the API server on the sign-in screen and in settings) exists in development builds only,
 * phone and TV alike: `__DEV__`, or a `profile` build made for dev-stack testing with `SF_DEV_TICKET_KEY=1`. A release
 * build talks to the production API only and ignores a stored server address, a stale one from an old dev install included.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock below is hoisted above this import, so the module loads against the mocks.
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";
import {
  devStackApiBaseUrl,
  defaultApiBaseUrl,
  getStoredApiHost,
  initApiConfig,
  serverPickerAllowed,
  setStoredApiHost,
} from "../src/lib/apiConfig";

const state = vi.hoisted(() => ({ storage: new Map<string, string>(), applied: [] as string[] }));

// No LibrarySync module: no store version, so no app identity is stated (REL-CD-29).
vi.mock("react-native", () => ({ Platform: { OS: "android", isTV: false }, NativeModules: {} }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => state.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void state.storage.set(key, value),
    removeItem: async (key: string) => void state.storage.delete(key),
  },
}));
vi.mock("@space/shared/api", () => ({
  setApiBaseUrl: (url: string) => void state.applied.push(url),
  setApiClientType: () => undefined,
  setStorageTunnelOptions: () => undefined,
}));

const RELEASE_ENVS = [
  { dev: false, devTicketKeyFlag: undefined },
  { dev: false, devTicketKeyFlag: "" },
  { dev: false, devTicketKeyFlag: "true" },
];
const DEV_ENVS = [
  { dev: true, devTicketKeyFlag: undefined },
  { dev: false, devTicketKeyFlag: "1" },
];
const STALE_DEV_HOST = "http://192.168.0.20:3000";

// @req ACCT-AUTH-09[badger-mobile,badger-tv]
describe("server picker in development builds only", () => {
  beforeEach(() => {
    state.storage.clear();
  });

  it("has the picker only in a development build", () => {
    console.info("[api-config-picker] start build gate");
    expect(PRODUCTION_API_BASE_URL).toBe("https://api.spacefleet.io");
    for (const env of RELEASE_ENVS) {
      console.info(`[api-config-picker] release env ${JSON.stringify(env)}`);
      expect(serverPickerAllowed(env)).toBe(false);
    }
    for (const env of DEV_ENVS) {
      console.info(`[api-config-picker] dev env ${JSON.stringify(env)}`);
      expect(serverPickerAllowed(env)).toBe(true);
    }
    console.info("[api-config-picker] done");
  });

  // @bugfix A Metro debug build started on the production API, so signing in against the local dev stack 404'd
  // until someone typed the dev address into the picker.
  it("starts a Metro build on the dev stack of the computer serving its bundle, every other build on production", () => {
    console.info("[api-config-picker] start default server");
    // A phone on Wi-Fi loads the bundle from the computer's LAN address (REL-ENV-08); an emulator through localhost.
    expect(devStackApiBaseUrl("http://192.168.0.20:8081/")).toBe("http://192.168.0.20:3000");
    expect(devStackApiBaseUrl("http://localhost:8081/")).toBe("http://localhost:3000");
    expect(devStackApiBaseUrl("http://[fd7a:115c::1]:8081/")).toBe("http://[fd7a:115c::1]:3000");
    expect(devStackApiBaseUrl(null)).toBe("http://localhost:3000");
    // No Metro under vitest: the dev build falls back to localhost.
    expect(defaultApiBaseUrl({ dev: true, devTicketKeyFlag: undefined })).toBe("http://localhost:3000");
    // A profile build made for dev-stack testing still starts on production; its picker points it elsewhere.
    expect(defaultApiBaseUrl({ dev: false, devTicketKeyFlag: "1" })).toBe(PRODUCTION_API_BASE_URL);
    // The guided test build names its dev stack at build time (REL-TEST-05); a release build never honours one.
    expect(defaultApiBaseUrl({ dev: false, devTicketKeyFlag: "1", devApiBaseUrl: "http://localhost:3412" })).toBe(
      "http://localhost:3412",
    );
    expect(defaultApiBaseUrl({ dev: false, devTicketKeyFlag: undefined, devApiBaseUrl: "http://localhost:3412" })).toBe(
      PRODUCTION_API_BASE_URL,
    );
    for (const env of RELEASE_ENVS) expect(defaultApiBaseUrl(env)).toBe(PRODUCTION_API_BASE_URL);
    // Vitest defines `__DEV__` as true: the module applied the dev stack at load.
    expect(state.applied[0]).toBe("http://localhost:3000");
    console.info("[api-config-picker] done");
  });

  it("ignores a stored server address in a release build and stores none", async () => {
    console.info("[api-config-picker] start release ignores stored host");
    for (const env of RELEASE_ENVS) {
      state.storage.set("sf_api_host", STALE_DEV_HOST);
      state.applied.length = 0;
      await initApiConfig(env);
      expect(state.applied).toEqual([]);
      expect(await getStoredApiHost(env)).toBeNull();
      await setStoredApiHost("http://10.0.0.5:3000", env);
      expect(state.applied).toEqual([]);
      expect(state.storage.get("sf_api_host")).toBe(STALE_DEV_HOST);
      console.info(`[api-config-picker] release env ${JSON.stringify(env)} kept the production API`);
    }
    console.info("[api-config-picker] done");
  });

  it("applies and stores the picked server in a development build", async () => {
    console.info("[api-config-picker] start dev honours picked host");
    // The bridge reads the stored address once and keeps it, so each build env picks the server the previous one left.
    state.storage.set("sf_api_host", STALE_DEV_HOST);
    let current = STALE_DEV_HOST;
    for (const [index, env] of DEV_ENVS.entries()) {
      state.applied.length = 0;
      await initApiConfig(env);
      expect(state.applied).toEqual([current]);
      expect(await getStoredApiHost(env)).toBe(current);
      const picked = `http://10.0.0.${index + 5}:3000`;
      await setStoredApiHost(picked, env);
      expect(state.storage.get("sf_api_host")).toBe(picked);
      expect(state.applied.at(-1)).toBe(picked);
      current = picked;
      console.info(`[api-config-picker] dev env ${JSON.stringify(env)} switched server to ${picked}`);
    }
    console.info("[api-config-picker] done");
  });
});
