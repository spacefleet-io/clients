/**
 * @test-id PARROT-MOBILE-CONFIG-001
 * @level unit
 * @why A Play build of Parrot must sign in to the production API Badger uses (REL-LAUNCH-03, REL-LAUNCH-06); the old
 *   default pointed at a domain that no longer serves the API, so every tester's sign-in failed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";

// config.ts states the build's identity from the SpaceAppInfo native module (REL-CD-29).
// `native` drives the iOS launch-argument read (Settings) in the release smoke cases below; Android by default.
const native = vi.hoisted(() => ({ os: "android", launchArgs: (_name: string): unknown => undefined }));
vi.mock("react-native", () => ({
  NativeModules: { SpaceAppInfo: { appVersion: "0.1.3", installer: "org.fdroid.fdroid" } },
  Platform: {
    get OS() {
      return native.os;
    },
    isTV: false,
  },
  Settings: { get: (name: string) => native.launchArgs(name) },
}));
const apiBaseUrlPlugin = require("../babel-plugin-api-base-url.js");

const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[PARROT-MOBILE-CONFIG-001] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// config.ts reads the build-time env when it loads, so each case re-imports it after stubbing the env.
describe("Parrot phone API target", () => {
  it("a release build (no PARROT_API_BASE_URL) talks to api.spacefleet.io", async () => {
    vi.stubEnv("PARROT_API_BASE_URL", "");
    const { API_BASE_URL } = await import("../src/config");
    expect(API_BASE_URL).toBe(PRODUCTION_API_BASE_URL);
    expect(API_BASE_URL).toBe("https://api.spacefleet.io");
  });

  it("a dev-stack test build uses the inlined PARROT_API_BASE_URL", async () => {
    vi.stubEnv("PARROT_API_BASE_URL", "http://10.0.2.2:3000 ");
    const { API_BASE_URL } = await import("../src/config");
    expect(API_BASE_URL).toBe("http://10.0.2.2:3000");
  });

  it("every API call says which build and store is calling @req OPS-BIZ-10", async () => {
    const testId = "client-identity";
    vi.stubEnv("PARROT_API_BASE_URL", "");
    await import("../src/config");
    // The same module instance config.ts just loaded (resetModules gives each case a fresh one).
    const { clientIdentityHeaders } = await import("@space/shared/appVersion");
    const sent = clientIdentityHeaders();
    log(testId, "sent", sent);
    expect(sent).toEqual({ "x-space-client": "parrot/android/0.1.3+fdroid" });
  });
});

// @req REL-TEST-36[ci]
// The Apple release smoke starts the release configuration of the TestFlight commit, built for the simulator, on a
// dev-stack lane through `-SFSmokeApiBaseUrl`. A device bundle (TestFlight, App Store) and an Android one never read it.
describe("release smoke lane override (simulator bundles only)", () => {
  const lane = "http://127.0.0.1:41234";
  const launchArgs = (value: unknown) => (name: string) => (name === "SFSmokeApiBaseUrl" ? value : undefined);

  afterEach(() => {
    native.os = "android";
    native.launchArgs = () => undefined;
  });

  it("inlines SF_SIMULATOR_BUILD from Xcode's platform: 1 for a simulator SDK, empty for a device archive and Android", () => {
    const testId = "simulator-flag";
    log(testId, "start");
    expect(apiBaseUrlPlugin.simulatorBuildValue({ PLATFORM_NAME: "iphonesimulator" })).toBe("1");
    expect(apiBaseUrlPlugin.simulatorBuildValue({ PLATFORM_NAME: "appletvsimulator" })).toBe("1");
    expect(apiBaseUrlPlugin.simulatorBuildValue({ PLATFORM_NAME: "iphoneos" })).toBe("");
    expect(apiBaseUrlPlugin.simulatorBuildValue({ PLATFORM_NAME: "appletvos" })).toBe("");
    expect(apiBaseUrlPlugin.simulatorBuildValue({})).toBe("");
    log(testId, "done");
  });

  it("a simulator bundle honours a loopback lane only; a device bundle never reads the argument", async () => {
    const testId = "smoke-lane";
    vi.stubEnv("PARROT_API_BASE_URL", "");
    const { SMOKE_API_LAUNCH_ARGUMENT, smokeApiBaseUrl } = await import("../src/config");
    log(testId, "start", { argument: SMOKE_API_LAUNCH_ARGUMENT });
    expect(SMOKE_API_LAUNCH_ARGUMENT).toBe("SFSmokeApiBaseUrl");
    expect(smokeApiBaseUrl("1", launchArgs(lane))).toBe(lane);
    expect(smokeApiBaseUrl("1", launchArgs(`${lane}/`))).toBe(lane);
    expect(smokeApiBaseUrl("1", launchArgs("http://localhost:3001"))).toBe("http://localhost:3001");
    expect(smokeApiBaseUrl("1", launchArgs(undefined))).toBeNull();
    // Only a loopback address with a port: never another server, never an HTTPS host elsewhere.
    for (const other of ["http://203.0.113.20:3000", "https://api.example.com", "http://127.0.0.1", "file:///x", 42]) {
      log(testId, "refused", other);
      expect(smokeApiBaseUrl("1", launchArgs(other))).toBeNull();
    }
    for (const deviceBuild of ["", undefined, "true"]) {
      expect(smokeApiBaseUrl(deviceBuild, launchArgs(lane))).toBeNull();
    }
    log(testId, "done");
  });

  it("a simulator bundle started on a lane talks to it; without the argument, or on a device, to production", async () => {
    const testId = "smoke-target";
    vi.stubEnv("PARROT_API_BASE_URL", "");
    vi.stubEnv("SF_SIMULATOR_BUILD", "1");
    native.os = "ios";
    native.launchArgs = launchArgs(lane);
    const onLane = await import("../src/config");
    log(testId, "lane", onLane.API_BASE_URL);
    expect(onLane.API_BASE_URL).toBe(lane);

    vi.resetModules();
    native.launchArgs = launchArgs(undefined);
    const noArgument = await import("../src/config");
    log(testId, "no argument", noArgument.API_BASE_URL);
    expect(noArgument.API_BASE_URL).toBe(PRODUCTION_API_BASE_URL);

    vi.resetModules();
    vi.stubEnv("SF_SIMULATOR_BUILD", "");
    native.launchArgs = launchArgs(lane);
    const device = await import("../src/config");
    log(testId, "device bundle", device.API_BASE_URL);
    expect(device.API_BASE_URL).toBe(PRODUCTION_API_BASE_URL);
  });
});
