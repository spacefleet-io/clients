/**
 * Phone side of device pairing (ACCT-PAIR-01, ACCT-PAIR-02; contract sf-pair-v2, PRIV-KEY-05, PRIV-PAIR-01..04).
 *
 * The phone is the approver: it resolves a short code to a waiting device, checks with it that no one sits in between
 * (the six-digit check code both screens show, PRIV-PAIR-01), shows who is asking, asks for the phone's own unlock,
 * seals the library key to the new device's public key and posts only the sealed blob. The API never sees the key in
 * clear, and cannot swap in its own public key without the codes differing.
 *
 * Pure logic with injected side effects so the whole flow is unit-testable without native modules.
 */

import {
  ApprovePairingError,
  isPairingBlob32,
  PAIRING_V1_REQUESTS_ACCEPTED,
  parsePairQrPayload,
  runPairingCheck,
  sealLibraryKey,
  type ApprovePairingErrorKind,
  type PairingCheck,
  type SealedKey,
} from "@space/pairing-crypto";
import { DEFAULT_SPACE_APP_ID, normalizeSpaceAppId, SPACE_APP_NAMES } from "@space/shared/appScope";
import { RATE_LIMIT_DEFAULT_MINUTES, retryAfterSecondsToMinutes, TOO_MANY_ATTEMPTS_KEY } from "@space/shared/signInError";
import { translate } from "../i18n";
import { scopeLogger } from "../logger";

const log = scopeLogger("pairing");

export type PairingRequestInfo = {
  requestId: string;
  /** The app asking to sign in (ACCT-PAIR-05): any Badger or Parrot app; a lookup without it (an older API) is Badger's. */
  app?: string;
  /** `key`: the device is already signed in to this account and asks only for the library key; none is a sign-in. */
  purpose?: string;
  deviceType: string;
  deviceName: string;
  publicKey: string;
  expiresAt: string;
  /** PRIV-PAIR-01: 2 once the device sends a commitment; none from a device built before the check. */
  protocol?: 1 | 2;
  /** SHA-256 commitment to the device's public key and its random number (base64), sf-pair-v2. */
  commitment?: string | null;
  /** Set by `checkDevice`: the code to compare, and whether the scanned QR already proved the device. */
  check?: PairingCheck;
};

export type PairingDeps = {
  lookup: (token: string, code: string) => Promise<PairingRequestInfo>;
  /**
   * `password` is the account password a TV sends with the approval; the API checks it before approving. An account
   * without a password sends `twoFactorCode` instead (ACCT-AUTH-04): undefined on the first try, which makes the API
   * email one (or ask the authenticator's) and answer `two_factor_required`.
   */
  approve: (
    token: string,
    requestId: string,
    sealedKey: SealedKey,
    password?: string,
    twoFactorCode?: string,
  ) => Promise<{ ok: boolean; sessionId?: string }>;
  deny: (token: string, requestId: string) => Promise<{ ok: boolean }>;
  getLibraryKey: () => Promise<string | null>;
  /**
   * Biometric / PIN prompt. Throws PairingFlowError("no_device_lock" | "unlock_cancelled" | "unlock_failed").
   * `null` on a TV, which has no lock of its own: the approver then proves ownership with the account password
   * (ACCT-PAIR-02), which `approveDevice` takes from the caller and the API checks.
   */
  requireUnlock: (() => Promise<void>) | null;
  now: () => number;
  /**
   * PRIV-PAIR-02: does this key open the account's current key probe? `false` stops before anything is sent;
   * `null` (no verdict) goes on, as the receiving device checks the key again.
   */
  keyOpensAccount: (token: string, libraryKey: string) => Promise<boolean | null>;
  /** PRIV-PAIR-01: `POST /pairing/requests/{id}/connect`. */
  connect: (token: string, requestId: string, approverNonce: string) => Promise<unknown>;
  /** PRIV-PAIR-01: `GET /pairing/requests/{id}/reveal`, long-polled. */
  readReveal: (token: string, requestId: string) => Promise<{ status: string; requesterNonce?: string }>;
};

