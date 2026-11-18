// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-EVEN-VOLUME-SETTINGS-001
 * @level integration (real SettingsPage and setting store over jsdom's localStorage)
 * @req PAR-PLAY-03
 * @why Listening test, Chris 2026-11-11: songs must play as recorded. Evening the volume is now a Settings switch,
 *   off by default, with Spotify's three levels under it; the choice is kept per account on this computer.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { parrotEvenVolumeStorageKey } from "@space/parrot-core";
import { SettingsPage } from "../src/renderer/src/AccountSettings";
import { PARROT_STRINGS } from "../src/renderer/src/i18n";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-EVEN-VOLUME-SETTINGS-001]";
const SWITCH = '[data-testid="settings-even-volume-switch"]';
const LEVEL = '[data-testid="settings-even-volume-level"]';
const EN: Record<string, string> = PARROT_STRINGS.en;
const t = (key: string) => EN[key] ?? key;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const mount = async (userId: string) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <SettingsPage
        t={t as never}
        email="parrot-test@example.test"
        userId={userId}
        language="en"
        onState={() => undefined}
        onPlan={() => undefined}
        onPair={() => undefined}
        onFeedback={() => undefined}
        onTour={() => undefined}
        onRefresh={() => undefined}
        onSignOut={() => undefined}
      />,
    );
  });
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  localStorage.clear();
});

describe("@req PAR-PLAY-03 Parrot desktop Settings → General: Even out volume", () => {
  it("is off by default, shows the three levels once on, and keeps the choice per account", async () => {
    console.info(`${SUITE} phase: first open, nothing stored`);
    await mount("u-1");
    const toggle = () => container!.querySelector<HTMLButtonElement>(SWITCH)!;
    const level = () => container!.querySelector<HTMLSelectElement>(LEVEL);
    const text = container!.textContent ?? "";
    expect(text).toContain(t("settings.evenVolume"));
    expect(text).toContain(t("settings.evenVolumeBody"));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(level()).toBeNull();

    console.info(`${SUITE} phase: switch on`);
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(level()!.value).toBe("normal");
    expect([...level()!.options].map((option) => option.textContent)).toEqual([t("settings.evenVolumeLevels.loud"), t("settings.evenVolumeLevels.normal"), t("settings.evenVolumeLevels.quiet")]);
    console.info(`${SUITE} stored after on: ${localStorage.getItem(parrotEvenVolumeStorageKey("u-1"))}`);
    expect(JSON.parse(localStorage.getItem(parrotEvenVolumeStorageKey("u-1"))!)).toEqual({ on: true, level: "normal" });

    console.info(`${SUITE} phase: pick Loud`);
    await act(async () => {
      level()!.value = "loud";
      level()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(JSON.parse(localStorage.getItem(parrotEvenVolumeStorageKey("u-1"))!)).toEqual({ on: true, level: "loud" });

    console.info(`${SUITE} phase: another account on this computer still has it off`);
    act(() => root?.unmount());
    container?.remove();
    await mount("u-2");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
});
