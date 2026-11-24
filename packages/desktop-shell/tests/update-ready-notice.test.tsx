// @vitest-environment jsdom
/**
 * @test-id DESKTOP-SHELL-UPDATE-READY-NOTICE-001
 * @level component (the real shared card and @space/ui buttons; the updater controls are a fake)
 * @req REL-UPD-01
 * @why Badger and Parrot desktop show one "update ready" card once a version has downloaded in the background:
 *   "Restart now" installs, "Later" hides it for that version only, and a mandatory update or the app's own blocking
 *   update prompt keeps it hidden. A download without a version still reads as a sentence.
 *
 * Diagnostic logging: suite `update-ready-notice`, `dump(label)` prints the rendered HTML and the fake's calls.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { INITIAL_UPDATER_STATE, type UpdaterState } from "../src/updater/types";
import type { DesktopUpdaterControls } from "../src/updater/useUpdater";
import { DesktopUpdateReadyNotice, type DesktopUpdateReadyNoticeProps } from "../src/updater/UpdateReadyNotice";
import { updateSectionStrings } from "../src/updater/strings";
import { CLIENT_UI_LANGUAGES } from "@space/shared/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "update-ready-notice";

let container: HTMLDivElement;
let root: Root;
let install: Mock<() => void>;

const controls = (state: Partial<UpdaterState>): DesktopUpdaterControls => ({
  state: { ...INITIAL_UPDATER_STATE, phase: "downloaded", version: "1.4.0", progress: 100, ...state },
  supported: true,
  check: vi.fn(async () => "downloaded" as const),
  download: vi.fn(async () => undefined),
  install,
  setAutoUpdate: vi.fn(async () => undefined),
  runFullUpdate: vi.fn(async () => undefined),
  reset: vi.fn(),
});

const render = (state: Partial<UpdaterState>, props: Partial<DesktopUpdateReadyNoticeProps> = {}) =>
  act(() => {
    root.render(<DesktopUpdateReadyNotice controls={controls(state)} language="en" appName="Parrot" {...props} />);
  });

const notice = () => container.querySelector<HTMLElement>("[data-testid='update-ready-notice']");
const button = (label: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label);
const dump = (label: string) =>
  console.info(`[${SUITE}:${label}] install.calls=${install.mock.calls.length} html=${container.innerHTML || "(empty)"}`);

beforeEach(() => {
  install = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DesktopUpdateReadyNotice", () => {
  // @req REL-UPD-01
  it.each(["idle", "checking", "available", "downloading", "installing", "error", "unsupported"] as const)(
    "stays hidden in phase %s",
    (phase) => {
      render({ phase });
      dump(`hidden-${phase}`);
      expect(notice()).toBeNull();
    },
  );

  // @req REL-UPD-01
  it("stays hidden for a mandatory update and while the app's blocking prompt is up", () => {
    render({ mandatory: true });
    dump("hidden-mandatory");
    expect(notice()).toBeNull();
    render({}, { blocked: true });
    dump("hidden-blocked");
    expect(notice()).toBeNull();
    render({}, { blocked: false });
    dump("shown-unblocked");
    expect(notice()).not.toBeNull();
  });

  // @req REL-UPD-01
  it("names the app and the downloaded version, and Restart now installs", async () => {
    render({ version: "2.1.0" });
    dump("restart");
    const card = notice();
    expect(card?.getAttribute("role")).toBe("status");
    expect(card?.textContent).toContain("Update ready");
    expect(card?.textContent).toContain("Parrot 2.1.0 has downloaded. It installs the next time you quit Parrot.");
    const restart = container.querySelector<HTMLButtonElement>("[data-testid='update-ready-restart']");
    expect(restart?.textContent).toBe("Restart now");
    await act(async () => restart!.click());
    dump("restart-clicked");
    expect(install).toHaveBeenCalledTimes(1);
  });

  // @req REL-UPD-01
  it("a download without a version still reads as a sentence, and Later hides it", async () => {
    render({ version: null });
    dump("no-version");
    expect(notice()?.textContent).toContain("A new version of Parrot has downloaded.");
    expect(notice()?.textContent).not.toContain("Parrot  has");
    await act(async () => button("Later")!.click());
    dump("no-version-later");
    expect(notice()).toBeNull();
  });

  // @req REL-UPD-01
  it("Later hides the card for that version only; a newer download shows it again", async () => {
    render({ version: "1.4.0" }, { appName: "Badger" });
    await act(async () => button("Later")!.click());
    dump("later");
    expect(notice()).toBeNull();
    expect(install).not.toHaveBeenCalled();
    render({ version: "1.5.0" }, { appName: "Badger" });
    dump("newer");
    expect(notice()?.textContent).toContain("Badger 1.5.0 has downloaded.");
  });

  // @req REL-UPD-01
  it("speaks the window's language and keeps the product name", () => {
    render({ version: "3.0.0" }, { language: "fr-FR" });
    dump("fr");
    expect(notice()?.textContent).toContain("Parrot 3.0.0 est téléchargé.");
    expect(button("Plus tard")).toBeDefined();
    expect(button("Redémarrer maintenant")).toBeDefined();
    for (const { code: language } of CLIENT_UI_LANGUAGES) {
      const strings = updateSectionStrings[language];
      console.info(`[${SUITE}:languages] ${language} readyBody=${strings.readyBody}`);
      expect(strings.readyBody).toContain("{app}");
      expect(strings.readyBody).toContain("{version}");
      expect(strings.readyBodyCurrent).toContain("{app}");
      expect(strings.readyBodyCurrent).not.toContain("{version}");
    }
  });

  // @req REL-UPD-01
  it("sits in the bottom-right corner unless the app places it", () => {
    render({});
    expect(notice()?.className).toContain("bottom-4 right-4");
    render({}, { className: "bottom-24 right-4" });
    dump("placed");
    expect(notice()?.className).toContain("bottom-24 right-4");
    expect(notice()?.className).not.toContain("bottom-4 ");
  });
});
