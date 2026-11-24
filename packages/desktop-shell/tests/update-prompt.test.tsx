// @vitest-environment jsdom
/**
 * @test-id DESKTOP-SHELL-UPDATE-PROMPT-001
 * @level component (the real shared modal, Settings section and @space/ui controls; the updater controls are a fake)
 * @req REL-UPD-08 REL-UPD-07 REL-UPD-01
 * @why Chris 2026-11-24: a user who never opens Settings never applied updates. Badger and Parrot desktop now offer a
 *   version found by the automatic checks in ONE modal, on every screen: "Restart now" once it has downloaded (AppImage,
 *   Windows, macOS), "Install now" through the package manager after the password (.deb/.rpm/.pacman) or through the
 *   Flatpak portal (Flatpak; the `flatpak update` command when that Flatpak is too old); beside it "Remind me later" and
 *   "Ignore". A mandatory update, automatic updates
 *   off and the app's own blocking prompt keep it hidden; it waits while something plays or the app is busy (unless the
 *   user is away). The modal renders through a portal, so queries search `document`.
 *
 * Diagnostic logging: suite `update-prompt`, `dump(label)` prints the rendered HTML and the fake's calls.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { CLIENT_UI_LANGUAGES } from "@space/shared/i18n";
import { INITIAL_UPDATER_STATE, type UpdaterState } from "../src/updater/types";
import type { DesktopUpdaterControls } from "../src/updater/useUpdater";
import { DesktopUpdatePrompt, isHeldByUser, UPDATE_PROMPT_IDLE_MS, updatePromptView } from "../src/updater/DesktopUpdatePrompt";
import { DesktopUpdateSection, updateSectionAction } from "../src/updater/UpdateSection";
import { updateSectionStrings } from "../src/updater/strings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "update-prompt";
const HELPER_COMMAND = "sudo /usr/lib/spacebadger/system-update";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-app-playback");
  document.documentElement.removeAttribute("data-app-busy");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.documentElement.removeAttribute("data-app-playback");
  document.documentElement.removeAttribute("data-app-busy");
  vi.useRealTimers();
});

const systemState = (state: Partial<UpdaterState> = {}): UpdaterState => ({
  ...INITIAL_UPDATER_STATE,
  phase: "available",
  version: "0.1.9",
  currentVersion: "0.1.5",
  autoUpdate: true,
  channel: "system",
  canInstall: true,
  manualCommand: HELPER_COMMAND,
  ...state,
});

const readyState = (state: Partial<UpdaterState> = {}): UpdaterState => ({
  ...INITIAL_UPDATER_STATE,
  phase: "downloaded",
  version: "1.4.0",
  progress: 100,
  currentVersion: "1.3.0",
  autoUpdate: true,
  channel: "self",
  ...state,
});

/** The controls the modal gets, with the actions kept as mocks so a test can count the calls. */
type FakeControls = DesktopUpdaterControls & {
  check: Mock<DesktopUpdaterControls["check"]>;
  download: Mock<DesktopUpdaterControls["download"]>;
  install: Mock<DesktopUpdaterControls["install"]>;
  remindLater: Mock<DesktopUpdaterControls["remindLater"]>;
  ignoreVersion: Mock<DesktopUpdaterControls["ignoreVersion"]>;
};

const makeControls = (state: UpdaterState): FakeControls => ({
  state,
  supported: true,
  check: vi.fn(async (): Promise<UpdaterState["phase"]> => "available"),
  download: vi.fn(async () => undefined),
  install: vi.fn(),
  setAutoUpdate: vi.fn(async () => undefined),
  runFullUpdate: vi.fn(async () => undefined),
  reset: vi.fn(),
  remindLater: vi.fn(async () => undefined),
  ignoreVersion: vi.fn(async () => undefined),
});

const mount = async (node: React.ReactNode) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
};

const rerender = async (node: React.ReactNode) => act(async () => root!.render(node));

const prompt = (controls: DesktopUpdaterControls, language = "en", appName = "Badger") => (
  <DesktopUpdatePrompt controls={controls} language={language} appName={appName} />
);

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

const dump = (label: string, controls?: FakeControls) =>
  console.log(
    `[${SUITE}:dump] ${label}`,
    document.body.innerHTML || "(empty)",
    controls
      ? JSON.stringify({
          state: controls.state,
          download: controls.download.mock.calls.length,
          install: controls.install.mock.calls.length,
          remindLater: controls.remindLater.mock.calls.length,
          ignoreVersion: controls.ignoreVersion.mock.calls.length,
        })
      : "",
  );

