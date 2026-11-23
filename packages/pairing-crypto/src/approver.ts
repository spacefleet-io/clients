/**
 * ACCT-PAIR-01 / ACCT-PAIR-02 / PRIV-KEY-05: the APPROVER side of pairing on a computer (Badger desktop, Parrot
 * desktop). The new-device side is `createPairingClientCore` (`./client`).
 *
 * The user types the short code another device shows (a TV, a phone, a browser, another computer). This resolves it
 * to the waiting request, and once the user has seen the device's name and type and typed the account password, seals
 * this computer's library key to the new device's public key and posts only the sealed blob with the password.
 * The API checks the password before approving; a wrong one leaves the request pending. The computer offers no
 * password check of its own to Electron, so the account password is the proof of ownership (ACCT-PAIR-02).
 *
 * PRIV-PAIR-01 (sf-pair-v2): between the lookup and the approval, `runPairingCheck` sends this app's random number,
 * reads the device's, checks it opens the device's commitment and returns the 6-digit check code both screens show.
 * The dialog asks "Does <device> show 123 456?" (skipped when the scanned QR link carried the matching fingerprint);
 * only after yes is the key sealed. A request without a commitment is refused (PRIV-PAIR-04), and a computer whose key
 * no longer opens the account's key probe sends nothing (PRIV-PAIR-02).
 *
 * Pure logic with injected side effects so the flow is unit-testable; the dialog is `PairDeviceDialog` in
 * `@space/desktop-shell/components`.
 */
import { DEFAULT_SPACE_APP_ID, normalizeSpaceAppId, type SpaceAppId } from "@space/shared/appScope";
import {
  PAIRING_V1_REQUESTS_ACCEPTED,
  commitmentOpens,
  fingerprintFromLink,
  fingerprintMatches,
  isPairingBlob32,
  newPairingNonce,
  pairingCheckCode,
} from "./checkCode";
import { sealLibraryKey, type SealedKey } from "./seal";
import { parsePairQrPayload } from "./shortCode";

export type PairingRequestInfo = {
  requestId: string;
  /** The app asking to sign in (ACCT-PAIR-05); a lookup without it (an older API) is Badger's. */
  app?: SpaceAppId;
  /** `key`: the device is already signed in to this account and asks only for the library key (its key screen); an
   * older API sends none, which is a sign-in. */
  purpose?: PairingPurpose;
  deviceType: string;
  deviceName: string;
  publicKey: string;
  /** PRIV-PAIR-01: 2 when the device committed to its key; an older API or app sends none (refused, PRIV-PAIR-04). */
  protocol?: 1 | 2;
  commitment?: string | null;
  expiresAt: string;
};

export type PairingPurpose = "sign_in" | "key";

/** What a window shows of a waiting request: no public key (Parrot keeps that in main, next to the library key).
 * `app` names the asking app: "<App> on <device> wants to sign in to your account" (ACCT-PAIR-05), or "… wants your
 * library key" when `purpose` is `key`. */
export type PairingRequestView = Pick<PairingRequestInfo, "requestId" | "deviceType" | "deviceName" | "expiresAt"> & {
  app: SpaceAppId;
  purpose: PairingPurpose;
  /** PRIV-PAIR-01: once `runPairingCheck` ran, the code the window asks the user to compare. */
  check?: PairingCheck;
};

/** A request as `lookupPairingRequest` hands it on: its asking app is always known. */
export type LookedUpPairingRequest = PairingRequestInfo & { app: SpaceAppId };

export const pairingRequestView = (request: PairingRequestInfo & { check?: PairingCheck }): PairingRequestView => ({
  requestId: request.requestId,
  app: normalizeSpaceAppId(request.app) ?? DEFAULT_SPACE_APP_ID,
  purpose: request.purpose === "key" ? "key" : "sign_in",
  deviceType: request.deviceType,
  deviceName: request.deviceName,
  expiresAt: request.expiresAt,
  ...(request.check ? { check: request.check } : {}),
});

/**
 * PRIV-PAIR-02, for `ApprovePairingDeps.keyOpensAccount`: true when the key opens the account's key probe, false when
 * it does not (the account has another key now), null without a verdict (the probe could not be read, or the account
 * has none yet).
 */
export const keyOpensProbe = async (
  libraryKey: string,
  readKeyProbe: () => Promise<string | null | undefined>,
  decryptProbe: (keyBase64: string, probe: string) => Promise<unknown>,
): Promise<boolean | null> => {
  let probe: string | null | undefined;
  try {
    probe = await readKeyProbe();
  } catch {
    return null;
  }
  if (!probe) return null;
  try {
    await decryptProbe(libraryKey, probe);
    return true;
  } catch {
    return false;
  }
};

