// The ticket reserve: anonymous lookup tickets kept in the app's own store and refilled on a schedule that has
// nothing to do with lookups or uploads (META-ANON-02). Nothing in this file logs; token values never leave
// the storage blob except through take().

import {
  MAX_TICKETS_PER_REQUEST,
  PINNED_TICKET_KEY,
  TOKEN_LENGTH,
  base64UrlToBytes,
  bytesToHex,
  createInThreadTicketCrypto,
  parseToken,
  type GetRandomBytes,
  type PinnedTicketKey,
  type TicketCrypto,
} from "@space/privacy-pass";
import {
  MAX_TIMER_MS,
  defaultRandom,
  defaultTimers,
  parseRetryAfterSeconds,
  type FetchLike,
  type KeyValueStorage,
  type RandomFn,
  type Timers,
} from "./types";

export const RESERVE_STORAGE_KEY = "space.metadata.tickets.v1";

const HOUR_MS = 3_600_000;

export interface TicketReserveOptions {
  /** Refill up to this many tickets. Default 600. */
  target?: number;
  /** A scheduled tick refills only when fewer than this many tickets are held. Default 300. */
  lowWater?: number;
  /** Tickets per issuance request, 1..100. Default 100. */
  batchSize?: number;
  /** Nominal time between scheduled ticks. Default 6 hours. */
  intervalMs?: number;
  /** Random spread of each tick, as a fraction of the interval (0.3 = +-30%). Default 0.3. */
  jitter?: number;
  /** First delay after a network or server failure; doubles per consecutive failure up to `intervalMs`. Default 5 minutes. */
  backoffBaseMs?: number;
  /** Storage key of the JSON blob. Default {@link RESERVE_STORAGE_KEY}. */
  storageKey?: string;
}

/** What the app gives the issuance request: the signed-in session plus whatever headers its API calls carry. */
export interface TicketAuth {
  /** Session token, sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Extra headers (app scope, device, ...). `Authorization` and `Content-Type` set here are ignored. */
  headers?: Record<string, string>;
}

export interface TicketReserveConfig {
  storage: KeyValueStorage;
  fetch: FetchLike;
  /** The signed-in session, or null when signed out (no request is made then). */
  getAuth: () => TicketAuth | null | Promise<TicketAuth | null>;
  /** The API base URL, read at every refill. */
  apiBaseUrl: () => string;
  /**
   * Keys a ticket may verify against (META-ANON-07). Default: `[PINNED_TICKET_KEY]`, the one production key from
   * `@space/privacy-pass`, which is what every release build passes (`ticketKeysForBuild(false)`). A development build
   * passes every environment's key (`ticketKeysForBuild(true)`) so its server picker can point at any API. The first key
   * is blinded against until an answer names another key of the list; the answer's keyId only ever picks among these.
   */
  pinnedKeys?: readonly PinnedTicketKey[];
  /** Jitter RNG, [0, 1). Default: crypto-backed. */
  random?: RandomFn;
  /** Randomness for ticket material, forwarded to `@space/privacy-pass`. Default: globalThis.crypto. */
  getRandomBytes?: GetRandomBytes;
  /**
   * Awaited before each ticket is blinded or unblinded, so a batch never holds the JS thread for more than one
   * ticket (~70 ms on Hermes; PERF-TIME-03). Default: one `setTimeout(0)` turn, independent of `timers`.
   */
  yieldToEventLoop?: () => Promise<void>;
  /**
   * Where tickets are blinded and unblinded (META-ANON-12). A browser host passes `createWorkerTicketCrypto` so the
   * RSA work never runs on its UI thread. Default: in-thread, one ticket per `yieldToEventLoop` turn.
   */
  ticketCrypto?: TicketCrypto;
  /** Clock in ms since epoch, used for HTTP-date Retry-After. Default Date.now. */
  now?: () => number;
  timers?: Timers;
  options?: TicketReserveOptions;
  /** Called after every scheduled tick with the outcome (counts only). Errors it throws are ignored. */
  onRefill?: (result: RefillResult) => void;
}