const checked = async (label: string, controls: FakeControls | undefined, fn: () => void | Promise<void>) => {
  try {
    await fn();
  } catch (err) {
    dump(`${label}:fail`, controls);
    throw err;
  }
};

describe("updatePromptView (REL-UPD-08)", () => {
  it("@req REL-UPD-08 a downloaded self update and a package-manager or Flatpak version ask; never mandatory, never with automatic updates off", () => {
    const cases = {
      ready: updatePromptView(readyState()),
      selfAvailable: updatePromptView(readyState({ phase: "available" })),
      selfDownloading: updatePromptView(readyState({ phase: "downloading" })),
      selfError: updatePromptView(readyState({ phase: "error" })),
      ask: updatePromptView(systemState()),
      manual: updatePromptView(systemState({ canInstall: false })),
      installing: updatePromptView(systemState({ phase: "installing" })),
      installed: updatePromptView(systemState({ phase: "installed" })),
      failed: updatePromptView(systemState({ phase: "error", failure: "packageManager" })),
      pending: updatePromptView(systemState({ phase: "error", failure: "notNewer" })),
      errorNoFailure: updatePromptView(systemState({ phase: "error", failure: null })),
      flatpak: updatePromptView(systemState({ channel: "flatpak", canInstall: false })),
      flatpakAsk: updatePromptView(systemState({ channel: "flatpak" })),
      flatpakInstalling: updatePromptView(systemState({ channel: "flatpak", phase: "installing" })),
      flatpakInstalled: updatePromptView(systemState({ channel: "flatpak", phase: "installed" })),
      flatpakFailed: updatePromptView(systemState({ channel: "flatpak", phase: "error", failure: "network" })),
      autoOff: updatePromptView(readyState({ autoUpdate: false })),
      systemAutoOff: updatePromptView(systemState({ autoUpdate: false })),
      mandatory: updatePromptView(readyState({ mandatory: true })),
      systemMandatory: updatePromptView(systemState({ mandatory: true })),
      idle: updatePromptView(systemState({ phase: "idle" })),
    };
    console.info(`[${SUITE}:view] ${JSON.stringify(cases)}`);
    expect(cases).toEqual({
      ready: "ready",
      selfAvailable: null,
      selfDownloading: null,
      selfError: null,
      ask: "ask",
      manual: "manual",
      installing: "installing",
      installed: "installed",
      failed: "failed",
      pending: "pending",
      errorNoFailure: null,
      flatpak: "flatpak",
      flatpakAsk: "ask",
      flatpakInstalling: "installing",
      flatpakInstalled: "installed",
      flatpakFailed: "failed",
      autoOff: null,
      systemAutoOff: null,
      mandatory: null,
      systemMandatory: null,
      idle: null,
    });
  });

  it("@req REL-UPD-08 Later holds a version until its time is up, Ignore holds it for good; a newer version asks again", () => {
    const now = Date.parse("2026-11-24T10:00:00Z");
    const later = { version: "1.4.0", until: now + 1000 };
    const held = {
      later: isHeldByUser(readyState({ remindLater: later }), now),
      laterOver: isHeldByUser(readyState({ remindLater: later }), now + 1001),
      laterNewer: isHeldByUser(readyState({ remindLater: later, version: "1.5.0" }), now),
      ignored: isHeldByUser(readyState({ ignoredVersion: "1.4.0" }), now + 365 * 24 * 3600 * 1000),
      ignoredNewer: isHeldByUser(readyState({ ignoredVersion: "1.4.0", version: "1.5.0" }), now),
      noVersion: isHeldByUser(readyState({ version: null, ignoredVersion: "1.4.0" }), now),
    };
    console.info(`[${SUITE}:held] ${JSON.stringify(held)}`);
    expect(held).toEqual({ later: true, laterOver: false, laterNewer: false, ignored: true, ignoredNewer: false, noVersion: false });
  });
});

