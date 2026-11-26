/**
 * @test-id TV-SETTINGS-ERROR-REPORTS-001
 * @level component
 * @why A TV user who said yes to error reports during setup must be able to turn them off again in Settings, and a
 *   user who said no must be able to turn them on (REL-LOG-06: "in the app's settings or during its setup steps").
 *   The TV Settings row is bound to the same stored answer as the phone (`errorReports` in the local app settings):
 *   it shows the stored value, OK on it flips the answer, the answer persists, and the reporter follows it at once
 *   (off closes the SDK, on starts it). Rendered with react-test-renderer: react-native is replaced by host-element
 *   stand-ins; the settings store, the error-report gate and the reporting controller are the real ones over a fake
 *   AsyncStorage, only the Sentry SDK is a spy.
 *
 * @req REL-LOG-06[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import { createReactNativeReporting } from "@space/error-report/react-native";
import { createFakeAsyncStorage } from "../../../tests/harness";
import {
  __resetAppSettingsForTests,
  APP_SETTINGS_STORAGE_KEY,
  getAppSettings,
  loadAppSettings,
  subscribeAppSettings,
} from "../../lib/appSettings";
import { followErrorReportSetting } from "@space/mobile-shell/errorReporting";
import { setErrorReportsOffered } from "@space/mobile-shell/error-reports-offered";
import { rememberTvSettingsGroup, resetTvSettingsGroup } from "../lib/tvSettingsGroups";
import { TvSettingsScreen } from "./TvSettingsScreen";

const fakeStorage = createFakeAsyncStorage();
const TEST_DSN = "https://0123456789abcdef@errors.example.test/7";
const ROW = "tv-settings-error-reports";
const TAG = "[TV-SETTINGS-ERROR-REPORTS-001]";

const sdk = vi.hoisted(() => ({ init: vi.fn(), close: vi.fn() }));

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    ScrollView: host("ScrollView"),
    Switch: host("Switch"),
    TVFocusGuideView: host("TVFocusGuideView"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFillObject: {} },
    Platform: { isTV: true, OS: "android", constants: {} },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    useWindowDimensions: () => ({ width: 960, height: 540 }),
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("@sentry/react-native", () => sdk);
vi.mock("../../lib/errorReportConfig", () => ({ getBuildDsn: () => TEST_DSN }));
vi.mock("@space/mobile-shell/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/theme")>();
  return { ...actual, useMobileShellTheme: () => actual.mergeMobileShellTheme(null) };
});
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: "en" } }) };
});
// Settings > About credits the outside data sources (#1689) under the open-source notice (UX-SET-03).
vi.mock("@space/mobile-shell/components", () => ({
  SkyCover: "SkyCover",
  useSkyScroll: () => ({}),
  MobileCreditsPanel: "MobileCreditsPanel",
  MobileOpenSourceNotice: "MobileOpenSourceNotice",
}));
// vi.mock factories run before the file's imports, so the shared stand-ins load inside it.
vi.mock("lucide-react-native", async () => (await import("../../../tests/setup/lucideMock")).lucideStandIns());
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }) }));
vi.mock("@space/mobile-shell/tv/useTvMenuKey", () => ({ useTvMenuKeyHold: () => undefined }));
vi.mock("../../lib/uiLanguage", () => ({ chooseUiLanguage: async () => undefined }));
vi.mock("../../lib/metadata/runtime", () => ({ mobileCreditsSource: { load: null, store: null } }));
// Sign out asks a key holder first (ACCT-DEV-03); the real module loads react-native-keychain, CommonJS out of vi.mock's reach.
vi.mock("../../lib/onboarding", () => ({ asksKeySavedBeforeSigningOut: async () => false }));
vi.mock("../../store/auth", () => ({
  useAuth: () => ({ token: "tok-1", user: { email: "tv@example.com", uiLanguage: "en" }, logout: async () => undefined }),
}));
vi.mock("../../lib/accountDevices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/accountDevices")>();
  return { ...actual, useAccountDevices: () => ({ sessions: [], loading: false, error: null, load: async () => undefined, signOut: async () => true }) };
});

let renderer: ReactTestRenderer | null = null;
let stopFollowing: (() => void) | null = null;

const phase = (name: string, detail: Record<string, unknown> = {}) => console.info(`${TAG} ${name}`, JSON.stringify(detail));
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const stored = (): Record<string, unknown> => JSON.parse(fakeStorage._backing.get(APP_SETTINGS_STORAGE_KEY) ?? "{}");
const one = (id: string): ReactTestInstance => {
  const found = renderer!.root.findAll((node) => typeof (node.type as unknown) === "string" && node.props.testID === id);
  if (found.length !== 1) {
    const ids = renderer!.root.findAll((node) => typeof node.props.testID === "string").map((node) => node.props.testID);
    console.info(`${TAG} testIDs on screen`, JSON.stringify(ids));
    throw new Error(`expected one ${id}, found ${found.length}`);
  }
  return found[0];
};
const dump = (label: string) => {
  const row = one(ROW);
  // The row's toggle (TvToggle) shows its state as its test id.
  const sw = row.findAll((node) => typeof (node.type as unknown) === "string" && /^tv-toggle-(on|off)$/.test(String(node.props.testID ?? "")));
  const state = {
    rowChecked: row.props.accessibilityState?.checked,
    rowLabel: row.props.accessibilityLabel,
    rowFocusable: row.props.focusable,
    switchValue: sw.length === 1 ? sw[0].props.testID === "tv-toggle-on" : undefined,
    store: { errorReports: getAppSettings().errorReports, errorReportsDecided: getAppSettings().errorReportsDecided },
    storage: stored(),
    sdkInit: sdk.init.mock.calls.length,
    sdkClose: sdk.close.mock.calls.length,
  };
  phase(`state:${label}`, state);
  return state;
};

/**
 * Starts the app the way `index.js` does: stored answer → settings store → reporter following it. Then TV Settings,
 * on its Privacy group (UX-TV-42: the group last opened in this app session).
 */
