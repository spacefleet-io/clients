// @vitest-environment jsdom
/**
 * @test-id DESKTOP-SHELL-SYSTEM-UPDATE-PROMPT-001
 * @level component (the real shared prompt, Settings section and @space/ui controls; the updater controls are a fake)
 * @req REL-UPD-07
 * @why A copy from SpaceFleet's .deb/.rpm/.pacman packages updates through the package manager after the user's
 *   password, so it must ASK in a modal: "Badger 0.1.9 is available. Install now?" → Install now (password window) /
 *   Later (a day), then progress and "Restarting Badger…" (the app relaunches itself), or the reason with the command
 *   to run by hand. Same steps in Settings › About. The modal renders through a portal, so queries search `document`.
 *
 * Diagnostic logging: suite `system-update-prompt`, `dump(label)` prints the rendered HTML and the fake's calls.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { INITIAL_UPDATER_STATE, type UpdaterState } from "../src/updater/types";
import type { DesktopUpdaterControls } from "../src/updater/useUpdater";
import { SYSTEM_PROMPT_SNOOZE_MS, SystemUpdatePrompt, systemPromptView } from "../src/updater/SystemUpdatePrompt";
import { DesktopUpdateSection, updateSectionAction } from "../src/updater/UpdateSection";
import { updateSectionStrings } from "../src/updater/strings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "system-update-prompt";
const HELPER_COMMAND = "sudo /usr/lib/spacebadger/system-update";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
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

/** The controls the prompt gets, with `check`, `download` and `install` kept as mocks so a test can count the calls. */
type FakeControls = DesktopUpdaterControls & {
  check: Mock<DesktopUpdaterControls["check"]>;
  download: Mock<DesktopUpdaterControls["download"]>;
  install: Mock<DesktopUpdaterControls["install"]>;
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
});

const mount = async (node: React.ReactNode) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
};

const rerender = async (node: React.ReactNode) => act(async () => root!.render(node));

const prompt = (controls: DesktopUpdaterControls, language = "en") => (
  <SystemUpdatePrompt controls={controls} language={language} appName="Badger" />
);

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

const dump = (label: string, controls?: FakeControls) =>
  console.log(
    `[${SUITE}:dump] ${label}`,
    document.body.innerHTML,
    controls ? JSON.stringify({ state: controls.state, download: controls.download.mock.calls.length, install: controls.install.mock.calls.length }) : "",
  );

const checked = async (label: string, controls: FakeControls | undefined, fn: () => void | Promise<void>) => {
  try {
    await fn();
  } catch (err) {
    dump(`${label}:fail`, controls);
    throw err;
  }
};

describe("systemPromptView (REL-UPD-07)", () => {
  it("@req REL-UPD-07 asks only for a package-manager or Flatpak copy, with automatic updates on, outside a mandatory update", () => {
    expect(systemPromptView(systemState())).toBe("ask");
    expect(systemPromptView(systemState({ canInstall: false }))).toBe("manual");
    expect(systemPromptView(systemState({ phase: "installing" }))).toBe("installing");
    expect(systemPromptView(systemState({ phase: "installed" }))).toBe("installed");
    expect(systemPromptView(systemState({ phase: "error", failure: "packageManager" }))).toBe("failed");
    expect(systemPromptView(systemState({ phase: "error", failure: "notNewer" }))).toBe("pending");
    expect(systemPromptView(systemState({ phase: "error", failure: null }))).toBeNull();
    expect(systemPromptView(systemState({ channel: "flatpak", canInstall: false }))).toBe("flatpak");
    expect(systemPromptView(systemState({ channel: "self" }))).toBeNull();
    expect(systemPromptView(systemState({ autoUpdate: false }))).toBeNull();
    expect(systemPromptView(systemState({ mandatory: true }))).toBeNull();
    expect(systemPromptView(systemState({ phase: "idle" }))).toBeNull();
  });
});