/**
 * What proves the approver owns the account (ACCT-PAIR-02): the account password, or, for an account without one
 * (`user.hasPassword` false, ACCT-AUTH-04), a code: the authenticator's, or the emailed one. An empty `code` asks the API
 * for it, which emails it when the authenticator app is off (`code_required`).
 */
export type ApprovePairingProof = string | { code: string };

export type ApprovePairingDeps = {
  lookup: (token: string, code: string) => Promise<PairingRequestInfo>;
  /** `password` is undefined when `twoFactorCode` is sent instead (an account without a password). */
  approve: (
    token: string,
    requestId: string,
    sealedKey: SealedKey,
    password: string | undefined,
    twoFactorCode?: string,
  ) => Promise<{ ok: boolean; sessionId?: string }>;
  deny: (token: string, requestId: string) => Promise<{ ok: boolean }>;
  getLibraryKey: () => Promise<string | null>;
  /**
   * PRIV-PAIR-02: does this key open the account's current key probe? `false` (the account has another key now, e.g.
   * after a rotation elsewhere) stops the approval before anything is sent; `null` (no verdict: no connection, or an
   * account without a probe) lets it go on, as the receiving device checks the key again.
   */
  keyOpensAccount: (token: string, libraryKey: string) => Promise<boolean | null>;
  /** PRIV-PAIR-01: `POST /pairing/requests/{id}/connect`. */
  connect: (token: string, requestId: string, approverNonce: string) => Promise<unknown>;
  /** PRIV-PAIR-01: `GET /pairing/requests/{id}/reveal`, long-polled (`wait`) by the implementation. */
  readReveal: (token: string, requestId: string) => Promise<{ status: string; requesterNonce?: string }>;
  now: () => number;
  log?: (message: string, extra?: Record<string, unknown>) => void;
};

export type ApprovePairingErrorKind =
  | "invalid_code"
  | "not_found"
  | "expired"
  | "already_used"
  | "no_library_key"
  | "password_missing"
  | "wrong_password"
  /** An account without a password: the API wants its code (`method` says which; an email one was just sent). */
  | "code_required"
  /** An account without a password: the code was wrong. */
  | "wrong_code"
  | "rate_limited"
  | "signed_out"
  | "network"
  | "bad_request"
  /** PRIV-PAIR-04: the asking device runs a version from before the check; it must be updated. */
  | "update_required"
  /** PRIV-PAIR-02: this device's key no longer opens the account (another key since); it cannot send it. */
  | "stale_key"
  /** PRIV-PAIR-01: the device's revealed number does not open its commitment: someone in between, nothing sent. */
  | "check_failed"
  | "unknown";

export class ApprovePairingError extends Error {
  readonly kind: ApprovePairingErrorKind;
  /** `rate_limited`: the API's `retryAfterSeconds` when it said, so the dialog can say when to try again. */
  readonly retryAfterSeconds: number | null;
  /** `code_required` / `wrong_code`: which code the API asks, the authenticator's or the emailed one. */
  readonly method: "email" | "totp" | null;

  constructor(kind: ApprovePairingErrorKind, retryAfterSeconds: number | null = null, method: "email" | "totp" | null = null) {
    super(`pairing approval failed: ${kind}`);
    this.name = "ApprovePairingError";
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
    this.method = method;
  }
}

export const approvePairingErrorKind = (error: unknown): ApprovePairingErrorKind =>
  error instanceof ApprovePairingError ? error.kind : "unknown";

/**
 * An approver step as a plain value, so it crosses an Electron IPC boundary (an Error's class does not) and the
 * dialog shows the same words whether the step ran in the window (Badger) or in main (Parrot). `retryAfterSeconds`
 * rides along on a `rate_limited` failure when the API said it.
 */
export type ApprovePairingResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: ApprovePairingErrorKind; retryAfterSeconds?: number; method?: "email" | "totp" };

export const approvePairingResult = async <T>(run: () => Promise<T>): Promise<ApprovePairingResult<T>> => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const retryAfterSeconds = error instanceof ApprovePairingError ? error.retryAfterSeconds : null;
    const method = error instanceof ApprovePairingError ? error.method : null;
    return {
      ok: false,
      kind: approvePairingErrorKind(error),
      ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
      ...(method === null ? {} : { method }),
    };
  }
};