export type RefillStatus =
  /** The reserve reached the target. */
  | "ok"
  /** Nothing to do: the reserve is at or above the low-water mark (or the target, when forced). */
  | "skipped"
  /** 402: the account is not paid up. What we hold is kept; retried at the next tick. */
  | "unpaid"
  /** 429: ceiling reached. `retryAfterSeconds` is the server's hint. */
  | "rate_limited"
  /** 401 or no session: signed out. The schedule stops until `start()` is called again. */
  | "signed_out"
  /** The request never got an answer. Backs off. */
  | "network_error"
  /** The API answered with an error or an unreadable body. Backs off. */
  | "server_error"
  /**
   * 409 ticket_key_mismatch: the API signs with a key this build does not trust (META-ANON-07), e.g. a release build
   * pointed at a stack that signs with the development key. `serverKeyId` names the API's key. Retried at the normal interval.
   */
  | "key_mismatch"
  /** A whole batch failed verification against the pinned key; nothing was kept. */
  | "rejected"
  /** `stop()` was called while the loop was running. */
  | "stopped"
  /** A local failure (storage, missing crypto) in a scheduled tick. `refill()` itself rejects with it instead. */
  | "error";

export interface RefillResult {
  status: RefillStatus;
  /** Tickets added to the reserve by this refill. */
  added: number;
  /** Signatures dropped because they did not verify against the pinned key (counted, never logged). */
  dropped: number;
  /** Tickets held when the refill ended. */
  count: number;
  retryAfterSeconds?: number;
  /** With `key_mismatch`: the token_key_id (lowercase hex) the API says it signs with. Untrusted, for logs only. */
  serverKeyId?: string;
}

export interface TicketReserve {
  /** Tickets currently held. */
  count(): Promise<number>;
  /**
   * Removes one ticket from the store and returns it, or null when the reserve is empty. The ticket is
   * deleted from storage before this resolves, so a crash after it can never reuse it. Never refills.
   */
  take(): Promise<string | null>;
  /**
   * Gives back a ticket that `take()` handed out and the service did not spend (META-ANON-05). Ignored when it is not
   * a well-formed ticket of the pinned key or is already held. Never rejects: a failed write loses the ticket, as
   * before, and the next `take()` returns it first.
   */
  put(ticket: string): Promise<void>;
  /**
   * Like `take()`, but when the reserve is empty while a refill is running (the one sign-in or the schedule started),
   * waits for that refill's next batch instead of answering null at once: a lookup made right after sign-in gets the
   * first ticket that lands. Resolves null when no refill is running, or the running one ends without leaving a
   * ticket (it failed, was stopped, ...). Never starts a refill (META-ANON-02).
   */
  takeWhenReady(): Promise<string | null>;
  /**
   * Calls `listener` with the new count each time a refill batch added tickets, so a screen that showed "unavailable"
   * can look up again on its own. Returns the unsubscribe. A listener that throws is ignored.
   */
  onTickets(listener: (count: number) => void): () => void;
  /**
   * Asks the API for tickets up to the target (only when below the low-water mark, unless `force`). One run at a
   * time: concurrent calls share the same run. Resolves with the outcome; rejects only on a local failure.
   */
  refill(options?: { force?: boolean }): Promise<RefillResult>;
  /** Starts the schedule (call when signed in): an immediate low-water check, then a jittered tick every ~6h. Never rejects. */
  start(): Promise<RefillResult>;
  /** Stops the schedule. An already running batch finishes, the loop then ends. */
  stop(): void;
}

