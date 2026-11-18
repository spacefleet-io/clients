/**
 * The system tray and close-to-tray lifecycle shared by the Electron main process of Badger and Parrot desktop
 * (PLAT-DESK-10, RT-LIFE-02, PLAT-DESK-06). One implementation; each app passes its own icon, name and the Electron
 * constructors.
 *
 * Electron is never imported here: the window, tray and IPC are described by the few members this module uses, so
 * the whole lifecycle runs under unit tests without Electron.
 */

export type TrayMenuItem =
  | { label: string; click: () => void }
  | { type: "separator" };

export type TrayActions = {
  onClick: () => void;
  menuItems: Array<TrayMenuItem>;
  tooltip: string;
};

/** The app's own words for the tray, in the language the app shows. */
export type TrayLabels = {
  /** First menu item, which shows the window ("Open Badger", "Open Parrot"). */
  open: string;
  quit: string;
  /** The app's name, shown when the pointer rests on the icon. */
  tooltip: string;
};

/** The tray's click and menu: Open (shows the window), a separator, Quit (the explicit quit). */
export const buildTrayActions = (deps: {
  showMainWindow: () => void;
  requestQuit: () => void;
  labels: TrayLabels;
}): TrayActions => ({
  onClick: () => deps.showMainWindow(),
  menuItems: [
    { label: deps.labels.open, click: () => deps.showMainWindow() },
    { type: "separator" },
    { label: deps.labels.quit, click: () => deps.requestQuit() },
  ],
  tooltip: deps.labels.tooltip,
});

/**
 * What closing the window does. Unless the app is quitting on purpose the app goes to the background ("background")
 * even with no tray (RT-LIFE-02: a desktop without a tray reopens the window with a second launch). While quitting,
 * "warn" asks first when work is in progress (the app's `before-quit` shows the dialog), "quit" lets it close.
 */
export const decideWindowCloseAction = ({
  isQuitting,
  hasActiveProcessing,
}: {
  isQuitting: boolean;
  hasTray: boolean;
  hasActiveProcessing: boolean;
}): "background" | "quit" | "warn" => {
  if (isQuitting) return hasActiveProcessing ? "warn" : "quit";
  return "background";
};

/** Every window closed: the app quits only when it is already quitting and the OS quits apps with no window. */
export const shouldQuitWhenAllWindowsClosed = ({
  isQuitting,
  quitWhenAllWindowsClosed,
}: {
  isQuitting: boolean;
  quitWhenAllWindowsClosed: boolean;
}): boolean => isQuitting && quitWhenAllWindowsClosed;

/**
 * The tray icon file: the app's colour icon (Linux, Windows), or the monochrome menu-bar template image (macOS,
 * PLAT-DESK-06; the "Template" file name makes macOS tint it and load the @2x file next to it). Returns undefined when
 * the file is missing, and then the app runs without a tray.
 */
export const resolveTrayIconPath = ({
  trayIcon,
  appIconPath,
  templateCandidates,
  exists,
}: {
  trayIcon: "color" | "template";
  appIconPath: string | undefined;
  /** Where `trayTemplate.png` may be: the packaged resources folder first, then the source tree. */
  templateCandidates: readonly string[];
  exists: (path: string) => boolean;
}): string | undefined => {
  if (trayIcon === "color") return appIconPath;
  return templateCandidates.find((candidate) => exists(candidate));
};

/** The part of Electron's `Tray` this module uses. */
export type TrayHandle = {
  setToolTip: (tooltip: string) => void;
  setContextMenu: (menu: never) => void;
  on: (event: "click", listener: () => void) => unknown;
  destroy: () => void;
};

export type AppTray = {
  /** Creates the tray once (later calls do nothing). No icon or no tray support: the app runs without one. */
  create: (iconPath: string | undefined) => void;
  /** Rebuilds the labels, for example after the app's language changed. */
  refresh: () => void;
  destroy: () => void;
  readonly active: boolean;
  readonly actions: TrayActions | null;
};

export const createAppTray = <Menu>(deps: {
  createTray: (iconPath: string) => TrayHandle;
  buildMenu: (items: Array<TrayMenuItem>) => Menu;
  buildActions: () => TrayActions;
  onUnavailable?: (error: unknown) => void;
}): AppTray => {
  let tray: TrayHandle | null = null;
  let actions: TrayActions | null = null;
  const applyMenu = () => {
    if (!tray || !actions) return;
    tray.setContextMenu(deps.buildMenu(actions.menuItems) as never);
  };
  return {
    create: (iconPath) => {
      if (tray || !iconPath) return;
      try {
        tray = deps.createTray(iconPath);
        actions = deps.buildActions();
        tray.setToolTip(actions.tooltip);
        applyMenu();
        tray.on("click", () => actions?.onClick());
      } catch (error) {
        deps.onUnavailable?.(error);
        tray = null;
        actions = null;
      }
    },
    refresh: () => {
      if (!tray) return;
      actions = deps.buildActions();
      tray.setToolTip(actions.tooltip);
      applyMenu();
    },
    destroy: () => {
      tray?.destroy();
      tray = null;
      actions = null;
    },
    get active() {
      return tray !== null;
    },
    get actions() {
      return actions;
    },
  };
};

