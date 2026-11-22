/**
 * ACCT-PAIR-01 / PRIV-KEY-05: the NEW-device side of pairing, shared by every app that shows a code and
 * waits for another signed-in device to approve it (desktop main process, TV app).
 *
 * Pure: the only side effects are the injected `fetch` (used by `@space/sdk`) and the OS-free key generation, so it runs in Node,
 * Hermes and under test. Platform specifics (device name, QR drawing, UI) stay with the caller.
 *
 *   start()  -> own X25519 keypair, POST /pairing/requests, short code + QR payload back to the caller.
 *   poll()   -> GET /pairing/requests/:id; on approval the sealed library key is opened here and
 *               {token, user, libraryKey} is handed to the caller.
 *   cancel() -> forget the keypair and abort any request in flight.
 *   deliverLocalKey() -> same-device sign-in (ACCT-PAIR-07): the sister app on this device approved with `localKey`
 *               and handed the sealed key over locally; the API's approval then carries only the token.
 *
 * The API returns the approved payload ONCE, so the opened result is kept in memory until
 * `cancel()` / the next `start()`: a caller that asks again (reload, retry) is not left with nothing.
 */
import * as sdk from "@space/sdk";
import type { SpaceAppId } from "@space/shared/appScope";
import { bytesToBase64 } from "./base64";
import { generateDeviceKeyPair, openSealedKey, type SealedKey } from "./seal";

export const PAIRING_DEVICE_NAME_MAX = 80;
const REQUEST_TIMEOUT_MS = 30_000;
/** Head-room on top of a long poll so the client never gives up before the server answers "pending". */
const LONG_POLL_MARGIN_MS = 15_000;
/** The API caps `?wait=` at 25 seconds. */
const MAX_WAIT_SECONDS = 25;

export type PairingUser = { id: string; email: string; [key: string]: unknown };

export type PairingCreated = {
  requestId: string;
  /** The 8 plain characters, e.g. "ABCDEFGH", shown as two groups of 4, never with a dash (ACCT-PAIR-01). */
  shortCode: string;
  qrPayload: string;
  expiresAt: string;
  deviceName: string;
};

export type PairingPoll =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "approved"; token: string; user: PairingUser; libraryKey: string }
  /** The approver sealed the key but it could not be opened with this device's key. */
  | { status: "key_unreadable" };

type PollResponse =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "consumed" }
  | { status: "approved"; token: string; user: PairingUser; sealedKey: SealedKey; clientType?: string; localKey?: undefined }
  /** ACCT-PAIR-07: approved by the sister app on this device, which hands the sealed key over locally. */
  | { status: "approved"; token: string; user: PairingUser; localKey: true; clientType?: string; sealedKey?: undefined }
  | { status: "key_approved"; user: PairingUser; sealedKey: SealedKey };

