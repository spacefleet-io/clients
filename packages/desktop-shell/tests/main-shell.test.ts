/**
 * @regression-proof
 * PLAT-DESK-10, RT-LIFE-02: the tray and close-to-tray lifecycle Badger and Parrot desktop share. Pins Badger's
 * behaviour as it was before the move (Open / separator / Quit, close destroys the window after the renderer flush,
 * a re-shown window survives the flush, quitting closes for real) and Parrot's hide mode (the window, and the music
 * playing in it, stays alive). PLAT-DESK-11: no menu bar on Linux and Windows, the minimal macOS menu, the dev-build
 * shortcuts, and the shared main-process words in all four languages.
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyApplicationMenu,
  attachCloseToTray,
  attachDevShortcuts,
  buildTrayActions,
  createAppTray,
  decideWindowCloseAction,
  devShortcutFor,
  MAIN_SHELL_STRINGS,
  registerTrayTestIpc,
  resolveTrayIconPath,
  revealWindow,
  shouldQuitWhenAllWindowsClosed,
  trayLabelsFor,
  TRAY_TEST_CHANNELS,
  type AppMenuItem,
  type ShellWindow,
  type ShortcutInput,
  type TrayHandle,
  type TrayMenuItem,
} from "../src/main-shell";

const BADGER_LABELS = { open: "Open Badger", quit: "Quit", tooltip: "Badger" };
const PARROT_LABELS = { open: "Open Parrot", quit: "Quit", tooltip: "Parrot" };

const log = (test: string, line: string, data?: unknown) =>
  console.info(`[tray-main:${test}] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const shape = (items: Array<TrayMenuItem>) => items.map((item) => ("label" in item ? item.label : "---"));

/** A BrowserWindow stand-in that records every call, so a failure prints the whole history. */
const fakeWindow = (initial: { visible?: boolean; minimized?: boolean } = {}) => {
  const history: string[] = [];
  const listeners: Record<string, Array<(event?: { preventDefault: () => void }) => void>> = {};
  const state = { visible: initial.visible ?? true, minimized: initial.minimized ?? false, destroyed: false, skipTaskbar: false };
  const win: ShellWindow = {
    on: ((event: string, listener: (event?: { preventDefault: () => void }) => void) => {
      (listeners[event] ??= []).push(listener);
      return win;
    }) as ShellWindow["on"],
    show: () => {
      history.push("show");
      state.visible = true;
    },
    hide: () => {
      history.push("hide");
      state.visible = false;
    },
    destroy: () => {
      history.push("destroy");
      state.destroyed = true;
      for (const listener of listeners.closed ?? []) listener();
    },
    focus: () => history.push("focus"),
    restore: () => {
      history.push("restore");
      state.minimized = false;
    },
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    setSkipTaskbar: (skip) => {
      history.push(`skipTaskbar(${skip})`);
      state.skipTaskbar = skip;
    },
  };
  /** Emits `close` like the user's close button; returns whether the close was prevented. */
  const close = () => {
    let prevented = false;
    for (const listener of listeners.close ?? []) listener({ preventDefault: () => (prevented = true) });
    history.push(prevented ? "close(prevented)" : "close(allowed)");
    return prevented;
  };
  const dump = (test: string) => log(test, "window snapshot", { state, history });
  return { win, state, history, close, dump };
};

// @req PLAT-DESK-10 (one shared tray for Badger and Parrot: Open / Quit, click reopens)
describe("buildTrayActions", () => {
  it("builds Badger's menu exactly as before: Open Badger, separator, Quit; tooltip Badger", () => {
    const showMainWindow = vi.fn();
    const requestQuit = vi.fn();
    const actions = buildTrayActions({ showMainWindow, requestQuit, labels: BADGER_LABELS });
    log("badger-menu", "built", { tooltip: actions.tooltip, menu: shape(actions.menuItems) });
    expect(shape(actions.menuItems)).toEqual(["Open Badger", "---", "Quit"]);
    expect(actions.tooltip).toBe("Badger");
    actions.onClick();
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(requestQuit).not.toHaveBeenCalled();
  });

  it("gives Parrot the same menu with its own words; Open shows the window and Quit quits", () => {
    const showMainWindow = vi.fn();
    const requestQuit = vi.fn();
    const actions = buildTrayActions({ showMainWindow, requestQuit, labels: PARROT_LABELS });
    log("parrot-menu", "built", { tooltip: actions.tooltip, menu: shape(actions.menuItems) });
    expect(shape(actions.menuItems)).toEqual(["Open Parrot", "---", "Quit"]);
    const [open, , quit] = actions.menuItems as Array<{ label: string; click: () => void }>;
    open.click();
    quit.click();
    log("parrot-menu", "calls", { show: showMainWindow.mock.calls.length, quit: requestQuit.mock.calls.length });
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(requestQuit).toHaveBeenCalledTimes(1);
  });
});

