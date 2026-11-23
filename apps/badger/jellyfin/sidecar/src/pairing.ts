import {
  bytesToBase64,
  generateDeviceKeyPair,
  isPairingBlob32,
  isSealedKey,
  newPairingNonce,
  normalizeShortCode,
  openSealedKey,
  pairingCheckCode,
  pairingCommitment,
  withCommitmentFingerprint,
  type SealedKey,
} from "@space/pairing-crypto";
import { clientIdentityHeaders } from "@space/shared/appVersion";
import { errorMessage } from "./errors";

/**
 * New-device side of the pairing contract (ACCT-PAIR-01, PRIV-KEY-05): the Jellyfin server asks for a code, the
 * user approves it with the phone app, and this service receives a session token plus the library key sealed
 * to a keypair that never leaves this process. The Jellyfin plugin only renders what `snapshot()` returns.
 *
 * PRIV-PAIR-01 (sf-pair-v2): the request carries a commitment to the public key and a secret number; once the
 * approving app connected (the poll carries its number), this service reveals its own and the page shows six digits
 * the approving app shows too, so a server swapping keys is caught.
 */
/** `needs_profile`: approved, but the account has several profiles and nothing is stored until the owner picks one (INTG-PROF-01). */
export type PairingState = "pending" | "approved" | "needs_profile" | "expired" | "denied" | "failed";

export type PairingSnapshot = {
  state: PairingState;
  requestId: string;
  /** The plain 8 characters, "ABCDEFGH" (ACCT-PAIR-01: shown as 4 + 4 with a gap, never a dash). */
  shortCode: string;
  /** What the phone's QR scanner reads, with `#c=<commitment fingerprint>` added here (PRIV-PAIR-01). */
  qrPayload: string;
  /** PRIV-PAIR-01: the six digits to compare with the approving app, once it connected; null before. */
  checkCode: string | null;
  expiresAt: string;
  deviceName: string;
  error: string | null;
};

export type PairingResult = {
  token: string;
  userId: string | null;
  email: string | null;
  apiUrl: string;
  /** The 32-byte library key, base64. Already opened with the sealed envelope; the caller must verify it. */
  libraryKeyBase64: string;
};

type CreateResponse = { requestId: string; pollSecret: string; shortCode: string; qrPayload: string; expiresAt: string };
type PollResponse =
  | { status: "pending"; approverNonce?: string }
  | { status: "expired" | "denied" | "consumed" }
  | { status: "approved"; token: string; user?: { id?: string; email?: string }; sealedKey: unknown; clientType?: string };

type LogFn = (message: string, meta?: Record<string, unknown>) => void;

export type PairingOptions = {
  log: LogFn;
  deviceType: string;
  /**
   * Called once with the approved result; throwing marks the pairing "failed" and the code is gone. Resolving
   * "needs_profile" leaves it waiting until the caller settles it with `settleProfilePick`.
   */
  onApproved: (result: PairingResult) => Promise<"approved" | "needs_profile">;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  now?: () => number;
};

const asObject = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : null);

/** The API holds a poll open up to 25 s (`?wait=`): one poll every ~27 s stays far under its 20-per-minute limit per address (OPS-LIMIT-02). */
const POLL_WAIT_SECONDS = 25;
/** A poll that has not answered 10 s after the hold is dropped and retried. */
const POLL_TIMEOUT_MS = (POLL_WAIT_SECONDS + 10) * 1000;

type PollInput = {
  apiUrl: string;
  pollSecret: string;
  keys: { publicKey: string; privateKey: string };
  requesterNonce: string;
  commitment: string;
  snapshot: PairingSnapshot;
  abort: AbortController;
};

