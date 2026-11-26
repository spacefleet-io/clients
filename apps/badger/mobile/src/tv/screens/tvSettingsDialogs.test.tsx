/**
 * @test-id TV-SETTINGS-DIALOGS-001
 * @level component
 * @why On the TV, a long choice (the default audio language) and a list that grows with the account (the signed-in
 *   devices) must each be one Settings row that opens its own scrolling dialog: the focus starts on the current
 *   choice, Back closes it and hands the focus back to its row, picking a language saves it, and a device is signed
 *   out only after a confirmation whose safe answer (Cancel) holds the focus. Signing this TV itself out is the
 *   ordinary sign-out. Rendered with react-test-renderer: react-native is replaced by host-element stand-ins, the
 *   devices API by a fake hook and the stored settings by an in-memory store.
 *
 * @req UX-LIST-01[badger-tv]
 * @req ACCT-DEV-01[badger-tv]
 * @req ACCT-SQUAD-03[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, translate } from "@space/mobile-shell/i18n";
import type { Session } from "@space/shared/api";
import { dialogInitialFocusIndex } from "@space/mobile-shell/tv/TvListDialog";
import { choiceOpensWindow, INLINE_CHOICE_LIMIT } from "../../lib/choiceLayout";
import { rememberTvSettingsGroup, resetTvSettingsGroup, type TvSettingsGroupId } from "../lib/tvSettingsGroups";
import { TvSettingsScreen } from "./TvSettingsScreen";

type FakeSettings = { defaultAudioLanguage: string | null; defaultSubtitleLanguage?: string | null; [key: string]: unknown };

const ctl = vi.hoisted(() => ({
  backHandlers: [] as Array<() => boolean>,
  settings: null as FakeSettings | null,
  patches: [] as Array<Record<string, unknown>>,
  sessions: [] as Session[],
  signedOut: [] as string[],
  signOutResult: true,
  loads: 0,
  logoutReasons: [] as string[],
  storedKey: null as string | null,
  logouts: 0,
  events: [] as string[],
}));

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
    BackHandler: {
      addEventListener: (_event: string, handler: () => boolean) => {
        ctl.backHandlers.push(handler);
        return { remove: () => ctl.backHandlers.splice(ctl.backHandlers.indexOf(handler), 1) };
      },
    },
    useWindowDimensions: () => ({ width: 960, height: 540 }),
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock("@space/mobile-shell/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/theme")>();
  return { ...actual, useMobileShellTheme: () => actual.mergeMobileShellTheme(null) };
});
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: "en" } }) };
});
vi.mock("@space/mobile-shell/components", () => ({
  SkyCover: "SkyCover",
  SkyCoversProvider: "SkyCoversProvider",
  MobileCreditsPanel: "MobileCreditsPanel",
  MobileOpenSourceNotice: "MobileOpenSourceNotice",
  useSkyScroll: () => ({}),
}));
// vi.mock factories run before the file's imports, so the shared stand-ins load inside it.
vi.mock("lucide-react-native", async () => (await import("../../../tests/setup/lucideMock")).lucideStandIns());
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }) }));
vi.mock("@space/mobile-shell/tv/useTvMenuKey", () => ({ useTvMenuKeyHold: () => undefined }));
vi.mock("../../lib/uiLanguage", () => ({ chooseUiLanguage: async () => undefined }));
vi.mock("../../lib/metadata/runtime", () => ({ mobileCreditsSource: { load: null, store: null } }));
vi.mock("../../lib/onboarding", async () => {
  const { asksKeySavedBeforeSigningOut } = await import("@space/mobile-shell/libraryKey");
  return { asksKeySavedBeforeSigningOut: () => asksKeySavedBeforeSigningOut(async () => ctl.storedKey) };
});
vi.mock("../../store/auth", () => ({
  useAuth: () => ({
    token: "tok-1",
    user: { email: "chris@example.com", uiLanguage: "en" },
    logout: async (reason: string) => {
      ctl.logouts += 1;
      ctl.logoutReasons.push(reason);
    },
  }),
}));
vi.mock("../../lib/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/appSettings")>();
  const ReactModule = await import("react");
  return {
    ...actual,
    useAppSettings: () => {
      const [settings, setSettings] = ReactModule.useState(() => ({ ...actual.DEFAULT_APP_SETTINGS, ...ctl.settings }));
      const update = (patch: Record<string, unknown>) => {
        ctl.patches.push(patch);
        setSettings((prev) => ({ ...prev, ...patch }));
      };
      return [settings, update];
    },
  };
});
vi.mock("../../lib/accountDevices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/accountDevices")>();
  const ReactModule = await import("react");
  return {
    ...actual,
    useAccountDevices: () => {
      const [sessions, setSessions] = ReactModule.useState<Session[]>(() => ctl.sessions);
      const load = ReactModule.useCallback(async () => {
        ctl.loads += 1;
      }, []);
      const signOut = ReactModule.useCallback(async (session: Session) => {
        ctl.signedOut.push(session.id);
        if (ctl.signOutResult) setSessions((prev) => prev.filter((item) => item.id !== session.id));
        return ctl.signOutResult;
      }, []);
      return { sessions, loading: false, error: ctl.signOutResult ? null : "revoke", load, signOut };
    },
  };
});

let renderer: ReactTestRenderer | null = null;

const phase = (name: string, detail: Record<string, unknown> = {}) => console.info(`[tv-settings-dialogs] ${name}`, JSON.stringify(detail));

const session = (id: string, current: boolean, deviceName: string): Session =>
  ({ id, current, deviceName, clientType: "badger-mobile", lastSeen: "2026-10-21T10:00:00.000Z" }) as Session;

const byTestId = (id: string): ReactTestInstance[] =>
  (renderer?.root.findAll((node) => typeof (node.type as unknown) === "string" && node.props.testID === id) ?? []) as ReactTestInstance[];
const one = (id: string): ReactTestInstance => {
  const found = byTestId(id);
  if (found.length !== 1) throw new Error(`expected one ${id}, found ${found.length}`);
  return found[0];
};
const has = (id: string): boolean => byTestId(id).length > 0;
const press = async (id: string) => {
  phase("press", { id });
  await act(async () => {
    one(id).props.onPress();
    // Sign out reads the stored key before it decides: let that chain settle.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
};
const back = async () => {
  phase("back", { handlers: ctl.backHandlers.length });
  await act(async () => {
    const handlers = [...ctl.backHandlers].reverse();
    for (const handler of handlers) if (handler()) return;
  });
};

/** Mount Settings with `group` open (the group the app session remembers; Playback when none, UX-TV-42). */
const render = async (group?: TvSettingsGroupId) => {
  if (group) rememberTvSettingsGroup(group);
  phase("render", { group: group ?? "default" });
  await act(async () => {
    renderer = create(<TvSettingsScreen history={null} />);
  });
};

