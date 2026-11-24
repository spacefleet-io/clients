// META-SKIP-05/06: the app's intro and credits reports (a "Yes" on a skipped intro, or changed times), kept in a local
// queue and sent hours later in one batch, each report a separate lookup with its own ticket. Nothing about the user,
// the file or the device travels: the show's id, the season and episode, the file's length, the kind, the times and
// the verdict. Portable like the rest of the package (no node:* import, no DOM).

import type { MetadataClient } from "./client";
import { MetadataRequestError } from "./client";
import { defaultRandom, defaultTimers, type KeyValueStorage, type RandomFn, type Timers } from "./types";

export type SkipContributionKind = "intro" | "credits";

/** `confirmed`: the user said the skipped times were right. `changed`: the user saved times of their own. */
export type SkipContributionVerdict = "confirmed" | "changed";

/** One report. `id` is the same show id the app passes to `skipMarkers`; times and length are in milliseconds. */
export type SkipContribution = {
  id: number;
  season: number;
  episode: number;
  durationMs: number;
  kind: SkipContributionKind;
  startMs: number;
  endMs: number;
  verdict: SkipContributionVerdict;
};

/** Where the queue lives in the app's storage. */
export const SKIP_CONTRIBUTION_STORAGE_KEY = "space.metadata.skip-contributions.v1";

/**
 * The batch goes out a random 2 to 8 hours after the first report waiting in it, so the time a report reaches the
 * service says nothing about when the episode was watched (META-SKIP-06).
 */
export const SKIP_CONTRIBUTION_DELAY_MS = { min: 2 * 3_600_000, max: 8 * 3_600_000 } as const;

/** A batch that came due while the app was closed waits a random 1 to 10 minutes after the queue is started again. */
export const SKIP_CONTRIBUTION_OVERDUE_DELAY_MS = { min: 60_000, max: 600_000 } as const;

/** Most reports kept waiting; the oldest goes first past it. */
export const SKIP_CONTRIBUTION_MAX_QUEUED = 200;

type Stored = { sendAt: number | null; items: SkipContribution[] };

export interface SkipContributionQueueDeps {
  client: Pick<MetadataClient, "lookup">;
  storage: KeyValueStorage;
  timers?: Timers;
  random?: RandomFn;
  now?: () => number;
}

export interface SkipContributionQueue {
  /** Adds a report; a report for the same episode and kind replaces the one waiting. Never throws. */
  queue(contribution: SkipContribution): Promise<void>;
  /** Arms the timer from the stored send time (call once the app has tickets). */
  start(): Promise<void>;
  /** Stops the timer; the queue stays stored. */
  stop(): void;
  /** Stops the timer and forgets every waiting report (sign-out). */
  clear(): Promise<void>;
  /** Sends the waiting reports now. Resolves the count sent. */
  sendNow(): Promise<number>;
}

const sameSlot = (a: SkipContribution, b: SkipContribution) =>
  a.id === b.id && a.season === b.season && a.episode === b.episode && a.kind === b.kind;

const draw = (random: RandomFn, bounds: { min: number; max: number }) => Math.round(bounds.min + random() * (bounds.max - bounds.min));

const isContribution = (value: unknown): value is SkipContribution => {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    ["id", "season", "episode", "durationMs", "startMs", "endMs"].every((key) => Number.isInteger(c[key])) &&
    (c.kind === "intro" || c.kind === "credits") &&
    (c.verdict === "confirmed" || c.verdict === "changed")
  );
};

/** Only the report's own fields: whatever else a caller passes never reaches storage or the service. */
const pick = (c: SkipContribution): SkipContribution => ({
  id: c.id,
  season: c.season,
  episode: c.episode,
  durationMs: Math.round(c.durationMs),
  kind: c.kind,
  startMs: Math.round(c.startMs),
  endMs: Math.round(c.endMs),
  verdict: c.verdict,
});

