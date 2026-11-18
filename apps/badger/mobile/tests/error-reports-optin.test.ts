/**
 * @test-id MOBILE-ERRREPORT-001
 * @level unit
 * @why Error reports are opt-in (REL-LOG-06): a build must never initialise the reporting SDK, or touch the network
 *   for it, before the user says yes; the answer must persist, apply live and survive a restart. The tests run the real
 *   settings store (fake AsyncStorage) and the real `@space/error-report` gate; only the Sentry SDK itself is a spy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAsyncStorage } from "./harness";

const fakeStorage = createFakeAsyncStorage();
const TEST_DSN = "https://0123456789abcdef@errors.example.test/7";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("@sentry/react-native", () => sdk);
vi.mock("react-native", () => ({ Platform: { isTV: false, OS: "android" } }));
vi.mock("../src/lib/errorReportConfig", () => ({ getBuildDsn: () => dsnForBuild.value }));

const dsnForBuild = vi.hoisted(() => ({ value: "" }));
const fetchSpy = vi.fn();

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A fresh app process: new module instances, same storage. */
const boot = async () => {
  vi.resetModules();
  const settings = await import("../src/lib/appSettings");
  settings.__resetAppSettingsForTests();
  const reporting = await import("../src/lib/errorReporting");
  return { settings, reporting };
};