export class PairingHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** A 429's `retryAfterSeconds` (OPS-LIMIT-02), null when the answer did not say. */
  readonly retryAfterSeconds: number | null;
  constructor(status: number, code: string | null, retryAfterSeconds: number | null = null) {
    super(code ?? `pairing_http_${status}`);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type PairingClientCoreDeps = {
  /** The app asking to sign in (`x-space-app`): the approver is told "<App> on <device> wants to sign in" and the
   * session the approval creates is `<appId>-<deviceType>` (ACCT-PAIR-05). */
  appId: SpaceAppId;
  getApiBaseUrl: () => string;
  /** What this device announces itself as: "desktop", "tv", ... (the API validates it). */
  deviceType: string;
  /** Raw device name; trimmed and cut to the API's limit here. Empty falls back to `fallbackDeviceName`. */
  deviceName: () => string;
  fallbackDeviceName: string;
  fetchImpl?: typeof fetch;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  /** Seconds the API may hold a poll open (`?wait=`, capped at 25). 0 / undefined = answer at once. */
  pollWaitSeconds?: number;
  /**
   * Key mode (the library-key screen, ACCT-PAIR-01): the device is already signed in and asks only for the key. The
   * request goes to `POST /pairing/key-requests` with this session token, approval creates no new session, and the
   * approved result carries this same token back so callers finish exactly as after a sign-in pairing.
   */
  sessionToken?: () => string | null;
};

type ActiveRequest = {
  requestId: string;
  pollSecret: string;
  privateKey: string;
  approved: Extract<PairingPoll, { status: "approved" }> | null;
  /** Key mode: the device's own session, handed back on approval. */
  sessionToken: string | null;
  /** ACCT-PAIR-07: the library key the sister app handed over locally, opened. */
  localKey: string | null;
  /** ACCT-PAIR-07: the API's once-only answer, kept until the local key arrives. */
  localApproval: { token: string; user: PairingUser } | null;
};

export type PairingClientCore = {
  start: () => Promise<PairingCreated>;
  poll: (requestId: string) => Promise<PairingPoll>;
  cancel: () => void;
  /** Same-device sign-in (ACCT-PAIR-07): the key sealed for `requestId`, received from the sister app. False when it is
   * not this request's or does not open with this device's key. */
  deliverLocalKey: (requestId: string, sealed: SealedKey) => boolean;
};

export const clampDeviceName = (raw: string, fallback: string): string => (raw.trim() || fallback).slice(0, PAIRING_DEVICE_NAME_MAX);

export const createPairingClientCore = (deps: PairingClientCoreDeps): PairingClientCore => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => undefined);
  const waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(deps.pollWaitSeconds ?? 0)));
  let active: ActiveRequest | null = null;
  // Bumped by every start() and cancel(); a request that finishes after a newer call must not become the active one.
  let generation = 0;
  // Long polls only: cancel() must not leave a 25 s request holding the radio. A start() is never aborted, so
  // an older start that finishes after a newer one still resolves (it just is not polled).
  const polling = new Set<AbortController>();

  // One SDK client per call: it reads the (changeable) API base URL, scopes the call to the asking app (`x-space-app`)
  // and goes through the injected fetch. A non-2xx answer is reported as a PairingHttpError.
  const sdkClient = () => sdk.createSpaceClient({ baseUrl: deps.getApiBaseUrl(), appId: deps.appId, fetch: fetchImpl });

  const request = async <T>(
    run: (client: sdk.Client, signal: AbortSignal) => PromiseLike<{ data?: T; error?: unknown; response?: Response }>,
    init: { timeoutMs: number; abortable?: boolean },
  ): Promise<T> => {
    const controller = new AbortController();
    if (init.abortable) polling.add(controller);
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    try {
      return await sdk.unwrap(run(sdkClient(), controller.signal));
    } catch (err) {
      if (err instanceof sdk.ApiError) {
        const { error, retryAfterSeconds } = err.payload;
        throw new PairingHttpError(
          err.status,
          typeof error === "string" ? error : null,
          typeof retryAfterSeconds === "number" ? retryAfterSeconds : null,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      polling.delete(controller);
    }
  };

  const forget = () => {
    generation += 1;
    active = null;
    for (const controller of polling) controller.abort();
    polling.clear();
  };

  const start = async (): Promise<PairingCreated> => {
    forget();
    const mine = generation;
    const keys = generateDeviceKeyPair();
    const deviceName = clampDeviceName(deps.deviceName(), deps.fallbackDeviceName);
    const sessionToken = deps.sessionToken?.() ?? null;
    if (deps.sessionToken && !sessionToken) throw new PairingHttpError(401, "unauthorized");
    const body = { deviceType: deps.deviceType, deviceName, publicKey: keys.publicKey };
    const created = await request(
      (client, signal) =>
        sessionToken
          ? sdk.createPairingKeyRequest({ client, body, signal, headers: { Authorization: `Bearer ${sessionToken}` } })
          : sdk.createPairingRequest({ client, body, signal }),
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    // A newer start() or a cancel() while this request was in flight wins: this one is no longer polled.
    if (mine === generation) {
      active = { requestId: created.requestId, pollSecret: created.pollSecret, privateKey: keys.privateKey, approved: null, sessionToken, localKey: null, localApproval: null };
    }
    log("pairing request created", { requestId: created.requestId, expiresAt: created.expiresAt, deviceName });
    return {
      requestId: created.requestId,
      shortCode: created.shortCode,
      qrPayload: created.qrPayload,
      expiresAt: created.expiresAt,
      deviceName,
    };
  };

  const poll = async (requestId: string): Promise<PairingPoll> => {
    const current = active;
    if (!current || current.requestId !== requestId) return { status: "expired" };
    if (current.approved) return current.approved;
    // ACCT-PAIR-07: the API already answered; only the sister app's key is missing.
    if (current.localApproval) return finishLocal(current);
    const mine = generation;

    let res: PollResponse;
    try {
      res = await request<PollResponse>(
        (client, signal) =>
          sdk.getPairingRequest({
            client,
            path: { requestId },
            query: { pollSecret: current.pollSecret, ...(waitSeconds > 0 ? { wait: String(waitSeconds) } : {}) },
            signal,
          }),
        { abortable: true, timeoutMs: waitSeconds * 1000 + LONG_POLL_MARGIN_MS },
      );
    } catch (err) {
      // cancel()/start() aborted this very poll: the caller already moved on.
      if (mine !== generation) return { status: "expired" };
      // The request is unknown or gone: same thing to the user as an expired code.
      if (err instanceof PairingHttpError && (err.status === 404 || err.status === 410)) return { status: "expired" };
      throw err;
    }
    if (mine !== generation) return { status: "expired" };

    if (res.status === "pending") return { status: "pending" };
    if (res.status === "expired" || res.status === "denied") {
      log("pairing request ended", { requestId, status: res.status });
      forget();
      return { status: res.status };
    }
    if (res.status === "consumed") {
      // Approved earlier and already delivered, but we lost the payload (restart): cannot be recovered.
      log("pairing request already consumed without a stored result", { requestId });
      forget();
      return { status: "expired" };
    }
    if (res.status === "approved" && res.localKey) {
      current.localApproval = { token: res.token, user: res.user };
      log("pairing approved by the sister app; key comes locally", { requestId, keyHere: current.localKey !== null });
      return finishLocal(current);
    }

    let libraryKey: string;
    try {
      libraryKey = bytesToBase64(openSealedKey({ devicePrivateKey: current.privateKey, requestId, sealed: res.sealedKey as SealedKey }));
    } catch (err) {
      log("pairing sealed key could not be opened", { requestId, message: err instanceof Error ? err.message : String(err) });
      forget();
      return { status: "key_unreadable" };
    }
    // Key mode: the device keeps the session it asked with; the API sent no new one.
    const token = res.status === "key_approved" ? current.sessionToken : res.token;
    if (!token) {
      log("pairing key approved without a session to keep it", { requestId });
      forget();
      return { status: "expired" };
    }
    const approved: Extract<PairingPoll, { status: "approved" }> = {
      status: "approved",
      token,
      user: res.user,
      libraryKey,
    };
    current.approved = approved;
    log("pairing approved", { requestId, userId: res.user.id, keyOnly: res.status === "key_approved", clientType: res.status === "approved" ? (res.clientType ?? null) : null });
    return approved;
  };

  const finishLocal = (current: ActiveRequest): PairingPoll => {
    if (!current.localApproval || current.localKey === null) return { status: "pending" };
    const approved: Extract<PairingPoll, { status: "approved" }> = {
      status: "approved",
      token: current.localApproval.token,
      user: current.localApproval.user,
      libraryKey: current.localKey,
    };
    current.approved = approved;
    log("pairing approved", { requestId: current.requestId, userId: approved.user.id, localKey: true });
    return approved;
  };

  const deliverLocalKey = (requestId: string, sealed: SealedKey): boolean => {
    const current = active;
    if (!current || current.requestId !== requestId) {
      log("local key for a request this device is not waiting on", { requestId });
      return false;
    }
    try {
      current.localKey = bytesToBase64(openSealedKey({ devicePrivateKey: current.privateKey, requestId, sealed }));
      log("local key received", { requestId });
      return true;
    } catch (err) {
      log("local key could not be opened", { requestId, message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  return { start, poll, cancel: forget, deliverLocalKey };
};
