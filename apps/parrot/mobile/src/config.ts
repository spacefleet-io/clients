// The API this build talks to and the client identity it reports. Runs once, before any API call (App.tsx imports it
// first).
import { Platform, Settings } from "react-native";
import { setApiBaseUrl, setApiClientType, setStorageTunnelOptions } from "@space/shared/api";
import { setClientIdentity } from "@space/shared/appVersion";
import { logApiFailuresOnDevice } from "@space/mobile-shell/apiFailureLog";
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";
import { deviceClientIdentity } from "@space/mobile-media-proxy/app-info";

/**
 * REL-TEST-36: the launch argument the Apple release smoke starts the app with (`-SFSmokeApiBaseUrl
 * http://127.0.0.1:<lane api port>`, from the UI test's `XCUIApplication.launchArguments`), read through the iOS user
 * defaults (the argument domain). Honoured only by a bundle built for the iOS or tvOS simulator (`SF_SIMULATOR_BUILD`,
 * inlined at build time from Xcode's PLATFORM_NAME by babel-plugin-api-base-url.js), and only for a loopback address:
 * the smoke runs the release configuration of the TestFlight commit on a simulator against a dev-stack lane on the
 * same Mac. A device build's bundle never reads it, so a TestFlight or App Store build talks to production only
 * (ACCT-AUTH-09). Same argument and rule as Badger's (apps/badger/mobile/src/lib/apiConfig.ts). Not a picker: nothing
 * in the app sets it.
 */
export const SMOKE_API_LAUNCH_ARGUMENT = "SFSmokeApiBaseUrl";

const readLaunchArgument = (name: string): unknown => {
  if (Platform.OS !== "ios") return undefined;
  try {
    return Settings.get(name);
  } catch {
    return undefined;
  }
};

/** The release smoke's lane API (see SMOKE_API_LAUNCH_ARGUMENT), or null. */
export const smokeApiBaseUrl = (
  simulatorBuild: string | undefined = process.env.SF_SIMULATOR_BUILD,
  read: (name: string) => unknown = readLaunchArgument,
): string | null => {
  if (simulatorBuild !== "1") return null;
  const value = read(SMOKE_API_LAUNCH_ARGUMENT);
  if (typeof value !== "string") return null;
  const url = value.trim().replace(/\/+$/u, "");
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/u.test(url) ? url : null;
};

/**
 * The production API (shared with Badger). A dev-stack test build inlines PARROT_API_BASE_URL
 * (babel-plugin-api-base-url.js); a simulator bundle started by the release smoke talks to the smoke's lane.
 */
export const API_BASE_URL = (process.env.PARROT_API_BASE_URL || "").trim() || smokeApiBaseUrl() || PRODUCTION_API_BASE_URL;

setApiBaseUrl(API_BASE_URL);
setApiClientType("parrot-mobile");
// REL-CD-29: every call says which build is calling (`parrot/android/0.1.3+play`, `parrot/ios/0.1.3`), as Badger's do.
setClientIdentity(deviceClientIdentity("parrot"));
// REL-LOG-31: a local line per failed API call, with the server's request id.
logApiFailuresOnDevice();
// Parrot's library and audio live in Parrot's storage scope (`x-space-app: parrot`, PLAT-SUITE-01).
setStorageTunnelOptions({
  tunnelMode: "waterfall",
  preferWsDownloadStream: true,
  preferWebSocket: true,
  appId: "parrot",
  log: (event, payload) => console.log("parrot.storage-tunnel", event, JSON.stringify(payload ?? null)),
});