describe("decideWindowCloseAction", () => {
  const rows: Array<[boolean, boolean, boolean, string]> = [
    [true, true, true, "warn"],
    [true, false, true, "warn"],
    [true, true, false, "quit"],
    [true, false, false, "quit"],
    [false, true, true, "background"],
    [false, true, false, "background"],
    [false, false, true, "background"],
    [false, false, false, "background"],
  ];
  it.each(rows)("isQuitting=%s hasTray=%s processing=%s → %s", (isQuitting, hasTray, hasActiveProcessing, expected) => {
    const actual = decideWindowCloseAction({ isQuitting, hasTray, hasActiveProcessing });
    log("close-action", "row", { isQuitting, hasTray, hasActiveProcessing, expected, actual });
    expect(actual).toBe(expected);
  });
});

describe("shouldQuitWhenAllWindowsClosed", () => {
  it("quits only while quitting on an OS that quits windowless apps", () => {
    const table = [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ] as const;
    for (const [isQuitting, quitWhenAllWindowsClosed, expected] of table) {
      const actual = shouldQuitWhenAllWindowsClosed({ isQuitting, quitWhenAllWindowsClosed });
      log("all-closed", "row", { isQuitting, quitWhenAllWindowsClosed, expected, actual });
      expect(actual).toBe(expected);
    }
  });
});

describe("resolveTrayIconPath", () => {
  it("uses the colour app icon on Linux/Windows and the first existing template on macOS", () => {
    const present = new Set(["/src/installer/trayTemplate.png"]);
    const candidates = ["/res/trayTemplate.png", "/src/installer/trayTemplate.png"];
    const colour = resolveTrayIconPath({ trayIcon: "color", appIconPath: "/res/icon.png", templateCandidates: candidates, exists: (p) => present.has(p) });
    const template = resolveTrayIconPath({ trayIcon: "template", appIconPath: "/res/icon.png", templateCandidates: candidates, exists: (p) => present.has(p) });
    const none = resolveTrayIconPath({ trayIcon: "template", appIconPath: "/res/icon.png", templateCandidates: candidates, exists: () => false });
    log("icon-path", "resolved", { colour, template, none });
    expect(colour).toBe("/res/icon.png");
    expect(template).toBe("/src/installer/trayTemplate.png");
    expect(none).toBeUndefined();
  });
});

