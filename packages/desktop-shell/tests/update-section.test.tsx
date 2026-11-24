// @vitest-environment jsdom
/**
 * @test-id DESKTOP-SHELL-UPDATE-SECTION-001
 * @level component (the real shared section and @space/ui controls; the updater controls are a plain fake)
 * @req REL-UPD-05
 * @req REL-UPD-01
 * @why Settings › About & updates is one component in both desktop apps: the installed version, what the updater is
 *   doing, ONE button whose action follows the state, and the automatic-updates switch. Each phase is rendered and
 *   its text, button and wiring checked here, so the apps' tests only prove their own wiring.
 *
 * Diagnostic logging: suite `update-section`, `dump(label)` prints the section's HTML and the fake's calls.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INITIAL_UPDATER_STATE, type UpdaterPhase, type UpdaterState } from "../src/updater/types";
import type { DesktopUpdaterControls } from "../src/updater/useUpdater";
import { DesktopUpdateSection, formatCheckedAt, updateSectionAction } from "../src/updater/UpdateSection";
import { updateErrorKey, updateSectionText } from "../src/updater/strings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "update-section";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const makeControls = (state: Partial<UpdaterState>, opts: { supported?: boolean; checkAnswer?: UpdaterPhase } = {}) => {
  const controls = {
    state: { ...INITIAL_UPDATER_STATE, currentVersion: "0.1.8", ...state },
    supported: opts.supported ?? true,
    check: vi.fn(async () => opts.checkAnswer ?? "idle"),
    download: vi.fn(async () => undefined),
    install: vi.fn(),
    setAutoUpdate: vi.fn(async () => undefined),
    runFullUpdate: vi.fn(async () => undefined),
    reset: vi.fn(),
    remindLater: vi.fn(async () => undefined),
    ignoreVersion: vi.fn(async () => undefined),
  } satisfies DesktopUpdaterControls;
  return controls;
};

const render = async (controls: DesktopUpdaterControls, language = "en", autoChecked = true) => {
  const onCheckedChange = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <DesktopUpdateSection controls={controls} language={language} appName="Badger" autoUpdate={{ checked: autoChecked, onCheckedChange }} />,
    ),
  );
  return { onCheckedChange };
};

const q = <T extends Element = HTMLElement>(testId: string) => container!.querySelector<T>(`[data-testid="${testId}"]`);

const dump = (label: string, controls?: DesktopUpdaterControls) =>
  console.info(
    `[${SUITE}:${label}] html=${container?.innerHTML ?? "(none)"}` +
      (controls
        ? ` check=${vi.mocked(controls.check).mock.calls.length} download=${vi.mocked(controls.download).mock.calls.length} install=${vi.mocked(controls.install).mock.calls.length}`
        : ""),
  );

describe("updateSectionAction", () => {
  it.each<[UpdaterPhase, string | null]>([
    ["idle", "check"],
    ["checking", "check"],
    ["error", "check"],
    ["available", "download"],
    ["downloading", "download"],
    ["downloaded", "restart"],
    ["unsupported", null],
  ])("@req REL-UPD-05 phase %s → %s", (phase, wanted) => {
    expect(updateSectionAction(phase)).toBe(wanted);
  });
});

describe("DesktopUpdateSection — each state", () => {
  const checkedAt = new Date(2026, 10, 18, 14, 5).getTime();
  it.each<[string, Partial<UpdaterState>, string, string | null, boolean]>([
    ["never checked", {}, "Not checked for updates yet.", "check", false],
    ["up to date", { lastCheckedAt: checkedAt }, "Badger is up to date · checked", "check", false],
    ["checking", { phase: "checking" }, "Checking for updates…", "check", true],
    ["available", { phase: "available", version: "0.1.9" }, "Version 0.1.9 is available.", "download", false],
    ["downloading", { phase: "downloading", version: "0.1.9", progress: 41.6 }, "Downloading version 0.1.9… 42%", "download", true],
    ["ready", { phase: "downloaded", version: "0.1.9", progress: 100 }, "Version 0.1.9 is ready to install. It installs when Badger restarts.", "restart", false],
    ["error", { phase: "error", errorMessage: "net::ERR_INTERNET_DISCONNECTED\nat stack" }, "Couldn't reach the update server. Try again later.", "check", false],
  ])("@req REL-UPD-05 %s", async (label, state, statusWanted, actionWanted, disabledWanted) => {
    const controls = makeControls(state);
    await render(controls);
    dump(label, controls);
    expect(q("update-section-version")!.textContent).toBe("Version 0.1.8");
    expect(q("update-section-status")!.textContent).toContain(statusWanted);
    expect(q("update-section-status")!.getAttribute("data-phase")).toBe(state.phase ?? "idle");
    const button = q<HTMLButtonElement>("update-section-action");
    expect(button?.getAttribute("data-action") ?? null).toBe(actionWanted);
    expect(button!.disabled).toBe(disabledWanted);
    expect(q("update-section-progress") !== null).toBe(state.phase === "downloading");
    if (state.phase === "downloading") expect(q("update-section-progress")!.getAttribute("aria-valuenow")).toBe("42");
    expect(q("settings-auto-update-switch")).not.toBeNull();
  });

  it("@req REL-UPD-05 unsupported (unpackaged, system-packaged Linux): the version and an explanation, no button, no switch", async () => {
    const controls = makeControls({ phase: "unsupported" }, { supported: true });
    await render(controls);
    dump("unsupported", controls);
    expect(q("update-section-version")!.textContent).toBe("Version 0.1.8");
    expect(q("update-section-status")!.getAttribute("data-phase")).toBe("unsupported");
    expect(q("update-section-action")).toBeNull();
    expect(q("settings-auto-update-switch")).toBeNull();
  });

  it("@req REL-UPD-05 no bridge reads as unsupported", async () => {
    const controls = makeControls({ phase: "idle" }, { supported: false });
    await render(controls);
    dump("no-bridge", controls);
    expect(q("update-section-status")!.getAttribute("data-phase")).toBe("unsupported");
    expect(q("update-section-action")).toBeNull();
  });
});

describe("DesktopUpdateSection — the button", () => {
  it("@req REL-UPD-05 Check with automatic updates off: checks, and a found version waits for Download", async () => {
    const controls = makeControls({ autoUpdate: false }, { checkAnswer: "available" });
    await render(controls, "en", false);
    await act(async () => q<HTMLButtonElement>("update-section-action")!.click());
    dump("check-manual", controls);
    expect(controls.check).toHaveBeenCalledTimes(1);
    expect(controls.download).not.toHaveBeenCalled();
  });

  it("@req REL-UPD-05 Check with automatic updates on: a found version downloads at once", async () => {
    const controls = makeControls({ autoUpdate: true }, { checkAnswer: "available" });
    await render(controls);
    await act(async () => q<HTMLButtonElement>("update-section-action")!.click());
    dump("check-auto", controls);
    expect(controls.check).toHaveBeenCalledTimes(1);
    expect(controls.download).toHaveBeenCalledTimes(1);
  });

  it("@req REL-UPD-05 Download update downloads; Restart to update installs", async () => {
    const available = makeControls({ phase: "available", version: "0.1.9" });
    await render(available);
    await act(async () => q<HTMLButtonElement>("update-section-action")!.click());
    dump("download", available);
    expect(available.download).toHaveBeenCalledTimes(1);
    expect(available.check).not.toHaveBeenCalled();
    act(() => root?.unmount());
    container?.remove();
    const ready = makeControls({ phase: "downloaded", version: "0.1.9" });
    await render(ready);
    await act(async () => q<HTMLButtonElement>("update-section-action")!.click());
    dump("restart", ready);
    expect(ready.install).toHaveBeenCalledTimes(1);
    expect(ready.download).not.toHaveBeenCalled();
  });

  it("@req REL-UPD-01 the switch shows the app's setting and reports a flip", async () => {
    const controls = makeControls({});
    const { onCheckedChange } = await render(controls, "en", true);
    const toggle = q<HTMLButtonElement>("settings-auto-update-switch")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    dump("switch", controls);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });
});

describe("strings", () => {
  it("@req REL-UPD-05 the section reads in the window's language, regional tags included, English otherwise", async () => {
    const controls = makeControls({ phase: "available", version: "0.1.9" });
    await render(controls, "fr-FR");
    dump("fr", controls);
    expect(q("update-section-status")!.textContent).toContain("La version 0.1.9 est disponible.");
    expect(q("update-section-action")!.textContent).toBe("Télécharger la mise à jour");
    expect(updateSectionText("xx", "check")).toBe("Check for updates");
    for (const language of ["en", "fr", "nl", "de", "es"]) {
      const text = updateSectionText(language, "upToDate", { app: "Parrot", time: "14:05" });
      console.info(`[${SUITE}:strings] ${language} upToDate=${JSON.stringify(text)}`);
      expect(text).toContain("Parrot");
      expect(text).toContain("14:05");
    }
  });

  it("@req REL-UPD-05 a check today shows the time only; an older one shows the date too", () => {
    const now = new Date(2026, 10, 18, 18, 0).getTime();
    const today = formatCheckedAt(new Date(2026, 10, 18, 14, 5).getTime(), "en", now);
    const older = formatCheckedAt(new Date(2026, 10, 12, 14, 5).getTime(), "en", now);
    console.info(`[${SUITE}:time] today=${JSON.stringify(today)} older=${JSON.stringify(older)}`);
    expect(today).not.toContain("Nov");
    expect(older).toContain("Nov");
  });

  it("@req REL-UPD-05 a failure shows a plain sentence, never the updater's raw message", async () => {
    const cases: Array<[string, string]> = [
      ["HttpError: 500 Internal Server Error\n\"method: GET url: https://api.spacefleet.io/desktop/parrot/latest-linux.yml\"", "errorNetwork"],
      ["net::ERR_INTERNET_DISCONNECTED", "errorNetwork"],
      ["getaddrinfo ENOTFOUND api.spacefleet.io", "errorNetwork"],
      ["Cannot find channel \"latest-linux.yml\" update info: HttpError: 404", "errorNetwork"],
      ["sha512 checksum mismatch, expected abc, got def", "errorIntegrity"],
      ["New version 0.1.9 is not signed by the application owner: publisherNames: PENA Chris-Alexandre", "errorIntegrity"],
      ["ENOSPC: no space left on device, write", "errorDisk"],
      [
        "Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again. If you're on macOS Sierra or later, you'll need to move the application out of the Downloads directory. See https://github.com/Squirrel/Squirrel.Mac/issues/182 for more information.",
        "errorReadOnly",
      ],
      ["update_failed", "errorOther"],
    ];
    for (const [raw, key] of cases) {
      console.info(`[${SUITE}:error-key] ${JSON.stringify(raw.split("\n")[0])} -> ${updateErrorKey(raw)}`);
      expect(updateErrorKey(raw)).toBe(key);
    }
    const controls = makeControls({ phase: "error", errorMessage: cases[0][0] });
    await render(controls);
    dump("error-raw", controls);
    const shown = q("update-section-status")!.textContent ?? "";
    expect(shown).toContain("Couldn't reach the update server. Try again later.");
    expect(shown).not.toMatch(/500|HttpError|Internal Server Error|https:/);
    for (const language of ["en", "fr", "nl", "de", "es"])
      for (const key of ["errorNetwork", "errorIntegrity", "errorDisk", "errorReadOnly", "errorOther"] as const)
        expect(updateSectionText(language, key, { app: "Badger" })).not.toMatch(/\{\w+\}/);
  });
});