export type PairingErrorKind =
  | "invalid_code"
  | "not_found"
  | "expired"
  | "already_used"
  | "no_library_key"
  | "no_device_lock"
  | "unlock_cancelled"
  | "unlock_failed"
  | "wrong_password"
  /** An account without a password: the API wants a code (emailed, or the authenticator's; `codeMethod`). */
  | "code_required"
  /** That code was wrong or expired; the request stays pending. */
  | "code_invalid"
  | "rate_limited"
  | "signed_out"
  | "network"
  | "bad_request"
  /** PRIV-PAIR-04: the asking device runs a version from before the check; it must be updated. */
  | "update_required"
  /** PRIV-PAIR-02: this device's key no longer opens the account (another key since a rotation). */
  | "stale_key"
  /** PRIV-PAIR-01: the device's number does not open its commitment; nothing sent. */
  | "check_failed"
  | "unknown";

/** How a TV approver proves it is the account owner (ACCT-PAIR-02): the password, or a code when the account has none. */
export type ApprovalProof = { password: string } | { code: string | null };

export class PairingFlowError extends Error {
  readonly kind: PairingErrorKind;
  /** `rate_limited`: whole minutes until the API takes the step again (its `retryAfterSeconds`, ACCT-AUTH-11). */
  readonly retryAfterMinutes: number;
  /** `code_required`: where the code comes from, as the API said (`email` when it does not say). */
  readonly codeMethod: "email" | "totp";

  constructor(kind: PairingErrorKind, retryAfterMinutes: number = RATE_LIMIT_DEFAULT_MINUTES, codeMethod: "email" | "totp" = "email") {
    super(pairingErrorMessage(kind, retryAfterMinutes));
    this.name = "PairingFlowError";
    this.kind = kind;
    this.retryAfterMinutes = retryAfterMinutes;
    this.codeMethod = codeMethod;
  }
}

/** The sentence for a failed step; `rate_limited` is the shared "Too many attempts. Try again in N minutes." (ACCT-AUTH-11). */
export const pairingErrorMessage = (kind: PairingErrorKind, retryAfterMinutes: number = RATE_LIMIT_DEFAULT_MINUTES): string =>
  kind === "rate_limited"
    ? translate(TOO_MANY_ATTEMPTS_KEY, { count: retryAfterMinutes, minutes: retryAfterMinutes })
    : translate(`pairing.errors.${kind}`);

const KNOWN_DEVICE_TYPES: Record<string, true> = { mobile: true, desktop: true, tv: true, kodi: true, jellyfin: true, web: true };

/** "Phone" / "Computer" / "TV" / "Kodi" / "Jellyfin server" / "Web browser" in the UI language; unknown types are shown as sent. */
export const deviceTypeLabel = (deviceType: string | null | undefined): string => {
  if (!deviceType) return translate("pairing.deviceType.unknown");
  return Object.hasOwn(KNOWN_DEVICE_TYPES, deviceType) ? translate(`pairing.deviceType.${deviceType}`) : deviceType;
};

/**
 * Device type of a signed-in session. Paired devices carry `deviceType`; older sessions only carry
 * the client type the app announced when it signed in.
 */
export const sessionDeviceType = (session: { deviceType?: string | null; clientType?: string | null }): string | null => {
  if (session.deviceType) return session.deviceType;
  const client = session.clientType ?? "";
  // `<app>-<deviceType>`: a password sign-in (`badger-tv`) or a pairing of any app (`parrot-desktop`, ACCT-PAIR-05).
  const appSession = /^(?:badger|parrot)-(.+)$/u.exec(client);
  if (appSession) return appSession[1];
  if (client === "client-mobile") return "mobile";
  if (client === "client-desktop") return "desktop";
  return null;
};

/** "Parrot on Studio laptop (Computer) wants to sign in to your account." (ACCT-PAIR-05), or "… wants your media library key."
 * when the device is already signed in and asks only for the key (ACCT-PAIR-01, key screen). */
export const approvalQuestion = (request: Pick<PairingRequestInfo, "app" | "purpose" | "deviceName" | "deviceType">): string =>
  translate(request.purpose === "key" ? "pairing.approvalKeyQuestion" : "pairing.approvalQuestion", {
    app: SPACE_APP_NAMES[normalizeSpaceAppId(request.app) ?? DEFAULT_SPACE_APP_ID],
    name: request.deviceName,
    type: deviceTypeLabel(request.deviceType),
  });