describe("createAppTray", () => {
  const setup = (options: { failCreate?: boolean } = {}) => {
    const calls: string[] = [];
    let clickListener: (() => void) | null = null;
    let language = "en";
    const showMainWindow = vi.fn();
    const tray = createAppTray({
      createTray: (iconPath) => {
        calls.push(`new Tray(${iconPath})`);
        if (options.failCreate) throw new Error("no StatusNotifier host");
        const handle: TrayHandle = {
          setToolTip: (tooltip) => calls.push(`tooltip(${tooltip})`),
          setContextMenu: (menu) => calls.push(`menu(${(menu as unknown as string[]).join("|")})`),
          on: (_event, listener) => {
            clickListener = listener;
          },
          destroy: () => calls.push("destroy"),
        };
        return handle;
      },
      buildMenu: (items) => shape(items),
      buildActions: () =>
        buildTrayActions({
          showMainWindow,
          requestQuit: vi.fn(),
          labels: language === "fr" ? { open: "Ouvrir Parrot", quit: "Quitter", tooltip: "Parrot" } : PARROT_LABELS,
        }),
      onUnavailable: (error) => calls.push(`unavailable(${(error as Error).message})`),
    });
    return { tray, calls, click: () => clickListener?.(), setLanguage: (next: string) => (language = next), showMainWindow };
  };

  it("creates the tray once, rebuilds its labels on refresh, and the icon click shows the window", () => {
    const { tray, calls, click, setLanguage, showMainWindow } = setup();
    tray.create(undefined);
    expect(tray.active).toBe(false);
    tray.create("/res/icon.png");
    tray.create("/res/icon.png");
    setLanguage("fr");
    tray.refresh();
    click();
    log("controller", "calls", { calls, active: tray.active, menu: tray.actions && shape(tray.actions.menuItems) });
    expect(calls).toEqual([
      "new Tray(/res/icon.png)",
      "tooltip(Parrot)",
      "menu(Open Parrot|---|Quit)",
      "tooltip(Parrot)",
      "menu(Ouvrir Parrot|---|Quitter)",
    ]);
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    tray.destroy();
    expect(tray.active).toBe(false);
    expect(tray.actions).toBeNull();
    expect(calls.at(-1)).toBe("destroy");
  });

  it("runs without a tray when the desktop has none", () => {
    const { tray, calls } = setup({ failCreate: true });
    tray.create("/res/icon.png");
    tray.refresh();
    log("controller-unavailable", "calls", { calls, active: tray.active });
    expect(tray.active).toBe(false);
    expect(calls).toEqual(["new Tray(/res/icon.png)", "unavailable(no StatusNotifier host)"]);
  });
});

// @req PLAT-DESK-10 (close hides to the tray: Badger destroys after the flush, Parrot hides so the music goes on)
describe("attachCloseToTray", () => {
  it("Badger (destroy): close hides at once, leaves the taskbar, then destroys after the renderer flush", async () => {
    const { win, state, history, close, dump } = fakeWindow();
    const { promise: flushed, resolve: flush } = Promise.withResolvers<string>();
    const onBackground = vi.fn();
    attachCloseToTray(win, {
      background: "destroy",
      isQuitting: () => false,
      hasTray: () => true,
      beforeDestroy: () => flushed,
      onBackground,
    });
    const prevented = close();
    log("destroy-mode", "after close, before flush", { state, history });
    try {
      expect(prevented).toBe(true);
      expect(state.visible).toBe(false);
      expect(state.skipTaskbar).toBe(true);
      expect(state.destroyed).toBe(false);
      flush("acked");
      await Promise.resolve();
      await Promise.resolve();
      expect(state.destroyed).toBe(true);
      expect(onBackground).toHaveBeenCalledWith("destroy");
    } catch (error) {
      dump("destroy-mode");
      throw error;
    }
  });

  it("Badger (destroy): a window shown again during the flush is kept", async () => {
    const { win, state, close, dump } = fakeWindow();
    const { promise: flushed, resolve: flush } = Promise.withResolvers<string>();
    const onDestroyCancelled = vi.fn();
    attachCloseToTray(win, {
      background: "destroy",
      isQuitting: () => false,
      hasTray: () => true,
      beforeDestroy: () => flushed,
      onDestroyCancelled,
    });
    close();
    revealWindow(win);
    flush("timeout");
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(state.destroyed).toBe(false);
      expect(state.visible).toBe(true);
      expect(state.skipTaskbar).toBe(false);
      expect(onDestroyCancelled).toHaveBeenCalledWith("timeout");
      // The next close goes to the background again.
      expect(close()).toBe(true);
    } catch (error) {
      dump("destroy-reshown");
      throw error;
    }
  });

  it("Parrot (hide): close only hides, never destroys, so the music in the window keeps playing", async () => {
    const { win, state, history, close, dump } = fakeWindow();
    const beforeDestroy = vi.fn(async () => "acked");
    attachCloseToTray(win, { background: "hide", isQuitting: () => false, hasTray: () => true, beforeDestroy });
    expect(close()).toBe(true);
    expect(close()).toBe(true);
    await Promise.resolve();
    log("hide-mode", "after two closes", { state, history });
    try {
      expect(state.visible).toBe(false);
      expect(state.destroyed).toBe(false);
      expect(beforeDestroy).not.toHaveBeenCalled();
    } catch (error) {
      dump("hide-mode");
      throw error;
    }
  });

  it("an explicit quit lets the close through in both modes", () => {
    for (const background of ["destroy", "hide"] as const) {
      const { win, state, close, dump } = fakeWindow();
      attachCloseToTray(win, { background, isQuitting: () => true, hasTray: () => true, hasActiveProcessing: () => true });
      const prevented = close();
      log("quit", background, { prevented, state });
      try {
        expect(prevented).toBe(false);
        expect(state.visible).toBe(true);
      } catch (error) {
        dump(`quit-${background}`);
        throw error;
      }
    }
  });
});

