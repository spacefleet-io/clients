/**
 * The ticket reserve and the metadata client of one signed-in app session (META-ANON-01/02, META-RELAY-01), shared
 * by every browser-like client: the desktop renderer and the Badger web player.
 *
 * Every host capability is an argument (storage, fetch, the session, the URLs) so tests drive it with fakes. Sign-in
 * calls `start()`, sign-out `stop()`; the issuance request (the only one that carries the session) is the reserve's,
 * lookups go straight to the metadata service with one ticket each.
 */
import { createMetadataClient, type MetadataClient } from "./client";
import { createTicketReserve, RESERVE_STORAGE_KEY, type RefillResult, type TicketAuth, type TicketReserve, type TicketReserveConfig } from "./reserve";
import { defaultRandom, defaultTimers, type FetchLike, type KeyValueStorage } from "./types";

/**
 * META-ANON-13: an app's background lookups (copies of lyrics, covers, pictures and texts nobody asked for on screen)
 * start no sooner than a uniform random 30 to 120 s after the sign-in refill ended, so their first ticket is not
 * spent right after the issuance that carried the session.
 */
export const BACKGROUND_LOOKUP_DELAY_MS = { min: 30_000, max: 120_000 } as const;

export interface SessionMetadataDeps {
  storage: KeyValueStorage;
  fetch: FetchLike;
  getAuth: () => TicketAuth | null | Promise<TicketAuth | null>;
  apiBaseUrl: () => string;
  metadataUrl: () => string;
  pinnedKeys?: TicketReserveConfig["pinnedKeys"];
  onRefill?: TicketReserveConfig["onRefill"];
  /** Where tickets are blinded and unblinded (META-ANON-12): a browser host passes its worker. Default: in-thread. */
  ticketCrypto?: TicketReserveConfig["ticketCrypto"];
  /** Reserve size, schedule and clock overrides. The app leaves this out (defaults: 600 tickets, refill below 300). */
  tuning?: Partial<Pick<TicketReserveConfig, "options" | "timers" | "random" | "now">>;
  /** META-ANON-13 bounds, for tests. Default `BACKGROUND_LOOKUP_DELAY_MS`. */
  backgroundDelayMs?: { min: number; max: number };
  /** META-ANON-14: the User-Agent of every lookup, for a host whose fetch honours it (Node, Bun, React Native). */
  userAgent?: string;
  /**
   * `false` (`metadataTicketsForBuild` of a dev build): lookups carry no ticket (META-ANON-06). The reserve still
   * fills from the API as before, so code that waits for tickets behaves the same. Default true.
   */
  tickets?: boolean;
}

export interface SessionMetadata {
  client: MetadataClient;
  reserve: TicketReserve;
  /** Sign-in: start the refill schedule. Settles when the first refill ends (every batch of it). Never rejects. */
  start(): Promise<RefillResult>;
  /**
   * Resolves once the latest `start()` has its first refill running (or found the session signed out again). A
   * lookup made after it waits for that refill's first batch only, not for the whole refill (META-ANON-10). Never rejects.
   */
  scheduleRunning(): Promise<void>;
  /**
   * META-ANON-13: resolves a uniform random 30 to 120 s after the latest `start()`'s first refill ended (whatever its
   * outcome), and at once at `stop()` or a newer `start()`. A background lookup pass awaits it before its first
   * lookup; a lookup the user asks for never does. Never rejects.
   */
  backgroundReady(): Promise<void>;
  /** Sign-out: stop the schedule and drop every stored ticket. */
  stop(): Promise<void>;
}

