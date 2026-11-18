// @vitest-environment jsdom
/**
 * REL-LOG-06: the First setup flow has an error-reports step. It is asked only while the question is
 * unanswered, recommends nothing (no recommendation line, no badge), starts on "Do not send" so Finish
 * is enabled at once (Chris 2026-11-11), and stores the pick through the preload bridge only at Finish.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import FirstSetup from "../src/renderer/src/components/FirstSetup";
import {
  FIRST_SETUP_STEPS,
  loadFirstSetup,
  openFirstSetupSteps,
  saveFirstSetup,
  type FirstSetupDevice,
} from "../src/renderer/src/components/firstSetupSteps";
import type { DeviceTranscodeSettings } from "../src/shared/transcodeDefault";
import type { DeviceUploadsDuringPlaybackSettings } from "../src/shared/uploadPlaybackDefault";
import type { ErrorReportsState } from "@space/error-report/desktop";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const P = "[first-setup-error-reports]";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    // Mirrors the locales: the error-reports choices have no description string (checked against en/fr/de/nl below).
    i18n: { language: "fr", exists: (key: string) => !key.startsWith("firstSetup.steps.errorReports.options.") },
  }),
}));
vi.mock("@/assets/mascot.webp", () => ({ default: "mascot.webp" }));
vi.mock("../src/renderer/src/lib/onboarding", () => ({ isLibraryKeyAcknowledged: async () => true }));

// The renderer adapter must never really load here; a spy proves what a pick starts.
const adapter = vi.hoisted(() => ({ setEnabled: vi.fn(async (_enabled: boolean) => undefined), create: vi.fn() }));
vi.mock("@space/error-report/electron-renderer", () => ({
  createElectronRendererReporting: ({ release }: { release: string }) => {
    adapter.create(release);
    return { setEnabled: adapter.setEnabled, isEnabled: () => false };
  },
}));

const state = (decision: ErrorReportsState["decision"]): ErrorReportsState => ({ decision, available: true, release: "9.9.9" });

const transcode = (over: Partial<DeviceTranscodeSettings> = {}): DeviceTranscodeSettings => ({
  fallbackCopy: false,
  answered: true,
  answer: "accepted",
  recommendation: { fallbackCopy: false, reason: "weak", hardware: null, detectedAt: "2026-10-13T00:00:00.000Z" },
  updatedAt: "2026-10-13T00:00:00.000Z",
  ...over,
});

// Left unanswered on purpose: the uploads question is no longer part of First setup.
const uploads = (): DeviceUploadsDuringPlaybackSettings => ({
  mode: "full",
  answered: false,
  answer: null,
  recommendation: { mode: "full", reason: "strong", hardware: null, detectedAt: "2026-10-13T00:00:00.000Z" },
  updatedAt: "2026-10-13T00:00:00.000Z",
});

const installBridges = (decision: ErrorReportsState["decision"], over: { setFails?: boolean } = {}) => {
  const errorReports = {
    get: vi.fn(async () => state(decision)),
    set: vi.fn(async (next: "on" | "off") => {
      console.info(`${P}:bridge set(${next})`);
      if (over.setFails) throw new Error("disk full");
      return state(next);
    }),
  };
  const deviceSettings = {
    getTranscode: vi.fn(async () => transcode()),
    getUploadsDuringPlayback: vi.fn(async () => uploads()),
    answerFirstRun: vi.fn(),
    answerUploadsFirstRun: vi.fn(),
  };
  Object.assign(window, { sf: { deviceSettings, errorReports } });
  return { errorReports, deviceSettings };
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

const mount = async (device: FirstSetupDevice, onDone = vi.fn()) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FirstSetup device={device} steps={openFirstSetupSteps(device)} onDone={onDone} />);
  });
  await flush();
  return onDone;
};

const find = (testId: string) => container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
const click = async (testId: string) => {
  const el = find(testId);
  expect(el, testId).toBeTruthy();
  await act(async () => {
    el!.click();
  });
  await flush();
};

const OPEN: FirstSetupDevice = { transcode: transcode(), uploads: uploads(), errorReports: state("undecided") };

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  Reflect.deleteProperty(window, "sf");
});

describe("@req REL-LOG-06[badger-desktop] the error-reports step is asked once and recommends nothing", () => {
  it("is the second step, after the copy question, open only while the question is unanswered", () => {
    expect(FIRST_SETUP_STEPS.map((s) => s.id)).toEqual(["transcode", "errorReports"]);
    const open = (errorReports: FirstSetupDevice["errorReports"]) =>
      openFirstSetupSteps({ transcode: transcode({ answered: false }), uploads: uploads(), errorReports }).map((s) => s.id);
    expect(open(state("undecided"))).toContain("errorReports");
    expect(open(state("on"))).not.toContain("errorReports");
    expect(open(state("off"))).not.toContain("errorReports");
    // No bridge, or an unreadable answer: the step is skipped, never guessed.
    expect(open(undefined)).not.toContain("errorReports");
  });

  it("makes no recommendation, but starts on 'off' (Do not send)", () => {
    const step = FIRST_SETUP_STEPS.find((s) => s.id === "errorReports")!;
    expect(step.recommended(OPEN)).toBeNull();
    expect(step.reason(OPEN)).toBeNull();
    expect(step.preselected?.(OPEN)).toBe("off");
    expect(step.options).toEqual(["on", "off"]);
  });

  it("loadFirstSetup reads the answer from main and asks only this step (copy answered, uploads not asked)", async () => {
    installBridges("undecided");
    const result = await loadFirstSetup();
    expect(result.status).toBe("needed");
    if (result.status === "needed") expect(result.steps.map((s) => s.id)).toEqual(["errorReports"]);
  });

  it("loadFirstSetup is done once the answer exists (including the harness's forced 'off')", async () => {
    installBridges("off");
    expect((await loadFirstSetup()).status).toBe("done");
  });
});

describe("@req REL-LOG-06[badger-desktop] the step starts on 'Do not send' and only the user opts in", () => {
  it("shows no recommendation or badge, starts on 'off' with Finish enabled, and Finish stores 'off'", async () => {
    const { errorReports } = installBridges("undecided");
    const onDone = await mount(OPEN);
    // The copy question is answered already and uploads are not asked, so the error-reports step is the only one.
    expect(find("first-setup-step-errorReports")).not.toBeNull();
    expect(find("first-setup-step-uploads")).toBeNull();
    expect(find("first-setup-recommendation")).toBeNull();
    expect(find("first-setup-recommended-badge")).toBeNull();
    expect(find("first-setup-option-on")?.getAttribute("aria-checked")).toBe("false");
    expect(find("first-setup-option-off")?.getAttribute("aria-checked")).toBe("true");
    const finish = find("first-setup-finish") as HTMLButtonElement;
    expect(finish.disabled).toBe(false);
    await click("first-setup-finish");
    expect(errorReports.set).toHaveBeenCalledExactlyOnceWith("off");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("copy is the same yes/no question in both options, with no 'recommended' wording", async () => {
    installBridges("undecided");
    await mount(OPEN);
    const text = container?.textContent ?? "";
    console.info(`${P}:text=${text}`);
    expect(text).toContain("firstSetup.steps.errorReports.title");
    expect(text).toContain("firstSetup.steps.errorReports.options.on.label");
    expect(text).toContain("firstSetup.steps.errorReports.options.off.label");
    expect(text).toContain("firstSetup.settingsLaterErrorReports");
    expect(text).not.toContain("recommend");
    expect(text).not.toContain("firstSetup.settingsLater\"");
  });

  it("one short line plus a 'What's in a report?' link to the privacy policy, and no line under either choice", async () => {
    installBridges("undecided");
    await mount(OPEN);
    const text = container?.textContent ?? "";
    const link = find("first-setup-info-link") as HTMLAnchorElement | null;
    console.info(`${P}:line+link text=${text} href=${link?.getAttribute("href")}`);
    expect(text).toContain("firstSetup.steps.errorReports.explain.line");
    expect(text).not.toContain(".description");
    expect(link?.textContent).toBe("settings.system.errorReports.link");
    expect(link?.getAttribute("href")).toBe("https://spacefleet.io/fr/privacy#error-reports");
    expect(link?.getAttribute("target")).toBe("_blank");
    for (const lang of ["en", "fr", "de", "nl"]) {
      const bundle = JSON.parse(readFileSync(resolve(__dirname, `../src/renderer/src/i18n/${lang}.json`), "utf8"));
      const step = bundle.firstSetup.steps.errorReports;
      console.info(`${P}:${lang} line=${step.explain.line} settings=${bundle.settings.system.errorReports.subtitle}`);
      expect(Object.keys(step.explain)).toEqual(["line"]);
      expect(step.explain.line).toBe(bundle.settings.system.errorReports.subtitle);
      expect(step.explain.line).toMatch(/🙂$/);
      expect(step.options.on).toEqual({ label: expect.any(String) });
      expect(step.options.off).toEqual({ label: expect.any(String) });
      expect(bundle.settings.system.errorReports.link).toBeTruthy();
    }
  });

  it("nothing is stored while picking; switching back to 'off' and Finish stores 'off' and starts nothing", async () => {
    const { errorReports } = installBridges("undecided");
    const onDone = await mount(OPEN);
    await click("first-setup-option-on");
    expect(find("first-setup-option-on")?.getAttribute("aria-checked")).toBe("true");
    await click("first-setup-option-off");
    expect(find("first-setup-option-off")?.getAttribute("aria-checked")).toBe("true");
    expect(errorReports.set).not.toHaveBeenCalled();
    expect((find("first-setup-finish") as HTMLButtonElement).disabled).toBe(false);
    await click("first-setup-finish");
    expect(errorReports.set).toHaveBeenCalledExactlyOnceWith("off");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("Finish stores 'on' and starts reporting in this window at once", async () => {
    const { errorReports } = installBridges("undecided");
    const onDone = await mount(OPEN);
    await click("first-setup-option-on");
    await click("first-setup-finish");
    expect(errorReports.set).toHaveBeenCalledExactlyOnceWith("on");
    expect(adapter.create).toHaveBeenCalledWith("9.9.9");
    expect(adapter.setEnabled).toHaveBeenLastCalledWith(true);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a failed save shows the error and leaves the flow open", async () => {
    installBridges("undecided", { setFails: true });
    const onDone = await mount(OPEN);
    await click("first-setup-option-on");
    await click("first-setup-finish");
    expect(find("first-setup-error")).not.toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    expect(adapter.create).not.toHaveBeenCalled();
  });
});

describe("@req REL-LOG-06[badger-desktop] saving without a pick never opts in", () => {
  it("saving the step with no pick at all stores nothing (never a guessed 'on'), so the question comes back next start", async () => {
    const { errorReports } = installBridges("undecided");
    const step = FIRST_SETUP_STEPS.find((s) => s.id === "errorReports")!;
    const saved = new Set<string>();
    await saveFirstSetup([step], {}, OPEN, saved);
    expect(errorReports.set).not.toHaveBeenCalled();
    expect(saved.size).toBe(0);
  });

  it("without the error-reports bridge a pick cannot be saved (loud failure, not a silent 'off')", async () => {
    Object.assign(window, { sf: { deviceSettings: {} } });
    const step = FIRST_SETUP_STEPS.find((s) => s.id === "errorReports")!;
    await expect(saveFirstSetup([step], { errorReports: "off" }, OPEN, new Set())).rejects.toThrow(/bridge unavailable/);
  });
});