export const createSkipContributionQueue = (deps: SkipContributionQueueDeps): SkipContributionQueue => {
  const timers = deps.timers ?? defaultTimers;
  const random = deps.random ?? defaultRandom;
  const now = deps.now ?? (() => Date.now());
  let handle: unknown = null;
  let running = false;
  let sending: Promise<number> | null = null;
  // Every read-modify-write of the stored queue runs one after the other.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const read = async (): Promise<Stored> => {
    try {
      const raw = await deps.storage.get(SKIP_CONTRIBUTION_STORAGE_KEY);
      if (!raw) return { sendAt: null, items: [] };
      const parsed = JSON.parse(raw) as { sendAt?: unknown; items?: unknown };
      const items = Array.isArray(parsed.items) ? parsed.items.filter(isContribution).map(pick) : [];
      const sendAt = typeof parsed.sendAt === "number" && Number.isFinite(parsed.sendAt) ? parsed.sendAt : null;
      return { sendAt: items.length > 0 ? sendAt : null, items };
    } catch {
      return { sendAt: null, items: [] };
    }
  };

  const write = async (stored: Stored) => {
    if (stored.items.length === 0) await deps.storage.remove(SKIP_CONTRIBUTION_STORAGE_KEY);
    else await deps.storage.set(SKIP_CONTRIBUTION_STORAGE_KEY, JSON.stringify(stored));
  };

  const disarm = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };

  const arm = (sendAt: number | null) => {
    disarm();
    if (!running || sendAt === null) return;
    const wait = sendAt - now();
    handle = timers.setTimeout(
      () => {
        handle = null;
        void sendNow();
      },
      wait > 0 ? wait : draw(random, SKIP_CONTRIBUTION_OVERDUE_DELAY_MS)
    );
  };

  /** One pass over the queue: sent and refused reports leave it; the first failure that may pass keeps the rest. */
  const sendBatch = async (): Promise<number> => {
    const { items } = await serial(read);
    const done: SkipContribution[] = [];
    let sent = 0;
    for (const item of items) {
      try {
        await deps.client.lookup({ op: "skipContribution", ...item });
        sent += 1;
        done.push(item);
      } catch (error) {
        // 400 (a report the service will never take) or 501 (reports switched off): drop it, never retry it.
        if (error instanceof MetadataRequestError && (error.status === 400 || error.status === 501)) {
          done.push(item);
          continue;
        }
        // No ticket, rate limited, service or network down: the rest waits for the next window.
        break;
      }
    }
    await serial(async () => {
      const stored = await read();
      // Reports queued while the batch was out stay, unless one of them was exactly what just went out.
      const left = stored.items.filter((item) => !done.some((d) => JSON.stringify(d) === JSON.stringify(item)));
      const sendAt = left.length > 0 ? now() + draw(random, SKIP_CONTRIBUTION_DELAY_MS) : null;
      await write({ sendAt, items: left });
      arm(sendAt);
    });
    return sent;
  };

  const sendNow = (): Promise<number> => {
    disarm();
    sending ??= sendBatch()
      .catch(() => 0)
      .finally(() => {
        sending = null;
      });
    return sending;
  };

  return {
    queue: (contribution) =>
      serial(async () => {
        if (!isContribution(contribution)) return;
        const stored = await read();
        const items = [...stored.items.filter((item) => !sameSlot(item, contribution)), pick(contribution)].slice(
          -SKIP_CONTRIBUTION_MAX_QUEUED
        );
        const sendAt = stored.sendAt ?? now() + draw(random, SKIP_CONTRIBUTION_DELAY_MS);
        await write({ sendAt, items });
        if (stored.sendAt === null) arm(sendAt);
      }).catch(() => undefined),
    start: async () => {
      running = true;
      const stored = await serial(read);
      if (handle === null && sending === null) arm(stored.sendAt);
    },
    stop: () => {
      running = false;
      disarm();
    },
    clear: async () => {
      running = false;
      disarm();
      await serial(() => deps.storage.remove(SKIP_CONTRIBUTION_STORAGE_KEY)).catch(() => undefined);
    },
    sendNow,
  };
};

let installed: SkipContributionQueue | null = null;
/** Reports made before a queue is installed (the app still signing in), handed to it on install. */
let early: SkipContribution[] = [];

/** Makes `queue` the one `queueSkipContribution` feeds, and starts it. The previous one is stopped. */
export const installSkipContributionQueue = (queue: SkipContributionQueue): void => {
  installed?.stop();
  installed = queue;
  const waiting = early;
  early = [];
  void (async () => {
    for (const contribution of waiting) await queue.queue(contribution);
    await queue.start();
  })().catch(() => undefined);
};

/** Stops and forgets the installed queue, and with `clear` every report waiting in it (sign-out). */
export const uninstallSkipContributionQueue = async (options: { clear?: boolean } = {}): Promise<void> => {
  const queue = installed;
  installed = null;
  early = [];
  if (!queue) return;
  if (options.clear) await queue.clear();
  else queue.stop();
};

/**
 * META-SKIP-05: the one call the player makes when the user confirms a skip or saves changed times. It returns at
 * once and never throws: the report waits in the queue and goes out hours later (META-SKIP-06).
 */
export const queueSkipContribution = (contribution: SkipContribution): void => {
  if (installed) {
    void installed.queue(contribution);
    return;
  }
  if (isContribution(contribution)) early = [...early.filter((item) => !sameSlot(item, contribution)), pick(contribution)].slice(-SKIP_CONTRIBUTION_MAX_QUEUED);
};