export const createSessionMetadata = (deps: SessionMetadataDeps): SessionMetadata => {
  // The reserve lets a batch that is in flight when stop() is called finish and append (by design). Here that would
  // put the old session's tickets into the store sign-out just emptied, or into the next account's reserve. So
  // every sign-in/sign-out opens a new generation: an issuance answer that arrives under another generation is
  // refused (the reserve sees a failed request and appends nothing), start() waits for such a request to settle
  // before it starts the next session's schedule, and nothing is written to the store between stop() and start().
  let generation = 0;
  let stopped = false;
  let issuing: Promise<void> = Promise.resolve();
  const storage: KeyValueStorage = {
    get: (key) => deps.storage.get(key),
    set: async (key, value) => {
      if (stopped) return;
      await deps.storage.set(key, value);
    },
    remove: (key) => deps.storage.remove(key),
  };
  // Only the reserve's issuance requests go through this one (lookups use `deps.fetch` directly).
  const issuanceFetch: FetchLike = (url, init) => {
    const startedIn = generation;
    const request = (async () => {
      const response = await deps.fetch(url, init);
      if (startedIn !== generation) throw new Error("metadata tickets: the session changed during issuance");
      return response;
    })();
    issuing = request.then(
      () => undefined,
      () => undefined
    );
    return request;
  };
  const reserve = createTicketReserve({
    storage,
    fetch: issuanceFetch,
    getAuth: deps.getAuth,
    apiBaseUrl: deps.apiBaseUrl,
    ...(deps.pinnedKeys ? { pinnedKeys: deps.pinnedKeys } : {}),
    ...(deps.onRefill ? { onRefill: deps.onRefill } : {}),
    ...(deps.ticketCrypto ? { ticketCrypto: deps.ticketCrypto } : {}),
    ...deps.tuning,
  });
  const client = createMetadataClient({
    reserve,
    fetch: deps.fetch,
    metadataUrl: deps.metadataUrl,
    ...(deps.tickets === false ? { tickets: false } : {}),
    ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
  });
  let running: Promise<void> = Promise.resolve();
  const timers = deps.tuning?.timers ?? defaultTimers;
  const random = deps.tuning?.random ?? defaultRandom;
  const delayRange = deps.backgroundDelayMs ?? BACKGROUND_LOOKUP_DELAY_MS;
  let background: Promise<void> = Promise.resolve();
  let backgroundTimer: unknown = null;
  let openBackground: (() => void) | null = null;
  // Sign-out (or a new sign-in) opens the gate at once: a pass still waiting reads the empty reserve and stops.
  const releaseBackground = () => {
    if (backgroundTimer !== null) timers.clearTimeout(backgroundTimer);
    backgroundTimer = null;
    openBackground?.();
    openBackground = null;
  };
  return {
    client,
    reserve,
    start: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      running = promise;
      releaseBackground();
      const gate = Promise.withResolvers<void>();
      background = gate.promise;
      openBackground = gate.resolve;
      // A request of the previous session may still be running: let it settle (and be refused) first.
      const startedIn = generation;
      return (async (): Promise<RefillResult> => {
        try {
          await issuing;
          await new Promise<void>((done) => setTimeout(done, 0));
          // Signed out again while waiting: nothing to start.
          if (startedIn !== generation) return { status: "stopped", added: 0, dropped: 0, count: 0 };
          stopped = false;
          // reserve.start() puts its refill in flight before it returns, so takeWhenReady() waits for its batches.
          const firstRefill = reserve.start();
          resolve();
          return await firstRefill;
        } finally {
          resolve();
          if (startedIn !== generation) gate.resolve();
          else if (openBackground === gate.resolve) {
            // Armed whatever the first refill's outcome: an error leaves the pass to its own retries, never stuck.
            const delay = Math.round(delayRange.min + (delayRange.max - delayRange.min) * random());
            backgroundTimer = timers.setTimeout(() => {
              backgroundTimer = null;
              openBackground = null;
              gate.resolve();
            }, delay);
          }
        }
      })();
    },
    scheduleRunning: () => running,
    backgroundReady: () => background,
    stop: async () => {
      stopped = true;
      generation += 1;
      releaseBackground();
      reserve.stop();
      await deps.storage.remove(RESERVE_STORAGE_KEY);
    },
  };
};

/** A synchronous string store (the browser's `Storage`): `localStorage` in the desktop renderer and the web player. */
export interface SyncStringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A synchronous store behind the async interface the reserve wants. `getStorage` is read at every call, so building
 * the adapter touches nothing (a module can create it at import time, before the page has a storage).
 */
export const syncStorageAdapter = (getStorage: () => SyncStringStorage): KeyValueStorage => ({
  get: async (key) => getStorage().getItem(key),
  set: async (key, value) => {
    getStorage().setItem(key, value);
  },
  remove: async (key) => {
    getStorage().removeItem(key);
  },
});