describe("SystemUpdatePrompt (REL-UPD-07)", () => {
  it("@req REL-UPD-07 asks 'Badger 0.1.9 is available. Install now?'; Install runs the update, never on its own", async () => {
    const controls = makeControls(systemState());
    await mount(prompt(controls));
    await checked("ask", controls, async () => {
      expect(q("system-update-prompt-message")?.textContent).toBe("Badger 0.1.9 is available. Install now?");
      expect(q("system-update-prompt")?.getAttribute("role")).toBe("dialog");
      expect(q("system-update-prompt-install")?.textContent).toBe("Install now");
      expect(controls.download).not.toHaveBeenCalled();
      await act(async () => q("system-update-prompt-install")?.click());
      expect(controls.download).toHaveBeenCalledTimes(1);
    });
  });

  it("@req REL-UPD-07 Later hides the prompt for a day, for that version only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    const controls = makeControls(systemState());
    await mount(prompt(controls));
    await act(async () => q("system-update-prompt-later")?.click());
    const afterLater = q("system-update-prompt");
    console.info(`[${SUITE}:snooze] stored=${localStorage.getItem("spacefleet.updater.snooze.badger")}`);
    vi.setSystemTime(new Date(Date.parse("2026-11-18T10:00:00Z") + SYSTEM_PROMPT_SNOOZE_MS - 60_000));
    await rerender(prompt(makeControls(systemState())));
    const almostADay = q("system-update-prompt");
    vi.setSystemTime(new Date(Date.parse("2026-11-18T10:00:00Z") + SYSTEM_PROMPT_SNOOZE_MS + 1));
    await rerender(prompt(makeControls(systemState())));
    const nextDay = q("system-update-prompt");
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    localStorage.setItem("spacefleet.updater.snooze.badger", JSON.stringify({ version: "0.1.9", until: Date.now() + 1000 }));
    await rerender(prompt(makeControls(systemState({ version: "0.2.0" }))));
    const newerVersion = q("system-update-prompt");
    await checked("snooze", controls, () => {
      expect(afterLater).toBeNull();
      expect(almostADay).toBeNull();
      expect(nextDay).not.toBeNull();
      expect(newerVersion).not.toBeNull();
    });
  });

  it("@req REL-UPD-07 shows progress while installing, then 'Restarting Badger…' with nothing to click", async () => {
    const controls = makeControls(systemState({ phase: "installing" }));
    await mount(prompt(controls));
    const installing = {
      view: q("system-update-prompt")?.dataset.view,
      bar: document.querySelector('[role="progressbar"]') !== null,
      later: q("system-update-prompt-later"),
    };
    const done = makeControls(systemState({ phase: "installed" }));
    await rerender(prompt(done));
    await checked("installed", done, async () => {
      expect(installing).toEqual({ view: "installing", bar: true, later: null });
      expect(q("system-update-prompt-message")?.textContent).toBe("Badger 0.1.9 is installed. Restarting Badger…");
      expect(q("system-update-prompt-restart")).toBeNull();
      expect(q("system-update-prompt-later")).toBeNull();
      expect(q("system-update-prompt-install")).toBeNull();
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
      expect(q("system-update-prompt")?.getAttribute("role")).toBe("alertdialog");
      expect(q("system-update-prompt-message")?.textContent).toBe(
        "Badger needs newer system packages first. Update your whole system, then try again.",
      );
      expect(q("system-update-prompt-detail")?.textContent).toContain("glibc>=2.41");
      expect(q("update-manual-command")?.textContent).toBe("sudo pacman -Syu");
      await act(async () => q("update-manual-copy")?.click());
      expect(writeText).toHaveBeenCalledWith("sudo pacman -Syu");
      expect(q("update-manual-copy")?.textContent).toBe("Copied");
      expect(q("system-update-prompt-later")?.textContent).toBe("Close");
      await act(async () => q("system-update-prompt-later")?.click());
      expect(q("system-update-prompt")).toBeNull();
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
    console.log(`[${SUITE}:pending:${lang}] ${q("system-update-prompt")?.outerHTML}`);
    await checked(`pending-${lang}`, controls, async () => {
      expect(q("system-update-prompt")?.getAttribute("data-view")).toBe("pending");
      expect(q("system-update-prompt")?.getAttribute("role")).toBe("dialog");
      expect(q("system-update-prompt-message")?.textContent).toBe(sentence);
      expect(q("system-update-prompt-detail")).toBeNull();
      expect(q("update-manual-command")).toBeNull();
      expect(q("system-update-prompt")?.textContent).not.toMatch(/doesn't have|failed|couldn't/i);
      await act(async () => q("system-update-prompt-later")?.click());
      expect(q("system-update-prompt")).toBeNull();
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
      expect(q("system-update-prompt-message")?.textContent).toBe(sentence);
      expect(q("system-update-prompt-detail")?.textContent).toContain("Could not resolve host");
      expect(q("update-manual-command")?.textContent).toBe(HELPER_COMMAND);
    });
  });

  it("@req REL-UPD-07 without a password window: only the command, no Install", async () => {
    const controls = makeControls(systemState({ canInstall: false }));
    await mount(prompt(controls, "fr"));
    await checked("manual", controls, () => {
      expect(q("system-update-prompt-install")).toBeNull();
      expect(q("system-update-prompt-message")?.textContent).toBe(
        "Badger 0.1.9 est disponible. L'installer maintenant ? Badger ne peut pas ouvrir ici la fenêtre de mot de passe du système.",
      );
      expect(q("update-manual-command")?.textContent).toBe(HELPER_COMMAND);
    });
  });

  it("@req REL-UPD-07 Flatpak: points to flatpak update", async () => {
    const controls = makeControls(systemState({ channel: "flatpak", canInstall: false, manualCommand: "flatpak update io.spacefleet.Badger" }));
    await mount(prompt(controls));
    await checked("flatpak", controls, () => {
      expect(q("system-update-prompt-install")).toBeNull();
      expect(q("update-manual-command")?.textContent).toBe("flatpak update io.spacefleet.Badger");
    });
  });

  it("@req REL-UPD-07 automatic updates off, an AppImage copy or a blocking mandatory prompt: no prompt", async () => {
    await mount(prompt(makeControls(systemState({ autoUpdate: false }))));
    const off = q("system-update-prompt");
    await rerender(prompt(makeControls(systemState({ channel: "self" }))));
    const appImage = q("system-update-prompt");
    await rerender(<SystemUpdatePrompt controls={makeControls(systemState())} language="en" appName="Badger" blocked />);
    expect({ off, appImage, blocked: q("system-update-prompt") }).toEqual({ off: null, appImage: null, blocked: null });
  });

  it("@req REL-UPD-07 every sentence exists in the 5 languages and never translates the app's name", () => {
    const keys = Object.keys(updateSectionStrings.en);
    for (const [lang, strings] of Object.entries(updateSectionStrings)) {
      expect(Object.keys(strings).sort(), lang).toEqual([...keys].sort());
      for (const [key, value] of Object.entries(strings)) {
        expect(value, `${lang}.${key}`).not.toMatch(/\b(Badger|Parrot|Blaireau|Perroquet|Papagei|Loro|Dachs|Tejón)\b/);
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
    expect(updateSectionAction("available", "flatpak")).toBeNull();
    expect(updateSectionAction("idle", "flatpak")).toBe("check");
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