const boot = async (storedAnswer: { errorReports: boolean; errorReportsDecided: boolean } | null) => {
  if (storedAnswer) fakeStorage._backing.set(APP_SETTINGS_STORAGE_KEY, JSON.stringify(storedAnswer));
  phase("boot", { storedAnswer });
  rememberTvSettingsGroup("privacy");
  const reporting = createReactNativeReporting({ dsn: TEST_DSN, release: "0.0.0-test" });
  stopFollowing = followErrorReportSetting(reporting, { load: loadAppSettings, get: getAppSettings, subscribe: subscribeAppSettings });
  await flush();
  await act(async () => {
    renderer = create(<TvSettingsScreen history={null} />);
  });
  await flush();
};
const pressRow = async () => {
  phase("press", { id: ROW });
  await act(async () => {
    one(ROW).props.onPress();
  });
  await flush();
};

beforeAll(async () => {
  await initI18n("en");
});
beforeEach(() => {
  phase("reset");
  fakeStorage._backing.clear();
  __resetAppSettingsForTests();
  resetTvSettingsGroup();
  sdk.init.mockReset();
  sdk.close.mockReset();
  sdk.close.mockResolvedValue(true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  stopFollowing?.();
  stopFollowing = null;
});

describe("TV Settings: error reports switch", () => {
  // @req REL-LOG-06[badger-tv]
  it("@req REL-LOG-06[badger-tv] a yes from setup shows on; OK turns it off, persists it and stops the reporter", async () => {
    await boot({ errorReports: true, errorReportsDecided: true });
    const before = dump("after-boot");
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(before.rowChecked).toBe(true);
    expect(before.switchValue).toBe(true);
    expect(before.rowFocusable).not.toBe(false);
    expect(before.rowLabel).toBe("Send error reports");

    await pressRow();
    const after = dump("after-off");
    expect(after.rowChecked).toBe(false);
    expect(after.switchValue).toBe(false);
    expect(after.storage).toMatchObject({ errorReports: false, errorReportsDecided: true });
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });

  // @req REL-LOG-06[badger-tv]
  it("@req REL-LOG-06[badger-tv] a no from setup shows off; OK turns it on, persists it and starts the reporter", async () => {
    await boot({ errorReports: false, errorReportsDecided: true });
    const before = dump("after-boot");
    expect(sdk.init).not.toHaveBeenCalled();
    expect(before.rowChecked).toBe(false);
    expect(before.switchValue).toBe(false);

    await pressRow();
    const after = dump("after-on");
    expect(after.rowChecked).toBe(true);
    expect(after.switchValue).toBe(true);
    expect(after.storage).toMatchObject({ errorReports: true, errorReportsDecided: true });
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.close).not.toHaveBeenCalled();
  });

  // @req REL-LOG-06[badger-tv]
  it("@req REL-LOG-06[badger-tv] sits in a Privacy group, like the phone's Settings", async () => {
    await boot(null);
    dump("after-boot");
    const groupTitles = renderer!.root
      .findAll((node) => (node.type as unknown) === "Text" && node.props.accessibilityRole === "header")
      .map((node) => [node.props.children].flat().join(""));
    phase("headers", { groupTitles });
    expect(groupTitles).toContain("Privacy");
    expect(sdk.init).not.toHaveBeenCalled();
  });

  // @req REL-LOG-06[badger-tv]
  it("@req REL-LOG-06[badger-tv] a build with no reporting address has no Privacy group and no switch (#2570)", async () => {
    setErrorReportsOffered("");
    try {
      await act(async () => {
        renderer = create(<TvSettingsScreen history={null} />);
      });
      await flush();
      const ids = renderer!.root.findAll((node) => typeof (node.type as unknown) === "string" && typeof node.props.testID === "string").map((node) => node.props.testID as string);
      phase("foss", { groups: ids.filter((id) => id.startsWith("tv-settings-group-")) });
      expect(ids).toContain("tv-settings-group-playback");
      expect(ids).not.toContain("tv-settings-group-privacy");
      expect(ids).not.toContain(ROW);
    } finally {
      setErrorReportsOffered(TEST_DSN);
    }
  });
});
