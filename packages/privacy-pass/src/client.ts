// Client side of ticket issuance: blind a batch of fresh token inputs, then unblind and verify what the
// API signed against the PINNED key. Anything that does not verify against the pinned key (a different
// signing key, a different key id, a garbled signature) is dropped, so the API cannot mark tickets by
// signing with a per-user key (META-ANON-03).

import { bytesToBigInt } from "./bigint";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, hexToBytes } from "./bytes";
import { PINNED_TICKET_KEY, type PinnedTicketKey } from "./pinnedKey";
import { defaultGetRandomBytes, type GetRandomBytes } from "./random";
import { blind, finalize, modulusBytes, type RsaPublicKey } from "./rsabssa";
import { NONCE_LENGTH, TOKEN_PUBLIC_EXPONENT, buildToken, keyIdOfModulus, tokenAuthenticatorInput } from "./token";

/** What the app must keep between asking for signatures and receiving them. JSON serialisable, secret. */
export interface PendingTicket {
  /** base64url, 32 random bytes: the token nonce. */
  nonce: string;
  /** base64url, the blinding inverse needed to unblind the signature. */
  inv: string;
}

export interface TicketRequests {
  /** base64url blinded messages (256 bytes each) to POST to `/metadata/tickets`. Same order as `pending`. */
  blinded: string[];
  pending: PendingTicket[];
}

export interface FinishedTickets {
  /** Verified tokens, base64url of the 354-byte token. Ready for `privateTokenAuthorization`. */
  tokens: string[];
  /** How many signatures were refused (wrong key id, bad signature, malformed or missing). */
  dropped: number;
}

export interface TicketRequestOptions {
  getRandomBytes?: GetRandomBytes;
}

export interface FinishTicketOptions {
  /** The `keyId` the API reported next to the signatures; when given and different from the pinned id, every ticket is dropped. */
  responseKeyId?: string;
}

export interface YieldOptions {
  /** Awaited before each ticket of an async batch. Default: one `setTimeout(0)` turn. */
  yieldToEventLoop?: () => Promise<void>;
}

export const MAX_TICKETS_PER_REQUEST = 100;

interface LoadedPinnedKey {
  pk: RsaPublicKey;
  keyId: Uint8Array;
}

/** Decodes the pinned constant and refuses one whose key id does not belong to its modulus (a broken pin). */
export function loadPinnedKey(pinned: PinnedTicketKey): LoadedPinnedKey {
  const modulus = hexToBytes(pinned.modulusHex);
  const pk: RsaPublicKey = { n: bytesToBigInt(modulus), e: TOKEN_PUBLIC_EXPONENT };
  if (modulus.length !== 256 || modulusBytes(pk) !== 256) throw new Error("pinned ticket key: modulus must be RSA-2048");
  const keyId = keyIdOfModulus(modulus);
  if (bytesToHex(keyId) !== pinned.keyId.toLowerCase()) throw new Error("pinned ticket key: keyId does not match the modulus");
  return { pk, keyId };
}

interface RequestBatch {
  pk: RsaPublicKey;
  keyId: Uint8Array;
  getRandomBytes: GetRandomBytes;
}

function startRequests(count: number, pinnedKey: PinnedTicketKey, options: TicketRequestOptions): RequestBatch {
  if (!Number.isInteger(count) || count < 1 || count > MAX_TICKETS_PER_REQUEST) {
    throw new Error(`count must be an integer from 1 to ${MAX_TICKETS_PER_REQUEST}`);
  }
  return { ...loadPinnedKey(pinnedKey), getRandomBytes: options.getRandomBytes ?? defaultGetRandomBytes };
}

function requestOne(batch: RequestBatch, out: TicketRequests): void {
  const nonce = batch.getRandomBytes(NONCE_LENGTH);
  const { blindedMsg, inv } = blind(batch.pk, tokenAuthenticatorInput(nonce, batch.keyId), { getRandomBytes: batch.getRandomBytes });
  out.blinded.push(bytesToBase64Url(blindedMsg));
  out.pending.push({ nonce: bytesToBase64Url(nonce), inv: bytesToBase64Url(inv) });
}

