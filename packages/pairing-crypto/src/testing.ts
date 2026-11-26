/**
 * Test-only (`@space/pairing-crypto/testing`): both ends of sf-pair-v2 (PRIV-PAIR-01) for tests that stand in for a
 * real app against a running API: the signed-in app approving a code, and a new device asking for one. The apps run
 * the same steps through this package's approver and client; these speak HTTP directly so any e2e harness can use them.
 *
 * Approver: lookup -> connect with its number -> wait for the device's number -> check code -> seal -> approve.
 * Device: create with a commitment -> reveal its number once an app connected -> poll for the sealed key.
 */
import { base64ToBytes } from "./base64";
import { commitmentOpens, newPairingNonce, pairingCheckCode, pairingCommitment } from "./checkCode";
import { generateDeviceKeyPair, sealLibraryKey } from "./seal";
import { normalizeShortCode } from "./index";

export type PairingHttpAnswer = { status: number; body: Record<string, unknown> };

type Http = {
  apiBaseUrl: string;
  /** `x-space-app` of the calls (the app the approver or device belongs to). */
  app: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
};

const call = async (http: Http, path: string, init: RequestInit = {}): Promise<PairingHttpAnswer> => {
  const res = await (http.fetchImpl ?? fetch)(http.apiBaseUrl.replace(/\/$/, "") + path, {
    ...init,
    headers: { "content-type": "application/json", "x-space-app": http.app, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  // Path only: codes, numbers and keys never reach a test log (PRIV-PAIR-03).
  http.log?.(`pairing ${init.method ?? "GET"} ${path.split("?")[0]} -> ${res.status}`);
  return { status: res.status, body };
};

export type ApproveAsAccountResult = {
  /** The lookup, connect, reveal or approve answer that ended the run (the approve one when it got that far). */
  answer: PairingHttpAnswer;
  requestId: string | null;
  /** The six digits the device must show; null when the run stopped before the check. */
  checkCode: string | null;
};

/**
 * Approves `shortCode` as a signed-in app of the account would. `password` / `twoFactorCode` go with the approve
 * call when given (TV-class approvers, ACCT-PAIR-02). A request without a commitment is refused like the apps
 * refuse it (PRIV-PAIR-04): `answer.status` 426.
 */
export const approveAsAccount = async (
  input: Http & {
    token: string;
    shortCode: string;
    /** The account's library key, base64. */
    libraryKey: string;
    password?: string;
    twoFactorCode?: string;
    /** How many 20 s reads of the device's number to wait through (default 6: two minutes). */
    revealReads?: number;
  },
): Promise<ApproveAsAccountResult> => {
  const auth = { authorization: `Bearer ${input.token}` };
  const code = normalizeShortCode(input.shortCode);
  if (!code) throw new Error(`not a pairing code: "${input.shortCode}"`);
  const look = await call(input, `/pairing/lookup?code=${code}`, { headers: auth });
  if (look.status !== 200) return { answer: look, requestId: null, checkCode: null };
  const { requestId, publicKey, commitment } = look.body as { requestId: string; publicKey: string; commitment?: string | null };
  if (!commitment) return { answer: { status: 426, body: { error: "pairing_update_required" } }, requestId, checkCode: null };

  const approverNonce = newPairingNonce();
  const connected = await call(input, `/pairing/requests/${requestId}/connect`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ approverNonce }),
  });
  if (connected.status !== 200) return { answer: connected, requestId, checkCode: null };

  let requesterNonce: string | null = null;
  for (let read = 0; read < (input.revealReads ?? 6) && !requesterNonce; read += 1) {
    const reveal = await call(input, `/pairing/requests/${requestId}/reveal?wait=20`, { headers: auth });
    if (reveal.status !== 200) return { answer: reveal, requestId, checkCode: null };
    if (reveal.body.status !== "pending") return { answer: reveal, requestId, checkCode: null };
    requesterNonce = typeof reveal.body.requesterNonce === "string" ? reveal.body.requesterNonce : null;
  }
  if (!requesterNonce) return { answer: { status: 408, body: { error: "pairing_reveal_timeout" } }, requestId, checkCode: null };
  if (!commitmentOpens(commitment, publicKey, requesterNonce))
    return { answer: { status: 400, body: { error: "pairing_commitment_mismatch" } }, requestId, checkCode: null };
  const checkCode = pairingCheckCode({ publicKey, commitment, approverNonce, requesterNonce });

  const sealedKey = sealLibraryKey({ devicePublicKey: publicKey, requestId, libraryKey: base64ToBytes(input.libraryKey) });
  const approved = await call(input, `/pairing/requests/${requestId}/approve`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      sealedKey,
      ...(input.password === undefined ? {} : { password: input.password }),
      ...(input.twoFactorCode === undefined ? {} : { twoFactorCode: input.twoFactorCode }),
    }),
  });
  return { answer: approved, requestId, checkCode };
};

export type DeviceRequest = {
  shortCode: string;
  requestId: string;
  pollSecret: string;
  /** The device's X25519 keys (the private one opens the sealed key). */
  keys: { publicKey: string; privateKey: string };
  requesterNonce: string;
  commitment: string;
};

/** A brand-new device asking for a code (deviceType `desktop` unless given), with its commitment. */
export const requestAsDevice = async (input: Http & { deviceName: string; deviceType?: string }): Promise<DeviceRequest> => {
  const keys = generateDeviceKeyPair();
  const requesterNonce = newPairingNonce();
  const commitment = pairingCommitment(keys.publicKey, requesterNonce);
  const created = await call(input, "/pairing/requests", {
    method: "POST",
    body: JSON.stringify({ deviceType: input.deviceType ?? "desktop", deviceName: input.deviceName, publicKey: keys.publicKey, commitment }),
  });
  if (created.status !== 200 && created.status !== 201) throw new Error(`pairing request refused (${created.status})`);
  return {
    shortCode: String(created.body.shortCode),
    requestId: String(created.body.requestId),
    pollSecret: String(created.body.pollSecret),
    keys,
    requesterNonce,
    commitment,
  };
};

/**
 * One poll as the device. Once an app connected (`approverNonce` in the answer) it reveals its number and adds the
 * check code it would show, so a test can compare it with the approver's screen.
 */
export const pollAsDevice = async (
  input: Http & { device: DeviceRequest; waitSeconds?: number },
): Promise<PairingHttpAnswer & { checkCode?: string }> => {
  const { device } = input;
  const wait = input.waitSeconds ? `&wait=${input.waitSeconds}` : "";
  const polled = await call(input, `/pairing/requests/${device.requestId}?pollSecret=${encodeURIComponent(device.pollSecret)}${wait}`);
  const approverNonce = polled.body.approverNonce;
  if (polled.status !== 200 || typeof approverNonce !== "string") return polled;
  const revealed = await call(input, `/pairing/requests/${device.requestId}/reveal`, {
    method: "POST",
    body: JSON.stringify({ pollSecret: device.pollSecret, requesterNonce: device.requesterNonce }),
  });
  if (revealed.status !== 200) return revealed;
  const checkCode = pairingCheckCode({
    publicKey: device.keys.publicKey,
    commitment: device.commitment,
    approverNonce,
    requesterNonce: device.requesterNonce,
  });
  return { ...polled, checkCode };
};
