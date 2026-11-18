// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-ERROR-REPORTS-SETTINGS-001
 * @level integration (real SettingsPage, shared hook and renderer error reports; `window.parrot` and the SDK adapter mocked)
 * @req REL-LOG-06
 * @why Parrot desktop asked "send error reports?" only once, in setup; nothing let the user change the answer later.
 *   Settings → General now has the switch: it shows main's answer, saves a change through the preload bridge and
 *   starts or stops this window's reporting at once. Without a bridge (browser build) the row is not shown.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorReportsState } from "@space/error-report/desktop";
import { SettingsPage } from "../src/renderer/src/AccountSettings";
import { PARROT_STRINGS } from "../src/renderer/src/i18n";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-ERROR-REPORTS-SETTINGS-001]";

const adapter = vi.hoisted(() => ({ setEnabled: vi.fn(async (_enabled: boolean) => undefined), create: vi.fn() }));
vi.mock("@space/error-report/electron-renderer", () => ({
  createElectronRendererReporting: ({ release, app }: { release: string; app: string }) => {
    adapter.create(release, app);
    return { setEnabled: adapter.setEnabled, isEnabled: () => false };
  },
}));

const SWITCH = '[data-testid="settings-error-reports-switch"]';
const EN: Record<string, string> = PARROT_STRINGS.en;
const t = (key: string) => EN[key] ?? key;
const stored = (decision: ErrorReportsState["decision"]): ErrorReportsState => ({ decision, available: true, release: "9.9.9" });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <SettingsPage
        t={t as never}
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
  });
};

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  Reflect.deleteProperty(window, "parrot");
});

describe("@req REL-LOG-06[parrot] Parrot desktop Settings → General error reports switch", () => {
  it("shows the stored answer, says what is sent, saves a change and starts reporting live", async () => {
    const set = vi.fn(async (decision: "on" | "off") => stored(decision));
    Object.assign(window, { parrot: { errorReports: { get: vi.fn(async () => stored("undecided")), set } } });
    await mount();

    const text = container!.textContent ?? "";
    console.info(`${SUITE} text has title=${text.includes(t("settings.errorReports"))}`);
    expect(text).toContain(t("settings.errorReports"));
    expect(text).toContain(t("settings.errorReportsBody"));
    // One short line (anonymous, helps a lot, smiley) and the "What's in a report?" link to the privacy policy.
    expect(t("settings.errorReportsBody")).toBe("Reports are anonymous and help us a lot to fix bugs 🙂");
    const link = container!.querySelector<HTMLAnchorElement>('[data-testid="settings-error-reports-link"]');
    console.info(`${SUITE} link href=${link?.getAttribute("href")} text=${link?.textContent}`);
    expect(link?.textContent).toBe(t("settings.errorReportsLink"));
    expect(link?.getAttribute("href")).toBe("https://spacefleet.io/en/privacy#error-reports");
    for (const lang of ["fr", "nl", "de"] as const) {
      const strings: Record<string, string> = PARROT_STRINGS[lang];
      expect(strings["settings.errorReportsBody"]).toMatch(/🙂$/);
      expect(strings["settings.errorReportsLink"]).not.toBe(t("settings.errorReportsLink"));
    }

    const toggle = () => container!.querySelector<HTMLButtonElement>(SWITCH);
    expect(toggle()).not.toBeNull();
    // An unanswered question reads as off, and nothing was loaded or started.
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
    expect(toggle()!.disabled).toBe(false);
    expect(adapter.create).not.toHaveBeenCalled();

    await act(async () => toggle()!.click());
    await flush();
    console.info(`${SUITE} after on: set=${JSON.stringify(set.mock.calls)} adapter=${JSON.stringify(adapter.create.mock.calls)}`);
    expect(set).toHaveBeenLastCalledWith("on");
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
    expect(adapter.create).toHaveBeenCalledWith("9.9.9", "parrot");
    expect(adapter.setEnabled).toHaveBeenLastCalledWith(true);

    await act(async () => toggle()!.click());
    await flush();
    expect(set).toHaveBeenLastCalledWith("off");
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
    expect(adapter.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("is disabled while the answer loads and shows 'on' when main stored it", async () => {
    const answer = Promise.withResolvers<ErrorReportsState>();
    const get = vi.fn(() => answer.promise);
    Object.assign(window, { parrot: { errorReports: { get, set: vi.fn() } } });
    await mount();
    expect(container!.querySelector<HTMLButtonElement>(SWITCH)!.disabled).toBe(true);
    await act(async () => answer.resolve(stored("on")));
    const toggle = container!.querySelector<HTMLButtonElement>(SWITCH)!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("hides the row without the preload bridge", async () => {
    await mount();
    expect(container!.querySelector(SWITCH)).toBeNull();
  });
});