/** Blinds `count` (1..100) fresh token inputs against the pinned key. */
export function createTicketRequests(
  count: number,
  pinnedKey: PinnedTicketKey = PINNED_TICKET_KEY,
  options: TicketRequestOptions = {},
): TicketRequests {
  const batch = startRequests(count, pinnedKey, options);
  const out: TicketRequests = { blinded: [], pending: [] };
  for (let i = 0; i < count; i += 1) requestOne(batch, out);
  return out;
}

/** Hands the event loop back for one macrotask turn (renders, taps, timers run). */
export const defaultYieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * `createTicketRequests` one ticket per event-loop turn: an RSA-2048 blind costs ~70 ms on Hermes, so a sync batch
 * of 25 froze the phone's JS thread ~1.8 s (PERF-TIME-03). Same output as the sync call for the same randomness.
 */
export async function createTicketRequestsAsync(
  count: number,
  pinnedKey: PinnedTicketKey = PINNED_TICKET_KEY,
  options: TicketRequestOptions & YieldOptions = {},
): Promise<TicketRequests> {
  const batch = startRequests(count, pinnedKey, options);
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
  const out: TicketRequests = { blinded: [], pending: [] };
  for (let i = 0; i < count; i += 1) {
    await yieldToEventLoop();
    requestOne(batch, out);
  }
  return out;
}

/**
 * Validates the untrusted answer shape; null when the whole batch must be dropped. `signed` and `responseKeyId` come
 * from an untrusted server response: a wrong shape drops the batch instead of throwing.
 */
function startFinish(signed: readonly string[], pinnedKey: PinnedTicketKey, options: FinishTicketOptions): LoadedPinnedKey | null {
  const loaded = loadPinnedKey(pinnedKey);
  const responseKeyId: unknown = options?.responseKeyId;
  if (!Array.isArray(signed) || (responseKeyId !== undefined && (typeof responseKeyId !== "string" || responseKeyId.toLowerCase() !== pinnedKey.keyId.toLowerCase()))) {
    return null;
  }
  return loaded;
}

function finishOne(key: LoadedPinnedKey, entry: PendingTicket, signature: unknown, out: FinishedTickets): void {
  if (typeof signature !== "string") {
    out.dropped += 1;
    return;
  }
  try {
    const nonce = base64UrlToBytes(entry.nonce);
    const authenticator = finalize(key.pk, tokenAuthenticatorInput(nonce, key.keyId), base64UrlToBytes(signature), base64UrlToBytes(entry.inv));
    out.tokens.push(bytesToBase64Url(buildToken(nonce, key.keyId, authenticator)));
  } catch {
    out.dropped += 1;
  }
}

/**
 * Unblinds `signed[i]` for `pending[i]` and keeps it only when the resulting signature verifies against
 * the pinned key. Never throws on bad server data: bad entries are counted in `dropped`.
 */
export function finishTickets(
  pending: readonly PendingTicket[],
  signed: readonly string[],
  pinnedKey: PinnedTicketKey = PINNED_TICKET_KEY,
  options: FinishTicketOptions = {},
): FinishedTickets {
  const key = startFinish(signed, pinnedKey, options);
  if (key === null) return { tokens: [], dropped: pending.length };
  const out: FinishedTickets = { tokens: [], dropped: 0 };
  for (let i = 0; i < pending.length; i += 1) finishOne(key, pending[i]!, signed[i], out);
  return out;
}

/** `finishTickets` one ticket per event-loop turn (see `createTicketRequestsAsync`). Same result as the sync call. */
export async function finishTicketsAsync(
  pending: readonly PendingTicket[],
  signed: readonly string[],
  pinnedKey: PinnedTicketKey = PINNED_TICKET_KEY,
  options: FinishTicketOptions & YieldOptions = {},
): Promise<FinishedTickets> {
  const key = startFinish(signed, pinnedKey, options);
  if (key === null) return { tokens: [], dropped: pending.length };
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
  const out: FinishedTickets = { tokens: [], dropped: 0 };
  for (let i = 0; i < pending.length; i += 1) {
    await yieldToEventLoop();
    finishOne(key, pending[i]!, signed[i], out);
  }
  return out;
}