/** Status, error code, 429 wait and asked code kind of an ApiError-shaped value (`@space/shared/api`), read with runtime checks. */
const readApiError = (
  error: unknown,
): { status: number | null; code: string | null; retryAfterSeconds: number | null; method: "email" | "totp" | null } => {
  if (!error || typeof error !== "object") return { status: null, code: null, retryAfterSeconds: null, method: null };
  const status = "status" in error && typeof error.status === "number" ? error.status : null;
  let code: string | null = null;
  let retryAfterSeconds: number | null = null;
  let method: "email" | "totp" | null = null;
  if ("payload" in error && error.payload && typeof error.payload === "object") {
    const candidate = "error" in error.payload ? error.payload.error : null;
    if (typeof candidate === "string") code = candidate;
    const wait = "retryAfterSeconds" in error.payload ? error.payload.retryAfterSeconds : null;
    if (typeof wait === "number") retryAfterSeconds = wait;
    const asked = "method" in error.payload ? error.payload.method : null;
    if (asked === "email" || asked === "totp") method = asked;
  }
  return { status, code, retryAfterSeconds, method };
};

export const mapApiError = (error: unknown): ApprovePairingError => {
  if (error instanceof ApprovePairingError) return error;
  const { status, code, retryAfterSeconds, method } = readApiError(error);
  if (code === "pairing_not_found") return new ApprovePairingError("not_found");
  if (code === "pairing_check_unsupported") return new ApprovePairingError("update_required");
  if (code === "pairing_expired" || status === 410) return new ApprovePairingError("expired");
  if (code === "pairing_already_used" || status === 409) return new ApprovePairingError("already_used");
  if (code === "invalid_password") return new ApprovePairingError("wrong_password");
  if (code === "two_factor_required") return new ApprovePairingError("code_required", null, method ?? "email");
  if (code === "two_factor_invalid") return new ApprovePairingError("wrong_code", null, method ?? "email");
  if (status === 429) return new ApprovePairingError("rate_limited", retryAfterSeconds);
  if (status === 401) return new ApprovePairingError("signed_out");
  if (status === 404) return new ApprovePairingError("not_found");
  if (status === 400 || status === 422) return new ApprovePairingError("bad_request");
  if (status === null) return new ApprovePairingError("network");
  return new ApprovePairingError("unknown");
};

const isExpired = (request: PairingRequestInfo, now: number) => {
  const at = Date.parse(request.expiresAt);
  return Number.isFinite(at) && at <= now;
};

/**
 * Turns a typed code (any case, with or without the dash) or a pasted QR link into the waiting device's request.
 * A request without a commitment is refused (`update_required`, PRIV-PAIR-04) unless `acceptV1`: only the same-device
 * sign-in (ACCT-PAIR-07) passes it, since its sealed key goes back over the local channel and never reaches the server.
 */
// tla: PairingV2/ALookup
export const lookupPairingRequest = async (
  deps: Pick<ApprovePairingDeps, "lookup" | "now" | "log">,
  token: string,
  input: string,
  options: { acceptV1?: boolean } = {},
): Promise<LookedUpPairingRequest> => {
  const code = parsePairQrPayload(input);
  if (!code) throw new ApprovePairingError("invalid_code");
  let request: PairingRequestInfo;
  try {
    request = await deps.lookup(token, code);
  } catch (error) {
    const mapped = mapApiError(error);
    deps.log?.("pairing approve: lookup failed", { kind: mapped.kind, status: readApiError(error).status });
    throw mapped;
  }
  if (isExpired(request, deps.now())) throw new ApprovePairingError("expired");
  const app = normalizeSpaceAppId(request.app) ?? DEFAULT_SPACE_APP_ID;
  const v2 = isPairingBlob32(request.commitment);
  if (!v2 && !PAIRING_V1_REQUESTS_ACCEPTED && !options.acceptV1) {
    deps.log?.("pairing approve: request without the check refused", { app, deviceType: request.deviceType, protocol: request.protocol ?? null });
    throw new ApprovePairingError("update_required");
  }
  deps.log?.("pairing approve: lookup ok", { requestId: request.requestId, app, deviceType: request.deviceType, v2 });
  return { ...request, app };
};

/** PRIV-PAIR-01: the check code both screens show, and whether the scanned QR link already proved the device. */
export type PairingCheck = {
  /** Six digits, e.g. "067383"; show it with `formatCheckCode`. */
  code: string;
  /** The QR link the camera read carried this request's commitment fingerprint: no comparison needed. */
  confirmedByQr: boolean;
};

export type CheckedPairingRequest = LookedUpPairingRequest & { check: PairingCheck };

/** How often the reveal is read again when the API answers at once (no long poll). */
const REVEAL_RETRY_MS = 1_000;

const sleepMs = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * PRIV-PAIR-02 then PRIV-PAIR-01, after the user picked the request and before anything is sealed: refuses when this
 * device's key no longer opens the account, sends this app's random number, waits for the device's, checks it opens the
 * commitment and computes the check code. `scannedLink` is the QR link the camera read (null when typed): its
 * fingerprint, written by the device itself, makes the comparison unnecessary.
 */
