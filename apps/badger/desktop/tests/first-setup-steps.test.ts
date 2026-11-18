// @vitest-environment jsdom
/**
 * #25: the "First setup" questions are a list (firstSetupSteps.ts).
 *  - which steps a computer still has to answer (fresh, legacy, answered): the copy question, then
 *    error reports (REL-LOG-06); uploads-during-playback is not asked here (Chris 2026-11-11);
 *  - answers go through the existing per-computer IPC (error reports through errorReports.set), in
 *    step order, and stop on the first failure;
 *  - the hardware is described in plain words.
 *
 * @bugfix @regression-proof
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeCpuModel,
  detectedHardware,
  FIRST_SETUP_STEPS,
  loadFirstSetup,
  openFirstSetupSteps,
  saveFirstSetup,
  type FirstSetupDevice,
} from "../src/renderer/src/components/firstSetupSteps";
import type { TranscodeHardware } from "@space/shared/transcodeHardware";
import type { DeviceTranscodeSettings } from "../src/shared/transcodeDefault";
import type { DeviceUploadsDuringPlaybackSettings, UploadsDuringPlayback } from "../src/shared/uploadPlaybackDefault";
import type { ErrorReportsState } from "@space/error-report/desktop";

const P = "[first-setup-steps]";

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

const ids = (device: FirstSetupDevice) => openFirstSetupSteps(device).map((s) => s.id);

const installBridge = (
  t: DeviceTranscodeSettings,
  u: DeviceUploadsDuringPlaybackSettings | Error,
  r: ErrorReportsState | Error = UNDECIDED,
) => {
  const bridge = {
    getTranscode: vi.fn(async () => t),
    answerFirstRun: vi.fn(async (answer: string) => ({ ...t, answered: true, answer })),
    setFallbackCopy: vi.fn(),
    getUploadsDuringPlayback: vi.fn(async () => {
      if (u instanceof Error) throw u;
      return u;
    }),
    answerUploadsFirstRun: vi.fn(async () => (u instanceof Error ? u : { ...u, answered: true })),
    setUploadsDuringPlayback: vi.fn(),
  };
  reports.get.mockImplementation(async () => {
    if (r instanceof Error) throw r;
    return r;
  });
  reports.set.mockImplementation(async (next) => {
    console.info(`${P}:errorReports.set(${next})`);
    return true;
  });
  Object.assign(window, { sf: { deviceSettings: bridge } });
  return bridge;
};

afterEach(() => {
  acknowledged.value = true;
  reports.get.mockReset();
  reports.set.mockReset();
  Reflect.deleteProperty(window, "sf");
});

describe("which steps are open", () => {
  it("a fresh computer answers the copy question, then error reports — no uploads step", () => {
    expect(FIRST_SETUP_STEPS.map((s) => s.id)).toEqual(["transcode", "errorReports"]);
    const open = ids({ transcode: transcode(), uploads: uploads(), errorReports: UNDECIDED });
    console.info(`${P}:fresh ${JSON.stringify(open)}`);
    expect(open).toEqual(["transcode", "errorReports"]);
  });

  it("a computer that only answered the copy question (legacy) sees just the error-reports step", () => {
    expect(ids({ transcode: transcode({ answered: true, answer: "accepted" }), uploads: uploads(), errorReports: UNDECIDED })).toEqual([
      "errorReports",
    ]);
  });

  it("an unanswered uploads setting never opens a step: main's recommendation keeps applying", () => {
    expect(ids({ transcode: transcode({ answered: true, answer: "accepted" }), uploads: uploads(), errorReports: reportsState("off") })).toEqual([]);
  });

  it("answered or forced values are never asked again", () => {
    expect(
      ids({
        transcode: transcode({ answered: true, answer: "forced" }),
        uploads: uploads("full", { answered: true, answer: "forced" }),
        errorReports: reportsState("on"),
      }),
    ).toEqual([]);
  });

  it("an unreadable error-reports answer skips that step but keeps the other", () => {
    expect(ids({ transcode: transcode(), uploads: undefined, errorReports: undefined })).toEqual(["transcode"]);
  });

  it("the flow is just a list: a custom list is filtered the same way", () => {
    const extra = { ...FIRST_SETUP_STEPS[0]!, id: "extra", needed: () => true };
    expect(openFirstSetupSteps({ transcode: transcode({ answered: true }), uploads: undefined }, [...FIRST_SETUP_STEPS, extra]).map((s) => s.id)).toEqual([
      "extra",
    ]);
  });

  it("the recommendations come from what main stored; error reports recommend nothing but start on 'off'", () => {
    const device: FirstSetupDevice = {
      transcode: transcode({ recommendation: { fallbackCopy: true, reason: "strong-cpu", hardware: REFERENCE, detectedAt: "x" } }),
      uploads: uploads("pause"),
      errorReports: UNDECIDED,
    };
    expect(FIRST_SETUP_STEPS.map((s) => s.recommended(device))).toEqual(["on", null]);
    expect(FIRST_SETUP_STEPS.map((s) => s.preselected?.(device) ?? s.recommended(device))).toEqual(["on", "off"]);
  });
});

describe("describing the computer", () => {
  it.each([
    ["Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz", "Intel Core i5-6500"],
    ["AMD Ryzen 7 5800X 8-Core Processor", "AMD Ryzen 7 5800X"],
    ["", null],
    [null, null],
  ])("%s → %s", (raw, expected) => {
    expect(describeCpuModel(raw)).toBe(expected);
  });

  it("hardware is read from either stored value", () => {
    expect(detectedHardware({ transcode: transcode(), uploads: undefined })).toEqual(REFERENCE);
    const noHw = transcode({ recommendation: { fallbackCopy: false, reason: null, hardware: null, detectedAt: "x" } });
    expect(detectedHardware({ transcode: noHw, uploads: uploads() })).toEqual(REFERENCE);
    expect(detectedHardware({ transcode: noHw, uploads: undefined })).toBeNull();
  });
});

describe("loading", () => {
  it("returns the open steps on a fresh computer", async () => {
    installBridge(transcode(), uploads());
    const result = await loadFirstSetup();
    expect(result.status).toBe("needed");
    if (result.status === "needed") expect(result.steps.map((s) => s.id)).toEqual(["transcode", "errorReports"]);
  });

  it("waits for the library key step: nothing is asked before it", async () => {
    acknowledged.value = false;
    installBridge(transcode(), uploads());
    // UX-SETUP-08: the key screen shows "Step 1 of 3" from this count of the questions after it.
    expect(await loadFirstSetup()).toEqual({ status: "deferred", openSteps: 2 });
  });

  it("is done when everything was answered, even with the uploads question unanswered", async () => {
    installBridge(transcode({ answered: true }), uploads("full"), reportsState("off"));
    expect((await loadFirstSetup()).status).toBe("done");
  });

  it("is done when there is no bridge (browser, tests)", async () => {
    expect((await loadFirstSetup()).status).toBe("done");
  });

  it("an unreadable uploads setting never blocks the questions", async () => {
    installBridge(transcode(), new Error("ipc down"));
    const result = await loadFirstSetup();
    expect(result.status).toBe("needed");
    if (result.status === "needed") expect(result.steps.map((s) => s.id)).toEqual(["transcode", "errorReports"]);
  });

  it("an unreadable error-reports answer skips that step but keeps the copy question", async () => {
    installBridge(transcode(), uploads(), new Error("ipc down"));
    const result = await loadFirstSetup();
    expect(result.status).toBe("needed");
    if (result.status === "needed") expect(result.steps.map((s) => s.id)).toEqual(["transcode"]);
  });
});

describe("saving", () => {
  const device: FirstSetupDevice = { transcode: transcode(), uploads: uploads("throttle"), errorReports: UNDECIDED };
  const steps = FIRST_SETUP_STEPS;

  it("the copy recommendation is stored as 'accepted', error reports through errorReports.set, uploads untouched", async () => {
    const bridge = installBridge(device.transcode, device.uploads!);
    await saveFirstSetup(steps, { transcode: "off", errorReports: "off" }, device, new Set());
    expect(bridge.answerFirstRun).toHaveBeenCalledWith("accepted");
    expect(reports.set).toHaveBeenCalledExactlyOnceWith("off");
    expect(bridge.answerUploadsFirstRun).not.toHaveBeenCalled();
  });

  it("other choices are stored as 'overridden' / 'on'", async () => {
    const bridge = installBridge(device.transcode, device.uploads!);
    await saveFirstSetup(steps, { transcode: "on", errorReports: "on" }, device, new Set());
    expect(bridge.answerFirstRun).toHaveBeenCalledWith("overridden");
    expect(reports.set).toHaveBeenCalledExactlyOnceWith("on");
  });

  it("a step without a pick falls back to its recommendation; error reports, recommending nothing, store nothing", async () => {
    const bridge = installBridge(device.transcode, device.uploads!);
    await saveFirstSetup(steps, {}, device, new Set());
    expect(bridge.answerFirstRun).toHaveBeenCalledWith("accepted");
    expect(reports.set).not.toHaveBeenCalled();
  });

  it("only the open steps are stored (legacy computer)", async () => {
    const bridge = installBridge(device.transcode, device.uploads!);
    const legacy: FirstSetupDevice = { ...device, transcode: transcode({ answered: true }) };
    await saveFirstSetup(openFirstSetupSteps(legacy), { errorReports: "on" }, legacy, new Set());
    expect(bridge.answerFirstRun).not.toHaveBeenCalled();
    expect(reports.set).toHaveBeenCalledExactlyOnceWith("on");
  });

  it("stops at the first failure and stores nothing after it", async () => {
    const bridge = installBridge(device.transcode, device.uploads!);
    bridge.answerFirstRun.mockRejectedValueOnce(new Error("disk full"));
    const saved = new Set<string>();
    await expect(saveFirstSetup(steps, { errorReports: "off" }, device, saved)).rejects.toThrow("disk full");
    expect(reports.set).not.toHaveBeenCalled();
    expect(saved.size).toBe(0);
  });

  it("a retry skips the steps already stored, so a stored answer is never sent twice", async () => {
    const bridge = installBridge(device.transcode, device.uploads!);
    reports.set.mockResolvedValueOnce(false);
    const saved = new Set<string>();
    await expect(saveFirstSetup(steps, { transcode: "on", errorReports: "off" }, device, saved)).rejects.toThrow(/bridge unavailable/);
    expect([...saved]).toEqual(["transcode"]);
    await saveFirstSetup(steps, { transcode: "off", errorReports: "off" }, device, saved);
    expect(bridge.answerFirstRun).toHaveBeenCalledTimes(1);
    expect(reports.set).toHaveBeenCalledTimes(2);
  });

  it("fails loudly when there is no bridge", async () => {
    await expect(saveFirstSetup(steps, {}, device, new Set())).rejects.toThrow(/bridge unavailable/);
  });
});
