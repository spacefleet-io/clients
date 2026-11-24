/**
 * Parrot desktop's error reports (REL-LOG-06) run on the shared desktop basis: the setup answer is stored through the
 * shared controller in `<userData>/error-reports.json` (the file Parrot always used), reporting is off until the user
 * says yes, and a build without a reporting address never starts it. The Sentry SDK adapter is replaced by a recorder;
 * the consent file, the controller and the setup saver are the real code.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParrotSetupState } from "../src/shared/ipc";

const SUITE = "[parrot-error-reports]";

const sdk = vi.hoisted(() => {
  const calls: Array<{ dsn: string; release: string; setEnabled: boolean[] }> = [];
  return { calls };
});

vi.mock("@space/error-report/electron-main", () => ({
  createElectronMainReporting: ({ dsn, release }: { dsn: string; release: string }) => {
    const record = { dsn, release, setEnabled: [] as boolean[] };
    sdk.calls.push(record);
    let enabled = false;
    return {
      isEnabled: () => enabled,
      async setEnabled(on: boolean) {
        record.setEnabled.push(on);
        enabled = on;
      },
    };
  },
}));

import { createConsentFile } from "@space/error-report/consent-file";
import { createDesktopErrorReports } from "@space/error-report/desktop-main-reports";
import { createSetupSaver } from "../src/main/errorReports";

const VALID_DSN = "https://publickey@bugsink.example.com/7";

const baseSetup = (): ParrotSetupState => ({
  step: "errorReports",
  done: false,
  language: "en",
  folders: [],
  startAtLogin: false,
  errorReports: false,
});

const fakeStore = () => {
  let setup = baseSetup();
  return {
    get setup() {
      return setup;
    },
    async updateSetup(patch: Partial<ParrotSetupState>) {
      setup = { ...setup, ...patch };
    },
  };
};

describe("@req REL-LOG-06[parrot] error reports on the shared desktop controller", () => {
  let dir: string;
  let lines: string[];
  const log = (line: string) => {
    lines.push(line);
    console.info(`${SUITE} log: ${line}`);
  };
  const fail = (line: string) => {
    lines.push(`FAIL ${line}`);
    console.info(`${SUITE} fail: ${line}`);
  };
  const consentPath = () => join(dir, "error-reports.json");
  const dump = (phase: string) => {
    console.info(`${SUITE} ${phase}: consent file=${existsSync(consentPath()) ? readFileSync(consentPath(), "utf8").trim() : "(none)"}`);
    console.info(`${SUITE} ${phase}: sdk=${JSON.stringify(sdk.calls)} lines=${JSON.stringify(lines)}`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parrot-error-reports-"));
    lines = [];
    sdk.calls.length = 0;
    console.info(`${SUITE} userData=${dir}`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is off by default: a fresh userData is undecided and the SDK is never enabled", async () => {
    const controller = createDesktopErrorReports({ app: "parrot", userDataDir: dir, dsn: VALID_DSN, release: "0.1.0", forcedRaw: undefined, log, logError: fail });
    await controller.start();
    dump("fresh start");
    expect(controller.getState()).toEqual({ decision: "undecided", available: true, release: "0.1.0" });
    expect(sdk.calls[0]).toMatchObject({ dsn: VALID_DSN, release: "0.1.0" });
    expect(sdk.calls[0]!.setEnabled).not.toContain(true);
    expect(existsSync(consentPath())).toBe(false);
  });

  it("stores the setup answer through the shared controller in <userData>/error-reports.json and starts reporting", async () => {
    const controller = createDesktopErrorReports({ app: "parrot", userDataDir: dir, dsn: VALID_DSN, release: "0.1.0", forcedRaw: undefined, log, logError: fail });
    await controller.start();
    const store = fakeStore();
    const setDecision = vi.spyOn(controller, "setDecision");
    const save = createSetupSaver({ store, errorReports: controller, applyStartAtLogin: () => undefined, log, fail });

    console.info(`${SUITE} phase: finish setup with errorReports=true`);
    await save({ errorReports: true, done: true });
    dump("after yes");
    expect(setDecision).toHaveBeenCalledWith("on");
    expect(JSON.parse(readFileSync(consentPath(), "utf8"))).toEqual({ version: 1, decision: "on" });
    expect(sdk.calls[0]!.setEnabled.at(-1)).toBe(true);
    expect(store.setup.errorReports).toBe(true);

    console.info(`${SUITE} phase: a second start reads the stored answer`);
    const again = createDesktopErrorReports({ app: "parrot", userDataDir: dir, dsn: VALID_DSN, release: "0.1.0", forcedRaw: undefined, log, logError: fail });
    await again.start();
    dump("restart");
    expect(again.getState().decision).toBe("on");
    expect(sdk.calls[1]!.setEnabled).toEqual([true]);

    console.info(`${SUITE} phase: answer no`);
    await save({ errorReports: false });
    dump("after no");
    expect(setDecision).toHaveBeenLastCalledWith("off");
    expect(JSON.parse(readFileSync(consentPath(), "utf8"))).toEqual({ version: 1, decision: "off" });
    expect(sdk.calls[0]!.setEnabled.at(-1)).toBe(false);
  });

  it("keeps an answer Parrot stored before the cutover (same file, same format)", async () => {
    createConsentFile(consentPath()).write("on");
    const controller = createDesktopErrorReports({ app: "parrot", userDataDir: dir, dsn: VALID_DSN, release: "0.1.0", forcedRaw: undefined, log, logError: fail });
    await controller.start();
    dump("pre-existing answer");
    expect(controller.getState().decision).toBe("on");
    expect(sdk.calls[0]!.setEnabled).toEqual([true]);
  });

  it("never starts reporting in a build without a reporting address, even after yes", async () => {
    const controller = createDesktopErrorReports({ app: "parrot", userDataDir: dir, dsn: "", release: "0.1.0", forcedRaw: undefined, log, logError: fail });
    await controller.start();
    const save = createSetupSaver({ store: fakeStore(), errorReports: controller, applyStartAtLogin: () => undefined, log, fail });
    await save({ errorReports: true, done: true });
    dump("no dsn");
    expect(controller.getState()).toMatchObject({ decision: "on", available: false });
    expect(sdk.calls[0]!.setEnabled).not.toContain(true);
  });

  it("SF_ERROR_REPORTS=off answers for the run without touching the file", async () => {
    const controller = createDesktopErrorReports({ app: "parrot", userDataDir: dir, dsn: VALID_DSN, release: "0.1.0", forcedRaw: "off", log, logError: fail });
    await controller.start();
    const save = createSetupSaver({ store: fakeStore(), errorReports: controller, applyStartAtLogin: () => undefined, log, fail });
    await save({ errorReports: true, done: true });
    dump("forced off");
    expect(controller.getState().decision).toBe("off");
    expect(existsSync(consentPath())).toBe(false);
    expect(sdk.calls[0]!.setEnabled).not.toContain(true);
  });

  it("a failing SDK does not break setup: the failure is logged and setup state is still saved", async () => {
    const store = fakeStore();
    const save = createSetupSaver({
      store,
      errorReports: { setDecision: async () => Promise.reject(new Error("sdk exploded")) },
      applyStartAtLogin: () => undefined,
      log,
      fail,
    });
    await expect(save({ errorReports: true, done: true })).resolves.toBeUndefined();
    dump("sdk failure");
    expect(store.setup).toMatchObject({ errorReports: true, done: true });
    expect(lines.some((line) => line.startsWith("FAIL [error-report]") && line.includes("sdk exploded"))).toBe(true);
  });
});
