import de from "./renderError/de.json";
import en from "./renderError/en.json";
import es from "./renderError/es.json";
import fr from "./renderError/fr.json";
import nl from "./renderError/nl.json";

/**
 * The words of the render-crash guards (UX-CRASH-01), one copy for every app: the web UI package's `RenderBoundary`
 * (desktop and browser apps) and the phone shell's (React Native) both read them from here, from the translation files
 * next to this module (UX-I18N-02), in the five client languages.
 */
export type RenderErrorCopy = {
  message: string;
  detail: string;
  /** The whole-window crash screen's line under `message`, with `{{app}}` for the app's name (`renderErrorWindowDetail`). */
  windowDetail: string;
  /** The one button of a crash notice, "Try again": retries, then reloads by itself if the retry fails again. */
  retry: string;
  /** Shown by the window guard after a crash closed a pop-up. */
  popupClosed: string;
  dismiss: string;
  /** The placeholder of one list or grid item that crashed. */
  itemFailed: string;
};

export type RenderErrorLanguage = "en" | "fr" | "nl" | "de" | "es";

export const RENDER_ERROR_COPY: Record<RenderErrorLanguage, RenderErrorCopy> = {
  en: en.renderBoundary,
  fr: fr.renderBoundary,
  nl: nl.renderBoundary,
  de: de.renderBoundary,
  es: es.renderBoundary,
};

/** The copy for a language tag (`"de-DE"` reads German); English for anything else. */
export const renderErrorCopyFor = (lang: string | null | undefined): RenderErrorCopy =>
  RENDER_ERROR_COPY[(lang || "en").slice(0, 2).toLowerCase() as RenderErrorLanguage] ?? RENDER_ERROR_COPY.en;

/** "Badger needs to restart this screen.": the whole-window crash screen's line, with the app's name filled in. */
export const renderErrorWindowDetail = (copy: RenderErrorCopy, appName: string): string =>
  copy.windowDetail.replace("{{app}}", appName);

type PopupCrashListener = () => void;
let closedPopup: string | null = null;
const popupCrashListeners = new Set<PopupCrashListener>();
const notifyPopupCrash = () => {
  for (const listener of popupCrashListeners) listener();
};

/**
 * A pop-up (dialog, sheet, menu, phone modal) that crashed is closed by its guard, which posts its name here; each app's
 * window guard (web `RenderBoundary variant="screen"`, phone `MobileRenderBoundary variant="window"`) shows the
 * "closed" notice for it until dismissed. Module state on purpose: the pop-up and whatever rendered it may be gone
 * by the time the notice shows. Shaped for `useSyncExternalStore`.
 */
export const popupCrashNotice = {
  current: (): string | null => closedPopup,
  post(name: string): void {
    closedPopup = name;
    notifyPopupCrash();
  },
  dismiss(): void {
    if (closedPopup === null) return;
    closedPopup = null;
    notifyPopupCrash();
  },
  subscribe(listener: PopupCrashListener): () => void {
    popupCrashListeners.add(listener);
    return () => popupCrashListeners.delete(listener);
  },
};

/**
 * The one button of a crash notice (UX-CRASH-01), "Try again", first retries: the guard mounts its part anew (fresh
 * component state) after the app cleared or refetched the data that part used (`onRetry`). When the same guard throws
 * again within `RETRY_FAILED_WITHIN_MS` of that press, the retry could not work, so the press goes on to reload the
 * window by itself, with no second notice and no extra click. A short-lived marker (`ReloadMarker`) records that
 * reload: a crash after it shows the notice again and the next press only retries, so a crash that survives a reload
 * never loops.
 */
export const RETRY_FAILED_WITHIN_MS = 5_000;
/** How long the marker of an automatic reload holds: within it, a failed retry shows the notice instead of reloading. */
export const RELOAD_MARKER_TTL_MS = 60_000;

/** Where the time of the last automatic reload is kept; it must outlive the reload it records. */
export type ReloadMarker = { read(): number | null; write(at: number): void };

/** A marker in module memory: outlives an in-app reload (the phone apps remount their tree), not a page load. */
export const memoryReloadMarker = (): ReloadMarker => {
  let at: number | null = null;
  return {
    read: () => at,
    write: (next) => {
      at = next;
    },
  };
};

/**
 * A marker in `sessionStorage`, which survives `window.location.reload()` and ends with the window. Falls back to
 * module memory when storage is unavailable (blocked or absent).
 */
export const sessionReloadMarker = (key = "sf:render-boundary:reloaded-at"): ReloadMarker => {
  const memory = memoryReloadMarker();
  const storage = (): Storage | null => {
    try {
      return typeof sessionStorage === "undefined" ? null : sessionStorage;
    } catch {
      return null;
    }
  };
  return {
    read: () => {
      try {
        const store = storage();
        if (!store) return memory.read();
        const raw = store.getItem(key);
        const at = raw == null ? null : Number(raw);
        return at !== null && Number.isFinite(at) ? at : null;
      } catch {
        return memory.read();
      }
    },
    write: (at) => {
      memory.write(at);
      try {
        storage()?.setItem(key, String(at));
      } catch {
        // memory keeps it
      }
    },
  };
};

/**
 * What a guard does when it catches a crash: `show` the notice, or `reload` the window because the crash came right
 * after a press of "Try again" (`retriedAt`) and no automatic reload happened within `RELOAD_MARKER_TTL_MS`. Writes the
 * marker when it answers `reload`.
 */
export const crashAfterRetry = ({ retriedAt, now, marker }: { retriedAt: number | null; now: number; marker: ReloadMarker }): "show" | "reload" => {
  if (retriedAt === null || now - retriedAt > RETRY_FAILED_WITHIN_MS) return "show";
  const reloadedAt = marker.read();
  if (reloadedAt !== null && now - reloadedAt >= 0 && now - reloadedAt < RELOAD_MARKER_TTL_MS) return "show";
  marker.write(now);
  return "reload";
};
