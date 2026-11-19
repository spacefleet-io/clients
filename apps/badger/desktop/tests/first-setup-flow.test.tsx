// @vitest-environment jsdom
/**
 * #25 (Chris 2026-10-13): the startup questions are a "First setup" flow, one
 * question per full-window step, not one dialog with two questions.
 *  - fresh computer: step 1 of 2 (copy question), step 2 of 2 (error reports, REL-LOG-06), Back keeps
 *    the pick, Finish stores both; uploads-during-playback is not asked here (Chris 2026-11-11);
 *  - nothing is stored before Finish (closing mid-flow keeps the flow for next time);
 *  - a computer that answered the fallback-copy question before sees one step, with no "Step 1 of 1";
 *  - the computer line is shown once, on the first step;
 *  - the gate waits for the library key step, then lands on Home after Finish.
 *
 * @bugfix @regression-proof
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import FirstSetup from "../src/renderer/src/components/FirstSetup";
import FirstSetupGate from "../src/renderer/src/components/FirstSetupGate";
import { openFirstSetupSteps, type FirstSetupDevice } from "../src/renderer/src/components/firstSetupSteps";
import type { TranscodeHardware } from "@space/shared/transcodeHardware";
import type { DeviceTranscodeSettings } from "../src/shared/transcodeDefault";
import type { DeviceUploadsDuringPlaybackSettings, UploadsDuringPlayback } from "../src/shared/uploadPlaybackDefault";
import type { ErrorReportsState } from "@space/error-report/desktop";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const P = "[first-setup-flow]";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: "en", exists: () => true },
  }),
}));

vi.mock("@/assets/mascot.webp", () => ({ default: "mascot.webp" }));

const acknowledged = vi.hoisted(() => ({ value: true }));
vi.mock("../src/renderer/src/lib/onboarding", () => ({ isLibraryKeyAcknowledged: async () => acknowledged.value }));

// The renderer error-reports module: `get` reads main's answer, `set` stores the pick (true once stored).
const reports = vi.hoisted(() => ({
  get: vi.fn<() => Promise<unknown>>(),
  set: vi.fn<(next: "on" | "off") => Promise<boolean>>(),
}));
vi.mock("../src/renderer/src/lib/errorReports", () => ({ errorReports: reports }));

const REFERENCE: TranscodeHardware = {
  cpuModel: "Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz",
  cores: 4,
  ramGB: 7.7,
  hwEncoder: "none",
};

const transcode = (over: Partial<DeviceTranscodeSettings> = {}): DeviceTranscodeSettings => ({
  fallbackCopy: false,
  answered: false,
  answer: null,
  recommendation: { fallbackCopy: false, reason: "weak", hardware: REFERENCE, detectedAt: "2026-10-13T00:00:00.000Z" },
  updatedAt: "2026-10-13T00:00:00.000Z",
  ...over,
});

const reportsState = (decision: ErrorReportsState["decision"]): ErrorReportsState => ({ decision, available: true, release: "9.9.9" });
const UNDECIDED = reportsState("undecided");

const uploads = (
  mode: UploadsDuringPlayback = "throttle",
  over: Partial<DeviceUploadsDuringPlaybackSettings> = {},
): DeviceUploadsDuringPlaybackSettings => ({
  mode,
  answered: false,
  answer: null,
  recommendation: { mode, reason: "modest", hardware: REFERENCE, detectedAt: "2026-10-13T00:00:00.000Z" },
  updatedAt: "2026-10-13T00:00:00.000Z",
  ...over,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const dump = (label: string) => {
  console.error(`=== ${P}:${label} ===\n${container?.innerHTML ?? "(no container)"}\n=== end ===`);
};

const installBridge = (t: DeviceTranscodeSettings, u: DeviceUploadsDuringPlaybackSettings, r: ErrorReportsState = UNDECIDED) => {
  const bridge = {
    getTranscode: vi.fn(async () => t),
    answerFirstRun: vi.fn(async (answer: string) => {
      console.info(`${P}:bridge answerFirstRun(${answer})`);
      return { ...t, answered: true, answer };
    }),
    setFallbackCopy: vi.fn(),
    getUploadsDuringPlayback: vi.fn(async () => u),
    answerUploadsFirstRun: vi.fn(async (answer: { kind: string; mode?: string }) => {
      console.info(`${P}:bridge answerUploadsFirstRun(${JSON.stringify(answer)})`);
      return { ...u, answered: true, answer: answer.kind };
    }),
    setUploadsDuringPlayback: vi.fn(),
  };
  reports.get.mockImplementation(async () => r);
  reports.set.mockImplementation(async (next) => {
    console.info(`${P}:errorReports.set(${next})`);
    return true;
  });
  Object.assign(window, { sf: { deviceSettings: bridge } });
  return bridge;
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

const render = async (node: React.ReactNode) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  await flush();
};

const mountFlow = async (device: FirstSetupDevice, onDone = vi.fn()) => {
  const bridge = installBridge(device.transcode, device.uploads!);
  await render(<FirstSetup device={device} steps={openFirstSetupSteps(device)} onDone={onDone} />);
  return { bridge, onDone };
};

const has = (testId: string) => container?.querySelector(`[data-testid="${testId}"]`) !== null;
const text = (testId: string) => container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

const click = async (testId: string) => {
  const el = container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) dump(`missing-${testId}`);
  expect(el, testId).toBeTruthy();
  await act(async () => {
    el!.click();
  });
  await flush();
};

const checked = (testId: string) => container?.querySelector(`[data-testid="${testId}"]`)?.getAttribute("aria-checked");

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  acknowledged.value = true;
  reports.get.mockReset();
  reports.set.mockReset();
  Reflect.deleteProperty(window, "sf");
});

const FRESH = (): FirstSetupDevice => ({ transcode: transcode(), uploads: uploads("throttle"), errorReports: UNDECIDED });

describe("fresh computer: two steps", () => {
  it("step 1 of 2 asks the copy question with the recommendation preselected and the computer described once", async () => {
    await mountFlow(FRESH());
    expect(has("first-setup")).toBe(true);
    expect(has("first-setup-step-transcode")).toBe(true);
    expect(text("first-setup-progress")).toBe('firstSetup.stepOf {"current":1,"total":2}');
    expect(has("first-setup-back")).toBe(false);
    expect(has("first-setup-next")).toBe(true);
    expect(has("first-setup-finish")).toBe(false);
    expect(text("first-setup-computer")).toContain('"cpu":"Intel Core i5-6500"');
    expect(text("first-setup-computer")).toContain('"cores":4');
    expect(text("first-setup-recommendation")).toContain("firstSetup.steps.transcode.recommend.off");
    expect(text("first-setup-recommendation")).toContain("firstSetup.steps.transcode.reason.weak");
    expect(checked("first-setup-option-off")).toBe("true");
    expect(checked("first-setup-option-on")).toBe("false");
  });

  // @req UX-SETUP-08[badger-desktop]: an option's description that wraps (French "Ne pas la créer") keeps normal line
  // spacing; the Label around it is `leading-none` (Chris 2026-11-18). One span serves the 5 languages.
  it("@req UX-SETUP-08[badger-desktop] gives every option description normal line spacing", async () => {
    await mountFlow(FRESH());
    for (const value of ["on", "off"]) {
      const description = container!.querySelector(`[data-testid="first-setup-option-${value}-description"]`);
      console.info(P, "description", value, description?.className);
      expect(description?.textContent).toBe(`firstSetup.steps.transcode.options.${value}.description`);
      expect(description?.className).toContain("leading-normal");
    }
  });

  // @req UX-SETUP-08[badger-desktop]: the language button keeps the window's top-right spot on every step, out of the card.
  it("keeps the language button in the window's top-right on both steps, never inside the card", async () => {
    await mountFlow(FRESH());
    const where = () => {
      const menu = container?.querySelector<HTMLElement>('[aria-label="settings.ui.language"]') ?? null;
      const controls = menu?.closest(".fixed") ?? null;
      console.info(`${P}:language menu=${menu !== null} controls=${JSON.stringify(controls?.className ?? null)}`);
      return { menu, controls };
    };
    for (const step of ["transcode", "errorReports"]) {
      if (step === "errorReports") await click("first-setup-next");
      const { menu, controls } = where();
      expect(menu, step).not.toBeNull();
      expect(controls?.className, step).toContain("right-8");
      expect(container!.querySelector(`[data-testid="first-setup-step-${step}"]`)!.contains(menu), step).toBe(false);
    }
  });

  // @req UX-SETUP-08[badger-desktop]: a step with a bottom Back beside Next shows no Back link at the top (Chris 2026-11-18).
  it("step 2 has one Back, at the bottom beside Finish, and no Back link at the top", async () => {
    await mountFlow(FRESH());
    await click("first-setup-next");
    const backs = [...container!.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "firstSetup.back");
    const links = [...container!.querySelectorAll("a")].filter((link) => /back/i.test(link.textContent ?? ""));
    console.info(`${P}:one-back backButtons=${backs.length} backLinks=${links.length}`);
    expect(backs).toHaveLength(1);
    expect(links).toHaveLength(0);
    expect(backs[0]!.parentElement).toBe(container!.querySelector('[data-testid="first-setup-finish"]')!.parentElement);
  });

  it("step 2 of 2 asks the error-reports question with no recommendation, 'off' preselected, Finish enabled and no computer line", async () => {
    await mountFlow(FRESH());
    await click("first-setup-next");
    expect(has("first-setup-step-errorReports")).toBe(true);
    expect(has("first-setup-step-uploads")).toBe(false);
    expect(text("first-setup-progress")).toBe('firstSetup.stepOf {"current":2,"total":2}');
    expect(has("first-setup-computer")).toBe(false);
    expect(has("first-setup-next")).toBe(false);
    expect(has("first-setup-finish")).toBe(true);
    expect(has("first-setup-back")).toBe(true);
    for (const value of ["on", "off"]) expect(has(`first-setup-option-${value}`), value).toBe(true);
    expect(checked("first-setup-option-off")).toBe("true");
    expect(checked("first-setup-option-on")).toBe("false");
    expect(has("first-setup-recommendation")).toBe(false);
    expect(has("first-setup-recommended-badge")).toBe(false);
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="first-setup-finish"]')?.disabled).toBe(false);
  });

  it("each step explains itself one sentence at a time, in order", async () => {
    await mountFlow(FRESH());
    const order = (page: string[]) => page.map((key) => (container?.textContent ?? "").indexOf(key));
    const first = order(["transcode.explain.what", "transcode.explain.when", "transcode.explain.cost", "transcode.explain.later"]);
    expect(first.every((at) => at >= 0)).toBe(true);
    expect([...first].sort((a, b) => a - b)).toEqual(first);
    await click("first-setup-next");
    // REL-LOG-06 (#1816): the error-reports step explains itself in one short line.
    expect((container?.textContent ?? "").indexOf("errorReports.explain.line")).toBeGreaterThanOrEqual(0);
  });

  it("only the recommended option carries the 'recommended' badge", async () => {
    await mountFlow(FRESH());
    expect(container?.querySelectorAll('[data-testid="first-setup-recommended-badge"]').length).toBe(1);
  });

  it("Back keeps what was picked", async () => {
    await mountFlow(FRESH());
    await click("first-setup-option-on");
    expect(checked("first-setup-option-on")).toBe("true");
    await click("first-setup-next");
    await click("first-setup-option-on");
    await click("first-setup-back");
    expect(has("first-setup-step-transcode")).toBe(true);
    expect(checked("first-setup-option-on")).toBe("true");
    await click("first-setup-next");
    expect(has("first-setup-step-errorReports")).toBe(true);
    expect(checked("first-setup-option-on")).toBe("true");
  });

  it("stores nothing until Finish", async () => {
    const { bridge, onDone } = await mountFlow(FRESH());
    await click("first-setup-option-on");
    await click("first-setup-next");
    await click("first-setup-option-on");
    expect(bridge.answerFirstRun).not.toHaveBeenCalled();
    expect(reports.set).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("Finish stores both picks, never the uploads question, then reports done", async () => {
    const { bridge, onDone } = await mountFlow(FRESH());
    await click("first-setup-option-on");
    await click("first-setup-next");
    await click("first-setup-option-on");
    await click("first-setup-finish");
    expect(bridge.answerFirstRun).toHaveBeenCalledWith("overridden");
    expect(reports.set).toHaveBeenCalledExactlyOnceWith("on");
    expect(bridge.answerUploadsFirstRun).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("going straight through stores the copy recommendation as 'accepted' and error reports 'off'", async () => {
    const { bridge, onDone } = await mountFlow(FRESH());
    await click("first-setup-next");
    await click("first-setup-finish");
    expect(bridge.answerFirstRun).toHaveBeenCalledWith("accepted");
    expect(reports.set).toHaveBeenCalledExactlyOnceWith("off");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a failed save shows a retryable error and does not report done", async () => {
    const { onDone } = await mountFlow(FRESH());
    await click("first-setup-next");
    reports.set.mockRejectedValueOnce(new Error("disk full"));
    await click("first-setup-finish");
    expect(has("first-setup-error")).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    await click("first-setup-finish");
    expect(has("first-setup-error")).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("after step 1 is stored and step 2 fails, a retry stores only step 2 and Back is gone", async () => {
    const { bridge, onDone } = await mountFlow(FRESH());
    await click("first-setup-option-on");
    await click("first-setup-next");
    reports.set.mockRejectedValueOnce(new Error("disk full"));
    await click("first-setup-finish");
    expect(bridge.answerFirstRun).toHaveBeenCalledTimes(1);
    expect(has("first-setup-back")).toBe(false);
    await click("first-setup-option-on");
    await click("first-setup-finish");
    expect(bridge.answerFirstRun).toHaveBeenCalledTimes(1);
    expect(reports.set).toHaveBeenLastCalledWith("on");
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("a computer that answered the copy question before this flow existed", () => {
  const legacy = (): FirstSetupDevice => ({
    transcode: transcode({ answered: true, answer: "accepted" }),
    uploads: uploads("throttle"),
    errorReports: UNDECIDED,
  });

  it("sees only the error-reports step with Finish, no step counter, and the computer line", async () => {
    const { bridge } = await mountFlow(legacy());
    expect(has("first-setup-step-transcode")).toBe(false);
    expect(has("first-setup-step-uploads")).toBe(false);
    expect(has("first-setup-step-errorReports")).toBe(true);
    expect(has("first-setup-progress")).toBe(false);
    expect(has("first-setup-back")).toBe(false);
    expect(has("first-setup-next")).toBe(false);
    expect(has("first-setup-computer")).toBe(true);
    await click("first-setup-finish");
    expect(bridge.answerFirstRun).not.toHaveBeenCalled();
    expect(bridge.answerUploadsFirstRun).not.toHaveBeenCalled();
    expect(reports.set).toHaveBeenCalledExactlyOnceWith("off");
  });
});

describe("the gate", () => {
  const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
  const mountGate = async (initial: string) =>
    render(
      <MemoryRouter initialEntries={[initial]}>
        <Where />
        <Routes>
          <Route
            path="*"
            element={
              <FirstSetupGate loadingFallback={<p data-testid="loading" />}>
                <p data-testid="app" />
              </FirstSetupGate>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

  it("replaces the app with the flow, and Finish lands on Home", async () => {
    const bridge = installBridge(transcode(), uploads("throttle"));
    await mountGate("/media-library");
    expect(has("first-setup")).toBe(true);
    expect(has("app")).toBe(false);
    await click("first-setup-next");
    await click("first-setup-finish");
    expect(bridge.answerFirstRun).toHaveBeenCalledTimes(1);
    expect(reports.set).toHaveBeenCalledExactlyOnceWith("off");
    expect(has("first-setup")).toBe(false);
    expect(has("app")).toBe(true);
    expect(text("where")).toBe("/home");
  });

  it("renders the app straight away when everything was answered (the uploads question is not part of it)", async () => {
    installBridge(transcode({ answered: true }), uploads("full"), reportsState("off"));
    await mountGate("/home");
    expect(has("first-setup")).toBe(false);
    expect(has("app")).toBe(true);
  });

  it("waits for the library key step: the app (and its redirect) is shown first", async () => {
    acknowledged.value = false;
    installBridge(transcode(), uploads("throttle"));
    await mountGate("/home");
    expect(has("first-setup")).toBe(false);
    expect(has("app")).toBe(true);
  });

  it("never asks while the user is on the library key page", async () => {
    installBridge(transcode(), uploads("throttle"));
    await mountGate("/onboarding/key");
    expect(has("first-setup")).toBe(false);
    expect(has("app")).toBe(true);
  });

  it("@req UX-SETUP-08[badger-desktop] counts on from the library key: after the key (step 1), the questions are steps 2 and 3", async () => {
    acknowledged.value = false;
    installBridge(transcode(), uploads("throttle"));
    const Go = () => {
      const navigate = useNavigate();
      return <button type="button" data-testid="go" onClick={() => navigate("/home")} />;
    };
    await render(
      <MemoryRouter initialEntries={["/media-library"]}>
        <Go />
        <Routes>
          <Route
            path="*"
            element={
              <FirstSetupGate loadingFallback={<p data-testid="loading" />}>
                <p data-testid="app" />
              </FirstSetupGate>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(has("first-setup")).toBe(false);
    // The key is acknowledged on its page; leaving it opens the questions.
    acknowledged.value = true;
    await click("go");
    await flush();
    expect(has("first-setup")).toBe(true);
    expect(text("first-setup-progress")).toContain('"current":2,"total":3');
    await click("first-setup-next");
    expect(text("first-setup-progress")).toContain('"current":3,"total":3');
  });
});
