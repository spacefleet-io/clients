// @vitest-environment jsdom
/**
 * @req STOR-BW-01
 * @req STOR-BW-09
 *
 * The jobs sidebar tells the user why offline downloads are not at full speed (EN + FR), keyed on the job stage code:
 * slowed in a high-traffic period (STOR-BW-01, downloads only slowed, never stopped) or held while the silo is
 * saturated (STOR-BW-09, resumes by itself). The wording never blames a time of day nor says "saturated".
 */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { HELD_SATURATED_STAGE_CODE, SLOWED_HIGH_TRAFFIC_STAGE_CODE } from "@space/shared/storageTrafficStage";
import HighTrafficDownloadsNotice, {
  isHeldForSaturation,
  isSlowedForHighTraffic,
} from "../src/renderer/src/components/HighTrafficDownloadsNotice";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const EN_HELD = "Downloads are on hold while traffic is very high. They resume on their own as soon as it drops.";
const FR_HELD = "Les téléchargements sont suspendus tant que le trafic est très élevé. Ils reprennent d'eux-mêmes dès qu'il baisse.";
const EN_SLOWED = "Downloads are slower because we're in a high-traffic period.";
const FR_SLOWED = "Les téléchargements sont plus lents car nous sommes en période de fort trafic.";

const HELD = '[data-testid="downloads-held-notice"]';
const SLOWED = '[data-testid="downloads-slowed-notice"]';

type Job = { status: string; stageCode?: string | null };
const running = (stageCode: string): Job => ({ status: "running", stageCode });

describe("high-traffic downloads notice (STOR-BW-01, STOR-BW-09)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const render = async (lng: "en" | "fr", jobs: Job[]) => {
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
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <HighTrafficDownloadsNotice jobs={jobs} />
        </I18nextProvider>
      );
      await Promise.resolve();
    });
    return container;
  };

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("shows the English slowed notice and never mentions the evening or saturation", async () => {
    const view = await render("en", [running(SLOWED_HIGH_TRAFFIC_STAGE_CODE)]);
    const notice = view.querySelector(SLOWED);
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toBe(EN_SLOWED);
    expect(notice?.textContent?.toLowerCase()).not.toContain("evening");
    expect(notice?.textContent?.toLowerCase()).not.toContain("saturated");
    expect(view.querySelector(HELD)).toBeNull();
  });

  it("shows the French slowed notice and never mentions the soir or saturation", async () => {
    const view = await render("fr", [running(SLOWED_HIGH_TRAFFIC_STAGE_CODE)]);
    const notice = view.querySelector(SLOWED);
    expect(notice?.textContent).toBe(FR_SLOWED);
    expect(notice?.textContent?.toLowerCase()).not.toContain("soir");
    expect(notice?.textContent?.toLowerCase()).not.toContain("saturé");
  });

  it("shows the English held notice and never mentions the evening or saturation", async () => {
    const view = await render("en", [running(HELD_SATURATED_STAGE_CODE)]);
    const notice = view.querySelector(HELD);
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toBe(EN_HELD);
    expect(notice?.textContent?.toLowerCase()).not.toContain("evening");
    expect(notice?.textContent?.toLowerCase()).not.toContain("saturated");
    expect(view.querySelector(SLOWED)).toBeNull();
  });

  it("shows the French held notice and never mentions the soir or saturation", async () => {
    const view = await render("fr", [running(HELD_SATURATED_STAGE_CODE)]);
    const notice = view.querySelector(HELD);
    expect(notice?.textContent).toBe(FR_HELD);
    expect(notice?.textContent?.toLowerCase()).not.toContain("soir");
    expect(notice?.textContent?.toLowerCase()).not.toContain("saturé");
  });

  it("shows only the held notice when held and slowed jobs coexist", async () => {
    const view = await render("en", [running(SLOWED_HIGH_TRAFFIC_STAGE_CODE), running(HELD_SATURATED_STAGE_CODE)]);
    expect(view.querySelector(HELD)?.textContent).toBe(EN_HELD);
    expect(view.querySelector(SLOWED)).toBeNull();
  });

  it("renders nothing when no job is held or slowed", async () => {
    const view = await render("en", [running("downloading")]);
    expect(view.querySelector(HELD)).toBeNull();
    expect(view.querySelector(SLOWED)).toBeNull();
  });

  it("is driven only by a live job in the held stage", () => {
    expect(isHeldForSaturation(running(HELD_SATURATED_STAGE_CODE))).toBe(true);
    expect(isHeldForSaturation({ status: "queued", stageCode: HELD_SATURATED_STAGE_CODE })).toBe(true);
    expect(isHeldForSaturation(running("downloading"))).toBe(false);
    expect(isHeldForSaturation(running(SLOWED_HIGH_TRAFFIC_STAGE_CODE))).toBe(false);
    // A job that ended while held keeps its last stageCode but is no longer held.
    expect(isHeldForSaturation({ status: "failed", stageCode: HELD_SATURATED_STAGE_CODE })).toBe(false);
    expect(isHeldForSaturation({ status: "cancelled", stageCode: HELD_SATURATED_STAGE_CODE })).toBe(false);
  });

  it("is driven only by a live job in the slowed stage", () => {
    expect(isSlowedForHighTraffic(running(SLOWED_HIGH_TRAFFIC_STAGE_CODE))).toBe(true);
    expect(isSlowedForHighTraffic({ status: "queued", stageCode: SLOWED_HIGH_TRAFFIC_STAGE_CODE })).toBe(true);
    expect(isSlowedForHighTraffic(running("downloading"))).toBe(false);
    expect(isSlowedForHighTraffic(running(HELD_SATURATED_STAGE_CODE))).toBe(false);
    expect(isSlowedForHighTraffic({ status: "completed", stageCode: SLOWED_HIGH_TRAFFIC_STAGE_CODE })).toBe(false);
    expect(isSlowedForHighTraffic({ status: "failed", stageCode: SLOWED_HIGH_TRAFFIC_STAGE_CODE })).toBe(false);
  });
});
