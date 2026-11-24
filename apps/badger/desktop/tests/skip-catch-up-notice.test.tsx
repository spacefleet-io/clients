// @vitest-environment jsdom
/**
 * @req MPV-PREV-08
 *
 * The one-time "Badger now finds intros and credits" notice (EN + FR): shown while the catch-up has videos to process,
 * not when it has none, remembered per user only once closed, and "Open Jobs" opens the Jobs panel.
 */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkipCatchUpStatus } from "../src/renderer/src/lib/skipCatchUp";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

const auth = vi.hoisted(() => ({
  user: { id: "user-a" } as { id: string } | null,
}));
vi.mock("@/auth", () => ({ useAuth: () => ({ user: auth.user }) }));

import { SkipCatchUpNotice, skipCatchUpNoticeSeenKey } from "../src/renderer/src/components/SkipCatchUpNotice";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "skip-catch-up-notice";
const status = (over: Partial<SkipCatchUpStatus> = {}): SkipCatchUpStatus => ({
  state: "running",
  retryAt: null,
  handled: 0,
  total: 85,
  current: {
    formatId: "f1",
    mediaId: "b99",
    season: 1,
    episode: 1,
    running: true,
    phase: null,
    downloaded: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    progress: 0,
  },
  failed: [],
  cancelled: [],
  videos: [],
  finishedAt: null,
  ...over,
});

describe("skip-detection one-time notice (MPV-PREV-08)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let current: SkipCatchUpStatus = status();

  beforeEach(() => {
    window.localStorage.clear();
    auth.user = { id: "user-a" };
    current = status();
    (window as unknown as { sf: unknown }).sf = {
      skipCatchUp: { getStatus: () => Promise.resolve(current) },
    };
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  const render = async (lng: "en" | "fr") => {
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
          <SkipCatchUpNotice />
        </I18nextProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const notice = document.querySelector('[data-testid="skip-catch-up-notice"]');
    console.info(
      `[${SUITE}:render] lng=${lng} shown=${notice !== null} text=${JSON.stringify(notice?.textContent ?? "")}`,
    );
    return notice;
  };

  const click = async (testId: string) => {
    await act(async () => {
      (document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null)?.click();
    });
  };

  it("@req MPV-PREV-08 shown while videos remain, in English and French; Close remembers it for that user", async () => {
    const enNotice = await render("en");
    expect(enNotice?.textContent).toContain("Badger now finds intros and credits");
    expect(enNotice?.textContent).toContain("Version 0.1.58 finds intros and credits on its own");
    expect(enNotice?.textContent).toContain("Open Jobs");
    act(() => root?.unmount());
    container?.remove();

    const frNotice = await render("fr");
    expect(frNotice?.textContent).toContain("Badger repère maintenant les génériques");
    expect(frNotice?.textContent).toContain("Ouvrir les Tâches");
    // Not stored until closed: a crash here shows it again.
    expect(window.localStorage.getItem(skipCatchUpNoticeSeenKey("user-a"))).toBeNull();

    await click("skip-catch-up-notice-close");
    expect(document.querySelector('[data-testid="skip-catch-up-notice"]')).toBeNull();
    expect(window.localStorage.getItem(skipCatchUpNoticeSeenKey("user-a"))).not.toBeNull();
    act(() => root?.unmount());
    container?.remove();

    expect(await render("en")).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    auth.user = { id: "user-b" };
    expect(await render("en")).not.toBeNull();
  });

  it("@req MPV-PREV-08 not shown when the catch-up has nothing to process", async () => {
    current = status({ state: "done", handled: 85, total: 85, current: null });
    expect(await render("en")).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    current = status({ state: "done", handled: 0, total: 0, current: null });
    expect(await render("en")).toBeNull();
    expect(window.localStorage.getItem(skipCatchUpNoticeSeenKey("user-a"))).toBeNull();
  });

  it("@req MPV-PREV-08 Open Jobs closes the notice and asks the Jobs panel to open", async () => {
    const opened = vi.fn();
    window.addEventListener("sf:open-jobs", opened);
    await render("en");
    await click("skip-catch-up-notice-open-jobs");
    window.removeEventListener("sf:open-jobs", opened);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="skip-catch-up-notice"]')).toBeNull();
    expect(window.localStorage.getItem(skipCatchUpNoticeSeenKey("user-a"))).not.toBeNull();
  });
});
