import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setApiBaseUrl, setApiClientType, setStorageTunnelOptions } from "@space/shared/api";
import { setClientIdentity } from "@space/shared/appVersion";
import { deviceClientIdentity } from "@space/mobile-media-proxy/app-info";
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";
import { createAsyncStoragePlatformBridge, type MobilePlatformBridge } from "@space/mobile-shell/platform";
import { currentMobileBuildEnv, isMobileDevBuild, type MobileBuildEnv } from "./devBuild";
import { scopeLogger } from "@space/mobile-shell/logger";

/** The local dev stack's API port (`bun run dev:core:full`). */
export const DEV_API_PORT = 3000;

/**
 * The local dev stack's API on the computer that serves this build's JS bundle (Metro): its LAN address when a phone
 * loads the bundle over Wi-Fi (REL-ENV-08), `localhost` when it comes through a forwarded port (an emulator, an iOS
 * simulator). `localhost` when the bundle's address is unknown.
 */
export const devStackApiBaseUrl = (devServerUrl: string | null): string => {
  const host = devServerUrl ? /^https?:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(devServerUrl.trim())?.[1] : undefined;
  return `http://${host ?? "localhost"}:${DEV_API_PORT}`;
};

/** Metro's address, read from the loaded bundle's URL; null when the bundle was not loaded from Metro. */
const metroServerUrl = (): string | null => {
  try {
    // A dev-only internal of React Native with no public typing; a release build never calls it.
    const getDevServer = require("react-native/Libraries/Core/Devtools/getDevServer").default as () => {
      url: string;
      bundleLoadedFromServer: boolean;
    };
    const server = getDevServer();
    return server.bundleLoadedFromServer ? server.url : null;
  } catch {
    return null;
  }
};

/**
 * The server a build talks to until one is picked: a dev-testing build that names its dev stack at build time
 * (`SF_DEV_API_BASE_URL`, the guided test build, REL-TEST-05) starts there; a Metro (`__DEV__`) build, the one run
 * against a local dev stack, starts on that stack, as the desktop app's dev run does; every other build starts on the
 * production API.
 */
export const defaultApiBaseUrl = (env: MobileBuildEnv = currentMobileBuildEnv()): string => {
  if (env.devApiBaseUrl && isMobileDevBuild(env)) return env.devApiBaseUrl;
  return env.dev === true ? devStackApiBaseUrl(metroServerUrl()) : PRODUCTION_API_BASE_URL;
};

export const platformBridge: MobilePlatformBridge = createAsyncStoragePlatformBridge({
  asyncStorage: AsyncStorage,
  storageKey: "sf_api_host",
  appName: "Badger",
  defaultApiBaseUrl: defaultApiBaseUrl(),
});

// Apply the synchronous parts at module load time so the storage tunnel client
// is always created with `tunnelMode: "waterfall"`. Previously these calls sat
// inside an async initApiConfig invoked from a useEffect, which races against
// LibraryProvider's first tunnel call — if that race lost, the client was
// created with default (no tunnelMode) options and could fall through to
// `runGatewayStreamDownload`, which fetches an entire object body in one shot.
const tunnelLog = scopeLogger("storage-tunnel");
// A TV announces itself as `badger-tv` (the same name a paired TV gets): the API then insists on the account
// password for every pairing approval from this session (ACCT-PAIR-02).
setApiClientType(Platform.isTV ? "badger-tv" : "client-mobile");
// REL-CD-29: every call says which build is calling (`badger/android/0.3.1+play`), so an outdated one is told to
// update, and installs are counted per store.
setClientIdentity(deviceClientIdentity("badger"));
// The default server from the first call on (the shared module's own default, "/api", only means something in a
// browser): a release build has no picker (ACCT-AUTH-09) and nothing else ever points it elsewhere.
setApiBaseUrl(defaultApiBaseUrl());
setStorageTunnelOptions({
  tunnelMode: "waterfall",
  preferWsDownloadStream: true,
  preferWebSocket: true,
  log: (event, payload) => tunnelLog.debug(event, payload),
});

/**
 * Whether this build has the server picker (ACCT-AUTH-09): development builds only, the same build-time switch that
 * makes it trust every environment's ticket key (META-ANON-07). A release build talks to the production API: it
 * trusts the production ticket key only, so another server would silently drop every title and poster.
 */
export const serverPickerAllowed = (env: MobileBuildEnv = currentMobileBuildEnv()): boolean => isMobileDevBuild(env);

/** Applies the picked server. A release build ignores a stored one (a stale value from an old dev install included). */
export const initApiConfig = async (env: MobileBuildEnv = currentMobileBuildEnv()) => {
  if (!serverPickerAllowed(env)) return;
  const state = await platformBridge.apiHost.get();
  if (state.customApiBaseUrl) {
    setApiBaseUrl(state.customApiBaseUrl);
  }
};

/** The picked server, or null; always null in a release build. */
export const getStoredApiHost = async (env: MobileBuildEnv = currentMobileBuildEnv()) => {
  if (!serverPickerAllowed(env)) return null;
  const state = await platformBridge.apiHost.get();
  return state.customApiBaseUrl;
};

/** Stores and applies a picked server; a release build has no picker and stores nothing. */
export const setStoredApiHost = async (host: string, env: MobileBuildEnv = currentMobileBuildEnv()) => {
  if (!serverPickerAllowed(env)) return;
  const state = await platformBridge.apiHost.set({ apiBaseUrl: host });
  setApiBaseUrl(state.apiBaseUrl);
};