beforeAll(async () => {
  await initI18n("en");
});

beforeEach(() => {
  resetTvSettingsGroup();
  ctl.backHandlers = [];
  ctl.settings = { defaultAudioLanguage: null };
  ctl.patches = [];
  ctl.sessions = [session("s-tv", true, "Living room TV"), session("s-phone", false, "Hallway phone"), session("s-tablet", false, "Kitchen tablet")];
  ctl.signedOut = [];
  ctl.signOutResult = true;
  ctl.loads = 0;
  ctl.logouts = 0;
  ctl.logoutReasons = [];
  ctl.storedKey = "a".repeat(43) + "=";
  ctl.events = [];
  vi.spyOn(console, "info").mockImplementation((event: unknown, payload?: unknown) => {
    if (typeof event === "string" && event.startsWith("tv.")) ctl.events.push(`${event} ${String(payload ?? "")}`);
  });
});

afterEach(async () => {
  phase("teardown", { events: ctl.events });
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("where a TV dialog puts the focus first", () => {
  it("starts on the named item, else on the current choice, else on the first row, else on Close", () => {
    const items = [{ key: "a" }, { key: "b", selected: true }, { key: "c" }];
    expect(dialogInitialFocusIndex(items, "c")).toBe(2);
    expect(dialogInitialFocusIndex(items)).toBe(1);
    expect(dialogInitialFocusIndex(items, "missing")).toBe(1);
    expect(dialogInitialFocusIndex([{ key: "a" }, { key: "b" }])).toBe(0);
    expect(dialogInitialFocusIndex([])).toBe(-1);
  });

  it("keeps a handful of options inline and opens a window past six", () => {
    expect(INLINE_CHOICE_LIMIT).toBe(6);
    expect(choiceOpensWindow(4)).toBe(false);
    expect(choiceOpensWindow(6)).toBe(false);
    expect(choiceOpensWindow(7)).toBe(true);
  });
});

describe("the default audio language opens its own list on the TV (UX-LIST-01)", () => {
  it("is one row; OK opens a scrolling dialog focused on the current choice; picking saves it and closes", async () => {
    ctl.settings = { defaultAudioLanguage: "fr" };
    await render();
    phase("rendered", {});
    const row = one("tv-settings-audio-language");
    expect(row.props.accessibilityLabel).toContain(translate("settings.playback.audioLanguage.title"));
    expect(has("tv-audio-language-dialog")).toBe(false);
    // No option of the long list sits inline in the page.
    expect(has("tv-audio-language-fr")).toBe(false);

    await press("tv-settings-audio-language");
    expect(has("tv-audio-language-dialog")).toBe(true);
    const french = one("tv-audio-language-fr");
    phase("dialog.open", { frenchLabel: french.props.accessibilityLabel, preferred: french.props.hasTVPreferredFocus });
    expect(french.props.hasTVPreferredFocus).toBe(true);
    expect(french.props.accessibilityState).toEqual({ selected: true });
    expect(one("tv-audio-language-original").props.hasTVPreferredFocus).toBe(false);
    // The list scrolls on its own, inside the dialog.
    const dialog = one("tv-audio-language-dialog");
    expect(dialog.findAll((node) => (node.type as unknown) === "ScrollView").length).toBe(1);

    await press("tv-audio-language-de");
    phase("picked", { patches: ctl.patches });
    expect(ctl.patches).toContainEqual({ defaultAudioLanguage: "de" });
    expect(has("tv-audio-language-dialog")).toBe(false);
    expect(one("tv-settings-audio-language").props.hasTVPreferredFocus).toBe(true);
    expect(ctl.events.some((event) => event.startsWith("tv.settings.audioLanguage") && event.includes('"de"'))).toBe(true);
  });

  it("Back closes the dialog without changing the setting and gives the focus back to the row", async () => {
    await render();
    await press("tv-settings-audio-language");
    expect(one("tv-audio-language-original").props.hasTVPreferredFocus).toBe(true);
    await back();
    expect(has("tv-audio-language-dialog")).toBe(false);
    expect(ctl.patches).toEqual([]);
    expect(one("tv-settings-audio-language").props.hasTVPreferredFocus).toBe(true);
    expect(ctl.events.some((event) => event.startsWith("tv.dialog.back"))).toBe(true);
  });

  it("the Close button carries a human label and closes too", async () => {
    await render();
    await press("tv-settings-audio-language");
    const close = one("tv-audio-language-dialog-close");
    expect(close.props.accessibilityLabel).toBe(translate("tvShell.dialog.close"));
    await press("tv-audio-language-dialog-close");
    expect(has("tv-audio-language-dialog")).toBe(false);
  });
});

describe("the profile's Subtitle language on the TV (ACCT-SQUAD-03, UX-LIST-01)", () => {
  // @req ACCT-SQUAD-03[badger-tv]
  it("is one row under the audio language with the desktop's wording; its dialog starts on the profile's choice; picking saves it", async () => {
    ctl.settings = { defaultAudioLanguage: null, defaultSubtitleLanguage: "fr" };
    await render();
    const row = one("tv-settings-subtitle-language");
    phase("subtitle.rendered", { label: row.props.accessibilityLabel });
    expect(translate("subtitleLanguage.title")).toBe("Subtitle language");
    expect(row.props.accessibilityLabel).toContain("Subtitle language");
    expect(has("tv-subtitle-language-fr"), "no option of the long list sits inline").toBe(false);

    await press("tv-settings-subtitle-language");
    const french = one("tv-subtitle-language-fr");
    phase("subtitle.dialog.open", { preferred: french.props.hasTVPreferredFocus, none: one("tv-subtitle-language-none").props.accessibilityLabel });
    expect(french.props.hasTVPreferredFocus).toBe(true);
    expect(french.props.accessibilityState).toEqual({ selected: true });
    expect(one("tv-subtitle-language-none").props.accessibilityLabel).toContain("No preference");

    await press("tv-subtitle-language-none");
    phase("subtitle.picked", { patches: ctl.patches });
    expect(ctl.patches).toContainEqual({ defaultSubtitleLanguage: null });
    expect(has("tv-subtitle-language-dialog")).toBe(false);
    expect(one("tv-settings-subtitle-language").props.hasTVPreferredFocus).toBe(true);
    expect(ctl.events.some((event) => event.startsWith("tv.settings.subtitleLanguage") && event.includes('"none"'))).toBe(true);
  });

  // @req ACCT-SQUAD-03[badger-tv]
  it("Back closes its dialog without a change and hands the focus back to the subtitle row", async () => {
    await render();
    await press("tv-settings-subtitle-language");
    expect(one("tv-subtitle-language-none").props.hasTVPreferredFocus).toBe(true);
    await back();
    expect(has("tv-subtitle-language-dialog")).toBe(false);
    expect(ctl.patches).toEqual([]);
    expect(one("tv-settings-subtitle-language").props.hasTVPreferredFocus).toBe(true);
  });
});

describe("the signed-in devices on the TV (ACCT-DEV-01)", () => {
  it("lists every device with its name, type and last seen, marks this TV, and refreshes on demand", async () => {
    await render("account");
    const row = one("tv-settings-devices");
    phase("row", { hint: row.props.accessibilityHint });
    expect(row.props.accessibilityHint).toBe(translate("account.devices.summary", { count: 3 }));

    await press("tv-settings-devices");
    expect(has("tv-devices-dialog")).toBe(true);
    const current = one("tv-device-current");
    phase("current", { label: current.props.accessibilityLabel });
    expect(current.props.accessibilityLabel).toContain(translate("tvShell.devices.thisDevice", { name: "Living room TV" }));
    expect(current.props.accessibilityLabel).toContain(translate("account.devices.lastSeen", { date: "" }).trim().replace(/:$/, ""));
    expect(one("tv-device-other-0").props.accessibilityLabel).toContain("Hallway phone");
    expect(one("tv-device-other-1").props.accessibilityLabel).toContain("Kitchen tablet");
    // A list that grows with the account scrolls inside the dialog.
    expect(one("tv-devices-dialog").findAll((node) => (node.type as unknown) === "ScrollView").length).toBe(1);

    const loadsBefore = ctl.loads;
    await press("tv-devices-refresh");
    expect(ctl.loads).toBe(loadsBefore + 1);
  });

  it("signs another device out only after a confirmation that starts on Cancel", async () => {
    await render("account");
    await press("tv-settings-devices");
    await press("tv-device-other-0");
    expect(has("tv-devices-dialog")).toBe(false);
    expect(has("tv-device-signout-dialog")).toBe(true);
    expect(one("tv-device-signout-cancel").props.hasTVPreferredFocus).toBe(true);
    expect(one("tv-device-signout-confirm").props.hasTVPreferredFocus).toBe(false);
    const allText = one("tv-device-signout-dialog")
      .findAll((node) => (node.type as unknown) === "Text")
      .map((node) => node.props.children)
      .join(" ");
    phase("confirm.text", { allText });
    expect(allText).toContain(translate("account.devices.confirmTitle", { name: "Hallway phone" }));
    expect(allText).toContain(translate("account.devices.confirmExplanation"));

    phase("cancel", {});
    await press("tv-device-signout-cancel");
    expect(ctl.signedOut).toEqual([]);
    expect(has("tv-devices-dialog")).toBe(true);

    await press("tv-device-other-0");
    await press("tv-device-signout-confirm");
    phase("confirmed", { signedOut: ctl.signedOut });
    expect(ctl.signedOut).toEqual(["s-phone"]);
    expect(has("tv-devices-dialog")).toBe(true);
    expect(byTestId("tv-device-other-0")[0]?.props.accessibilityLabel).toContain("Kitchen tablet");
    expect(has("tv-device-other-1")).toBe(false);
    expect(ctl.logouts).toBe(0);
  });

  it("Back on the confirmation goes back to the list; Back on the list closes it onto its row", async () => {
    await render("account");
    await press("tv-settings-devices");
    await press("tv-device-other-1");
    await back();
    expect(has("tv-device-signout-dialog")).toBe(false);
    expect(has("tv-devices-dialog")).toBe(true);
    await back();
    expect(has("tv-devices-dialog")).toBe(false);
    expect(one("tv-settings-devices").props.hasTVPreferredFocus).toBe(true);
    expect(ctl.signedOut).toEqual([]);
  });

  it("signing this TV out from the list, holding no key, is the ordinary sign-out with its own warning", async () => {
    ctl.storedKey = null;
    await render("account");
    await press("tv-settings-devices");
    await press("tv-device-current");
    expect(has("tv-signout-key-dialog")).toBe(false);
    const allText = one("tv-device-signout-dialog")
      .findAll((node) => (node.type as unknown) === "Text")
      .map((node) => node.props.children)
      .join(" ");
    expect(allText).toContain(translate("tvShell.devices.confirmSelfTitle"));
    expect(allText).toContain(translate("tvShell.devices.confirmSelfBody"));
    await press("tv-device-signout-confirm");
    phase("self", { logouts: ctl.logouts, signedOut: ctl.signedOut });
    expect(ctl.logouts).toBe(1);
    expect(ctl.logoutReasons).toEqual(["signOut"]);
    expect(ctl.signedOut).toEqual([]);
  });

  it("a refused sign-out keeps the device listed and says so", async () => {
    ctl.signOutResult = false;
    await render("account");
    await press("tv-settings-devices");
    await press("tv-device-other-0");
    await press("tv-device-signout-confirm");
    expect(ctl.signedOut).toEqual(["s-phone"]);
    expect(has("tv-device-other-0")).toBe(true);
    const texts = one("tv-devices-dialog")
      .findAll((node) => (node.type as unknown) === "Text")
      .map((node) => node.props.children)
      .join(" ");
    phase("refused", { texts });
    expect(texts).toContain(translate("account.devices.errors.revoke"));
  });
});

/**
 * @test-id TV-SETTINGS-SIGN-OUT-KEY-001
 * @level component
 * @req ACCT-DEV-03[badger-tv]
 * @why Signing the TV out forgets the library key; without it the only way back in is typing it, since QR sign-in
 *   needs another device that still holds the key. A TV holding the key asks once whether it was saved, from the
 *   Settings row and from its own row in the devices list (that path folds the key question into its confirmation,
 *   never two questions). Cancel holds the focus and, like Back, changes nothing; only the confirm signs out. A TV
 *   with no key signs out from the Settings row at once.
 */
describe("Sign out asks a TV holding the library key whether it was saved (ACCT-DEV-03)", () => {
  const dialogText = () =>
    one("tv-signout-key-dialog")
      .findAll((node) => (node.type as unknown) === "Text")
      .map((node) => node.props.children)
      .join(" ");

  it("Settings › Sign out on a key holder: the question opens on Cancel; Cancel keeps the TV signed in", async () => {
    await render("account");
    await press("tv-settings-sign-out");
    phase("signOutKey.question", { text: dialogText(), logouts: ctl.logouts, events: ctl.events });
    expect(ctl.logouts).toBe(0);
    expect(dialogText()).toContain(translate("account.signOutKey.title"));
    expect(dialogText()).toContain(translate("account.signOutKey.body"));
    expect(one("tv-signout-key-cancel").props.hasTVPreferredFocus).toBe(true);
    expect(one("tv-signout-key-confirm").props.hasTVPreferredFocus).toBe(false);

    await press("tv-signout-key-cancel");
    phase("signOutKey.cancelled", { logouts: ctl.logouts });
    expect(has("tv-signout-key-dialog")).toBe(false);
    expect(ctl.logouts).toBe(0);
    expect(one("tv-settings-sign-out").props.hasTVPreferredFocus).toBe(true);

    await press("tv-settings-sign-out");
    await back();
    phase("signOutKey.back", { logouts: ctl.logouts });
    expect(has("tv-signout-key-dialog")).toBe(false);
    expect(ctl.logouts).toBe(0);
  });

  it("the confirm signs out once, as the user's own Sign out", async () => {
    await render("account");
    await press("tv-settings-sign-out");
    await press("tv-signout-key-confirm");
    phase("signOutKey.confirmed", { logouts: ctl.logouts, reasons: ctl.logoutReasons });
    expect(ctl.logoutReasons).toEqual(["signOut"]);
    expect(has("tv-signout-key-dialog")).toBe(false);
  });

  it("a TV with no key signs out from Settings at once, with no question", async () => {
    ctl.storedKey = null;
    await render("account");
    await press("tv-settings-sign-out");
    phase("signOutKey.noKey", { logouts: ctl.logouts, reasons: ctl.logoutReasons });
    expect(has("tv-signout-key-dialog")).toBe(false);
    expect(ctl.logoutReasons).toEqual(["signOut"]);
  });

  it("this TV's own row in the devices list asks the key question once instead of the plain confirmation", async () => {
    await render("account");
    await press("tv-settings-devices");
    await press("tv-device-current");
    phase("signOutKey.fromDevices", { text: dialogText() });
    expect(has("tv-device-signout-dialog")).toBe(false);
    expect(has("tv-devices-dialog")).toBe(false);
    expect(dialogText()).toContain(translate("account.signOutKey.title"));
    expect(one("tv-signout-key-cancel").props.hasTVPreferredFocus).toBe(true);

    await press("tv-signout-key-cancel");
    expect(has("tv-devices-dialog")).toBe(true);
    expect(ctl.logouts).toBe(0);

    await press("tv-device-current");
    await back();
    expect(has("tv-devices-dialog")).toBe(true);
    expect(ctl.logouts).toBe(0);

    await press("tv-device-current");
    await press("tv-signout-key-confirm");
    phase("signOutKey.fromDevices.confirmed", { reasons: ctl.logoutReasons, signedOut: ctl.signedOut });
    expect(ctl.logoutReasons).toEqual(["signOut"]);
    expect(ctl.signedOut).toEqual([]);
  });
});
