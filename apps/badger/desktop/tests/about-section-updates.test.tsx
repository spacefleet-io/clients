// @vitest-environment jsdom

/**
 * Settings → About & updates (REL-UPD-05, REL-UPD-01): Badger mounts the shared update section over its own updater
 * and its window setting. The section shows the stored automatic-updates choice and a flip saves it through
 * `updateSetting("autoUpdate", …)` (which also records the user's choice and tells the main process). The section's own
 * states are tested once in packages/desktop-shell/tests/update-section.test.tsx.
 */
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { INITIAL_UPDATER_STATE } from "@space/desktop-shell/updater";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "about-section-updates";

const settings = vi.hoisted(() => ({ config: { autoUpdate: true }, updateSetting: (() => undefined) as (key: string, value: unknown) => void }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@space/desktop-shell/components", () => ({ CreditsPanel: () => null, OpenSourceNotice: () => null }));
vi.mock("@space/desktop-shell/tour", () => ({ desktopTourText: (_l: string, key: string) => key, startDesktopTour: vi.fn() }));
vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { onClick, disabled, ...rest }, children),
  Switch: ({ checked, onCheckedChange, ...rest }: { checked: boolean; onCheckedChange: (checked: boolean) => void }) =>
    React.createElement("input", {
      type: "checkbox",
      checked,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onCheckedChange(event.target.checked),
      ...rest,
    }),
}));
vi.mock("@/lib/useUpdater", () => ({
  useUpdater: () => ({
    state: { ...INITIAL_UPDATER_STATE, currentVersion: "0.1.8" },
    supported: true,
    check: vi.fn(async () => "idle"),
    download: vi.fn(async () => undefined),
    install: vi.fn(),
    setAutoUpdate: vi.fn(async () => undefined),
    runFullUpdate: vi.fn(async () => undefined),
    reset: vi.fn(),
  }),
}));
vi.mock("@/lib/settings/useClientSettings", () => ({
  useClientSettings: () => ({ config: settings.config, updateSetting: settings.updateSetting }),
}));

import AboutSection from "../src/renderer/src/components/settings/sections/AboutSection";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderSection = async (autoUpdate: boolean) => {
  settings.config = { autoUpdate };
  const updateSetting = vi.fn();
  settings.updateSetting = updateSetting;
  await act(async () => {
    root.render(React.createElement(AboutSection));
  });
  const version = container.querySelector("[data-testid='update-section-version']")?.textContent ?? null;
  const toggle = container.querySelector<HTMLInputElement>("[data-testid='settings-auto-update-switch']");
  console.info(`[${SUITE}] autoUpdate=${autoUpdate} version=${JSON.stringify(version)} checked=${toggle?.checked}`);
  return { version, toggle, updateSetting };
};

describe("Badger About & updates", () => {
  it.each([true, false])("@req REL-UPD-05 shows the installed version and the stored switch (autoUpdate=%s)", async (autoUpdate) => {
    const { version, toggle } = await renderSection(autoUpdate);
    expect(version).toBe("Version 0.1.8");
    expect(toggle?.checked).toBe(autoUpdate);
  });

  it("@req REL-UPD-01 flipping the switch saves the setting through updateSetting('autoUpdate', …)", async () => {
    const { toggle, updateSetting } = await renderSection(true);
    await act(async () => {
      toggle?.click();
    });
    const calls = updateSetting.mock.calls;
    console.info(`[${SUITE}:flip] updateSetting=${JSON.stringify(calls)}`);
    expect(calls).toEqual([["autoUpdate", false]]);
  });
});