/** The part of Electron's `BrowserWindow` this module uses. */
export type ShellWindow = {
  on(event: "close", listener: (event: { preventDefault: () => void }) => void): unknown;
  on(event: "closed", listener: () => void): unknown;
  show: () => void;
  hide: () => void;
  destroy: () => void;
  focus: () => void;
  restore: () => void;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isMinimized: () => boolean;
  setSkipTaskbar: (skip: boolean) => void;
};

/** Brings a hidden, minimized or background window to the front, back in the taskbar. */
export const revealWindow = (win: ShellWindow): void => {
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.setSkipTaskbar(false);
  win.focus();
};

/**
 * Closing the window sends the app to the background instead of quitting it (RT-LIFE-02).
 * - `background: "destroy"` (Badger, whose player is mpv, outside the window): the window hides at once, then is
 *   destroyed once `beforeDestroy` settles (the renderer flushes its caches), which frees the renderer's memory. A
 *   window shown again meanwhile (tray click, second launch) is kept.
 * - `background: "hide"` (Parrot, whose player plays inside the window): the window only hides, so the music keeps
 *   playing; showing it again is instant.
 * While the app quits on purpose the close goes through (the app's `before-quit` handles the processing warning).
 */
export const attachCloseToTray = (
  win: ShellWindow,
  options: {
    background: "destroy" | "hide";
    isQuitting: () => boolean;
    hasTray: () => boolean;
    hasActiveProcessing?: () => boolean;
    beforeDestroy?: () => Promise<unknown>;
    /** Called with `beforeDestroy`'s outcome when the window was shown again before it was destroyed. */
    onDestroyCancelled?: (outcome: unknown) => void;
    onBackground?: (mode: "destroy" | "hide") => void;
  },
): void => {
  let destroying = false;
  win.on("close", (event) => {
    if (destroying) {
      destroying = false;
      return;
    }
    const action = decideWindowCloseAction({
      isQuitting: options.isQuitting(),
      hasTray: options.hasTray(),
      hasActiveProcessing: options.hasActiveProcessing?.() ?? false,
    });
    if (action !== "background") return;
    event.preventDefault();
    try {
      win.setSkipTaskbar(true);
    } catch {
      // Not every OS lets an app leave the taskbar; hiding is enough there.
    }
    win.hide();
    options.onBackground?.(options.background);
    if (options.background === "hide") return;
    destroying = true;
    void (options.beforeDestroy?.() ?? Promise.resolve(null)).then((outcome) => {
      if (win.isDestroyed()) return;
      if (win.isVisible()) {
        destroying = false;
        options.onDestroyCancelled?.(outcome);
        return;
      }
      win.destroy();
    });
  });
  win.on("closed", () => {
    destroying = false;
  });
};

export const TRAY_TEST_CHANNELS = {
  state: "sf-test-tray-state",
  click: "sf-test-tray-click",
  contextClick: "sf-test-tray-context-click",
} as const;

/** The part of Electron's `ipcMain` the test hooks use. */
export type TrayTestIpc = {
  handle: (channel: string, listener: (event: unknown, payload: { label: string }) => unknown) => void;
};

/**
 * E2E hooks (registered only when SF_E2E=1): read the tray's state and press its icon or a menu item, which the OS
 * tray does not let a test reach.
 */
export const registerTrayTestIpc = (ipc: TrayTestIpc, tray: AppTray): void => {
  const labelled = (item: TrayMenuItem): item is { label: string; click: () => void } => "label" in item;
  ipc.handle(TRAY_TEST_CHANNELS.state, () => ({
    visible: tray.active,
    tooltip: tray.actions?.tooltip ?? null,
    contextMenuLabels: tray.actions ? tray.actions.menuItems.filter(labelled).map((item) => item.label) : [],
  }));
  ipc.handle(TRAY_TEST_CHANNELS.click, () => {
    tray.actions?.onClick();
    return { ok: true };
  });
  ipc.handle(TRAY_TEST_CHANNELS.contextClick, (_event, payload) => {
    const item = tray.actions?.menuItems.filter(labelled).find((entry) => entry.label === payload.label);
    if (!item) return { ok: true, matched: false };
    item.click();
    return { ok: true, matched: true };
  });
};
