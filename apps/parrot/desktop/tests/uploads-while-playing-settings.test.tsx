// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-UPLOADS-WHILE-PLAYING-001
 * @level integration (real SettingsPage and translator; `window.parrot` mocked)
 * @req PAR-UP-15
 * @why Chris played songs while the Artie Shaw album imported (2026-11-26): imports now share Badger's playback gate,
 *   and Settings → General lets each computer pick what imports do while a song plays (full speed, slowed down,
 *   paused), with this computer's hardware recommendation marked.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/renderer/src/AccountSettings";
import { PARROT_STRINGS, translator } from "../src/renderer/src/i18n";
import type { ParrotUploadsWhilePlaying } from "../src/shared/ipc";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-UPLOADS-WHILE-PLAYING-001]";
const SELECT = '[data-testid="settings-uploads-while-playing"]';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <SettingsPage
        t={translator("en")}
        email="parrot-test@example.test"
        userId="u-test"
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
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  Reflect.deleteProperty(window, "parrot");
});

describe("@req PAR-UP-15 Parrot desktop Settings → General: uploads while a song plays", () => {
  it("shows this computer's mode, marks the recommendation and saves a change", async () => {
    const answer: ParrotUploadsWhilePlaying = { mode: "throttle", recommended: "throttle", picked: false };
    const set = vi.fn(async (mode: ParrotUploadsWhilePlaying["mode"]) => ({ ...answer, mode, picked: true }));
    Object.assign(window, { parrot: { getUploadsWhilePlaying: vi.fn(async () => answer), setUploadsWhilePlaying: set } });
    await mount();
    const select = container!.querySelector<HTMLSelectElement>(SELECT);
    console.info(`${SUITE} options=${JSON.stringify([...(select?.options ?? [])].map((o) => [o.value, o.textContent]))}`);
    expect(select).not.toBeNull();
    expect(container!.textContent).toContain("Imports while a song plays");
    expect(select!.value).toBe("throttle");
    const labels = Object.fromEntries([...select!.options].map((o) => [o.value, o.textContent]));
    expect(labels).toEqual({ full: "Full speed", throttle: "Slowed down (recommended)", pause: "Paused until the song stops" });

    await act(async () => {
      select!.value = "pause";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(set).toHaveBeenLastCalledWith("pause");
    expect(container!.querySelector<HTMLSelectElement>(SELECT)!.value).toBe("pause");
  });

  it("hides the row without the preload bridge", async () => {
    await mount();
    expect(container!.querySelector(SELECT)).toBeNull();
  });

  it("every language has the words, French with its spacing", () => {
    const keys = ["settings.uploadsWhilePlaying", "settings.uploadsWhilePlayingBody", "settings.uploadsWhilePlaying.full", "settings.uploadsWhilePlaying.throttle", "settings.uploadsWhilePlaying.pause", "settings.uploadsWhilePlaying.recommended"];
    for (const lang of ["fr", "nl", "de", "es"] as const) {
      const strings: Record<string, string> = PARROT_STRINGS[lang];
      for (const key of keys) {
        expect(strings[key], `${lang} ${key}`).toBeTruthy();
        expect(strings[key], `${lang} ${key}`).not.toBe((PARROT_STRINGS.en as Record<string, string>)[key]);
      }
    }
    expect(translator("fr")("settings.uploadsWhilePlaying.recommended", { mode: "Ralenties" })).toBe("Ralenties (recommandé)");
  });
});