describe("revealWindow", () => {
  it("shows, restores, returns to the taskbar and focuses a hidden minimized window", () => {
    const { win, history } = fakeWindow({ visible: false, minimized: true });
    revealWindow(win);
    log("reveal", "history", history);
    expect(history).toEqual(["show", "restore", "skipTaskbar(false)", "focus"]);
  });
});

describe("registerTrayTestIpc", () => {
  it("answers Badger's existing e2e channels: state, icon click, menu click by label", async () => {
    const handlers = new Map<string, (event: unknown, payload: { label: string }) => unknown>();
    const showMainWindow = vi.fn();
    const requestQuit = vi.fn();
    const tray = createAppTray({
      createTray: () => ({ setToolTip: () => {}, setContextMenu: () => {}, on: () => {}, destroy: () => {} }),
      buildMenu: (items) => items,
      buildActions: () => buildTrayActions({ showMainWindow, requestQuit, labels: BADGER_LABELS }),
    });
    registerTrayTestIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, tray);
    expect([...handlers.keys()]).toEqual(["sf-test-tray-state", "sf-test-tray-click", "sf-test-tray-context-click"]);
    const before = handlers.get(TRAY_TEST_CHANNELS.state)!(null, { label: "" });
    tray.create("/res/icon.png");
    const after = handlers.get(TRAY_TEST_CHANNELS.state)!(null, { label: "" });
    handlers.get(TRAY_TEST_CHANNELS.click)!(null, { label: "" });
    const quit = handlers.get(TRAY_TEST_CHANNELS.contextClick)!(null, { label: "Quit" });
    const missing = handlers.get(TRAY_TEST_CHANNELS.contextClick)!(null, { label: "Nope" });
    log("test-ipc", "answers", { before, after, quit, missing });
    expect(before).toEqual({ visible: false, tooltip: null, contextMenuLabels: [] });
    expect(after).toEqual({ visible: true, tooltip: "Badger", contextMenuLabels: ["Open Badger", "Quit"] });
    expect(quit).toEqual({ ok: true, matched: true });
    expect(missing).toEqual({ ok: true, matched: false });
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(requestQuit).toHaveBeenCalledTimes(1);
  });
});

const key = (k: string, mods: Partial<ShortcutInput> = {}): ShortcutInput => ({
  type: "keyDown",
  key: k,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods,
});

