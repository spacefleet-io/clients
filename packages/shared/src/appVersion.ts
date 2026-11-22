import { ApiError, onApiError, setSpaceClientHeader, SPACE_CLIENT_HEADER, spaceClientHeaders } from "@space/sdk";
import { isSpaceAppId, type SpaceAppId } from "./appScope";

/**
 * REL-CD-29: every app says which app, platform and version it is on every API call, in one header
 * (`x-space-client: badger/android/0.3.1`). The API refuses a call from a version below the minimum for that app and
 * platform with 426 `app_update_required`, and the app shows its update screen. Shared by the API (the check) and every
 * app (the header and the refusal).
 */
export { SPACE_CLIENT_HEADER };

/** The `error` code of the 426 answer a too-old app gets. */
export const APP_UPDATE_REQUIRED = "app_update_required";

/** The HTTP status of that answer (426 Upgrade Required). */
export const APP_UPDATE_REQUIRED_STATUS = 426;

/**
 * Where an app runs. A minimum is set per app and per platform, because each store ships updates at its own pace.
 * `kodi` and `jellyfin` are Badger's Kodi add-on and Jellyfin plugin (`badger/kodi/<ver>`), each on its own repository.
 */
export const CLIENT_PLATFORMS = ["desktop", "android", "ios", "android-tv", "tvos", "web", "kodi", "jellyfin"] as const;

export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

export const isClientPlatform = (value: string): value is ClientPlatform =>
  (CLIENT_PLATFORMS as readonly string[]).includes(value);

export type ClientIdentity = { app: SpaceAppId; platform: ClientPlatform; version: string };

const VERSION_PATTERN = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.+-]*)?$/;

/** `badger/android/0.3.1`. */
export const formatClientHeader = ({ app, platform, version }: ClientIdentity): string => `${app}/${platform}/${version}`;

/** The identity a header states, or null when it is missing or malformed (such a call is never refused for its version). */
export const parseClientHeader = (value: string | null | undefined): ClientIdentity | null => {
  if (!value) return null;
  const [app, platform, version, ...rest] = value.trim().toLowerCase().split("/");
  if (rest.length > 0 || !app || !platform || !version) return null;
  if (!isSpaceAppId(app) || !isClientPlatform(platform) || !VERSION_PATTERN.test(version)) return null;
  return { app, platform, version };
};

/**
 * OPS-BIZ-10: how the app was installed, sent as the version's `+<source>` build metadata (`0.3.1+play`). Android
 * reports the installer family, the Linux desktop how it is packaged, the Windows and macOS desktop the system its
 * installer is for (WEB-ADMIN-39: so the admin accounts page tells Linux, Windows and macOS apart); nothing finer leaves
 * the device.
 */
export const INSTALL_SOURCES = ["play", "fdroid", "obtainium", "sideload", "flatpak", "appimage", "system", "windows", "macos"] as const;

export type InstallSource = (typeof INSTALL_SOURCES)[number];

const isInstallSource = (value: string): value is InstallSource => (INSTALL_SOURCES as readonly string[]).includes(value);

/** `0.3.1+play` → `{ version: "0.3.1", source: "play" }`; a version without a known source keeps its suffix, source null. */
export const splitInstallSource = (version: string): { version: string; source: InstallSource | null } => {
  const plus = version.lastIndexOf("+");
  if (plus < 0) return { version, source: null };
  const source = version.slice(plus + 1).toLowerCase();
  return isInstallSource(source) ? { version: version.slice(0, plus), source } : { version, source: null };
};

