/**
 * Paces the renderer's `POST /lookup` calls to the metadata service's per-connection limit (META-PUB-02).
 *
 * The service answers 429 `rate_limited` with `Retry-After` before it reads the ticket, so the ticket is not spent.
 * Without pacing, a burst (Add to library of many titles while the background artwork copy runs) fired request after
 * request into that 429 and the foreground lookup failed. Every lookup of the app goes through this one gate:
 * - at most `concurrency` lookups in flight at once. A freed slot goes to the oldest waiting lookup the user waits on
 *   (search, details, ...) before any background artwork copy (`op: "image"`): a library's artwork copy is hundreds of
 *   image lookups, and queued in front of an Add to library it held each title's details back for minutes;
 * - after a 429, no lookup is sent before its `Retry-After` has passed (one shared pause, not one per caller);
 * - the 429'd lookup is sent again after the pause, up to `maxAttempts` sends; the last 429 reaches the client, which
 *   throws `MetadataUnavailableError` as before.
 * Any other request (the API's ticket issuance) passes through untouched.
 */
import { parseRetryAfterSeconds, type FetchLike } from "@space/metadata-client";

export type LookupPacerOptions = {
  concurrency?: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export const LOOKUP_CONCURRENCY = 4;
export const LOOKUP_MAX_ATTEMPTS = 6;
/** Pause when the 429 carries no usable `Retry-After`; a longer one is capped so a lookup never hangs for minutes. */
const DEFAULT_PAUSE_MS = 1_000;
const MAX_PAUSE_MS = 30_000;

export const createLookupPacer = (fetch: FetchLike, options: LookupPacerOptions = {}): FetchLike => {
  const concurrency = Math.max(1, options.concurrency ?? LOOKUP_CONCURRENCY);
  const maxAttempts = Math.max(1, options.maxAttempts ?? LOOKUP_MAX_ATTEMPTS);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });

  let inFlight = 0;
  const waiting = { foreground: [] as Array<() => void>, background: [] as Array<() => void> };
  /** No lookup leaves before this time (ms since epoch): set by the latest 429's `Retry-After`. */
  let resumeAt = 0;

  const acquire = async (lane: keyof typeof waiting) => {
    if (inFlight < concurrency) {
      inFlight += 1;
      return;
    }
    // The slot is handed over by release(), so inFlight stays counted for the waiter.
    const { promise, resolve } = Promise.withResolvers<void>();
    waiting[lane].push(resolve);
    await promise;
  };
  const release = () => {
    const next = waiting.foreground.shift() ?? waiting.background.shift();
    if (next) next();
    else inFlight -= 1;
  };

  return async (url, init) => {
    if (!/\/lookup(?:[?#]|$)/u.test(url)) return fetch(url, init);
    // The client's lookup body is our own JSON; anything unreadable waits with the foreground.
    let body: unknown = null;
    try {
      body = JSON.parse(init.body);
    } catch {
      body = null;
    }
    const background = typeof body === "object" && body !== null && "op" in body && body.op === "image";
    await acquire(background ? "background" : "foreground");
    try {
      for (let attempt = 1; ; attempt += 1) {
        for (let wait = resumeAt - now(); wait > 0; wait = resumeAt - now()) await sleep(wait);
        const response = await fetch(url, init);
        if (response.status !== 429 || attempt >= maxAttempts) return response;
        const seconds = parseRetryAfterSeconds(response.headers.get("retry-after"), now());
        const pauseMs = seconds && seconds > 0 ? Math.min(MAX_PAUSE_MS, seconds * 1000) : DEFAULT_PAUSE_MS;
        resumeAt = Math.max(resumeAt, now() + pauseMs);
      }
    } finally {
      release();
    }
  };
};
