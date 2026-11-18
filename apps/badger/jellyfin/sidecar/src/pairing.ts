import { bytesToBase64, formatShortCode, generateDeviceKeyPair, isSealedKey, openSealedKey, type SealedKey } from "@space/pairing-crypto";
import { errorMessage } from "./errors";

/**
 * New-device side of the pairing contract (ACCT-PAIR-01, PRIV-KEY-05): the Jellyfin server asks for a code, the
 * user approves it with the phone app, and this service receives a session token plus the library key sealed
 * to a keypair that never leaves this process. The Jellyfin plugin only renders what `snapshot()` returns.
 */
/** `needs_profile`: approved, but the account has several profiles and nothing is stored until the owner picks one (INTG-PROF-01). */
export type PairingState = "pending" | "approved" | "needs_profile" | "expired" | "denied" | "failed";

export type PairingSnapshot = {
  state: PairingState;
  requestId: string;
  /** "ABCD-EFGH" */
  shortCode: string;
  /** What the phone's QR scanner reads. */
  qrPayload: string;
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
  | { status: "pending" | "expired" | "denied" | "consumed" }
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
    const apiUrl = input.apiUrl.replace(/\/+$/, "");
    const res = await this.fetchImpl(`${apiUrl}/pairing/requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-space-app": "badger" },
      body: JSON.stringify({ deviceType: this.options.deviceType, deviceName: input.deviceName, publicKey: keys.publicKey }),
    });
    const body = asObject(await res.json().catch(() => null));
    if (!res.ok || !body || typeof body.requestId !== "string" || typeof body.pollSecret !== "string") {
      const detail = typeof body?.error === "string" ? body.error : `api_${res.status}`;
      this.options.log("pairing request refused", { status: res.status, detail });
      throw Object.assign(new Error(detail), { status: res.status });
    }
    const created = body as unknown as CreateResponse;
    const snapshot: PairingSnapshot = {
      state: "pending",
      requestId: created.requestId,
      shortCode: created.shortCode.includes("-") ? created.shortCode : formatShortCode(created.shortCode),
      qrPayload: created.qrPayload,
      expiresAt: created.expiresAt,
      deviceName: input.deviceName,
      error: null,
    };
    const abort = new AbortController();
    this.current = { snapshot, abort };
    this.options.log("pairing started", { requestId: snapshot.requestId, expiresAt: snapshot.expiresAt, deviceName: input.deviceName });
    void this.poll({ apiUrl, pollSecret: created.pollSecret, privateKey: keys.privateKey, snapshot, abort });
    return { ...snapshot };
  }

  private update(snapshot: PairingSnapshot, patch: Partial<PairingSnapshot>) {
    if (this.current?.snapshot.requestId === snapshot.requestId) {
      this.current.snapshot = { ...this.current.snapshot, ...patch };
    }
  }

  private async poll(input: { apiUrl: string; pollSecret: string; privateKey: string; snapshot: PairingSnapshot; abort: AbortController }) {
    const { apiUrl, pollSecret, privateKey, snapshot, abort } = input;
    const requestId = snapshot.requestId;
    while (!abort.signal.aborted) {
      if (Date.parse(snapshot.expiresAt) + 30_000 <= this.now()) {
        this.update(snapshot, { state: "expired" });
        this.options.log("pairing code expired", { requestId });
        return;
      }
      try {
        const res = await this.fetchImpl(`${apiUrl}/pairing/requests/${encodeURIComponent(requestId)}?pollSecret=${encodeURIComponent(pollSecret)}&wait=${POLL_WAIT_SECONDS}`, {
          headers: { "x-space-app": "badger" },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
        });
        const body = (await res.json().catch(() => null)) as PollResponse | null;
        if (res.status === 404 || res.status === 410) {
          this.update(snapshot, { state: "expired" });
          return;
        }
        if (res.ok && body) {
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
