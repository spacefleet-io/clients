/**
 * The "First setup" questions a computer answers once (#25), as a list.
 *
 * Adding a question is one entry in FIRST_SETUP_STEPS plus its strings under
 * `firstSetup.steps.<id>` in en.json / fr.json — the flow (FirstSetup.tsx), the
 * "Step N of M" indicator and the save-on-finish behaviour follow from the list.
 *
 * Each step is a single choice. A computer only sees the steps it has not
 * answered yet, so a computer that answered an older question (a legacy
 * install) is asked just the new ones.
 *
 * Main detected the hardware once (main/transcodeHardware.ts) and stored a
 * recommendation per question in `<userData>/device-settings.json`
 * (main/deviceSettings.ts); nothing is stored as an answer until the user
 * finishes the flow, so closing the window part-way asks everything again on the
 * next start.
 */
import { rendererLogger } from "@/logger";
import { isLibraryKeyAcknowledged } from "@/lib/onboarding";
import { errorReports } from "@/lib/errorReports";
import type { ErrorReportsState } from "@space/error-report/desktop";
import { errorReportsPrivacyUrl } from "@space/shared/websiteLinks";
import type { TranscodeHardware } from "@space/shared/transcodeHardware";
import type { DeviceTranscodeSettings } from "../../../shared/transcodeDefault";
import type { DeviceUploadsDuringPlaybackSettings } from "../../../shared/uploadPlaybackDefault";

const log = rendererLogger.child({ scope: "first-setup" });

export type DeviceSettingsBridge = NonNullable<NonNullable<Window["sf"]>["deviceSettings"]>;

/**
 * What main stored for this computer. `uploads` and `errorReports` are undefined when they could not
 * be read (or there is no bridge for them): those steps are then skipped.
 */
export type FirstSetupDevice = {
  transcode: DeviceTranscodeSettings;
  uploads: DeviceUploadsDuringPlaybackSettings | undefined;
  errorReports?: ErrorReportsState | undefined;
};

export type FirstSetupStep = {
  /**
   * Also the i18n namespace, `firstSetup.steps.<id>`:
   * `title`, `explain.<sentence>`, `recommend.<value>`, `reason.<reason>`, `options.<value>.{label,description?}`
   * (a choice without a `description` string shows its label alone).
   */
  id: string;
  /** The sentences of the explanation, in order: one i18n key each (`firstSetup.steps.<id>.explain.<sentence>`). */
  explain: readonly string[];
  /** The values the user picks from, in display order. */
  options: readonly string[];
  /** True while this computer has not answered this question. */
  needed: (device: FirstSetupDevice) => boolean;
  /**
   * The option main recommends for this computer; preselected. Null when the step makes no
   * recommendation: nothing is preselected and the user has to pick before moving on.
   */
  recommended: (device: FirstSetupDevice) => string | null;
  /** The option picked when the step opens without calling it recommended; defaults to `recommended`. */
  preselected?: (device: FirstSetupDevice) => string | null;
  /** Plain-language bucket naming why (`firstSetup.steps.<id>.reason.<reason>`), null when nothing was detected. */
  reason: (device: FirstSetupDevice) => string | null;
  /** i18n key of a note shown on this step about changing the answer later; the steps without one share `firstSetup.settingsLater`. */
  later?: string;
  /** A small link after the explanation: its i18n label key and the address it opens, in the app's language. */
  infoLink?: { label: string; href: (language: string) => string };
  /** Store the user's choice through the existing per-computer IPC answer. */
  save: (bridge: DeviceSettingsBridge, choice: string, device: FirstSetupDevice) => Promise<unknown>;
};

const transcodeStep: FirstSetupStep = {
  id: "transcode",
  explain: ["what", "when", "cost", "later"],
  options: ["on", "off"],
  needed: (device) => !device.transcode.answered,
  recommended: (device) => (device.transcode.recommendation.fallbackCopy ? "on" : "off"),
  reason: (device) => device.transcode.recommendation.reason,
  save: (bridge, choice, device) =>
    bridge.answerFirstRun(choice === transcodeStep.recommended(device) ? "accepted" : "overridden"),
};

/**
 * REL-LOG-06: opt in to error reports. Nothing is recommended, and "Do not send" starts picked, so
 * reports stay off unless the user chooses to send them (Chris 2026-11-11).
 */
const errorReportsStep: FirstSetupStep = {
  id: "errorReports",
  // REL-LOG-06: one short line, details behind the privacy policy link; the two choices have no description.
  explain: ["line"],
  options: ["on", "off"],
  infoLink: { label: "settings.system.errorReports.link", href: errorReportsPrivacyUrl },
  needed: (device) => device.errorReports?.decision === "undecided",
  recommended: () => null,
  preselected: () => "off",
  reason: () => null,
  later: "firstSetup.settingsLaterErrorReports",
  save: async (_bridge, choice) => {
    // Through the renderer module, so reporting starts (or stays off) in this window at once.
    if (!(await errorReports.set(choice === "on" ? "on" : "off"))) throw new Error("error reports bridge unavailable");
  },
};