export class PairingFlow {
  private current: { snapshot: PairingSnapshot; abort: AbortController } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: PairingOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.now = options.now ?? Date.now;
  }

  snapshot(): PairingSnapshot | null {
    const current = this.current;
    if (!current) return null;
    if (current.snapshot.state === "pending" && Date.parse(current.snapshot.expiresAt) <= this.now()) {
      current.snapshot = { ...current.snapshot, state: "expired" };
    }
    return { ...current.snapshot };
  }

  cancel() {
    this.current?.abort.abort();
    this.current = null;
  }

  /** Ends a `needs_profile` pairing: approved once the picked profile and the session are stored, else failed. */
  settleProfilePick(error: string | null) {
    const current = this.current;
    if (current?.snapshot.state !== "needs_profile") return;
    current.snapshot = { ...current.snapshot, state: error ? "failed" : "approved", error };
    this.options.log(error ? "pairing failed after the profile pick" : "pairing approved: profile picked, session and library key stored", {
      requestId: current.snapshot.requestId,
      error,
    });
  }

  /** Asks the API for a fresh code (replacing any previous one) and starts polling for the approval. */
  async start(input: { apiUrl: string; deviceName: string }): Promise<PairingSnapshot> {
    this.cancel();
    const keys = generateDeviceKeyPair();
    const requesterNonce = newPairingNonce();
    const commitment = pairingCommitment(keys.publicKey, requesterNonce);
    const apiUrl = input.apiUrl.replace(/\/+$/, "");
    const res = await this.fetchImpl(`${apiUrl}/pairing/requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-space-app": "badger", ...clientIdentityHeaders() },
      body: JSON.stringify({ deviceType: this.options.deviceType, deviceName: input.deviceName, publicKey: keys.publicKey, commitment }),
    });
    const body = asObject(await res.json().catch(() => null));
    if (!res.ok || !body || typeof body.requestId !== "string" || typeof body.pollSecret !== "string") {
      const detail = typeof body?.error === "string" ? body.error : `api_${res.status}`;
      this.options.log("pairing request refused", { status: res.status, detail });
      throw Object.assign(new Error(detail), { status: res.status, payload: body });
    }
    const created = body as unknown as CreateResponse;
    const snapshot: PairingSnapshot = {
      state: "pending",
      requestId: created.requestId,
      shortCode: normalizeShortCode(created.shortCode) ?? created.shortCode,
      qrPayload: withCommitmentFingerprint(created.qrPayload, commitment),
      checkCode: null,
      expiresAt: created.expiresAt,
      deviceName: input.deviceName,
      error: null,
    };
    const abort = new AbortController();
    this.current = { snapshot, abort };
    this.options.log("pairing started", { requestId: snapshot.requestId, expiresAt: snapshot.expiresAt, deviceName: input.deviceName });
    void this.poll({ apiUrl, pollSecret: created.pollSecret, keys, requesterNonce, commitment, snapshot, abort });
    return { ...snapshot };
  }

  private update(snapshot: PairingSnapshot, patch: Partial<PairingSnapshot>) {
    if (this.current?.snapshot.requestId === snapshot.requestId) {
      this.current.snapshot = { ...this.current.snapshot, ...patch };
    }
  }

  /**
   * PRIV-PAIR-01: reveal this service's number (the API accepts the same one again) and compute the code from the FIRST
   * approver number the polls carried (pinned by `poll` before the reveal is sent). A server that takes the reveal but
   * fails the answer, then shows another approver number, would know this service's number and could grind its new
   * number until the code matches one it controls on the approver; a retry therefore keeps the pinned number.
   */
  private async reveal(input: PollInput, approverNonce: string): Promise<string | null> {
    const { apiUrl, pollSecret, keys, requesterNonce, commitment, snapshot, abort } = input;
    try {
      const res = await this.fetchImpl(`${apiUrl}/pairing/requests/${encodeURIComponent(snapshot.requestId)}/reveal`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-space-app": "badger", ...clientIdentityHeaders() },
        body: JSON.stringify({ pollSecret, requesterNonce }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
      });
      if (!res.ok) {
        this.options.log("pairing reveal failed", { requestId: snapshot.requestId, status: res.status });
        return null;
      }
    } catch (error) {
      if (!abort.signal.aborted) this.options.log("pairing reveal error", { requestId: snapshot.requestId, error: errorMessage(error) });
      return null;
    }
    this.options.log("pairing check code ready", { requestId: snapshot.requestId });
    return pairingCheckCode({ publicKey: keys.publicKey, commitment, approverNonce, requesterNonce });
  }

  private async poll(input: PollInput) {
    const { apiUrl, pollSecret, keys, snapshot, abort } = input;
    const privateKey = keys.privateKey;
    let checkCode: string | null = null;
    let pinnedApproverNonce: string | null = null;
    const requestId = snapshot.requestId;
    while (!abort.signal.aborted) {
      if (Date.parse(snapshot.expiresAt) + 30_000 <= this.now()) {
        this.update(snapshot, { state: "expired" });
        this.options.log("pairing code expired", { requestId });
        return;
      }
      try {
        const res = await this.fetchImpl(`${apiUrl}/pairing/requests/${encodeURIComponent(requestId)}?pollSecret=${encodeURIComponent(pollSecret)}&wait=${POLL_WAIT_SECONDS}`, {
          headers: { "x-space-app": "badger", ...clientIdentityHeaders() },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
        });
        const body = (await res.json().catch(() => null)) as PollResponse | null;
        if (res.status === 404 || res.status === 410) {
          this.update(snapshot, { state: "expired" });
          return;
        }
        if (res.ok && body) {
          if (body.status === "pending" && !checkCode && isPairingBlob32(body.approverNonce)) {
            pinnedApproverNonce ??= body.approverNonce;
            if (body.approverNonce !== pinnedApproverNonce) {
              this.options.log("pairing approver number changed; ignored, the first one stays", { requestId });
            }
            checkCode = await this.reveal(input, pinnedApproverNonce);
            if (checkCode) this.update(snapshot, { checkCode });
          }
          if (body.status === "approved") {
            await this.finish(apiUrl, privateKey, snapshot, body);
            return;
          }
          if (body.status === "denied" || body.status === "expired") {
            this.update(snapshot, { state: body.status });
            this.options.log("pairing ended", { requestId, status: body.status });
            return;
          }
          if (body.status === "consumed") {
            this.update(snapshot, { state: "failed", error: "pairing_already_consumed" });
            return;
          }
        } else {
          this.options.log("pairing poll failed", { requestId, status: res.status });
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        this.options.log("pairing poll error", { requestId, error: errorMessage(error) });
      }
      const { promise: slept, resolve: wake } = Promise.withResolvers<void>();
      const timer = setTimeout(wake, this.pollIntervalMs);
      abort.signal.addEventListener("abort", () => (clearTimeout(timer), wake()), { once: true });
      await slept;
    }
  }

  private async finish(apiUrl: string, privateKey: string, snapshot: PairingSnapshot, body: Extract<PollResponse, { status: "approved" }>) {
    const requestId = snapshot.requestId;
    try {
      if (!isSealedKey(body.sealedKey)) throw new Error("pairing_sealed_key_invalid");
      const key = openSealedKey({ devicePrivateKey: privateKey, requestId, sealed: body.sealedKey });
      const state = await this.options.onApproved({
        token: body.token,
        userId: body.user?.id ?? null,
        email: body.user?.email ?? null,
        apiUrl,
        libraryKeyBase64: bytesToBase64(key),
      });
      this.update(snapshot, { state });
      this.options.log(state === "approved" ? "pairing approved: session and library key stored" : "pairing approved: waiting for the profile pick", {
        requestId,
        email: body.user?.email ?? null,
      });
    } catch (error) {
      this.update(snapshot, { state: "failed", error: errorMessage(error) });
      this.options.log("pairing approval could not be completed", { requestId, error: errorMessage(error) });
    }
  }
}