describe("DesktopUpdatePrompt, a downloaded update (REL-UPD-08)", () => {
  it("@req REL-UPD-08 opens on its own with Restart now, Remind me later and Ignore; Restart now installs", async () => {
    const controls = makeControls(readyState({ version: "2.1.0" }));
    await mount(prompt(controls, "en", "Parrot"));
    dump("ready", controls);
    await checked("ready", controls, async () => {
      expect(q("update-prompt")?.getAttribute("data-view")).toBe("ready");
      expect(q("update-prompt")?.getAttribute("role")).toBe("dialog");
      expect(q("update-prompt")?.textContent).toContain("Update ready");
      expect(q("update-prompt-message")?.textContent).toBe("Parrot 2.1.0 has downloaded. It installs the next time you quit Parrot.");
      expect(q("update-prompt-install")?.textContent).toBe("Restart now");
      expect(q("update-prompt-later")?.textContent).toBe("Remind me later");
      expect(q("update-prompt-ignore")?.textContent).toBe("Ignore");
      expect(q("update-prompt-busy")).toBeNull();
      // The primary action, never Ignore, has the focus on open.
      console.info(`[${SUITE}:ready:focus] active=${document.activeElement?.getAttribute("data-testid")}`);
      expect(document.activeElement).toBe(q("update-prompt-install"));
      await act(async () => q("update-prompt-install")?.click());
      expect(controls.install).toHaveBeenCalledTimes(1);
      expect(controls.download).not.toHaveBeenCalled();
    });
  });

  it("@req REL-UPD-08 Remind me later asks main to hold the version; the held state hides the modal until the time is up", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    const controls = makeControls(readyState());
    await mount(prompt(controls));
    await act(async () => q("update-prompt-later")?.click());
    const calls = controls.remindLater.mock.calls.length;
    // The main process answers with the `prompt-snoozed` event; the hook folds it into the state.
    const until = Date.now() + 24 * 60 * 60 * 1000;
    const held = makeControls(readyState({ remindLater: { version: "1.4.0", until } }));
    await rerender(prompt(held));
    const whileHeld = q("update-prompt");
    await act(async () => vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 60_000));
    const almostADay = q("update-prompt");
    await act(async () => vi.advanceTimersByTime(60_000 + 100));
    const nextDay = q("update-prompt");
    dump("later", held);
    await checked("later", held, () => {
      expect(calls).toBe(1);
      expect(controls.ignoreVersion).not.toHaveBeenCalled();
      expect(controls.install).not.toHaveBeenCalled();
      expect(whileHeld).toBeNull();
      expect(almostADay).toBeNull();
      expect(nextDay).not.toBeNull();
    });
  });

  it("@req REL-UPD-08 Ignore asks main to skip the version; it stays hidden, a newer version asks again", async () => {
    const controls = makeControls(readyState());
    await mount(prompt(controls));
    await act(async () => q("update-prompt-ignore")?.click());
    const ignored = makeControls(readyState({ ignoredVersion: "1.4.0" }));
    await rerender(prompt(ignored));
    const afterIgnore = q("update-prompt");
    await rerender(prompt(makeControls(readyState({ ignoredVersion: "1.4.0", version: "1.5.0" }))));
    dump("ignore-newer");
    await checked("ignore", controls, () => {
      expect(controls.ignoreVersion).toHaveBeenCalledTimes(1);
      expect(controls.remindLater).not.toHaveBeenCalled();
      expect(afterIgnore).toBeNull();
      expect(q("update-prompt-message")?.textContent).toContain("Badger 1.5.0 has downloaded.");
    });
  });

  it("@req REL-UPD-08 a download without a version still reads as a sentence, with Close instead of Later/Ignore", async () => {
    const controls = makeControls(readyState({ version: null }));
    await mount(prompt(controls, "en", "Parrot"));
    dump("no-version", controls);
    await checked("no-version", controls, async () => {
      expect(q("update-prompt-message")?.textContent).toBe("A new version of Parrot has downloaded. It installs the next time you quit Parrot.");
      expect(q("update-prompt-later")).toBeNull();
      expect(q("update-prompt-ignore")).toBeNull();
      await act(async () => q("update-prompt-close")?.click());
      expect(q("update-prompt")).toBeNull();
      expect(controls.remindLater).not.toHaveBeenCalled();
    });
  });

  it("@req REL-UPD-08 a mandatory update, automatic updates off, the app's blocking prompt or no bridge: no modal", async () => {
    await mount(prompt(makeControls(readyState({ mandatory: true }))));
    const mandatory = q("update-prompt");
    await rerender(prompt(makeControls(readyState({ autoUpdate: false }))));
    const off = q("update-prompt");
    await rerender(<DesktopUpdatePrompt controls={makeControls(readyState())} language="en" appName="Badger" blocked />);
    const blocked = q("update-prompt");
    await rerender(prompt({ ...makeControls(readyState()), supported: false }));
    const unsupported = q("update-prompt");
    await rerender(prompt(makeControls(readyState())));
    const shown = q("update-prompt");
    dump("hidden-cases");
    expect({ mandatory, off, blocked, unsupported, shown: shown !== null }).toEqual({
      mandatory: null,
      off: null,
      blocked: null,
      unsupported: null,
      shown: true,
    });
  });

  it.each([
    ["fr", "Parrot 3.0.0 est téléchargé. Il s'installe la prochaine fois que vous quittez Parrot.", "Redémarrer maintenant", "Me le rappeler plus tard", "Ignorer"],
    ["nl", "Parrot 3.0.0 is gedownload. De update wordt geïnstalleerd zodra je Parrot afsluit.", "Nu herstarten", "Herinner me later", "Negeren"],
    ["de", "Parrot 3.0.0 wurde heruntergeladen. Es wird beim nächsten Beenden von Parrot installiert.", "Jetzt neu starten", "Später erinnern", "Ignorieren"],
    ["es", "Parrot 3.0.0 ya se descargó. Se instala la próxima vez que cierres Parrot.", "Reiniciar ahora", "Recordármelo más tarde", "Ignorar"],
  ])("@req REL-UPD-08 speaks the window's language (%s) and keeps the product name", async (lang, sentence, restart, later, ignore) => {
    await mount(prompt(makeControls(readyState({ version: "3.0.0" })), `${lang}-XX`, "Parrot"));
    console.info(`[${SUITE}:lang:${lang}] ${q("update-prompt")?.textContent}`);
    expect({
      message: q("update-prompt-message")?.textContent,
      restart: q("update-prompt-install")?.textContent,
      later: q("update-prompt-later")?.textContent,
      ignore: q("update-prompt-ignore")?.textContent,
    }).toEqual({ message: sentence, restart, later, ignore });
  });
});

