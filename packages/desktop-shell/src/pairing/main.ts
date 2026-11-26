/**
 * ACCT-PAIR-01 / PRIV-KEY-05: the NEW-device side of pairing on a computer (Badger desktop and Parrot desktop), kept
 * in the main process so the device's private key and the poll secret never reach a window.
 *
 * The protocol itself (keypair, request, poll, opening the sealed key) is the shared `createPairingClientCore` in
 * `@space/pairing-crypto`, the same code the TV, the phones and the web players run. This file adds what is specific
 * to a computer: its system and name as the device name ("Linux (chris-pc)", shown to the approving phone as
 * "Parrot on Linux (chris-pc)") and the QR drawn as an SVG for the window.
 *
 * Flow (contract: ACCT-PAIR-01, PRIV-KEY-05):
 *   start()  -> own X25519 keypair, POST /pairing/requests (x-space-app = the asking app), QR + short code back.
 *   start({ mode: "key" }) -> the same from the key screen of a signed-in computer: POST /pairing/key-requests with
 *               this computer's session (`sessionToken`); the approval hands that same session back with the key.
 *   poll()   -> GET /pairing/requests/:id; on approval the sealed library key is opened here.
 *   cancel() -> forget the keypair.
 */
import { hostname as osHostname } from "node:os";
import QRCode from "qrcode";
import { PairingHttpError, clampDeviceName, createPairingClientCore, type PairingClientCore, type SealedKey } from "@space/pairing-crypto";
import type { SpaceAppId } from "@space/shared/appScope";
import { retryAfterSecondsToMinutes } from "@space/shared/signInError";
import type { PairingMode, PairingPoll, PairingRefusal, PairingStart, PairingStartOptions } from "./types";
import type { DesktopSystem } from "../clientIdentity";

export const PAIRING_DEVICE_TYPE = "desktop";

export { PairingHttpError };

export type DesktopPairingClientDeps = {
  getApiBaseUrl: () => string;
  /** The app asking to sign in; the approving phone names it ("Parrot on Linux (chris-pc)"). */
  appId: SpaceAppId;
  fetchImpl?: typeof fetch;
  hostname?: () => string;
  /** This computer's system, from the platform layer (`getDesktopPlatform().id`). */
  platform: DesktopSystem;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  /** The session this computer is signed in with (key mode only); null when signed out. */
  sessionToken?: () => string | null;
};

export type DesktopPairingClient = {
  start: (options?: PairingStartOptions) => Promise<PairingStart>;
  poll: (requestId: string) => Promise<PairingPoll>;
  cancel: () => void;
  /** ACCT-PAIR-07: the library key the sister app on this computer sealed to this request, over the local channel. */
  deliverLocalKey: (requestId: string, sealedKey: SealedKey) => boolean;
};

const SYSTEM_NAMES: Record<DesktopSystem, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };

/** "Linux (chris-pc)": the system first, so the phone reads "Parrot on Linux (chris-pc) wants to sign in". */
export const resolveDeviceName = (rawHostname: string, platform: DesktopSystem): string => {
  const host = rawHostname.trim().replace(/\.local$/i, "");
  const system = SYSTEM_NAMES[platform];
  return clampDeviceName(host ? `${system} (${host})` : system, "Computer");
};

/**
 * A refused call is "failed" (or "rate_limited" on 429, with the API's wait in whole minutes); fetch() rejecting means
 * the API cannot be reached.
 */
export const pairingRefusalOf = (err: unknown): PairingRefusal => {
  if (!(err instanceof PairingHttpError)) return { error: "unreachable" };
  if (err.status !== 429) return { error: "failed" };
  return { error: "rate_limited", retryAfterMinutes: retryAfterSecondsToMinutes(err.retryAfterSeconds) };
};

export const createDesktopPairingClient = (deps: DesktopPairingClientDeps): DesktopPairingClient => {
  const coreFor = (mode: PairingMode) =>
    createPairingClientCore({
      getApiBaseUrl: deps.getApiBaseUrl,
      appId: deps.appId,
      deviceType: PAIRING_DEVICE_TYPE,
      deviceName: () => resolveDeviceName((deps.hostname ?? osHostname)(), deps.platform),
      fallbackDeviceName: "Computer",
      fetchImpl: deps.fetchImpl,
      log: deps.log,
      // Long-poll: one poll per ~27 s instead of one per 2 s, far under the API's 20 polls per minute per address (OPS-LIMIT-02).
      pollWaitSeconds: 25,
      // Key mode without a session (signed out, or no provider) is refused by the core with a 401 before any call.
      ...(mode === "key" ? { sessionToken: deps.sessionToken ?? (() => null) } : {}),
    });
  const cores: Record<PairingMode, PairingClientCore> = { sign_in: coreFor("sign_in"), key: coreFor("key") };
  // The mode of the last start(): poll() and cancel() go to its core; the other one is forgotten on every start().
  let mode: PairingMode = "sign_in";

  const start = async (options?: PairingStartOptions): Promise<PairingStart> => {
    mode = options?.mode === "key" ? "key" : "sign_in";
    cores[mode === "key" ? "sign_in" : "key"].cancel();
    const created = await cores[mode].start();
    const qrSvg = await QRCode.toString(created.qrPayload, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    deps.log?.("pairing: code ready", { requestId: created.requestId, app: deps.appId, deviceName: created.deviceName, mode });
    return { ...created, qrSvg };
  };

  return {
    start,
    poll: (requestId) => cores[mode].poll(requestId),
    cancel: () => cores[mode].cancel(),
    deliverLocalKey: (requestId, sealedKey) => cores[mode].deliverLocalKey(requestId, sealedKey),
  };
};
