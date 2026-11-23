/**
 * The daily hello (OPS-BIZ-20): once per local day an app tells the API it ran, with two tallies counted on this
 * device since its last hello: plays started (`noteHelloPlay`) and screens opened (`noteHelloScreen`). The request
 * carries the app, platform and version (`x-space-client`) and the two numbers, nothing else: no account, session,
 * device or install id, no `Authorization` header. The API adds it to the day's totals per app, platform and version.
 *
 * - Never blocks start-up: the first try waits `delayMs` (5 s), then the app checks again every hour, so an app left
 *   open past midnight says hello for the new day.
 * - Failures stay silent; the tallies are kept and go with the next hello. Only a 2xx clears what was sent.
 * - What it keeps on the device (`DailyHelloStore`): the local date of the last hello and the two tallies.
 */
import { clientIdentityHeaders, SPACE_CLIENT_HEADER } from "./appVersion";

/** Where an app keeps the hello's state: localStorage, AsyncStorage or a JSON file. Either sync or async. */
export type DailyHelloStore = {
  read: () => string | null | Promise<string | null>;
  write: (value: string) => void | Promise<void>;
};

/** The hello's key in an app's key-value storage (localStorage, AsyncStorage). */
export const DAILY_HELLO_STORAGE_KEY = "spacefleet.dailyHello";

/** A {@link DailyHelloStore} over a key-value storage with `getItem` / `setItem` (localStorage, AsyncStorage). */
export const keyValueHelloStore = (storage: {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
}): DailyHelloStore => ({
  read: () => storage.getItem(DAILY_HELLO_STORAGE_KEY),
  write: (value) => storage.setItem(DAILY_HELLO_STORAGE_KEY, value),
});

export type DailyHelloOptions = {
  /** API origin; a function is read at each try (an app whose API can change at runtime). */
  baseUrl: string | (() => string);
  store: DailyHelloStore;
  fetch?: typeof fetch;
  /** Wait before the first try, so the hello never competes with start-up. */
  delayMs?: number;
  /** How often a running app checks whether the local day changed. */
  checkEveryMs?: number;
  /** The local date, `YYYY-MM-DD` (tests). */
  today?: () => string;
};

type HelloState = { day: string | null; plays: number; screens: number };

/** Tallies added since the stored state was last read or written (start-up, or a note before the store is loaded). */
const unsaved = { plays: 0, screens: 0 };
let saved: HelloState | null = null;
let activeStore: DailyHelloStore | null = null;
let writing: Promise<void> = Promise.resolve();

const localDay = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

const parse = (raw: string | null): HelloState => {
  try {
    const value = raw ? (JSON.parse(raw) as Partial<HelloState>) : {};
    return { day: typeof value.day === "string" ? value.day : null, plays: count(value.plays), screens: count(value.screens) };
  } catch {
    return { day: null, plays: 0, screens: 0 };
  }
};

/** Folds the unsaved tallies into the stored state and writes it. Never throws. */
const persist = (): Promise<void> => {
  writing = writing.then(async () => {
    if (!activeStore || !saved) return;
    saved = { ...saved, plays: saved.plays + unsaved.plays, screens: saved.screens + unsaved.screens };
    unsaved.plays = 0;
    unsaved.screens = 0;
    try {
      await activeStore.write(JSON.stringify(saved));
    } catch {
      // Silent (OPS-BIZ-20): the tallies stay in memory for the next write.
    }
  });
  return writing;
};

const note = (key: "plays" | "screens") => {
  unsaved[key] += 1;
  void persist();
};

/** A play started on this device (a video, an episode, a song), streamed or from a kept copy. */
export const noteHelloPlay = () => note("plays");

/** A screen opened in this app. */
export const noteHelloScreen = () => note("screens");

/** Sends today's hello when it was not sent yet. Resolves true when sent (or already sent today). Never throws. */
export const sayDailyHelloIfDue = async (options: DailyHelloOptions): Promise<boolean> => {
  try {
    activeStore = options.store;
    if (!saved) saved = parse(await options.store.read());
    await persist();
    const day = (options.today ?? localDay)();
    const state: HelloState = saved;
    if (state.day === day) return true;
    const client = clientIdentityHeaders();
    // No identity set (a dev build): nothing to count it under.
    if (!client[SPACE_CLIENT_HEADER]) return false;
    const base = (typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl).replace(/\/+$/u, "");
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const sent = { plays: state.plays, screens: state.screens };
    const response = await doFetch(`${base}/usage/hello`, {
      method: "POST",
      headers: { ...client, "Content-Type": "application/json" },
      body: JSON.stringify(sent),
    });
    if (!response.ok) return false;
    const current: HelloState = saved ?? state;
    saved = { day, plays: Math.max(0, current.plays - sent.plays), screens: Math.max(0, current.screens - sent.screens) };
    await persist();
    return true;
  } catch {
    return false;
  }
};

/**
 * Starts the daily hello: a first try after `delayMs`, then a check every `checkEveryMs` (1 h). Returns a stop
 * function. Call once at app start, after the app's identity (`setClientIdentity`) is set.
 */
export const startDailyHello = (options: DailyHelloOptions): (() => void) => {
  const run = () => void sayDailyHelloIfDue(options);
  const first = setTimeout(run, options.delayMs ?? 5_000);
  const every = setInterval(run, options.checkEveryMs ?? 60 * 60 * 1000);
  (every as { unref?: () => void }).unref?.();
  (first as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
};

/** Test-only: forget the loaded state and the store. */
export const __resetDailyHelloForTests = () => {
  unsaved.plays = 0;
  unsaved.screens = 0;
  saved = null;
  activeStore = null;
  writing = Promise.resolve();
};
