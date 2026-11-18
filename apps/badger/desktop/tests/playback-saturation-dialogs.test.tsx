// @vitest-environment jsdom
/**
 * @req STOR-BW-07
 * @req STOR-BW-08
 *
 * The two dialogs of a saturated silo (EN + FR): "too much traffic" when it refuses a new playback, "playback stopped"
 * when it stops the one in progress. Each offers "Upgrade plan" and "Close"; nothing resumes by itself, the dialog only
 * closes when the user closes it. Wording never blames a time of day.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlaybackSaturationDialogs from "../src/renderer/src/components/PlaybackSaturationDialogs";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Props = React.ComponentProps<typeof PlaybackSaturationDialogs>;

describe("saturated silo dialogs (STOR-BW-07, STOR-BW-08)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  const mount = async (lng: "en" | "fr", props: Props) => {
    const i18n = createInstance();
    await i18n.init({
      lng,
      fallbackLng: "en",
      resources: { en: { translation: en }, fr: { translation: fr } },
      interpolation: { escapeValue: false },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = async (next: Props) => {
      await act(async () => {
        root?.render(
          <I18nextProvider i18n={i18n}>
            <PlaybackSaturationDialogs {...next} />
          </I18nextProvider>,
        );
        await Promise.resolve();
      });
    };
    await render(props);
    return render;
  };

  const dialog = () => document.body.querySelector('[role="dialog"]');
  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = "";
  });

  it("shows nothing until something happens", async () => {
    await mount("en", { refusals: 0, stops: 0, onUpgrade: vi.fn() });
    expect(dialog()).toBeNull();
  });

  it("does not open for events that were already counted when it mounted", async () => {
    await mount("en", { refusals: 4, stops: 2, onUpgrade: vi.fn() });
    expect(dialog()).toBeNull();
  });

  it("opens the refusal dialog when a new playback is refused, with Upgrade plan and Close", async () => {
    const render = await mount("en", { refusals: 0, stops: 0, onUpgrade: vi.fn() });
    await render({ refusals: 1, stops: 0, onUpgrade: vi.fn() });
    expect(dialog()?.textContent).toContain("Too much traffic right now");
    expect(dialog()?.textContent).toContain("Paid plans keep priority during busy periods.");
    expect(button("Upgrade plan")).not.toBeNull();
    expect(button("Close")).not.toBeNull();
    expect(dialog()?.textContent?.toLowerCase()).not.toContain("evening");
  });

  it("opens the stopped dialog when the silo stops the playback in progress, and says nothing resumes by itself", async () => {
    const render = await mount("en", { refusals: 0, stops: 0, onUpgrade: vi.fn() });
    await render({ refusals: 0, stops: 1, onUpgrade: vi.fn() });
    expect(dialog()?.textContent).toContain("Playback stopped: high traffic");
    expect(dialog()?.textContent).not.toContain("resume");
  });

  it("stays open until the user closes it, then opens again on the next refusal", async () => {
    const render = await mount("en", { refusals: 0, stops: 0, onUpgrade: vi.fn() });
    await render({ refusals: 1, stops: 0, onUpgrade: vi.fn() });
    await render({ refusals: 1, stops: 0, onUpgrade: vi.fn() });
    expect(dialog()).not.toBeNull();
    await act(async () => button("Close")?.click());
    expect(dialog()).toBeNull();
    await render({ refusals: 2, stops: 0, onUpgrade: vi.fn() });
    expect(dialog()).not.toBeNull();
  });

  it("sends the user to the plans on Upgrade plan and closes", async () => {
    const onUpgrade = vi.fn();
    const render = await mount("en", { refusals: 0, stops: 0, onUpgrade });
    await render({ refusals: 0, stops: 1, onUpgrade });
    await act(async () => button("Upgrade plan")?.click());
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("speaks French and never mentions the soir", async () => {
    const render = await mount("fr", { refusals: 0, stops: 0, onUpgrade: vi.fn() });
    await render({ refusals: 0, stops: 1, onUpgrade: vi.fn() });
    expect(dialog()?.textContent).toContain("Lecture arrêtée : trafic élevé");
    expect(dialog()?.textContent?.toLowerCase()).not.toContain("soir");
    expect(button("Passer à une offre payante")).not.toBeNull();
    expect(button("Fermer")).not.toBeNull();
  });

  it("carries the quality cap toast wording in both languages", () => {
    expect(en.player.capToast480p).toBe("Too much traffic right now: playing at up to 480p.");
    expect(fr.player.capToast480p).toBe("Trop de trafic en ce moment : lecture en 480p maximum.");
    expect(en.player.capToast1080p).toBe("High traffic: your plan plays at up to 1080p right now.");
    expect(fr.player.capToast1080p).toBe("Trafic élevé : votre offre lit en 1080p maximum pour le moment.");
  });
});
