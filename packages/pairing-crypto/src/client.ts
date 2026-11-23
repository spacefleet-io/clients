/**
 * ACCT-PAIR-01 / PRIV-KEY-05: the NEW-device side of pairing, shared by every app that shows a code and
 * waits for another signed-in device to approve it (desktop main process, TV app).
 *
 * Pure: the only side effects are the injected `fetch` (used by `@space/sdk`) and the OS-free key generation, so it runs in Node,
 * Hermes and under test. Platform specifics (device name, QR drawing, UI) stay with the caller.
 *
 *   start()  -> own X25519 keypair and a commitment to it (PRIV-PAIR-01), POST /pairing/requests, short code + QR
 *               payload (carrying the commitment's fingerprint, written here) back to the caller.
 *   poll()   -> GET /pairing/requests/:id; once a sending app connected, reveals this device's number and hands the
 *               6-digit check code to the caller to show; on approval the sealed library key is opened here and
 *               {token, user, libraryKey} is handed to the caller.
 *   cancel() -> forget the keypair, abort any request in flight and delete the request on the API (PRIV-PAIR-03).
 *   deliverLocalKey() -> same-device sign-in (ACCT-PAIR-07): the sister app on this device approved with `localKey`
 *               and handed the sealed key over locally; the API's approval then carries only the token.
 *
 * The API returns the approved payload ONCE, so the opened result is kept in memory until
 * `cancel()` / the next `start()`: a caller that asks again (reload, retry) is not left with nothing.
 */
import * as sdk from "@space/sdk";
import type { SpaceAppId } from "@space/shared/appScope";
import { bytesToBase64 } from "./base64";
import { newPairingNonce, pairingCheckCode, pairingCommitment, withCommitmentFingerprint } from "./checkCode";
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
  /** `checkCode`: a sending app connected (PRIV-PAIR-01); show these six digits until the approval comes. */
  | { status: "pending"; checkCode?: string }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "approved"; token: string; user: PairingUser; libraryKey: string }
  /** The approver sealed the key but it could not be opened with this device's key. */
  | { status: "key_unreadable" };

type PollResponse =
  | { status: "pending"; approverNonce?: string }
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
  /** PRIV-PAIR-01: this device's key, its secret number and the commitment sent with the request. */
  publicKey: string;
  requesterNonce: string;
  commitment: string;
  /** PRIV-PAIR-01: the first approver number a poll carried, pinned before any await; every other number is ignored. */
  approverNonce: string | null;
  /** The check code, once a sending app connected and this device revealed its number. */
  checkCode: string | null;
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

  // tla: PairingV2/RStart
  const start = async (): Promise<PairingCreated> => {
    forget();
    const mine = generation;
    const keys = generateDeviceKeyPair();
    const deviceName = clampDeviceName(deps.deviceName(), deps.fallbackDeviceName);
    const sessionToken = deps.sessionToken?.() ?? null;
    if (deps.sessionToken && !sessionToken) throw new PairingHttpError(401, "unauthorized");
    const requesterNonce = newPairingNonce();
    const commitment = pairingCommitment(keys.publicKey, requesterNonce);
    const body = { deviceType: deps.deviceType, deviceName, publicKey: keys.publicKey, commitment };
    const created = await request(
      (client, signal) =>
        sessionToken
          ? sdk.createPairingKeyRequest({ client, body, signal, headers: { Authorization: `Bearer ${sessionToken}` } })
          : sdk.createPairingRequest({ client, body, signal }),
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    // A newer start() or a cancel() while this request was in flight wins: this one is no longer polled.
    if (mine === generation) {
      active = {
        requestId: created.requestId,
        pollSecret: created.pollSecret,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        requesterNonce,
        commitment,
        approverNonce: null,
        checkCode: null,
        approved: null,
        sessionToken,
        localKey: null,
        localApproval: null,
      };
    }
    log("pairing request created", { requestId: created.requestId, expiresAt: created.expiresAt, deviceName });
    return {
      requestId: created.requestId,
      shortCode: created.shortCode,
      // PRIV-PAIR-01: the fingerprint is written here, over anything the server put in the link.
      qrPayload: withCommitmentFingerprint(created.qrPayload, commitment),
      expiresAt: created.expiresAt,
      deviceName,
    };
  };

  /**
   * PRIV-PAIR-01: a sending app connected with its number. This device reveals its own and computes the code from the
   * FIRST approver number it saw, pinned synchronously before the reveal is sent. A server that takes the reveal but
   * fails the answer must not get a second, different number accepted: it would know this device's number by then and
   * could grind that number until the code matches a code it controls on the approver. A retry after a failed reveal
   * re-sends the same reveal (the API accepts the same number again) and still uses the pinned number.
   */
  // tla: PairingV2/RPoll
  const revealFor = async (current: ActiveRequest, approverNonce: string): Promise<string | null> => {
    if (current.checkCode) return current.checkCode;
    current.approverNonce ??= approverNonce;
    const pinned = current.approverNonce;
    if (approverNonce !== pinned) {
      log("pairing approver number changed; ignored, the first one stays", { requestId: current.requestId });
    }
    try {
      await request(
        (client, signal) =>
          sdk.revealPairing({
            client,
            path: { requestId: current.requestId },
            body: { pollSecret: current.pollSecret, requesterNonce: current.requesterNonce },
            signal,
          }),
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
    } catch (err) {
      log("pairing reveal failed", { requestId: current.requestId, status: err instanceof PairingHttpError ? err.status : null });
      return null;
    }
    current.checkCode ??= pairingCheckCode({
      publicKey: current.publicKey,
      commitment: current.commitment,
      approverNonce: pinned,
      requesterNonce: current.requesterNonce,
    });
    log("pairing check code ready", { requestId: current.requestId });
    return current.checkCode;
  };

  // tla: PairingV2/RPoll
  // tla: PairingV2/RApproved
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

    if (res.status === "pending") {
      const checkCode = res.approverNonce ? await revealFor(current, res.approverNonce) : current.checkCode;
      if (mine !== generation) return { status: "expired" };
      return checkCode ? { status: "pending", checkCode } : { status: "pending" };
    }
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

  /** The user left the screen: the request goes at once, on the API too (PRIV-PAIR-03); a failure only logs. */
  const cancel = () => {
    const current = active;
    forget();
    if (!current || current.approved) return;
    void request(
      (client, signal) => sdk.cancelPairingRequest({ client, path: { requestId: current.requestId }, query: { pollSecret: current.pollSecret }, signal }),
      { timeoutMs: REQUEST_TIMEOUT_MS },
    ).catch((err: unknown) => log("pairing cancel failed", { requestId: current.requestId, status: err instanceof PairingHttpError ? err.status : null }));
  };

  return { start, poll, cancel, deliverLocalKey };
};
