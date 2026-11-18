/**
 * @test-id PARROT-MOBILE-ERRREPORT-001
 * @level unit
 * @why Parrot's error reports run on the phone basis shared with Badger (REL-FAM-03) and stay opt-in (REL-LOG-06):
 *   the SDK is never initialised before the user turns the Settings switch on, the answer persists across restarts,
 *   and turning it off stops reporting at once. The real settings store (fake AsyncStorage), the shared follower and
 *   the real `@space/error-report` gate run; only the Sentry SDK is a spy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";

const P = "[parrot-error-reports]";
const TEST_DSN = "https://0123456789abcdef@errors.example.test/9";

const storage = vi.hoisted(() => new Map<string, string>());
const sdk = vi.hoisted(() => ({ init: vi.fn(), close: vi.fn() }));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value),
  },
}));
vi.mock("@sentry/react-native", () => sdk);
vi.mock("react-native", () => ({ Platform: { isTV: false, OS: "android" } }));

/** Lets the stored answer be read and applied (all promise work, no timers involved). */
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

/** A fresh app process: new module instances, same storage (dynamic on purpose: each boot re-runs module state). */
const boot = async () => {
  vi.resetModules();
  return import("../src/lib/errorReports");
};

beforeEach(() => {
  console.info(`${P} phase=reset storage and SDK spies`);
  storage.clear();
  sdk.init.mockReset();
  sdk.close.mockReset();
  sdk.close.mockResolvedValue(true);
});

describe("@req REL-LOG-06[parrot] Parrot error reports stay off until the user opts in", () => {
  it("a fresh install never touches the SDK", async () => {
    const reports = await boot();
    reports.startParrotErrorReporting(TEST_DSN);
    await flush();
    console.info(`${P} phase=fresh setting=${JSON.stringify(reports.getErrorReportsSetting())} init=${sdk.init.mock.calls.length}`);
    expect(reports.getErrorReportsSetting()).toEqual({ errorReports: false, errorReportsDecided: false });
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("a build without a DSN never starts the SDK, even with the switch on", async () => {
    storage.set("parrot.errorReports", JSON.stringify({ errorReports: true }));
    const reports = await boot();
    reports.startParrotErrorReporting("");
    await flush();
    console.info(`${P} phase=no-dsn init=${sdk.init.mock.calls.length}`);
    expect(reports.getErrorReportsSetting().errorReports).toBe(true);
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("an unreadable stored answer means off", async () => {
    storage.set("parrot.errorReports", "{not json");
    const reports = await boot();
    reports.startParrotErrorReporting(TEST_DSN);
    await flush();
    expect(sdk.init).not.toHaveBeenCalled();
  });
});

describe("@req REL-LOG-06[parrot] turning the switch on and off applies at once and persists", () => {
  it("on starts the JavaScript SDK with Parrot's DSN and version, off closes it, and the answer survives a restart", async () => {
    const first = await boot();
    first.startParrotErrorReporting(TEST_DSN);
    await flush();
    await first.setErrorReports(true);
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const options = sdk.init.mock.calls[0][0];
    console.info(`${P} phase=on dsn=${options.dsn === TEST_DSN} release=${options.release} enableNative=${options.enableNative}`);
    expect(options).toMatchObject({ dsn: TEST_DSN, release: pkg.version, enableNative: false });
    expect(storage.get("parrot.errorReports")).toBe(JSON.stringify({ errorReports: true }));

    await first.setErrorReports(false);
    await vi.waitFor(() => expect(sdk.close).toHaveBeenCalledTimes(1), { timeout: 5000 });
    console.info(`${P} phase=off stored=${storage.get("parrot.errorReports")}`);

    sdk.init.mockReset();
    const second = await boot();
    second.startParrotErrorReporting(TEST_DSN);
    await flush();
    console.info(`${P} phase=restart setting=${JSON.stringify(second.getErrorReportsSetting())}`);
    expect(second.getErrorReportsSetting()).toEqual({ errorReports: false, errorReportsDecided: true });
    expect(sdk.init).not.toHaveBeenCalled();
  });
});

describe("@req UX-SETUP-09[parrot] keeping the preselected 'off' in setup is an answer", () => {
  it("a fresh install that keeps off is stored as decided and is not asked again after a restart", async () => {
    const first = await boot();
    first.startParrotErrorReporting(TEST_DSN);
    await flush();
    expect(first.getErrorReportsSetting(), "fresh: off and never asked").toEqual({ errorReports: false, errorReportsDecided: false });
    // The setup step's Next calls `errorReports.save(false)` with the preselected answer (PhoneSetupFlow).
    await first.setErrorReports(false);
    console.info(`${P} phase=keep-default stored=${storage.get("parrot.errorReports")}`);
    expect(storage.get("parrot.errorReports")).toBe(JSON.stringify({ errorReports: false }));

    const second = await boot();
    second.startParrotErrorReporting(TEST_DSN);
    await flush();
    console.info(`${P} phase=keep-default-restart setting=${JSON.stringify(second.getErrorReportsSetting())}`);
    expect(second.getErrorReportsSetting()).toEqual({ errorReports: false, errorReportsDecided: true });
    expect(sdk.init).not.toHaveBeenCalled();
  });
});

// Dynamic imports on purpose: after `boot()` resets the modules, only these see the flag that boot just set.
describe("@req REL-LOG-06[parrot] a build with no reporting address offers no error reports (#2570)", () => {
  it("with no generated config the setup has no error reports step: step N of 2", async () => {
    const reports = await boot();
    // No argument: the DSN read from `src/generated/errorReportConfig.ts`, absent in this test.
    reports.startParrotErrorReporting();
    await flush();
    const { errorReportsOffered } = await import("@space/mobile-shell/error-reports-offered");
    const setup = await import("@space/mobile-shell/setup");
    const progress = { ...setup.INITIAL_PHONE_SETUP, languageReconciled: true };
    console.info(`${P} phase=foss offered=${errorReportsOffered()} steps=${JSON.stringify(setup.phoneSetupNumberedSteps(progress))}`);
    expect(errorReportsOffered()).toBe(false);
    expect(setup.phoneSetupNumberedSteps(progress)).toEqual(["libraryKey", "notifications"]);
    expect(setup.phoneSetupPosition({ ...progress, step: "notifications" })).toEqual({ step: 2, total: 2 });
    expect(setup.nextPhoneSetupStep({ ...progress, step: "notifications" })).toBeNull();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("a build with a DSN keeps the question as step 3 of 3", async () => {
    const reports = await boot();
    reports.startParrotErrorReporting(TEST_DSN);
    await flush();
    const { errorReportsOffered } = await import("@space/mobile-shell/error-reports-offered");
    const setup = await import("@space/mobile-shell/setup");
    console.info(`${P} phase=play offered=${errorReportsOffered()}`);
    expect(errorReportsOffered()).toBe(true);
    expect(setup.phoneSetupPosition({ ...setup.INITIAL_PHONE_SETUP, step: "errorReports" })).toEqual({ step: 3, total: 3 });
  });
});
