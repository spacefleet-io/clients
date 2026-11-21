/**
 * ACCT-PAIR-01 / PRIV-KEY-05: the NEW-device side of pairing for the TV apps (Badger TV, Parrot TV). A TV has no keyboard worth
 * typing a password on, so it shows a QR + short code and waits for a signed-in app to approve it.
 *
 * The protocol (keypair, POST /pairing/requests, long poll, opening the sealed key) is the shared
 * `createPairingClientCore` from `@space/pairing-crypto`, the same code the desktop app runs. This file only
 * fixes what is TV specific: the device type, the device name and the long-poll length.
 *
 * Kept free of react-native imports so it runs under the logic test runner; each app's wiring (API host,
 * Platform, its library and key store) lives in the app (Badger's `tv/lib/pairingRuntime.ts`).
 */
import { clampDeviceName, createPairingClientCore, type PairingClientCore } from "@space/pairing-crypto";
import type { SpaceAppId } from "@space/shared/appScope";

export { PairingHttpError } from "@space/pairing-crypto";
export type { PairingCreated, PairingPoll, PairingUser } from "@space/pairing-crypto";

export const TV_PAIRING_DEVICE_TYPE = "tv";
/** Seconds the API holds a poll open (`GET /pairing/requests/:id?wait=`; the API caps it at 25). */
export const TV_POLL_WAIT_SECONDS = 25;

export type TvDeviceInfo = {
  /** Android `Build.MANUFACTURER` / `Build.BRAND` / `Build.MODEL` from `Platform.constants`; absent on tvOS. */
  manufacturer?: string | null;
  brand?: string | null;
  model?: string | null;
  isTVOS: boolean;
};

const FALLBACK_NAMES = { appleTv: "Apple TV", androidTv: "Android TV" } as const;

/**
 * "Chromecast with Google TV", "Fire TV Stick 4K", "Apple TV": what the approver sees next to "TV".
 * The model is prefixed with the brand when it does not already carry it ("Sony BRAVIA 4K").
 */
export const resolveTvDeviceName = (info: TvDeviceInfo): string => {
  if (info.isTVOS) return FALLBACK_NAMES.appleTv;
  const model = (info.model ?? "").trim();
  const maker = (info.manufacturer ?? info.brand ?? "").trim();
  if (!model) return clampDeviceName(maker, FALLBACK_NAMES.androidTv);
  const makerShown = maker && !model.toLowerCase().includes(maker.toLowerCase()) ? `${maker} ` : "";
  return clampDeviceName(`${makerShown}${model}`, FALLBACK_NAMES.androidTv);
};

export type TvPairingClientDeps = {
  /** The app asking (`badger`, `parrot`): the approver reads its name and the session is `<app>-tv` (ACCT-PAIR-05). */
  appId: SpaceAppId;
  getApiBaseUrl: () => string;
  deviceName: () => string;
  fetchImpl?: typeof fetch;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  /** Key mode (the key screen): the signed-in TV asks only for the library key with its own session. */
  sessionToken?: () => string | null;
};

export type TvPairingClient = PairingClientCore;

export const createTvPairingClient = (deps: TvPairingClientDeps): TvPairingClient =>
  createPairingClientCore({
    appId: deps.appId,
    getApiBaseUrl: deps.getApiBaseUrl,
    deviceType: TV_PAIRING_DEVICE_TYPE,
    deviceName: deps.deviceName,
    fallbackDeviceName: FALLBACK_NAMES.androidTv,
    fetchImpl: deps.fetchImpl,
    log: deps.log,
    pollWaitSeconds: TV_POLL_WAIT_SECONDS,
    sessionToken: deps.sessionToken,
  });