// @req PLAT-DESK-11 (no menu bar on Linux and Windows, the minimal macOS menu)
describe("application menu (PLAT-DESK-11)", () => {
  const menuFake = () => {
    const set = vi.fn();
    const build = vi.fn((template: never[]) => ({ template }));
    return { set, build, menu: { setApplicationMenu: set, buildFromTemplate: build } };
  };

  it("removes the menu bar on Linux and Windows (no global menu bar)", () => {
    const fake = menuFake();
    applyApplicationMenu({ menu: fake.menu, hasGlobalMenuBar: false, appName: "Parrot", requestQuit: vi.fn(), strings: MAIN_SHELL_STRINGS.en });
    log("menu-linux", "setApplicationMenu calls", fake.set.mock.calls);
    expect(fake.set).toHaveBeenCalledWith(null);
    expect(fake.build).not.toHaveBeenCalled();
  });

  it("installs the minimal app / Edit / Window menu on macOS, with an explicit quit", () => {
    const fake = menuFake();
    const requestQuit = vi.fn();
    applyApplicationMenu({ menu: fake.menu, hasGlobalMenuBar: true, appName: "SpaceBadger", requestQuit, strings: MAIN_SHELL_STRINGS.fr });
    const template = fake.build.mock.calls[0]?.[0] as unknown as AppMenuItem[];
    log("menu-macos", "template", template.map((item) => item.label ?? item.role));
    expect(template.map((item) => item.label ?? item.role)).toEqual(["SpaceBadger", "editMenu", "windowMenu"]);
    const quit = template[0]?.submenu?.find((item) => item.accelerator === "CommandOrControl+Q");
    expect(quit?.label).toBe("Quitter SpaceBadger");
    quit?.click?.();
    expect(requestQuit).toHaveBeenCalledTimes(1);
    expect(fake.set).toHaveBeenCalledWith({ template });
  });
});

// @req PLAT-DESK-11 (dev builds keep reload and the developer tools without a menu)
describe("dev-build shortcuts (PLAT-DESK-11)", () => {
  it("maps reload and devtools keys, and leaves everything else (copy, paste, undo) alone", () => {
    const cases: Array<[ShortcutInput, "reload" | "devtools" | null]> = [
      [key("F5"), "reload"],
      [key("r", { control: true }), "reload"],
      [key("r", { meta: true }), "reload"],
      [key("F12"), "devtools"],
      [key("I", { control: true, shift: true }), "devtools"],
      [key("i", { meta: true, shift: true }), "devtools"],
      [key("c", { control: true }), null],
      [key("v", { control: true }), null],
      [key("a", { control: true }), null],
      [key("z", { control: true }), null],
      [key("r"), null],
      [key("r", { control: true, alt: true }), null],
      [{ ...key("F5"), type: "keyUp" }, null],
    ];
    for (const [input, expected] of cases) {
      const got = devShortcutFor(input);
      if (got !== expected) log("dev-keys", "mismatch", { input, expected, got });
      expect(got).toBe(expected);
    }
  });

  it("reloads or toggles the devtools from before-input-event", () => {
    type Listener = (event: { preventDefault: () => void }, input: ShortcutInput) => void;
    let listener: Listener | undefined;
    const target = {
      on: vi.fn((_event: "before-input-event", l: Listener) => {
        listener = l;
      }),
      reload: vi.fn(),
      toggleDevTools: vi.fn(),
    };
    attachDevShortcuts(target);
    const preventDefault = vi.fn();
    listener?.({ preventDefault }, key("F5"));
    listener?.({ preventDefault }, key("F12"));
    listener?.({ preventDefault }, key("c", { control: true }));
    log("dev-keys", "calls", { reload: target.reload.mock.calls.length, devtools: target.toggleDevTools.mock.calls.length });
    expect(target.reload).toHaveBeenCalledTimes(1);
    expect(target.toggleDevTools).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
});

describe("shared main-process words (UX-I18N-01)", () => {
  it("exist in en, fr, nl, de and es with no empty text, and keep Badger's tray wording", () => {
    expect(Object.keys(MAIN_SHELL_STRINGS).sort()).toEqual(["de", "en", "es", "fr", "nl"]);
    for (const [code, strings] of Object.entries(MAIN_SHELL_STRINGS)) {
      const texts = [strings.trayOpen("X"), strings.trayQuit, strings.menuAbout("X"), strings.menuHide("X"), strings.menuQuit("X")];
      if (texts.some((text) => !text.trim())) log("strings", "empty text", { code, texts });
      for (const text of texts) expect(text.trim()).not.toBe("");
    }
    expect(trayLabelsFor(MAIN_SHELL_STRINGS.en, "Badger")).toEqual(BADGER_LABELS);
    expect(trayLabelsFor(MAIN_SHELL_STRINGS.en, "Parrot")).toEqual(PARROT_LABELS);
    expect(trayLabelsFor(MAIN_SHELL_STRINGS.de, "Parrot").open).toBe("Parrot öffnen");
  });
});
