/**
 * ACCT-PAIR-07 / PRIV-KEY-05: same-device sign-in, the APPROVING side. A signed-in Badger signs in Parrot freshly
 * installed on the same computer or phone (and the reverse) with no typed code and no password: the asking app opens an
 * ordinary pairing request (its own session and device entry, ACCT-PAIR-01) and hands its code over a local channel the
 * OS restricts to this user (a user-only socket or pipe on a computer, a caller-checked intent or URL on a phone).
 *
 * Before anything is approved, the request must be the sister app's own sign-in, on this kind of device and, on a
 * computer, this very computer. The library key is sealed here to the request's key with its id bound in and returned
 * to the caller, which passes it back over the same local channel: the API is told only to approve (`localKey`), so
 * the server never sees the key, not even sealed.
 *
 * Pure logic with injected side effects, like `./approver`.
 */
import { normalizeSpaceAppId, siblingAppOf, type SpaceAppId } from "@space/shared/appScope";
import { base64ToBytes } from "./base64";
import {
  ApprovePairingError,
  lookupPairingRequest,
  mapApiError,
  type ApprovePairingDeps,
  type PairingRequestInfo,
} from "./approver";
import { sealLibraryKey, type SealedKey } from "./seal";

export { siblingAppOf };

/** What the sister app said it is signed in to (its status file, provider row or shared keychain item). */
export type SiblingAccount = { userId?: string; email?: string };

/**
 * The asking side's last check: the account the API signed this app in to is the one the sister app showed. A code
 * that reached anyone else (a squatted pipe, an app claiming the sister's URL scheme) could be approved with another
 * account; that sign-in is refused. Every given field must match; nothing given is a refusal.
 */
export const checkSiblingAccount = (user: { id: string; email: string }, expected: SiblingAccount): boolean => {
  const userId = expected.userId?.trim();
  const email = expected.email?.trim().toLowerCase();
  if (!userId && !email) return false;
  if (userId && user.id !== userId) return false;
  if (email && user.email.trim().toLowerCase() !== email) return false;
  return true;
};

export type SiblingApproveDeps = Pick<ApprovePairingDeps, "lookup" | "deny" | "getLibraryKey" | "now" | "log"> & {
  /** `POST /pairing/requests/{id}/approve` with `{ localKey: true }`: no key in the body. */
  approveLocal: (token: string, requestId: string) => Promise<{ ok: boolean; sessionId?: string }>;
};

/** What the approving app expects of the request it was handed. */
export type SiblingExpectation = {
  /** The sister app that asks (the approver's `siblingAppOf`). */
  asker: SpaceAppId;
  /** This device's type: a Parrot phone is never signed in by a Badger computer. */
  deviceType: string;
  /** This computer's name as the asking app announces it (`resolveDeviceName`). Omitted on phones, where the OS has
   * already named the calling app. */
  deviceName?: string;
};

export type SiblingRefusal = "wrong_app" | "wrong_device_type" | "wrong_device" | "key_request";

export const checkSiblingRequest = (request: PairingRequestInfo, expect: SiblingExpectation): SiblingRefusal | null => {
  if (normalizeSpaceAppId(request.app) !== expect.asker) return "wrong_app";
  if (request.purpose === "key") return "key_request";
  if (request.deviceType !== expect.deviceType) return "wrong_device_type";
  if (expect.deviceName !== undefined && request.deviceName !== expect.deviceName) return "wrong_device";
  return null;
};

const lookupChecked = async (deps: SiblingApproveDeps, token: string, code: string, expect: SiblingExpectation) => {
  const request = await lookupPairingRequest(deps, token, code);
  const refusal = checkSiblingRequest(request, expect);
  if (refusal) {
    deps.log?.("sibling sign-in: request refused", { requestId: request.requestId, refusal, app: request.app, deviceType: request.deviceType });
    throw new ApprovePairingError("bad_request");
  }
  return request;
};

export type SiblingApproved = { sessionId: string; sealedKey: SealedKey };

/** Approves the sister app's request and returns the key sealed for it, to pass back over the local channel. */
export const approveSiblingRequest = async (
  deps: SiblingApproveDeps,
  token: string,
  code: string,
  expect: SiblingExpectation,
): Promise<SiblingApproved> => {
  const request = await lookupChecked(deps, token, code, expect);
  const libraryKey = await deps.getLibraryKey();
  if (!libraryKey) throw new ApprovePairingError("no_library_key");
  const sealedKey = sealLibraryKey({
    devicePublicKey: request.publicKey,
    requestId: request.requestId,
    libraryKey: base64ToBytes(libraryKey),
  });
  let result: { ok: boolean; sessionId?: string };
  try {
    result = await deps.approveLocal(token, request.requestId);
  } catch (error) {
    const mapped = mapApiError(error);
    deps.log?.("sibling sign-in: approve failed", { requestId: request.requestId, kind: mapped.kind });
    throw mapped;
  }
  if (!result.ok || !result.sessionId) throw new ApprovePairingError("unknown");
  deps.log?.("sibling sign-in: approved", { requestId: request.requestId, app: request.app, sessionId: result.sessionId });
  return { sessionId: result.sessionId, sealedKey };
};

/** Cancel in the approving app: denies the sister app's request so it stops waiting at once. */
export const refuseSiblingRequest = async (
  deps: SiblingApproveDeps,
  token: string,
  code: string,
  expect: SiblingExpectation,
): Promise<void> => {
  const request = await lookupChecked(deps, token, code, expect);
  await deps.deny(token, request.requestId);
  deps.log?.("sibling sign-in: refused by the user", { requestId: request.requestId });
};