/** Status, error code and 429 wait of an ApiError-shaped value, read with runtime checks. */
export const readApiError = (error: unknown): { status: number | null; code: string | null; retryAfterSeconds: number | null } => {
  if (!error || typeof error !== "object") return { status: null, code: null, retryAfterSeconds: null };
  const status = "status" in error && typeof error.status === "number" ? error.status : null;
  let code: string | null = null;
  let retryAfterSeconds: number | null = null;
  if ("payload" in error && error.payload && typeof error.payload === "object") {
    const candidate = "error" in error.payload ? error.payload.error : null;
    if (typeof candidate === "string") code = candidate;
    const wait = "retryAfterSeconds" in error.payload ? error.payload.retryAfterSeconds : null;
    if (typeof wait === "number") retryAfterSeconds = wait;
  }
  return { status, code, retryAfterSeconds };
};

const mapApiError = (error: unknown): PairingFlowError => {
  if (error instanceof PairingFlowError) return error;
  const { status, code, retryAfterSeconds } = readApiError(error);
  if (code === "pairing_not_found") return new PairingFlowError("not_found");
  if (code === "pairing_expired" || status === 410) return new PairingFlowError("expired");
  if (code === "pairing_already_used" || status === 409) return new PairingFlowError("already_used");
  if (code === "invalid_password") return new PairingFlowError("wrong_password");
  if (code === "two_factor_required") {
    const payload = error && typeof error === "object" && "payload" in error ? error.payload : null;
    const method = payload && typeof payload === "object" && "method" in payload && payload.method === "totp" ? "totp" : "email";
    return new PairingFlowError("code_required", RATE_LIMIT_DEFAULT_MINUTES, method);
  }
  if (code === "two_factor_invalid") return new PairingFlowError("code_invalid");
  if (status === 429) return new PairingFlowError("rate_limited", retryAfterSecondsToMinutes(retryAfterSeconds));
  if (status === 401) return new PairingFlowError("signed_out");
  if (status === 404) return new PairingFlowError("not_found");
  if (status === 400 || status === 422) return new PairingFlowError("bad_request");
  if (status === null) return new PairingFlowError("network");
  return new PairingFlowError("unknown");
};

const isExpired = (request: PairingRequestInfo, now: number) => {
  const at = Date.parse(request.expiresAt);
  return Number.isFinite(at) && at <= now;
};

/**
 * Turns a typed or scanned code into the waiting device's request. A request without a commitment (a device built
 * before the check) is refused with `update_required` (PRIV-PAIR-04): its public key could be the server's own.
 */
export const lookupDevice = async (
  deps: PairingDeps,
  token: string,
  input: string,
): Promise<PairingRequestInfo> => {
  const code = parsePairQrPayload(input);
  if (!code) {
    log.warn("lookup.invalid_input", { length: input.length });
    throw new PairingFlowError("invalid_code");
  }
  let request: PairingRequestInfo;
  try {
    request = await deps.lookup(token, code);
  } catch (error) {
    const mapped = mapApiError(error);
    log.warn("lookup.failed", { kind: mapped.kind, status: readApiError(error).status });
    throw mapped;
  }
  if (isExpired(request, deps.now())) {
    log.warn("lookup.expired_client_side", { requestId: request.requestId });
    throw new PairingFlowError("expired");
  }
  if (!isPairingBlob32(request.commitment) && !PAIRING_V1_REQUESTS_ACCEPTED) {
    log.warn("lookup.update_required", { app: request.app, deviceType: request.deviceType, protocol: request.protocol ?? null });
    throw new PairingFlowError("update_required");
  }
  log.warn("lookup.ok", {
    requestId: request.requestId,
    app: request.app,
    deviceType: request.deviceType,
    deviceName: request.deviceName,
  });
  return request;
};

const FLOW_KIND_OF: Partial<Record<ApprovePairingErrorKind, PairingErrorKind>> = {
  wrong_code: "code_invalid",
  password_missing: "unlock_cancelled",
};

/** An error of the shared check as this flow's, keeping a 429's wait. */
const toFlowError = (error: unknown): PairingFlowError => {
  if (error instanceof PairingFlowError) return error;
  if (!(error instanceof ApprovePairingError)) return mapApiError(error);
  const kind = FLOW_KIND_OF[error.kind] ?? (error.kind as PairingErrorKind);
  return new PairingFlowError(kind, retryAfterSecondsToMinutes(error.retryAfterSeconds));
};