describe("DesktopUpdatePrompt waits for a good moment (REL-UPD-08)", () => {
  it("@req REL-UPD-08 waits while something plays, and opens once playback stops", async () => {
    document.documentElement.setAttribute("data-app-playback", "");
    const controls = makeControls(readyState());
    await mount(prompt(controls));
    const playing = q("update-prompt");
    await act(async () => document.documentElement.removeAttribute("data-app-playback"));
    const stopped = q("update-prompt");
    await act(async () => document.documentElement.setAttribute("data-app-playback", ""));
    const playingAgain = q("update-prompt");
    dump("playback", controls);
    expect({ playing, stopped: stopped !== null, playingAgain }).toEqual({ playing: null, stopped: true, playingAgain: null });
  });

  it("@req REL-UPD-08 waits while the app is busy, then opens after the user is idle, saying the restart interrupts the work", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    document.documentElement.setAttribute("data-app-busy", "");
    const controls = makeControls(readyState());
    await mount(prompt(controls));
    const busy = q("update-prompt");
    await act(async () => vi.advanceTimersByTime(UPDATE_PROMPT_IDLE_MS / 2));
    // The user is still working: the idle clock starts again.
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })));
    await act(async () => vi.advanceTimersByTime(UPDATE_PROMPT_IDLE_MS / 2 + 30_000));
    const stillWorking = q("update-prompt");
    await act(async () => vi.advanceTimersByTime(UPDATE_PROMPT_IDLE_MS));
    const idle = q("update-prompt");
    dump("busy-idle", controls);
    await checked("busy-idle", controls, () => {
      expect(busy).toBeNull();
      expect(stillWorking).toBeNull();
      expect(idle).not.toBeNull();
      expect(q("update-prompt-busy")?.textContent).toBe("Badger is still busy with something. Restarting now interrupts it.");
    });
  });

  it("@req REL-UPD-08 opens as soon as the busy work ends", async () => {
    document.documentElement.setAttribute("data-app-busy", "");
    await mount(prompt(makeControls(systemState()), "fr"));
    const busy = q("update-prompt");
    await act(async () => document.documentElement.removeAttribute("data-app-busy"));
    dump("busy-ends");
    expect(busy).toBeNull();
    expect(q("update-prompt-message")?.textContent).toBe("Badger 0.1.9 est disponible. L'installer maintenant ?");
    expect(q("update-prompt-busy")).toBeNull();
  });

  it("@req REL-UPD-08 progress and results of an install the user started never wait", async () => {
    document.documentElement.setAttribute("data-app-playback", "");
    await mount(prompt(makeControls(systemState({ phase: "installing" }))));
    dump("installing-while-playing");
    expect(q("update-prompt")?.getAttribute("data-view")).toBe("installing");
  });
});