beforeEach(() => {
  console.info("[error-reports:reset] clearing storage and spies");
  fakeStorage._backing.clear();
  dsnForBuild.value = TEST_DSN;
  sdk.init.mockReset();
  sdk.close.mockReset();
  sdk.close.mockResolvedValue(true);
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

describe("error reports are off until the user opts in", () => {
  // @req REL-LOG-06[badger-mobile]
  it("a fresh install starts without touching the SDK or the network", async () => {
    console.info("[error-reports] fresh install: no stored settings");
    const { reporting } = await boot();
    reporting.startErrorReporting();
    await flush();
    expect(sdk.init).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // @req REL-LOG-06[badger-mobile]
  it("a declined answer stays declined across restarts and never starts the SDK", async () => {
    const first = await boot();
    await first.settings.loadAppSettings();
    first.settings.updateAppSettings({ errorReports: false });
    await flush();
    console.info("[error-reports] stored:", fakeStorage._backing.get(first.settings.APP_SETTINGS_STORAGE_KEY));

    const second = await boot();
    second.reporting.startErrorReporting();
    await flush();
    expect(second.settings.getAppSettings()).toMatchObject({ errorReports: false, errorReportsDecided: true });
    expect(sdk.init).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // @req REL-LOG-06[badger-mobile]
  it("an unreadable settings store means off", async () => {
    fakeStorage._backing.set("sf:app-settings:v1", JSON.stringify({ errorReports: true, errorReportsDecided: true }));
    const getItem = vi.spyOn(fakeStorage, "getItem").mockRejectedValue(new Error("storage unavailable"));
    const { reporting } = await boot();
    reporting.startErrorReporting();
    await flush();
    console.info("[error-reports] storage read attempts:", getItem.mock.calls.length);
    expect(getItem).toHaveBeenCalled();
    expect(sdk.init).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // @req REL-LOG-06[badger-mobile]
  it("a stored yes without the user having decided (never written by the app) is not a yes", async () => {
    fakeStorage._backing.set("sf:app-settings:v1", JSON.stringify({ errorReports: true }));
    const { reporting } = await boot();
    reporting.startErrorReporting();
    await flush();
    expect(sdk.init).not.toHaveBeenCalled();
  });
});

describe("opting in", () => {
  // @req REL-LOG-06[badger-mobile]
  it("starts the JavaScript SDK with the build DSN and the app version once a saved yes is read at startup", async () => {
    fakeStorage._backing.set("sf:app-settings:v1", JSON.stringify({ errorReports: true, errorReportsDecided: true }));
    const { reporting } = await boot();
    reporting.startErrorReporting();
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled(), { timeout: 5000 });
    expect(sdk.init).toHaveBeenCalledTimes(1);
    const options = sdk.init.mock.calls[0][0];
    console.info("[error-reports] init options:", JSON.stringify({ ...options, beforeSend: typeof options.beforeSend, integrations: typeof options.integrations }));
    const pkg = (await import("../package.json")).default;
    expect(options).toMatchObject({
      dsn: TEST_DSN,
      release: pkg.version,
      enableNative: false,
      enableNativeCrashHandling: false,
      enableAutoSessionTracking: false,
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
    });
    expect(typeof options.beforeSend).toBe("function");
  });

  // @req REL-LOG-06[badger-mobile]
  it("turning it on in the app starts reporting without a restart, turning it off stops it, and each answer persists", async () => {
    const { settings, reporting } = await boot();
    reporting.startErrorReporting();
    await flush();
    expect(sdk.init).not.toHaveBeenCalled();

    console.info("[error-reports] user opts in");
    settings.updateAppSettings({ errorReports: true });
    await flush();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.close).not.toHaveBeenCalled();
    expect(JSON.parse(fakeStorage._backing.get(settings.APP_SETTINGS_STORAGE_KEY) ?? "{}")).toMatchObject({
      errorReports: true,
      errorReportsDecided: true,
    });

    console.info("[error-reports] user opts out");
    settings.updateAppSettings({ errorReports: false });
    await flush();
    expect(sdk.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fakeStorage._backing.get(settings.APP_SETTINGS_STORAGE_KEY) ?? "{}")).toMatchObject({
      errorReports: false,
      errorReportsDecided: true,
    });

    settings.updateAppSettings({ autoSkipIntro: false });
    await flush();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });

  // @req REL-LOG-06[badger-mobile]
  it("a build without a DSN cannot report even when the user said yes", async () => {
    dsnForBuild.value = "";
    fakeStorage._backing.set("sf:app-settings:v1", JSON.stringify({ errorReports: true, errorReportsDecided: true }));
    const { reporting } = await boot();
    reporting.startErrorReporting();
    await flush();
    expect(sdk.init).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the one-time question", () => {
  // @req REL-LOG-06[badger-mobile]
  it("existing installs that never answered are undecided, answering either way marks it decided", async () => {
    // A settings file from before this feature: no error-report keys at all.
    fakeStorage._backing.set("sf:app-settings:v1", JSON.stringify({ autoSkipIntro: false }));
    const { settings } = await boot();
    const loaded = await settings.loadAppSettings();
    expect(loaded).toMatchObject({ errorReports: false, errorReportsDecided: false, autoSkipIntro: false });

    settings.updateAppSettings({ errorReports: false });
    await flush();
    const restarted = await boot();
    const reloaded = await restarted.settings.loadAppSettings();
    console.info("[error-reports] after answering no and restarting:", JSON.stringify(reloaded));
    expect(reloaded).toMatchObject({ errorReports: false, errorReportsDecided: true, autoSkipIntro: false });
  });

  // @req REL-LOG-06[badger-mobile]
  it("routes an undecided user to the reports step exactly once", async () => {
    const { resolveNavigatorScreen } = await import("../src/navigation/resolveScreen");
    const ready = {
      authLoading: false,
      user: { id: "u1" },
      contractIssue: null,
      formatTooNew: false,
      needsKey: false,
      initializing: false,
      datasetStatus: { core: true },
    };
    const first = await boot();
    const screens: string[] = [];
    const next = (settings: typeof first.settings) =>
      resolveNavigatorScreen({ ...ready, errorReportsAnswered: settings.getAppSettings().errorReportsDecided });

    await first.settings.loadAppSettings();
    screens.push(next(first.settings));
    first.settings.updateAppSettings({ errorReports: true });
    screens.push(next(first.settings));
    await flush();

    const restarted = await boot();
    await restarted.settings.loadAppSettings();
    screens.push(next(restarted.settings));
    console.info("[error-reports] screens over time:", screens.join(" -> "));
    expect(screens).toEqual(["onboarding-reports", "main", "main"]);
  });

  // @req REL-LOG-06[badger-mobile]
  it("the answer is not kept in anything the account syncs: only the local settings key is written", async () => {
    const { settings } = await boot();
    await settings.loadAppSettings();
    settings.updateAppSettings({ errorReports: true });
    await flush();
    const keys = [...fakeStorage._backing.keys()];
    console.info("[error-reports] storage keys written:", keys.join(", "));
    expect(keys).toEqual(["sf:app-settings:v1"]);
  });
});