/**
 * PRIV-PAIR-02 then PRIV-PAIR-01, right after the lookup and before the question is asked: refuses when this device's
 * key no longer opens the account, exchanges the random numbers with the waiting device and works out the six-digit
 * code both screens then show. `scannedLink` is what the camera read (null when typed): its fingerprint, written by the
 * device itself, makes the comparison unnecessary.
 */
export const checkDevice = async (
  deps: PairingDeps,
  token: string,
  request: PairingRequestInfo,
  scannedLink: string | null = null,
): Promise<PairingRequestInfo & { check: PairingCheck }> => {
  const app = normalizeSpaceAppId(request.app) ?? DEFAULT_SPACE_APP_ID;
  try {
    const checked = await runPairingCheck(
      { ...deps, log: (message, extra) => log.warn(message, extra) },
      token,
      { ...request, app, purpose: request.purpose === "key" ? "key" : undefined },
      scannedLink,
    );
    return { ...request, check: checked.check };
  } catch (error) {
    const mapped = toFlowError(error);
    log.warn("check.failed", { kind: mapped.kind });
    throw mapped;
  }
};

/**
 * Approves a checked device (`checkDevice`, after the user confirmed the code). Order matters (ACCT-PAIR-02): the key is only read and sealed after
 * the phone has been unlocked, and nothing is sent when unlock is refused or cancelled. A TV has no unlock:
 * it must pass a `proof`, the account password, which travels with the approval and is checked by the API before
 * the request is approved (a wrong one leaves the request pending, so the caller may ask again). An account without
 * a password proves itself with a code instead (ACCT-AUTH-04): `{ code: null }` first, which the API answers with
 * `code_required` after emailing one (or asking the authenticator's), then `{ code }`.
 */
export const approveDevice = async (
  deps: PairingDeps,
  token: string,
  request: PairingRequestInfo,
  proof?: ApprovalProof,
): Promise<{ sessionId: string | null }> => {
  if (!request.check && !PAIRING_V1_REQUESTS_ACCEPTED) throw new PairingFlowError("update_required");
  if (isExpired(request, deps.now())) throw new PairingFlowError("expired");

  const libraryKey = await deps.getLibraryKey();
  if (!libraryKey) {
    log.warn("approve.no_library_key", { requestId: request.requestId });
    throw new PairingFlowError("no_library_key");
  }

  const requireUnlock = deps.requireUnlock;
  if (requireUnlock) {
    try {
      await requireUnlock();
    } catch (error) {
      const mapped = error instanceof PairingFlowError ? error : new PairingFlowError("unlock_failed");
      log.warn("approve.unlock_refused", { requestId: request.requestId, kind: mapped.kind });
      throw mapped;
    }
  } else if (!proof || ("password" in proof && !proof.password)) {
    log.warn("approve.password_missing", { requestId: request.requestId });
    throw new PairingFlowError("unlock_cancelled");
  }
  const password = !requireUnlock && proof && "password" in proof ? proof.password : undefined;
  const twoFactorCode = !requireUnlock && proof && "code" in proof ? proof.code ?? undefined : undefined;

  let sealedKey: SealedKey;
  try {
    sealedKey = sealLibraryKey({
      devicePublicKey: request.publicKey,
      requestId: request.requestId,
      libraryKey: libraryKey.trim(),
    });
  } catch (error) {
    log.warn("approve.seal_failed", {
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new PairingFlowError("bad_request");
  }

  try {
    const result = await deps.approve(token, request.requestId, sealedKey, password, twoFactorCode);
    log.warn("approve.ok", { requestId: request.requestId, sessionId: result.sessionId ?? null });
    return { sessionId: result.sessionId ?? null };
  } catch (error) {
    const mapped = mapApiError(error);
    log.warn("approve.failed", { requestId: request.requestId, kind: mapped.kind, status: readApiError(error).status });
    throw mapped;
  }
};

export const denyDevice = async (deps: PairingDeps, token: string, request: PairingRequestInfo): Promise<void> => {
  try {
    await deps.deny(token, request.requestId);
    log.warn("deny.ok", { requestId: request.requestId });
  } catch (error) {
    // The code expires by itself in minutes, so a failed deny is reported but never blocks leaving.
    const mapped = mapApiError(error);
    log.warn("deny.failed", { requestId: request.requestId, kind: mapped.kind });
    throw mapped;
  }
};