const TOKEN_CHARS = Math.ceil((TOKEN_LENGTH * 4) / 3);
const TOKEN_RE = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_CHARS}}$`, "u");
const KEY_ID_RE = /^[0-9a-f]{64}$/u;

/** The API's key id from a 409 `ticket_key_mismatch` answer, or null when the body is not one (untrusted input). */
const keyMismatchKeyId = async (response: { json(): Promise<unknown> }): Promise<string | null> => {
  try {
    const body = (await response.json()) as { error?: unknown; keyId?: unknown } | null;
    if (body === null || typeof body !== "object" || body.error !== "ticket_key_mismatch") return null;
    return typeof body.keyId === "string" && KEY_ID_RE.test(body.keyId) ? body.keyId : null;
  } catch {
    return null;
  }
};

export function createTicketReserve(config: TicketReserveConfig): TicketReserve {
  const { storage, getAuth, apiBaseUrl } = config;
  const ticketCrypto = config.ticketCrypto ?? createInThreadTicketCrypto(config.yieldToEventLoop);
  const doFetch = config.fetch;
  const pinnedKeys: readonly PinnedTicketKey[] = config.pinnedKeys ?? [PINNED_TICKET_KEY];
  const random = config.random ?? defaultRandom;
  const now = config.now ?? Date.now;
  const timers = config.timers ?? defaultTimers;
  const storageKey = config.options?.storageKey ?? RESERVE_STORAGE_KEY;
  const target = config.options?.target ?? 600;
  const lowWater = config.options?.lowWater ?? 300;
  const batchSize = config.options?.batchSize ?? MAX_TICKETS_PER_REQUEST;
  const intervalMs = config.options?.intervalMs ?? 6 * HOUR_MS;
  const jitter = config.options?.jitter ?? 0.3;
  const backoffBaseMs = config.options?.backoffBaseMs ?? 5 * 60_000;

  if (!Number.isInteger(target) || target < 1) throw new Error("metadata-client: target must be a positive integer");
  if (!Number.isInteger(lowWater) || lowWater < 1 || lowWater > target) throw new Error("metadata-client: lowWater must be between 1 and target");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_TICKETS_PER_REQUEST) {
    throw new Error(`metadata-client: batchSize must be 1..${MAX_TICKETS_PER_REQUEST}`);
  }
  if (!(intervalMs > 0) || !(jitter >= 0 && jitter < 1) || !(backoffBaseMs > 0)) throw new Error("metadata-client: bad schedule options");

  if (pinnedKeys.length === 0) throw new Error("metadata-client: pinnedKeys must hold at least one key");
  const pinnedKeyIds = new Set(pinnedKeys.map((key) => key.keyId.toLowerCase()));
  /** The key the next batch is blinded against: the first trusted key until an answer names another trusted one. */
  let activeKey = pinnedKeys[0]!;

  // ---- storage, serialised by one in-process mutex -------------------------------------------------------------

  let chain: Promise<unknown> = Promise.resolve();
  /** Runs `fn` after every earlier locked call finished; `chain` never rejects so one failure cannot wedge the lock. */
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  let keyChecked = false;

  const heldKeyIdMatches = (token: string): boolean => {
    try {
      const parsed = parseToken(base64UrlToBytes(token));
      return parsed !== null && pinnedKeyIds.has(bytesToHex(parsed.keyId));
    } catch {
      return false;
    }
  };

  const parseBlob = (raw: string | null): string[] => {
    if (raw === null) return [];
    try {
      const blob = JSON.parse(raw) as { v?: unknown; tokens?: unknown } | null;
      if (blob === null || typeof blob !== "object" || blob.v !== 1 || !Array.isArray(blob.tokens)) return [];
      return blob.tokens.filter((t): t is string => typeof t === "string" && TOKEN_RE.test(t));
    } catch {
      return [];
    }
  };

  const writeTokens = (tokens: string[]): Promise<void> =>
    tokens.length === 0 ? storage.remove(storageKey) : storage.set(storageKey, JSON.stringify({ v: 1, tokens }));

  /** Must run inside `locked`. The first read of an instance also drops tickets that do not carry the pinned key id (after a key rotation). */
  const readTokens = async (): Promise<string[]> => {
    const raw = await storage.get(storageKey);
    let tokens = parseBlob(raw);
    if (!keyChecked) {
      const kept = tokens.filter(heldKeyIdMatches);
      if (kept.length !== tokens.length) {
        tokens = kept;
        await writeTokens(tokens);
      }
      keyChecked = true;
    }
    return tokens;
  };

  const count = (): Promise<number> => locked(async () => (await readTokens()).length);

  const take = (): Promise<string | null> =>
    locked(async () => {
      const tokens = await readTokens();
      const ticket = tokens.pop();
      if (ticket === undefined) return null;
      // Persisted removal first: if the write throws the ticket stays stored and is not handed out.
      await writeTokens(tokens);
      return ticket;
    });

  const put = (ticket: string): Promise<void> =>
    locked(async () => {
      if (!TOKEN_RE.test(ticket) || !heldKeyIdMatches(ticket)) return;
      const tokens = await readTokens();
      if (tokens.includes(ticket)) return;
      tokens.push(ticket);
      await writeTokens(tokens);
    }).catch(() => undefined);

  const append = (added: string[]): Promise<number> =>
    locked(async () => {
      const tokens = await readTokens();
      for (const ticket of added) tokens.push(ticket);
      await writeTokens(tokens);
      return tokens.length;
    });

  // ---- refill ---------------------------------------------------------------------------------------------------

  let inflight: Promise<RefillResult> | null = null;
  /** Lookups in `takeWhenReady` waiting for the running refill: woken after each batch and when the refill ends. */
  const waiters = new Set<() => void>();
  const wakeWaiters = () => {
    const woken = [...waiters];
    waiters.clear();
    for (const wake of woken) wake();
  };
  const ticketListeners = new Set<(count: number) => void>();
  const ticketsAdded = (held: number) => {
    wakeWaiters();
    for (const listener of [...ticketListeners]) {
      try {
        listener(held);
      } catch {
        // a screen's listener must not break the refill
      }
    }
  };
  /** Consecutive transport / server failures of scheduled ticks, drives the exponential backoff. */
  let failures = 0;

  /** App headers minus Authorization / Content-Type, whatever their case: those two are ours alone. */
  const appHeaders = (headers: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !["authorization", "content-type"].includes(name.toLowerCase())));

  const refillLoop = async (force: boolean, shouldContinue: () => boolean): Promise<RefillResult> => {
    let held = await count();
    const result: RefillResult = { status: "ok", added: 0, dropped: 0, count: held };
    const finish = (status: RefillStatus, extra: { retryAfterSeconds?: number; serverKeyId?: string } = {}): RefillResult => {
      result.status = status;
      result.count = held;
      if (extra.retryAfterSeconds !== undefined) result.retryAfterSeconds = extra.retryAfterSeconds;
      if (extra.serverKeyId !== undefined) result.serverKeyId = extra.serverKeyId;
      return result;
    };
    if (held >= target || (!force && held >= lowWater)) return finish("skipped");

    let switchedKey = false;
    while (held < target) {
      if (!shouldContinue()) return finish("stopped");
      const auth = await getAuth();
      if (!auth) return finish("signed_out");
      const want = Math.min(batchSize, target - held);
      const batchKey = activeKey;
      const { blinded, pending } = await ticketCrypto.createTicketRequests(want, batchKey, config.getRandomBytes ? { getRandomBytes: config.getRandomBytes } : {});
      // Blinding spans many event-loop turns: a stop() (sign-out, shutdown) during it must not send the batch.
      if (!shouldContinue()) return finish("stopped");

      let response;
      try {
        response = await doFetch(`${apiBaseUrl()}/metadata/tickets`, {
          method: "POST",
          headers: { ...appHeaders(auth.headers), "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
          body: JSON.stringify({ blinded }),
        });
      } catch {
        return finish("network_error");
      }

      if (response.status === 401) return finish("signed_out");
      if (response.status === 402) return finish("unpaid");
      if (response.status === 429) return finish("rate_limited", { retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after"), now()) });
      if (response.status === 409) {
        const serverKeyId = await keyMismatchKeyId(response);
        return serverKeyId === null ? finish("server_error") : finish("key_mismatch", { serverKeyId });
      }
      if (response.status < 200 || response.status >= 300) return finish("server_error");

      let body: { signed?: unknown; keyId?: unknown };
      try {
        body = (await response.json()) as { signed?: unknown; keyId?: unknown };
      } catch {
        return finish("server_error");
      }
      if (body === null || typeof body !== "object") return finish("server_error");

      // Fail closed: an answer without a string keyId drops the whole batch, like one naming another key.
      if (typeof body.keyId !== "string") {
        result.dropped += pending.length;
        return finish("rejected");
      }
      // Only with more than one trusted key (a development build, META-ANON-07): the server signs with another key of
      // the list, so this batch was blinded for the wrong modulus. Drop it and blind the rest for that key, once per run
      // so a server alternating key ids cannot loop. The answer only picks among the embedded keys, never adds one.
      const answeredKey = pinnedKeys.find((key) => key.keyId.toLowerCase() === (body.keyId as string).toLowerCase());
      if (answeredKey !== undefined && answeredKey !== batchKey && !switchedKey) {
        result.dropped += pending.length;
        activeKey = answeredKey;
        switchedKey = true;
        continue;
      }
      // finishTickets verifies each signature against the batch's key and drops anything else (META-ANON-03); a keyId
      // other than that key drops the whole batch. `signed` is untrusted: the package validates its shape.
      const finished = await ticketCrypto.finishTickets(pending, body.signed as string[], batchKey, { responseKeyId: body.keyId });
      result.dropped += finished.dropped;
      if (finished.tokens.length === 0) return finish("rejected");
      held = await append(finished.tokens);
      ticketsAdded(held);
      result.added += finished.tokens.length;
    }
    return finish("ok");
  };

  const refill = (options: { force?: boolean } = {}, shouldContinue: () => boolean = () => true): Promise<RefillResult> => {
    // A run that ended "stopped" (stop() while it ran) does not satisfy a caller that is still active, e.g. stop() then start().
    if (inflight) return inflight.then((r) => (r.status === "stopped" && shouldContinue() ? refill(options, shouldContinue) : r));
    const run = refillLoop(options.force === true, shouldContinue).finally(() => {
      inflight = null;
      wakeWaiters();
    });
    inflight = run;
    return run;
  };

  const takeWhenReady = async (): Promise<string | null> => {
    for (;;) {
      // Registered before take(): a batch that lands while take() runs still wakes this lookup.
      const { promise: woken, resolve: wake } = Promise.withResolvers<void>();
      waiters.add(wake);
      const ticket = await take().catch((error: unknown) => {
        waiters.delete(wake);
        throw error;
      });
      if (ticket !== null || inflight === null) {
        waiters.delete(wake);
        return ticket;
      }
      await woken;
    }
  };

  const onTickets = (listener: (count: number) => void): (() => void) => {
    ticketListeners.add(listener);
    return () => {
      ticketListeners.delete(listener);
    };
  };

  // ---- schedule -------------------------------------------------------------------------------------------------

  let running = false;
  let generation = 0;
  let timer: unknown = null;
  let initial: Promise<RefillResult> = Promise.resolve({ status: "skipped", added: 0, dropped: 0, count: 0 });

  const jittered = (): number => Math.max(1, Math.round(intervalMs * (1 + jitter * (2 * random() - 1))));

  const nextDelayMs = (result: RefillResult): number => Math.min(rawNextDelayMs(result), MAX_TIMER_MS);

  const rawNextDelayMs = (result: RefillResult): number => {
    switch (result.status) {
      case "network_error":
      case "server_error":
      case "error": {
        failures += 1;
        return Math.min(backoffBaseMs * 2 ** Math.min(failures - 1, 30), intervalMs);
      }
      case "rate_limited":
        failures = 0;
        return Math.max(jittered(), (result.retryAfterSeconds ?? 0) * 1000);
      default:
        failures = 0;
        return jittered();
    }
  };

  const clearTimer = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const tick = async (gen: number): Promise<RefillResult> => {
    const active = () => running && gen === generation;
    let result: RefillResult;
    try {
      result = await refill({}, active);
    } catch {
      result = { status: "error", added: 0, dropped: 0, count: 0 };
    }
    try {
      config.onRefill?.(result);
    } catch {
      // the observer must not break the schedule
    }
    if (!active()) return result;
    if (result.status === "signed_out") {
      running = false;
      return result;
    }
    clearTimer();
    timer = timers.setTimeout(() => {
      timer = null;
      void tick(gen);
    }, nextDelayMs(result));
    return result;
  };

  const start = (): Promise<RefillResult> => {
    if (running) return initial;
    running = true;
    generation += 1;
    failures = 0;
    initial = tick(generation);
    return initial;
  };

  const stop = (): void => {
    running = false;
    generation += 1;
    clearTimer();
  };

  return { count, take, put, takeWhenReady, onTickets, refill: (options) => refill(options), start, stop };
}
