// The API this build talks to and the client identity it reports. Runs once, before any API call (App.tsx imports it
// first).
import { setApiBaseUrl, setApiClientType, setStorageTunnelOptions } from "@space/shared/api";
import { setClientIdentity } from "@space/shared/appVersion";
import { logApiFailuresOnDevice } from "@space/mobile-shell/apiFailureLog";
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";
import { deviceClientIdentity } from "@space/mobile-media-proxy/app-info";

/** The production API (shared with Badger); only a dev-stack test build inlines PARROT_API_BASE_URL (babel-plugin-api-base-url.js). */
export const API_BASE_URL = (process.env.PARROT_API_BASE_URL || "").trim() || PRODUCTION_API_BASE_URL;

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
