// @vitest-environment jsdom
/**
 * @req STOR-BW-07
 * @req STOR-BW-08
 *
 * `PlaybackSaturationHost` mounts the refused / stopped dialogs with the live state. It is mounted from
 * AuthenticatedApp behind `lazy`, not from TopNav: the dialogs and the code they pull in must not weigh on the TopNav
 * chunk (renderer chunk budget, `check-renderer-budgets-lib.mjs`). A refusal or a stop opens its dialog, an event
 * counted before the host mounted opens nothing, and "Upgrade plan" opens Settings.
 */
import React from "react";
import { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

import PlaybackSaturationHost from "../src/renderer/src/components/PlaybackSaturationHost";
import en from "../src/renderer/src/i18n/en.json";
import type { PlaybackSaturationState } from "../src/shared/playbackSaturation";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Bridge = {
  getPlaybackSaturationState: () => Promise<PlaybackSaturationState>;
  onPlaybackSaturationChange: (cb: (s: PlaybackSaturationState) => void) => () => void;
};
const testWindow = window as unknown as { sf?: Bridge };

const rendererSource = (file: string) => readFileSync(path.resolve(__dirname, "../src/renderer/src", file), "utf8");

describe("playback saturation host (STOR-BW-07, STOR-BW-08)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let push: (s: PlaybackSaturationState) => void = () => undefined;

  const mount = async (initial: PlaybackSaturationState = { qualityCap: null, refusals: 0, stops: 0 }) => {
    testWindow.sf = {
      getPlaybackSaturationState: async () => initial,
      onPlaybackSaturationChange: (cb) => {
        push = cb;
        return () => undefined;
      },
    };
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <PlaybackSaturationHost />
        </I18nextProvider>,
      );
      await Promise.resolve();
    });
  };

  const emit = (state: PlaybackSaturationState) => act(async () => push(state));
  const dialog = () => document.body.querySelector('[role="dialog"]');

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = "";
    delete testWindow.sf;
    navigate.mockClear();
  });

  it("is kept out of the TopNav chunk: TopNav does not import it, AuthenticatedApp loads it lazily", () => {
    const topNav = rendererSource("components/TopNav.tsx");
    expect(topNav).not.toMatch(/PlaybackSaturation/);
    expect(rendererSource("AuthenticatedApp.tsx")).toMatch(
      /const PlaybackSaturationHost = lazy\(\(\) => import\("\.\/components\/PlaybackSaturationHost"\)\)/,
    );
  });

  it("opens the refusal dialog on the first refusal", async () => {
    await mount();
    await emit({ qualityCap: "480p", refusals: 1, stops: 0 });
    expect(dialog()?.textContent).toContain("Too much traffic right now");
  });

  it("opens the stopped dialog on the first stop", async () => {
    await mount();
    await emit({ qualityCap: "480p", refusals: 0, stops: 1 });
    expect(dialog()?.textContent).toContain("Playback stopped: high traffic");
  });

  it("shows nothing while only a quality cap applies", async () => {
    await mount();
    await emit({ qualityCap: "1080p", refusals: 0, stops: 0 });
    expect(dialog()).toBeNull();
  });

  it("does not react to events that happened before it mounted", async () => {
    await mount({ qualityCap: "480p", refusals: 3, stops: 2 });
    expect(dialog()).toBeNull();
    await emit({ qualityCap: "480p", refusals: 3, stops: 2 });
    expect(dialog()).toBeNull();
    await emit({ qualityCap: "480p", refusals: 4, stops: 2 });
    expect(dialog()).not.toBeNull();
  });

  it("sends Upgrade plan to Settings", async () => {
    await mount();
    await emit({ qualityCap: null, refusals: 1, stops: 0 });
    const upgrade = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Upgrade plan");
    await act(async () => upgrade?.click());
    expect(navigate).toHaveBeenCalledWith("/settings");
  });
});