const numericParts = (version: string): number[] =>
  version
    .split(/[-+]/, 1)[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

/** Compares dotted versions part by part (`1.10` > `1.9`, `1.0` = `1`); a `-beta`/`+build` suffix is ignored. */
export const compareVersions = (a: string, b: string): number => {
  const left = numericParts(a);
  const right = numericParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
};

/** The body of the 426 answer. */
export type AppUpdateRequiredPayload = {
  error: typeof APP_UPDATE_REQUIRED;
  app: SpaceAppId;
  platform: ClientPlatform;
  version: string;
  minVersion: string;
  /**
   * Why, when it is not the version floor: `library_op_stream` = the account's library moved to an op stream this
   * build does not declare, or holds an op type it does not know (LIB-FMT-13), whatever its version. Another app's
   * library states its own reason through {@link requireLibraryUpdate}.
   */
  reason?: string;
  /** With `reason: "library_op_stream"`: the op stream version the library needs. */
  opStreamVersion?: number;
};

/** The 426 `reason` of a library switched to an op stream the calling build does not declare (LIB-FMT-13). */
export const LIBRARY_OP_STREAM_REASON = "library_op_stream";

/**
 * Why a Parrot build must update for the account's music library (PAR-FMT-01, API-VER-01): the library file is at a
 * newer schema than the build knows, or the account stores songs split in parts and the build predates that format.
 */
export const LIBRARY_SCHEMA_REASON = "library_schema";

/** True when an API error is the "please update" refusal. */
export const isAppUpdateRequired = (error: unknown): error is ApiError =>
  error instanceof ApiError &&
  error.status === APP_UPDATE_REQUIRED_STATUS &&
  error.payload?.error === APP_UPDATE_REQUIRED;

/** The 409 `error` code of a library upload declaring an older format than the account's library (LIB-FMT-05). */
export const LIBRARY_FORMAT_DOWNGRADE = "library_format_downgrade";

/**
 * True when the API refused a library save because the account's library is in a newer format than this build
 * writes (LIB-FMT-05). Such a build can never save that library again, so it must update (LIB-FMT-09).
 */
export const isLibraryFormatRefusal = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 409 && error.payload?.error === LIBRARY_FORMAT_DOWNGRADE;

/**
 * The typed "please update" outcome of a failed call, or null when the failure is anything else. A library format
 * refusal (LIB-FMT-09) is one too: its body names no minimum, so the payload states this build's own identity and an
 * empty `minVersion` (the update screens never show the minimum).
 */
export const appUpdateRequiredFrom = (error: unknown): AppUpdateRequiredPayload | null => {
  if (isLibraryFormatRefusal(error)) {
    return {
      error: APP_UPDATE_REQUIRED,
      app: identity?.app ?? "badger",
      platform: identity?.platform ?? "desktop",
      version: identity?.version ?? "",
      minVersion: "",
    };
  }
  if (!isAppUpdateRequired(error)) return null;
  const { app, platform, version, minVersion } = error.payload;
  return {
    error: APP_UPDATE_REQUIRED,
    app: typeof app === "string" && isSpaceAppId(app) ? app : "badger",
    platform: typeof platform === "string" && isClientPlatform(platform) ? platform : "desktop",
    version: typeof version === "string" ? version : "",
    minVersion: typeof minVersion === "string" ? minVersion : "",
  };
};

let identity: ClientIdentity | null = null;

/**
 * Called once at app start-up: from then on every API call this process makes through the shared clients (the SDK
 * and every hand-written fetch that spreads {@link clientIdentityHeaders}) says which app, platform and version it is.
 */
export const setClientIdentity = (next: ClientIdentity | null) => {
  identity = next;
  setSpaceClientHeader(next ? formatClientHeader(next) : null);
};

export const getClientIdentity = (): ClientIdentity | null => identity;

/**
 * The environment variable through which an app hands its identity (the `x-space-client` value, `badger/desktop/0.2.3`)
 * to a helper process it starts, such as Badger desktop's local runtime, so that process's API calls state the same
 * build. Unset or malformed: the helper states nothing.
 */
export const CLIENT_IDENTITY_ENV = "SF_CLIENT_IDENTITY";

/**
 * A web player's identity (`badger/web/2026.1118.1915`): the version the website image was built with
 * (`VITE_SPACE_WEB_VERSION`, the built commit's time). Null when the build states none (a dev server) or a malformed
 * one, so such a page is never refused for its version.
 */
export const webClientIdentity = (app: SpaceAppId, version: unknown): ClientIdentity | null =>
  typeof version === "string" && VERSION_PATTERN.test(version.trim()) ? { app, platform: "web", version: version.trim() } : null;

/** The identity header for a hand-written `fetch` to the API (never to a third party); empty while no identity is set. */
export { spaceClientHeaders as clientIdentityHeaders };

let libraryReadOpStreamVersion: number | null = null;

/**
 * Called once at app start-up by a build that reads the library's op stream (`READ_OP_STREAM_VERSION`, which this
 * package cannot import): a 426 `library_op_stream` asking for an op stream at or below it is then not a "please
 * update" for this build but the switch of LIB-FMT-13, so it is not latched; the writer re-reads the library's
 * `targetOpStreamVersion` and retries ({@link isLibraryOpStreamSwitch}).
 */
export const setLibraryReadOpStreamVersion = (version: number | null) => {
  libraryReadOpStreamVersion = version;
};

/**
 * True when the API refused a call because the account's library was switched to an op stream this build already
 * reads (LIB-FMT-13): re-read the library meta and retry declaring the new op stream, instead of asking to update.
 */
export const isLibraryOpStreamSwitch = (error: unknown): boolean => {
  if (!isAppUpdateRequired(error) || libraryReadOpStreamVersion === null) return false;
  const { reason, opStreamVersion } = error.payload ?? {};
  return (
    reason === LIBRARY_OP_STREAM_REASON &&
    typeof opStreamVersion === "number" &&
    opStreamVersion <= libraryReadOpStreamVersion
  );
};

let updateRequired: AppUpdateRequiredPayload | null = null;
const updateListeners = new Set<(payload: AppUpdateRequiredPayload) => void>();

const latchUpdateRequired = (payload: AppUpdateRequiredPayload) => {
  // The first refusal is kept as is: later ones say the same, and a stable value is what React's external-store
  // subscribers (`useSyncExternalStore`) require.
  if (updateRequired) return;
  updateRequired = payload;
  for (const listener of updateListeners) listener(payload);
};

onApiError((error) => {
  if (isLibraryOpStreamSwitch(error)) return;
  const payload = appUpdateRequiredFrom(error);
  if (payload) latchUpdateRequired(payload);
});

/**
 * The library holds a change this build cannot apply (LIB-FMT-13: an op type it does not know): the sync stopped with
 * nothing applied, and the app asks for an update exactly as for the API's 426 `library_op_stream`. No server answer
 * carries it, so the payload states this build's own identity. `reason` names what the library needs (another app's
 * library passes its own).
 */
export const requireLibraryUpdate = (reason: string = LIBRARY_OP_STREAM_REASON) =>
  latchUpdateRequired({
    error: APP_UPDATE_REQUIRED,
    app: identity?.app ?? "badger",
    platform: identity?.platform ?? "desktop",
    version: identity?.version ?? "",
    minVersion: "",
    reason,
  });

/** The refusal this process got, or null while the API has not refused it. Once refused, it stays refused. */
export const getAppUpdateRequired = (): AppUpdateRequiredPayload | null => updateRequired;

/**
 * Calls `listener` the first time any API call of this process is refused with "please update", whichever call it
 * was; called at once when that already happened. Returns the unsubscribe function.
 */
export const onAppUpdateRequired = (listener: (payload: AppUpdateRequiredPayload) => void): (() => void) => {
  updateListeners.add(listener);
  if (updateRequired) listener(updateRequired);
  return () => {
    updateListeners.delete(listener);
  };
};

/** Test-only: forget the identity and a refusal seen before. */
export const __resetAppVersionStateForTests = () => {
  setClientIdentity(null);
  updateRequired = null;
  libraryReadOpStreamVersion = null;
  updateListeners.clear();
};
