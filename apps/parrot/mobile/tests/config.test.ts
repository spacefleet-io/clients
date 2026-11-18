/**
 * @test-id PARROT-MOBILE-CONFIG-001
 * @level unit
 * @why A Play build of Parrot must sign in to the production API Badger uses (REL-LAUNCH-03, REL-LAUNCH-06); the old
 *   default pointed at a domain that no longer serves the API, so every tester's sign-in failed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";

// config.ts states the build's identity from the SpaceAppInfo native module (REL-CD-29).
vi.mock("react-native", () => ({
  NativeModules: { SpaceAppInfo: { appVersion: "0.1.3", installer: "org.fdroid.fdroid" } },
  Platform: { OS: "android", isTV: false },
}));

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
