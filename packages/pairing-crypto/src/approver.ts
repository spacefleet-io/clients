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
 * Pure logic with injected side effects so the flow is unit-testable; the dialog is `PairDeviceDialog` in
 * `@space/desktop-shell/components`.
 */
import { DEFAULT_SPACE_APP_ID, normalizeSpaceAppId, type SpaceAppId } from "@space/shared/appScope";
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
  expiresAt: string;
};

export type PairingPurpose = "sign_in" | "key";

/** What a window shows of a waiting request: no public key (Parrot keeps that in main, next to the library key).
 * `app` names the asking app: "<App> on <device> wants to sign in to your account" (ACCT-PAIR-05), or "… wants your
 * library key" when `purpose` is `key`. */
export type PairingRequestView = Pick<PairingRequestInfo, "requestId" | "deviceType" | "deviceName" | "expiresAt"> & {
  app: SpaceAppId;
  purpose: PairingPurpose;
};

/** A request as `lookupPairingRequest` hands it on: its asking app is always known. */
export type LookedUpPairingRequest = PairingRequestInfo & { app: SpaceAppId };

export const pairingRequestView = (request: PairingRequestInfo): PairingRequestView => ({
  requestId: request.requestId,
  app: normalizeSpaceAppId(request.app) ?? DEFAULT_SPACE_APP_ID,
  purpose: request.purpose === "key" ? "key" : "sign_in",
  deviceType: request.deviceType,
  deviceName: request.deviceName,
  expiresAt: request.expiresAt,
});

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

/** Turns a typed code (any case, with or without the dash) or a pasted QR link into the waiting device's request. */
export const lookupPairingRequest = async (
  deps: Pick<ApprovePairingDeps, "lookup" | "now" | "log">,
  token: string,
  input: string,
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
  deps.log?.("pairing approve: lookup ok", { requestId: request.requestId, app, deviceType: request.deviceType });
  return { ...request, app };
};

/**
 * Approves a looked-up device with the account password, or with a code for an account without one. Nothing is read,
 * sealed or sent without a password (a code proof may be empty: that first call asks the API for the code); the key is
 * sealed to this request only (the request id is bound into the box), so the blob is useless elsewhere.
 */
export const approvePairingRequest = async (
  deps: ApprovePairingDeps,
  token: string,
  request: PairingRequestInfo,
  proof: ApprovePairingProof,
): Promise<{ sessionId: string | null }> => {
  const password = typeof proof === "string" ? proof : undefined;
  const twoFactorCode = typeof proof === "string" ? undefined : proof.code.trim();
  if (password !== undefined && !password) throw new ApprovePairingError("password_missing");
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
