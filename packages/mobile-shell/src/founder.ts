/**
 * Founder status on the phone and TV shells (WAIT-FOUND-01, WAIT-FOUND-04), shared by Badger and Parrot.
 *
 * The watch asks `GET /account/founder` when the app starts or signs in, and again when it comes back to the foreground
 * (at most once per `FOUNDER_REFRESH_THROTTLE_MS`). The first answer with `noticePending` hands the one-time "Founder
 * ticket recognised" notice to the shell once (`onNotice`); the shell shows it in its notice queue (UX-NOTICE-01) and,
 * however it leaves (timer, tap, close, Back), calls `noticeSeen`, which tells the API (`POST /account/founder/
 * notice-seen`) so no device shows it again. A failed POST is retried on the next refresh rather than showing the notice
 * twice. Settings reads `useFounderStatus` for the "Founder 🎫 · since …" badge.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { getFounderStatus, markFounderNoticeSeen } from "@space/shared/api";
import { founderCopy, founderSinceText, type FounderStatusResponse } from "@space/shared/founder";
import { scopeLogger } from "./logger";

/** A foreground return asks again at most this often; a start or a sign-in always asks. */
export const FOUNDER_REFRESH_THROTTLE_MS = 5 * 60_000;

export type FounderWatchOptions = {
  fetchStatus: (token: string) => Promise<FounderStatusResponse>;
  markSeen: (token: string) => Promise<unknown>;
  throttleMs?: number;
  now?: () => number;
  log?: (event: string, payload: Record<string, unknown>) => void;
};

export type FounderWatch = {
  /** The last answer for the signed-in account, null before the first one (or after sign-out). */
  get: () => FounderStatusResponse | null;
  subscribe: (listener: () => void) => () => void;
  /** Asks the API; `force` skips the throttle (start, sign-in). A different token starts over (another account). */
  refresh: (token: string, options?: { force?: boolean }) => Promise<void>;
  /**
   * Called once per account and app run when the API says the notice is pending. A shell that starts listening while
   * the notice is still due (it was announced before any shell listened, or to a shell that went away before it was
   * dismissed) is handed it at once.
   */
  onNotice: (listener: () => void) => () => void;
  /** The notice left the screen: marks it seen on the API (retried on the next refresh when that fails). */
  noticeSeen: (token: string) => Promise<void>;
  /** Signed out: forgets the account's status. */
  reset: () => void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createFounderWatch = ({
  fetchStatus,
  markSeen,
  throttleMs = FOUNDER_REFRESH_THROTTLE_MS,
  now = Date.now,
  log,
}: FounderWatchOptions): FounderWatch => {
  let token: string | null = null;
  let status: FounderStatusResponse | null = null;
  let lastFetchAt: number | null = null;
  let inFlight: Promise<void> | null = null;
  /** The notice was handed to a listening shell for this account: refreshes never hand it again this run. */
  let announced = false;
  /** The notice left the screen but the API has not acknowledged it yet. */
  let seenUnsent = false;
  const listeners = new Set<() => void>();
  const noticeListeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const startOver = (next: string | null) => {
    token = next;
    status = null;
    lastFetchAt = null;
    inFlight = null;
    announced = false;
    seenUnsent = false;
  };

  const sendSeen = async (forToken: string) => {
    try {
      await markSeen(forToken);
      if (token === forToken) seenUnsent = false;
      log?.("founder.seen.sent", {});
    } catch (error) {
      log?.("founder.seen.failed", { error: errorText(error) });
    }
  };

  const refresh = (next: string, { force = false }: { force?: boolean } = {}): Promise<void> => {
    if (next !== token) {
      log?.("founder.account", { had: token !== null });
      startOver(next);
      notify();
    }
    if (inFlight) return inFlight;
    const at = now();
    if (!force && lastFetchAt !== null && at - lastFetchAt < throttleMs) {
      log?.("founder.refresh.throttled", { sinceMs: at - lastFetchAt });
      return Promise.resolve();
    }
    lastFetchAt = at;
    const forToken = next;
    const run = (async () => {
      try {
        const answer = await fetchStatus(forToken);
        if (token !== forToken) return;
        log?.("founder.status", { founder: answer.founder, since: answer.since, noticePending: answer.noticePending, announced, seenUnsent });
        if (answer.noticePending && seenUnsent) {
          status = { ...answer, noticePending: false };
          notify();
          await sendSeen(forToken);
          return;
        }
        const announce = answer.noticePending && !announced && noticeListeners.size > 0;
        if (announce) announced = true;
        status = answer;
        notify();
        if (announce) for (const listener of noticeListeners) listener();
      } catch (error) {
        log?.("founder.status.failed", { error: errorText(error) });
      } finally {
        if (token === forToken) inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  };

  return {
    get: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    onNotice: (listener) => {
      noticeListeners.add(listener);
      // Still due (not dismissed on any shell, not marked seen): this shell shows it; the queues drop a duplicate.
      if (status?.noticePending && !seenUnsent) {
        log?.("founder.notice.handover", {});
        announced = true;
        listener();
      }
      return () => noticeListeners.delete(listener);
    },
    noticeSeen: async (forToken) => {
      if (forToken !== token) return;
      seenUnsent = true;
      if (status?.noticePending) {
        status = { ...status, noticePending: false };
        notify();
      }
      await sendSeen(forToken);
    },
    reset: () => {
      if (token === null) return;
      log?.("founder.reset", {});
      startOver(null);
      notify();
    },
  };
};

const founderLog = scopeLogger("founder");

/** The app's one watch: Badger and Parrot each run one, against the API their `@space/shared/api` points at. */
export const founderWatch = createFounderWatch({
  fetchStatus: (token) => getFounderStatus(token),
  markSeen: (token) => markFounderNoticeSeen(token),
  log: (event, payload) => founderLog.warn(event, payload),
});

/**
 * Keeps the watch current for the signed-in shell: asks at once for `token`, again on each return to the foreground
 * (throttled), forgets on sign-out, and calls the latest `onNotice` when the notice is due.
 */
export const useFounderWatch = (token: string | null | undefined, onNotice: () => void, watch: FounderWatch = founderWatch) => {
  const latest = useRef(onNotice);
  latest.current = onNotice;
  useEffect(() => watch.onNotice(() => latest.current()), [watch]);
  useEffect(() => {
    if (!token) {
      watch.reset();
      return undefined;
    }
    void watch.refresh(token, { force: true });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void watch.refresh(token);
    });
    return () => subscription.remove();
  }, [token, watch]);
};

/** The signed-in account's founder status (null until known), for the Settings badge. */
export const useFounderStatus = (watch: FounderWatch = founderWatch): FounderStatusResponse | null =>
  useSyncExternalStore(watch.subscribe, watch.get, watch.get);

/** "Founder 🎫 · since the waitlist, 3 March 2026" in `language`; without a date, "Founder 🎫". */
export const founderBadgeText = (language: string | null | undefined, since: string | null): string => {
  const label = `${founderCopy(language).badge} 🎫`;
  const detail = founderSinceText(language, since);
  return detail ? `${label} · ${detail}` : label;
};

/** The notice's lines in `language`: "🎫 **{bannerTitle}** {bannerBody}" and the close control's label. */
export const founderNoticeText = (language: string | null | undefined) => {
  const copy = founderCopy(language);
  return { title: `🎫 ${copy.bannerTitle}`, body: copy.bannerBody, dismiss: copy.bannerDismiss };
};