describe("DesktopUpdatePrompt on a package-manager or Flatpak copy (REL-UPD-07)", () => {
  it("@req REL-UPD-07 asks 'Badger 0.1.9 is available. Install now?'; Install runs the update, never on its own", async () => {
    const controls = makeControls(systemState());
    await mount(prompt(controls));
    await checked("ask", controls, async () => {
      expect(q("update-prompt-message")?.textContent).toBe("Badger 0.1.9 is available. Install now?");
      expect(q("update-prompt")?.getAttribute("role")).toBe("dialog");
      expect(q("update-prompt-install")?.textContent).toBe("Install now");
      expect(q("update-prompt-later")?.textContent).toBe("Remind me later");
      expect(q("update-prompt-ignore")?.textContent).toBe("Ignore");
      expect(controls.download).not.toHaveBeenCalled();
      await act(async () => q("update-prompt-install")?.click());
      expect(controls.download).toHaveBeenCalledTimes(1);
      expect(controls.install).not.toHaveBeenCalled();
    });
  });

  it("@req REL-UPD-07 shows progress while installing, then 'Restarting Badger…' with nothing to click", async () => {
    const controls = makeControls(systemState({ phase: "installing" }));
    await mount(prompt(controls));
    const installing = {
      view: q("update-prompt")?.dataset.view,
      bar: document.querySelector('[role="progressbar"]') !== null,
      later: q("update-prompt-later"),
    };
    const done = makeControls(systemState({ phase: "installed" }));
    await rerender(prompt(done));
    await checked("installed", done, async () => {
      expect(installing).toEqual({ view: "installing", bar: true, later: null });
      expect(q("update-prompt-message")?.textContent).toBe("Badger 0.1.9 is installed. Restarting Badger…");
      expect(q("update-prompt-later")).toBeNull();
      expect(q("update-prompt-ignore")).toBeNull();
      expect(q("update-prompt-install")).toBeNull();
      expect(q("update-prompt-close")).toBeNull();
      expect(done.install).not.toHaveBeenCalled();
    });
  });

  it("@req REL-UPD-07 a failure shows the reason, the package manager's lines and the command with a copy button", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const controls = makeControls(
      systemState({ phase: "error", failure: "needsSystemUpdate", failureDetail: "error: spacebadger needs glibc>=2.41", manualCommand: "sudo pacman -Syu" }),
    );
    await mount(prompt(controls));
    await checked("failed", controls, async () => {
      expect(q("update-prompt")?.getAttribute("role")).toBe("alertdialog");
      expect(q("update-prompt-message")?.textContent).toBe("Badger needs newer system packages first. Update your whole system, then try again.");
      expect(q("update-prompt-detail")?.textContent).toContain("glibc>=2.41");
      expect(q("update-manual-command")?.textContent).toBe("sudo pacman -Syu");
      await act(async () => q("update-manual-copy")?.click());
      expect(writeText).toHaveBeenCalledWith("sudo pacman -Syu");
      expect(q("update-manual-copy")?.textContent).toBe("Copied");
      expect(q("update-prompt-later")).toBeNull();
      expect(q("update-prompt-ignore")).toBeNull();
      expect(q("update-prompt-close")?.textContent).toBe("Close");
      await act(async () => q("update-prompt-close")?.click());
      expect(q("update-prompt")).toBeNull();
    });
  });

  // @bugfix @regression-proof Chris 2026-11-23: Parrot offered 0.1.40 before the Arch repository listed it, and the
  // modal said "The package repository doesn't have the new version yet" as a failure. It is not one: the version is on
  // its way, and the main process offers it again once the repository has it.
  it.each([
    ["en", "A new version is on its way. We'll offer it when it's ready."],
    ["fr", "Une nouvelle version arrive. Nous vous la proposerons dès qu'elle sera prête."],
  ])("@req REL-UPD-07 the repository does not list the version yet (%s): 'on its way', no failure, no command", async (lang, sentence) => {
    const controls = makeControls(
      systemState({ phase: "error", failure: "notNewer", failureDetail: "[system-update] nothing newer than 0.1.39", manualCommand: HELPER_COMMAND }),
    );
    await mount(prompt(controls, lang));
    console.log(`[${SUITE}:pending:${lang}] ${q("update-prompt")?.outerHTML}`);
    await checked(`pending-${lang}`, controls, async () => {
      expect(q("update-prompt")?.getAttribute("data-view")).toBe("pending");
      expect(q("update-prompt")?.getAttribute("role")).toBe("dialog");
      expect(q("update-prompt-message")?.textContent).toBe(sentence);
      expect(q("update-prompt-detail")).toBeNull();
      expect(q("update-manual-command")).toBeNull();
      expect(q("update-prompt")?.textContent).not.toMatch(/doesn't have|failed|couldn't/i);
      await act(async () => q("update-prompt-close")?.click());
      expect(q("update-prompt")).toBeNull();
    });
  });

  it.each([
    ["en", "Couldn't reach SpaceFleet's update server. Check your connection and try again."],
    ["fr", "Impossible de joindre le serveur de mises à jour de SpaceFleet. Vérifiez votre connexion et réessayez."],
    ["nl", "De updateserver van SpaceFleet is niet bereikbaar. Controleer je verbinding en probeer het opnieuw."],
    ["de", "Der Update-Server von SpaceFleet ist nicht erreichbar. Prüf deine Verbindung und versuch es noch einmal."],
    ["es", "No se pudo conectar con el servidor de actualizaciones de SpaceFleet. Comprueba tu conexión y vuelve a intentarlo."],
  ])("@req REL-UPD-07 a network failure says the server couldn't be reached (%s), with the details and the command", async (lang, sentence) => {
    const detail = "error: failed retrieving file 'spacefleet.db' from packages.spacefleet.io : Could not resolve host";
    const controls = makeControls(systemState({ phase: "error", failure: "network", failureDetail: detail, manualCommand: HELPER_COMMAND }));
    await mount(prompt(controls, lang));
    await checked(`network-${lang}`, controls, () => {
      expect(q("update-prompt-message")?.textContent).toBe(sentence);
      expect(q("update-prompt-detail")?.textContent).toContain("Could not resolve host");
      expect(q("update-manual-command")?.textContent).toBe(HELPER_COMMAND);
    });
  });

  it("@req REL-UPD-07 without a password window: says why there is no Install, shows only the command, Later and Ignore still there", async () => {
    const controls = makeControls(systemState({ canInstall: false }));
    await mount(prompt(controls, "fr"));
    await checked("manual", controls, () => {
      expect(q("update-prompt-install")).toBeNull();
      // Never "Install now?" without an Install button.
      expect(q("update-prompt-message")?.textContent).toBe(
        "Badger 0.1.9 est disponible. Badger ne peut pas demander votre mot de passe ici, il ne peut donc pas installer la mise à jour lui-même.",
      );
      expect(q("update-prompt-message")?.textContent).not.toContain("maintenant ?");
      expect(q("update-manual-command")?.textContent).toBe(HELPER_COMMAND);
      expect(q("update-prompt-later")?.textContent).toBe("Me le rappeler plus tard");
      expect(q("update-prompt-ignore")?.textContent).toBe("Ignorer");
      // No Install here: Later, never Ignore, has the focus on open.
      console.info(`[${SUITE}:manual:focus] active=${document.activeElement?.getAttribute("data-testid")}`);
      expect(document.activeElement).toBe(q("update-prompt-later"));
    });
  });

  it("@req REL-UPD-07 Flatpak too old for the portal: says why, points to flatpak update, with one lead-in sentence", async () => {
    const controls = makeControls(systemState({ channel: "flatpak", canInstall: false, manualCommand: "flatpak update io.spacefleet.Badger" }));
    await mount(prompt(controls));
    await checked("flatpak", controls, () => {
      expect(q("update-prompt")?.getAttribute("data-view")).toBe("flatpak");
      expect(q("update-prompt-install")).toBeNull();
      expect(q("update-prompt-message")?.textContent).toBe(
        "Badger 0.1.9 is available. The Flatpak on this computer is too old to let Badger update itself. Update it from your software centre, or run this in a terminal:",
      );
      expect(q("update-manual-command")?.textContent).toBe("flatpak update io.spacefleet.Badger");
      // The Flatpak sentence already ends "run this in a terminal:", so the generic hint is not repeated under it.
      expect(q("update-manual")?.textContent).not.toContain(updateSectionStrings.en.manualHint);
    });
  });

  it("@req REL-UPD-07 Flatpak with the portal: Install now, then Flatpak's own progress while it installs", async () => {
    const controls = makeControls(systemState({ channel: "flatpak", manualCommand: "flatpak update io.spacefleet.Badger" }));
    await mount(prompt(controls));
    const askView = q("update-prompt")?.getAttribute("data-view");
    const askMessage = q("update-prompt-message")?.textContent;
    await act(async () => q("update-prompt-install")?.click());
    const installing = makeControls(systemState({ channel: "flatpak", phase: "installing", progress: 40 }));
    await rerender(prompt(installing, "fr"));
    dump("flatpak-installing", installing);
    await checked("flatpak-portal", installing, () => {
      expect(askView).toBe("ask");
      expect(askMessage).toBe("Badger 0.1.9 is available. Install now?");
      expect(controls.download).toHaveBeenCalledTimes(1);
      expect(q("update-prompt-message")?.textContent).toBe(
        "Installation de Badger 0.1.9… Flatpak peut d'abord vous demander d'autoriser la mise à jour.",
      );
      expect(q("update-prompt-progress")?.getAttribute("aria-valuenow")).toBe("40");
      expect(q("update-manual-command")).toBeNull();
      expect(q("update-prompt-later")).toBeNull();
    });
  });

  it("@req REL-UPD-08 every sentence exists in the 5 languages and never translates the app's name", () => {
    const keys = Object.keys(updateSectionStrings.en);
    for (const { code } of CLIENT_UI_LANGUAGES) {
      const strings = updateSectionStrings[code];
      console.info(`[${SUITE}:languages] ${code} remindLater=${strings.remindLater} ignore=${strings.ignore} busyNote=${strings.busyNote}`);
      expect(Object.keys(strings).sort(), code).toEqual([...keys].sort());
      expect(strings.busyNote, code).toContain("{app}");
      expect(strings.readyBody, code).toContain("{version}");
      expect(strings.readyBodyCurrent, code).not.toContain("{version}");
      for (const [key, value] of Object.entries(strings)) {
        expect(value, `${code}.${key}`).not.toMatch(/\b(Badger|Parrot|Blaireau|Perroquet|Papagei|Loro|Dachs|Tejón)\b/);
        if (key.startsWith("autoHint")) expect(value, `${code}.${key}`).toMatch(/4/);
      }
    }
  });
});

