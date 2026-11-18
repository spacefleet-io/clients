import type { BrowserWindow, IpcMain, WebContents } from "electron";
import { scopeLogger } from "./logger";

// Issue #25 P19/M7: the main window runs with `backgroundThrottling: false`
// (playback IPC, job SSE and the OSC-action listener must keep running while
// external mpv plays), so `win.hide()` neither throttles the renderer nor flips
// `document.visibilityState`. Main is the only process that knows the window
// is hidden, so it pushes that fact to the renderer: the renderer then skips
// UI-only state churn and the e2e perf probe marks hidden spans from it.

export const APP_WINDOW_VISIBILITY_CHANNEL = "sf-app-window-visibility";
export const APP_WINDOW_VISIBILITY_GET_CHANNEL = "sf-app-window-visibility-get";

/** `atMs` is epoch ms (Date.now) in main, comparable with the renderer's clock. */
export type AppWindowVisibility = { hidden: boolean; atMs: number; reason: string };

const logger = scopeLogger("app-window-visibility");

const lastByWebContents = new WeakMap<WebContents, AppWindowVisibility>();

type AppWindowVisibilityListener = (win: BrowserWindow, next: AppWindowVisibility) => void;
const listeners = new Set<AppWindowVisibilityListener>();

/**
 * Issue #25 P1: main-side consumers (the library snapshot pusher) hold
 * UI-only pushes while the window is hidden and flush on show. Returns the
 * unsubscribe.
 */
export const onAppWindowVisibilityChange = (listener: AppWindowVisibilityListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The last flag main pushed for this window; false when never marked. */
export const isAppWindowMarkedHidden = (win: BrowserWindow): boolean =>
  lastByWebContents.get(win.webContents)?.hidden === true;

/**
 * Record and push the window's hidden flag. Deduped per window: the explicit
 * external-mpv hide/show calls and the BrowserWindow hide/show events both
 * land here, and only an actual flip is logged and sent.
 */
export const markAppWindowVisibility = (
  win: BrowserWindow | null | undefined,
  hidden: boolean,
  reason: string,
  now: () => number = Date.now,
): AppWindowVisibility | null => {
  if (!win || win.isDestroyed()) return null;
  const webContents = win.webContents;
  if (!webContents || webContents.isDestroyed()) return null;
  const previous = lastByWebContents.get(webContents);
  if (previous && previous.hidden === hidden) return null;
  const next: AppWindowVisibility = { hidden, atMs: now(), reason };
  lastByWebContents.set(webContents, next);
  logger.info(
    { hidden, reason, atMs: next.atMs, previousAtMs: previous?.atMs ?? null },
    hidden ? "app window hidden; renderer told to skip UI churn" : "app window visible; renderer resumes UI updates",
  );
  webContents.send(APP_WINDOW_VISIBILITY_CHANNEL, next);
  for (const listener of listeners) {
    try {
      listener(win, next);
    } catch (error) {
      logger.warn({ hidden, reason, error: error instanceof Error ? error.message : String(error) }, "visibility listener threw");
    }
  }
  return next;
};

/**
 * Keep the flag in sync with every hide/show path (tray, close-to-tray, mpv
 * handoff) and with minimize/restore: a minimized window is just as unseen,
 * and with `backgroundThrottling: false` Chromium keeps its CSS animations and
 * UI-only re-renders running unless main says so (#928, low-end idle CPU).
 */
export const trackAppWindowVisibility = (win: BrowserWindow): void => {
  win.on("hide", () => markAppWindowVisibility(win, true, "window-hide-event"));
  // `show` on a still-minimized window (a hidden-then-minimized window brought back by the tray) stays unseen until restore.
  win.on("show", () => markAppWindowVisibility(win, win.isMinimized(), "window-show-event"));
  win.on("minimize", () => markAppWindowVisibility(win, true, "window-minimize-event"));
  win.on("restore", () => markAppWindowVisibility(win, !win.isVisible(), "window-restore-event"));
};

/** A renderer that (re)loads while hidden pulls the current state once. */
export const registerAppWindowVisibilityIpc = (ipc: IpcMain): void => {
  ipc.handle(APP_WINDOW_VISIBILITY_GET_CHANNEL, (event): AppWindowVisibility | null =>
    lastByWebContents.get(event.sender) ?? null,
  );
};
