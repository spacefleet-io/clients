/**
 * The application menu Badger and Parrot desktop share (PLAT-DESK-11, PLAT-DESK-06), and the words the main process
 * draws for it and the tray in the five app languages (UX-I18N-01).
 *
 * - Linux and Windows: no menu bar, in dev builds too. Copy, paste, cut, select-all and undo in text fields still
 *   work: Chromium handles those keys itself there.
 * - macOS (`shell.applicationMenu`): the minimal menu bar, the app menu (About, Hide, Cmd+Q "Quit <app>" through the
 *   app's explicit quit, so `before-quit` can warn), Edit (on macOS copy / paste only work through its items) and
 *   Window. Role-only items are translated by macOS itself.
 * - Dev builds only: Ctrl/Cmd+R and F5 reload, Ctrl/Cmd+Shift+I and F12 open the developer tools, which the removed
 *   menu used to provide.
 *
 * Electron is not imported: the template is plain data and the few calls are described structurally.
 */
import type { ClientUiLanguage } from "@space/shared";

export type MainShellStrings = {
  trayOpen: (appName: string) => string;
  trayQuit: string;
  menuAbout: (appName: string) => string;
  menuHide: (appName: string) => string;
  menuQuit: (appName: string) => string;
};

export const MAIN_SHELL_STRINGS: Record<ClientUiLanguage, MainShellStrings> = {
  en: {
    trayOpen: (appName) => `Open ${appName}`,
    trayQuit: "Quit",
    menuAbout: (appName) => `About ${appName}`,
    menuHide: (appName) => `Hide ${appName}`,
    menuQuit: (appName) => `Quit ${appName}`,
  },
  fr: {
    trayOpen: (appName) => `Ouvrir ${appName}`,
    trayQuit: "Quitter",
    menuAbout: (appName) => `À propos de ${appName}`,
    menuHide: (appName) => `Masquer ${appName}`,
    menuQuit: (appName) => `Quitter ${appName}`,
  },
  nl: {
    trayOpen: (appName) => `${appName} openen`,
    trayQuit: "Stoppen",
    menuAbout: (appName) => `Over ${appName}`,
    menuHide: (appName) => `Verberg ${appName}`,
    menuQuit: (appName) => `Stop ${appName}`,
  },
  de: {
    trayOpen: (appName) => `${appName} öffnen`,
    trayQuit: "Beenden",
    menuAbout: (appName) => `Über ${appName}`,
    menuHide: (appName) => `${appName} ausblenden`,
    menuQuit: (appName) => `${appName} beenden`,
  },
  es: {
    trayOpen: (appName) => `Abrir ${appName}`,
    trayQuit: "Salir",
    menuAbout: (appName) => `Acerca de ${appName}`,
    menuHide: (appName) => `Ocultar ${appName}`,
    menuQuit: (appName) => `Salir de ${appName}`,
  },
};

/** The subset of Electron's `MenuItemConstructorOptions` the menu uses. */
export type AppMenuItem = {
  label?: string;
  role?: string;
  type?: "separator";
  accelerator?: string;
  click?: () => void;
  submenu?: AppMenuItem[];
};

/** macOS's minimal menu bar: the app menu, Edit and Window. */
export const buildApplicationMenu = (deps: {
  appName: string;
  requestQuit: () => void;
  strings?: MainShellStrings;
}): AppMenuItem[] => {
  const strings = deps.strings ?? MAIN_SHELL_STRINGS.en;
  return [
    {
      label: deps.appName,
      submenu: [
        { role: "about", label: strings.menuAbout(deps.appName) },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: strings.menuHide(deps.appName) },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: strings.menuQuit(deps.appName), accelerator: "CommandOrControl+Q", click: () => deps.requestQuit() },
      ],
    },
    { role: "editMenu" },
    {
      role: "windowMenu",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }, { type: "separator" }, { role: "front" }],
    },
  ];
};

/**
 * Installs the app's menu: the macOS menu bar where the OS has a global one, no menu at all elsewhere. Call it again
 * after the language changed.
 */
export const applyApplicationMenu = <Menu>(deps: {
  menu: { setApplicationMenu: (menu: Menu | null) => void; buildFromTemplate: (template: never[]) => Menu };
  hasGlobalMenuBar: boolean;
  appName: string;
  requestQuit: () => void;
  strings: MainShellStrings;
}): void => {
  if (!deps.hasGlobalMenuBar) {
    deps.menu.setApplicationMenu(null);
    return;
  }
  const template = buildApplicationMenu({ appName: deps.appName, requestQuit: deps.requestQuit, strings: deps.strings });
  deps.menu.setApplicationMenu(deps.menu.buildFromTemplate(template as never[]));
};

/** The part of Electron's keyboard `Input` the dev shortcuts read. */
export type ShortcutInput = { type: string; key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean };

/** The dev-build shortcut a key press stands for, if any. */
export const devShortcutFor = (input: ShortcutInput): "reload" | "devtools" | null => {
  if (input.type !== "keyDown" || input.alt) return null;
  const key = input.key.toLowerCase();
  const command = input.control || input.meta;
  if (key === "f5" || (command && !input.shift && key === "r")) return "reload";
  if (key === "f12" || (command && input.shift && key === "i")) return "devtools";
  return null;
};

/** The part of Electron's `WebContents` the dev shortcuts use. */
export type DevShortcutTarget = {
  on: (event: "before-input-event", listener: (event: { preventDefault: () => void }, input: ShortcutInput) => void) => unknown;
  reload: () => void;
  toggleDevTools: () => void;
};

/** Dev builds only: reload and the developer tools without a menu. */
export const attachDevShortcuts = (webContents: DevShortcutTarget): void => {
  webContents.on("before-input-event", (event, input) => {
    const shortcut = devShortcutFor(input);
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === "reload") webContents.reload();
    else webContents.toggleDevTools();
  });
};