describe("Settings › About on a package-manager copy (REL-UPD-07)", () => {
  it("@req REL-UPD-07 the button reads Install, then Restart Badger; a check never installs on its own", () => {
    expect(updateSectionAction("available", "system", true)).toBe("install");
    expect(updateSectionAction("available", "system", false)).toBeNull();
    expect(updateSectionAction("installing", "system")).toBe("install");
    expect(updateSectionAction("installed", "system")).toBe("restartApp");
    expect(updateSectionAction("error", "system")).toBe("check");
    expect(updateSectionAction("available", "flatpak")).toBe("install");
    expect(updateSectionAction("available", "flatpak", false)).toBeNull();
    expect(updateSectionAction("installed", "flatpak")).toBe("restartApp");
    expect(updateSectionAction("idle", "flatpak")).toBe("check");
  });

  it("@req REL-UPD-07 Flatpak: Install through the portal with its progress; too old a Flatpak says why and shows the command", async () => {
    const section = (c: DesktopUpdaterControls) => (
      <DesktopUpdateSection controls={c} language="en" appName="Badger" autoUpdate={{ checked: true, onCheckedChange: vi.fn() }} />
    );
    const portal = makeControls(systemState({ channel: "flatpak", manualCommand: "flatpak update io.spacefleet.Badger" }));
    await mount(section(portal));
    const askStatus = q("update-section-status")?.textContent;
    const askButton = q("update-section-action")?.textContent;
    const askCommand = q("update-manual-command");
    await act(async () => q("update-section-action")?.click());
    const installing = makeControls(systemState({ channel: "flatpak", phase: "installing", progress: 75 }));
    await rerender(section(installing));
    const installingStatus = q("update-section-status")?.textContent;
    const bar = q("update-section-progress")?.getAttribute("aria-valuenow");
    const old = makeControls(systemState({ channel: "flatpak", canInstall: false, manualCommand: "flatpak update io.spacefleet.Badger" }));
    await rerender(section(old));
    dump("section-flatpak", old);
    await checked("section-flatpak", old, () => {
      expect(askStatus).toBe("Badger 0.1.9 is available. Install now?");
      expect(askButton).toBe("Install");
      expect(askCommand).toBeNull();
      expect(portal.download).toHaveBeenCalledTimes(1);
      expect(installingStatus).toBe("Installing Badger 0.1.9… Flatpak may ask you to allow the update first.");
      expect(bar).toBe("75");
      expect(q("update-section")?.textContent).toContain("too old to let Badger update itself");
      expect(q("update-section")?.textContent).not.toContain("Install now?");
      expect(q("update-manual-command")?.textContent).toBe("flatpak update io.spacefleet.Badger");
    });
  });

  it("@req REL-UPD-07 shows the prompt's sentence, Install, the failure with the command, and the switch", async () => {
    const controls = makeControls(systemState({ phase: "idle" }));
    const section = (c: DesktopUpdaterControls, language = "en") => (
      <DesktopUpdateSection controls={c} language={language} appName="Badger" autoUpdate={{ checked: true, onCheckedChange: vi.fn() }} />
    );
    await mount(section(controls));
    await act(async () => q("update-section-action")?.click());
    const checkCalls = { check: controls.check.mock.calls.length, download: controls.download.mock.calls.length };
    const available = makeControls(systemState());
    await rerender(section(available, "fr"));
    const frStatus = q("update-section-status")?.textContent;
    const frButton = q("update-section-action")?.textContent;
    await act(async () => q("update-section-action")?.click());
    const failed = makeControls(systemState({ phase: "error", failure: "notAuthorized", manualCommand: HELPER_COMMAND }));
    await rerender(section(failed));
    await checked("section", failed, () => {
      expect(checkCalls).toEqual({ check: 1, download: 0 });
      expect(frStatus).toBe("Badger 0.1.9 est disponible. L'installer maintenant ?");
      expect(frButton).toBe("Installer");
      expect(available.download).toHaveBeenCalledTimes(1);
      expect(q("update-section-status")?.textContent).toBe("Your account isn't allowed to install updates.");
      expect(q("update-manual-command")?.textContent).toBe(HELPER_COMMAND);
      expect(q("settings-auto-update-switch")).not.toBeNull();
    });
  });

  it("@req REL-UPD-08 an ignored version is still offered in Settings", async () => {
    const controls = makeControls(systemState({ ignoredVersion: "0.1.9" }));
    await mount(<DesktopUpdateSection controls={controls} language="en" appName="Badger" autoUpdate={{ checked: true, onCheckedChange: vi.fn() }} />);
    dump("section-ignored", controls);
    await checked("section-ignored", controls, async () => {
      expect(q("update-prompt")).toBeNull();
      expect(q("update-section-status")?.textContent).toBe("Badger 0.1.9 is available. Install now?");
      expect(q("update-section-action")?.textContent).toBe("Install");
      await act(async () => q("update-section-action")?.click());
      expect(controls.download).toHaveBeenCalledTimes(1);
    });
  });

  it("@req REL-UPD-07 @bugfix the repository not ready yet reads 'on its way' in Settings, not as an error, with no command", async () => {
    const controls = makeControls(systemState({ phase: "error", failure: "notNewer", manualCommand: HELPER_COMMAND }));
    await mount(<DesktopUpdateSection controls={controls} language="en" appName="Badger" autoUpdate={{ checked: true, onCheckedChange: vi.fn() }} />);
    await checked("section-pending", controls, () => {
      expect(q("update-section-status")?.textContent).toBe("A new version is on its way. We'll offer it when it's ready.");
      expect(q("update-section-status")?.className).not.toContain("text-destructive");
      expect(q("update-manual-command")).toBeNull();
    });
  });
});