// tla: PairingV2/AConnect
// tla: PairingV2/ARead
export const runPairingCheck = async (
  deps: ApprovePairingDeps,
  token: string,
  request: LookedUpPairingRequest,
  scannedLink: string | null = null,
  sleep: (ms: number) => Promise<void> = sleepMs,
): Promise<CheckedPairingRequest> => {
  const commitment = request.commitment;
  if (!isPairingBlob32(commitment)) throw new ApprovePairingError("update_required");
  if (isExpired(request, deps.now())) throw new ApprovePairingError("expired");

  const libraryKey = await deps.getLibraryKey();
  if (!libraryKey) throw new ApprovePairingError("no_library_key");
  const opens = await deps.keyOpensAccount(token, libraryKey.trim()).catch(() => null);
  if (opens === false) {
    deps.log?.("pairing approve: this device's key no longer opens the account", { requestId: request.requestId });
    throw new ApprovePairingError("stale_key");
  }

  const approverNonce = newPairingNonce();
  try {
    await deps.connect(token, request.requestId, approverNonce);
  } catch (error) {
    const mapped = mapApiError(error);
    deps.log?.("pairing approve: connect failed", { requestId: request.requestId, kind: mapped.kind });
    throw mapped;
  }

  let requesterNonce: string | null = null;
  while (requesterNonce === null) {
    if (isExpired(request, deps.now())) throw new ApprovePairingError("expired");
    let state: { status: string; requesterNonce?: string };
    try {
      state = await deps.readReveal(token, request.requestId);
    } catch (error) {
      throw mapApiError(error);
    }
    if (state.status === "denied" || state.status === "consumed" || state.status === "approved") throw new ApprovePairingError("already_used");
    if (state.status === "expired") throw new ApprovePairingError("expired");
    if (typeof state.requesterNonce === "string") requesterNonce = state.requesterNonce;
    else await sleep(REVEAL_RETRY_MS);
  }
  if (!commitmentOpens(commitment, request.publicKey, requesterNonce)) {
    deps.log?.("pairing approve: the device's number does not open its commitment", { requestId: request.requestId });
    throw new ApprovePairingError("check_failed");
  }
  const code = pairingCheckCode({ publicKey: request.publicKey, commitment, approverNonce, requesterNonce });
  const confirmedByQr = scannedLink !== null && fingerprintMatches(fingerprintFromLink(scannedLink), commitment);
  deps.log?.("pairing approve: check ready", { requestId: request.requestId, confirmedByQr });
  return { ...request, check: { code, confirmedByQr } };
};

/**
 * Approves a checked device (`runPairingCheck`, after the user confirmed the code) with the account password, or with a
 * code for an account without one. Nothing is read, sealed or sent without a password (a code proof may be empty: that
 * first call asks the API for the code); the key is sealed to this request only (the request id is bound into the box),
 * so the blob is useless elsewhere.
 */
// tla: PairingV2/ASeal
export const approvePairingRequest = async (
  deps: ApprovePairingDeps,
  token: string,
  request: CheckedPairingRequest,
  proof: ApprovePairingProof,
): Promise<{ sessionId: string | null }> => {
  const password = typeof proof === "string" ? proof : undefined;
  const twoFactorCode = typeof proof === "string" ? undefined : proof.code.trim();
  if (password !== undefined && !password) throw new ApprovePairingError("password_missing");
  if (!request.check && !PAIRING_V1_REQUESTS_ACCEPTED) throw new ApprovePairingError("update_required");
  if (isExpired(request, deps.now())) throw new ApprovePairingError("expired");

  const libraryKey = await deps.getLibraryKey();
  if (!libraryKey) {
    deps.log?.("pairing approve: no library key on this computer", { requestId: request.requestId });
    throw new ApprovePairingError("no_library_key");
  }

  let sealedKey: SealedKey;
  try {
    sealedKey = sealLibraryKey({ devicePublicKey: request.publicKey, requestId: request.requestId, libraryKey: libraryKey.trim() });
  } catch (error) {
    deps.log?.("pairing approve: seal failed", {
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ApprovePairingError("bad_request");
  }

  try {
    const result = await deps.approve(token, request.requestId, sealedKey, password, twoFactorCode);
    deps.log?.("pairing approve: approved", { requestId: request.requestId, sessionId: result.sessionId ?? null });
    return { sessionId: result.sessionId ?? null };
  } catch (error) {
    const mapped = mapApiError(error);
    deps.log?.("pairing approve: approve failed", { requestId: request.requestId, kind: mapped.kind });
    throw mapped;
  }
};

/** Refuses the request so the code stops working at once. A failure is reported; the code expires by itself anyway. */
export const denyPairingRequest = async (deps: ApprovePairingDeps, token: string, request: PairingRequestInfo): Promise<void> => {
  try {
    await deps.deny(token, request.requestId);
  } catch (error) {
    throw mapApiError(error);
  }
};
