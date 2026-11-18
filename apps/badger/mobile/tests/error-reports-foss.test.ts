/**
 * @test-id MOBILE-ERRREPORT-004
 * @level unit
 * @why REL-LOG-06, issue #2570: a build with no reporting address (built without `src/generated/errorReportConfig.ts`,
 *   so `getBuildDsn()` is "") must never ask "Send error reports?": not as a phone setup step (the setup is numbered
 *   "of 2"), not as a TV setup step, and not as the question the navigator shows after the setup. A build with a DSN
 *   still asks. The shared reporter start, the setup steps and the navigator gate run for real; only the build's DSN,
 *   the Sentry SDK and storage are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAsyncStorage } from "./harness";

const fakeStorage = createFakeAsyncStorage();
const TAG = "[MOBILE-ERRREPORT-004]";
const sdk = vi.hoisted(() => ({ init: vi.fn(), close: vi.fn() }));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("@sentry/react-native", () => sdk);
// The real reader `require`s the generated file inside a try, out of vi.mock's reach; the DSN it returns is what counts.
let buildDsn = "";
vi.mock("../src/lib/errorReportConfig", () => ({ getBuildDsn: () => buildDsn }));

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/**
 * A fresh app process started the way `index.js` does. Dynamic imports on purpose: each boot resets the modules, and
 * only modules loaded after it see the flag that boot's start just set.
 */
const boot = async (dsn: string) => {
  vi.resetModules();
  buildDsn = dsn;
  (await import("../src/lib/errorReporting")).startErrorReporting();
  await flush();
  return {
    offered: (await import("@space/mobile-shell/error-reports-offered")).errorReportsOffered(),
    setup: await import("@space/mobile-shell/setup"),
    tv: await import("../src/tv/lib/tvSetup"),
    resolveNavigatorScreen: (await import("../src/navigation/resolveScreen")).resolveNavigatorScreen,
  };
};

/** Signed in, key in, library open, setup done, "Send error reports?" never answered: the navigator's last gate. */
const afterSetup = { authLoading: false, user: {}, contractIssue: null, formatTooNew: false, needsKey: false, errorReportsAnswered: false, initializing: false, datasetStatus: { core: true } };

beforeEach(() => {
  fakeStorage._backing.clear();
  sdk.init.mockReset();
  sdk.close.mockReset();
});

describe("a build with no reporting address offers no error reports (#2570)", () => {
  // @req REL-LOG-06[badger-mobile]
  // @req REL-LOG-06[badger-tv]
  it("with no reporting address the phone setup is two steps, the TV's has no reports step and the question never shows", async () => {
    const app = await boot("");
    const progress = { ...app.setup.INITIAL_PHONE_SETUP, languageReconciled: true };
    const state = {
      offered: app.offered,
      phone: app.setup.phoneSetupNumberedSteps(progress),
      tv: app.tv.tvSetupNumberedSteps({ pairedKey: false }),
      screen: app.resolveNavigatorScreen(afterSetup),
    };
    console.info(`${TAG} foss`, JSON.stringify(state));
    expect(state.offered).toBe(false);
    expect(state.phone).toEqual(["libraryKey", "notifications"]);
    expect(app.setup.phoneSetupPosition({ ...progress, step: "notifications" })).toEqual({ step: 2, total: 2 });
    expect(app.setup.nextPhoneSetupStep({ ...progress, step: "notifications" })).toBeNull();
    expect(state.tv).toEqual(["libraryKey"]);
    expect(state.screen).toBe("main");
    expect(sdk.init).not.toHaveBeenCalled();
  });

  // @req REL-LOG-06[badger-mobile]
  it("a build with a DSN still asks: step 3 of 3 on the phone and the question before the app", async () => {
    const app = await boot("https://0123456789abcdef@errors.example.test/7");
    const progress = { ...app.setup.INITIAL_PHONE_SETUP, step: "errorReports" as const };
    console.info(`${TAG} play`, JSON.stringify({ offered: app.offered, phone: app.setup.phoneSetupNumberedSteps(progress) }));
    expect(app.offered).toBe(true);
    expect(app.setup.phoneSetupPosition(progress)).toEqual({ step: 3, total: 3 });
    expect(app.tv.tvSetupNumberedSteps({ pairedKey: false })).toEqual(["libraryKey", "errorReports"]);
    expect(app.resolveNavigatorScreen(afterSetup)).toBe("onboarding-reports");
  });
});
