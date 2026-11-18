/**
 * The founder notice and badge every signed-in client shows (WAIT-FOUND-01, WAIT-FOUND-04): web, Badger and Parrot on
 * desktop. `useFounderStatus` reads `GET /account/founder` through the app's own route to the API (the web's fetch,
 * Badger's renderer client, Parrot's main process) at start, after a sign-in (a new source) and when the window comes
 * back (throttled); `FounderBanner` shows the one-time "Founder ticket recognised" line while `noticePending`, and its
 * dismiss marks the notice seen on the server, so it never shows again on any device. `FounderBadge` is the account
 * settings line "Founder 🎫 · since the waitlist, {date}". All copy comes from `@space/shared/founder`.
 *
 * WAIT-FOUND-03: nothing founder-related shows before the email is verified; the API answers `founder: false` until then.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { founderCopy, founderSinceText, type FounderStatusResponse } from "@space/shared/founder";

/** The app's way to the two founder routes. `getStatus` throws (or answers null) when the server did not answer. */
export type FounderStatusSource = {
  /** One per signed-in session (the session token, or the account id where the token stays out of the window). */
  key: string;
  getStatus: () => Promise<FounderStatusResponse | null>;
  markSeen: () => Promise<void>;
};

/** The status is read again (at mount or when the window comes back) at most this often. */
export const FOUNDER_REFOCUS_MS = 60_000;

export type FounderStatusState = {
  /** Null until the first answer (or when there is no source). */
  status: FounderStatusResponse | null;
  /** Hides the banner at once and marks the notice seen on the server. */
  dismiss: () => void;
};

const log = (message: string, data?: Record<string, unknown>) => console.info(`[founder] ${message}`, JSON.stringify(data ?? {}));

/**
 * One entry per session, shared by every component that reads it (the banner, the settings badge) and kept across
 * remounts (a top bar mounted on each page), so a page change neither reads again nor brings back a dismissed banner.
 */
type Entry = {
  status: FounderStatusResponse | null;
  /** A dismiss wins over a read still in flight, and over a later read if the seen-mark did not reach the server. */
  dismissed: boolean;
  readAt: number;
  reading: boolean;
  listeners: Set<() => void>;
};
const entries = new Map<string, Entry>();

const entryFor = (key: string): Entry => {
  let entry = entries.get(key);
  if (!entry) {
    entry = { status: null, dismissed: false, readAt: 0, reading: false, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
};

const publish = (entry: Entry, status: FounderStatusResponse | null) => {
  entry.status = status && entry.dismissed ? { ...status, noticePending: false } : status;
  for (const listener of entry.listeners) listener();
};

const readStatus = async (source: FounderStatusSource, reason: string, refocusMs: number) => {
  const entry = entryFor(source.key);
  if (entry.reading || Date.now() - entry.readAt < refocusMs) return;
  entry.reading = true;
  entry.readAt = Date.now();
  try {
    const next = await source.getStatus();
    log("status read", { reason, founder: next?.founder ?? null, noticePending: next?.noticePending ?? null, since: next?.since ?? null });
    if (next) publish(entry, next);
  } catch (error) {
    log("status unavailable", { reason, error: error instanceof Error ? error.message : String(error) });
  } finally {
    entry.reading = false;
  }
};

/** Test helper: forgets every session's status. */
export const resetFounderStatusCache = () => entries.clear();

/**
 * Reads the status at mount, after a sign-in (a new `source.key`) and when the window comes back, at most once per
 * `refocusMs` for a session. Keep `source` stable (memoise it on the session).
 */
export function useFounderStatus(source: FounderStatusSource | null, refocusMs = FOUNDER_REFOCUS_MS): FounderStatusState {
  const key = source?.key ?? null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (key === null) return () => {};
      const entry = entryFor(key);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [key],
  );
  const snapshot = useCallback(() => (key === null ? null : entryFor(key).status), [key]);
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (!source) return;
    void readStatus(source, "start", refocusMs);
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      void readStatus(source, "focus", refocusMs);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [source, refocusMs]);

  const dismiss = useCallback(() => {
    if (!source) return;
    const entry = entryFor(source.key);
    entry.dismissed = true;
    publish(entry, entry.status);
    log("notice dismissed");
    source.markSeen().then(
      () => log("notice marked seen"),
      (error: unknown) => log("notice seen-mark failed", { error: error instanceof Error ? error.message : String(error) }),
    );
  }, [source]);

  return { status, dismiss };
}

type BannerProps = {
  /** The app's UI language. */
  language: string | null | undefined;
  status: FounderStatusResponse | null;
  onDismiss: () => void;
  className?: string;
};

/** The one-time "🎫 Founder ticket recognised." line; renders nothing unless the notice is pending. */
export function FounderBanner({ language, status, onDismiss, className }: BannerProps) {
  if (!status?.noticePending) return null;
  const copy = founderCopy(language);
  return (
    <div
      role="status"
      data-testid="founder-banner"
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-primary bg-primary/12 px-3.5 py-2.5 text-sm text-foreground ${className ?? ""}`}
    >
      <p className="min-w-0 flex-1">
        <span aria-hidden="true">🎫</span> <strong className="font-semibold">{copy.bannerTitle}</strong> {copy.bannerBody}
      </p>
      <button
        type="button"
        data-testid="founder-banner-dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded-md border border-primary/60 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
      >
        {copy.bannerDismiss}
      </button>
    </div>
  );
}

type BadgeProps = {
  language: string | null | undefined;
  status: FounderStatusResponse | null;
  /** `stacked` puts the date on its own line, for a narrow column (the web account menu). */
  layout?: "inline" | "stacked";
  className?: string;
};

/** "Founder 🎫 · since the waitlist, {date}" in account settings; renders nothing unless the account is a founder. */
export function FounderBadge({ language, status, layout = "inline", className }: BadgeProps) {
  if (!status?.founder) return null;
  const since = founderSinceText(language, status.since);
  const label = (
    <>
      <strong className="font-semibold text-primary">{founderCopy(language).badge}</strong> <span aria-hidden="true">🎫</span>
    </>
  );
  if (layout === "stacked") {
    return (
      <span data-testid="founder-badge" className={`block text-sm text-foreground ${className ?? ""}`}>
        <span className="block">{label}</span>
        {since ? <span className="block text-muted-foreground">{since}</span> : null}
      </span>
    );
  }
  return (
    <span data-testid="founder-badge" className={`inline-flex flex-wrap items-baseline gap-x-1 text-sm text-foreground ${className ?? ""}`}>
      <span>{label}</span>
      {since ? <span className="text-muted-foreground">· {since}</span> : null}
    </span>
  );
}