/** In the order they are asked. */
export const FIRST_SETUP_STEPS: readonly FirstSetupStep[] = [transcodeStep, errorReportsStep];

/** The steps this computer still has to answer, in order. */
export const openFirstSetupSteps = (
  device: FirstSetupDevice,
  steps: readonly FirstSetupStep[] = FIRST_SETUP_STEPS,
): FirstSetupStep[] => steps.filter((step) => step.needed(device));

/** The hardware main detected, described once for the whole flow. */
export const detectedHardware = (device: FirstSetupDevice): TranscodeHardware | null =>
  device.transcode.recommendation.hardware ?? device.uploads?.recommendation.hardware ?? null;

/**
 * Turn an `os.cpus()` model string into something a non-technical reader
 * recognises: "Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz" → "Intel Core i5-6500".
 */
export const describeCpuModel = (raw: string | null | undefined): string | null => {
  const cleaned = (raw ?? "")
    .replace(/\((R|TM|C)\)/gi, "")
    .replace(/\bCPU\b/gi, "")
    .replace(/@\s*[\d.]+\s*GHz/gi, "")
    .replace(/\b\d+-Core Processor\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
};

export type FirstSetupLoad =
  /**
   * The library-key step is not done yet; ask again once it is. `openSteps` counts the questions still to come after
   * the key, so the key screen can show "Step 1 of M" (UX-SETUP-08).
   */
  | { status: "deferred"; openSteps: number }
  /** Nothing to ask (or no device-settings bridge). */
  | { status: "done" }
  | { status: "needed"; device: FirstSetupDevice; steps: FirstSetupStep[] };

/** Read this computer's stored values and decide whether the flow has to run now. */
export const loadFirstSetup = async (): Promise<FirstSetupLoad> => {
  const bridge = window.sf?.deviceSettings;
  if (!bridge) {
    log.warn("[first-setup] device settings bridge unavailable — first setup skipped");
    return { status: "done" };
  }
  const [transcode, uploads, reports, keyAcknowledged] = await Promise.all([
    bridge.getTranscode(),
    bridge.getUploadsDuringPlayback().catch((err: unknown) => {
      log.error({ err: String(err) }, "[first-setup] could not read this computer's uploads setting — that step is skipped");
      return undefined;
    }),
    errorReports.get().catch((err: unknown) => {
      log.error({ err: String(err) }, "[first-setup] could not read this computer's error-reports answer — that step is skipped");
      return undefined;
    }),
    // Right after a first sign-in the shell has not redirected to the library-key
    // step yet: wait for that step before asking anything.
    isLibraryKeyAcknowledged().catch(() => false),
  ]);
  const device: FirstSetupDevice = { transcode, uploads, errorReports: reports };
  if (!keyAcknowledged) {
    const open = openFirstSetupSteps(device);
    log.info({ steps: open.map((s) => s.id) }, "[first-setup] deferred — library key step not done yet");
    return { status: "deferred", openSteps: open.length };
  }
  const steps = openFirstSetupSteps(device);
  if (steps.length === 0) {
    log.info("[first-setup] already answered — not shown");
    return { status: "done" };
  }
  log.info(
    {
      steps: steps.map((s) => s.id),
      recommended: Object.fromEntries(steps.map((s) => [s.id, s.recommended(device)])),
    },
    "[first-setup] shown",
  );
  return { status: "needed", device, steps };
};

/**
 * Store every choice, in step order. Stops at the first failure so nothing later is saved.
 * `saved` collects the steps that are stored: a retry skips them (the main process keeps
 * the first answer it got, so storing a changed pick a second time would be silently ignored).
 */
export const saveFirstSetup = async (
  steps: readonly FirstSetupStep[],
  choices: Readonly<Record<string, string>>,
  device: FirstSetupDevice,
  saved: Set<string>,
): Promise<void> => {
  const bridge = window.sf?.deviceSettings;
  if (!bridge) throw new Error("device settings bridge unavailable");
  for (const step of steps) {
    if (saved.has(step.id)) continue;
    const choice = choices[step.id] ?? step.recommended(device);
    if (choice === null) {
      // A step with no recommendation and no pick stores nothing: the question comes back next start.
      log.info({ step: step.id }, "[first-setup] no answer picked — not stored");
      continue;
    }
    log.info({ step: step.id, choice, recommended: step.recommended(device) }, "[first-setup] saving answer");
    await step.save(bridge, choice, device);
    saved.add(step.id);
  }
  log.info({ steps: steps.map((s) => s.id) }, "[first-setup] finished");
};
