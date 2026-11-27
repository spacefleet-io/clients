/**
 * @test-id TV-SETTINGS-COLUMNS-001
 * @level component
 * @why TV Settings is two columns (UX-TV-42): the groups at the left, the open group's rows at the right. Focusing a
 *   group opens it, Left from a row comes back to the open group (the left focus guide's destination), Right goes into
 *   the rows (the pane's focus guide remembers the last row), the first visit opens Playback with the focus on
 *   Autoplay, and the last group opened survives leaving Settings. Every setting that shipped before stays in its group,
 *   and quality is one value row that opens a window (UX-TV-43). Rendered with react-test-renderer: react-native is
 *   replaced by host-element stand-ins, the stored settings by an in-memory store and the profiles by a fake snapshot.
 *
 * @req UX-TV-42[badger-tv]
 * @req UX-TV-43[badger-tv]
 * @req ACCT-SQUAD-03[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import { rememberTvSettingsGroup, resetTvSettingsGroup, TV_SETTINGS_GROUPS, tvSettingsOpenGroup, type TvSettingsGroupId } from "../lib/tvSettingsGroups";
import { TvSettingsScreen } from "./TvSettingsScreen";

const TAG = "[TV-SETTINGS-COLUMNS-001]";

const ctl = vi.hoisted(() => ({
  backHandlers: [] as Array<() => boolean>,
  patches: [] as Array<Record<string, unknown>>,
  events: [] as Array<{ event: string; payload: unknown }>,
  profiles: [] as Array<{ id: string; name: string; isMain: boolean }>,
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
vi.mock("../../lib/onboarding", () => ({ asksKeySavedBeforeSigningOut: async () => false }));
vi.mock("../../store/auth", () => ({
  useAuth: () => ({ token: "tok-1", user: { email: "viewer@example.com", uiLanguage: "en" }, logout: async () => undefined }),
}));
vi.mock("../../lib/profiles/profileStore", () => ({
  useProfiles: () => ({
    userId: "u-1",
    profiles: ctl.profiles,
    maxProfiles: 5,
    activeId: ctl.profiles[0]?.id ?? null,
    needsChoice: false,
    status: "ready",
    stale: false,
  }),
}));
vi.mock("../../lib/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/appSettings")>();
  const ReactModule = await import("react");
  return {
    ...actual,
    useAppSettings: () => {
      const [settings, setSettings] = ReactModule.useState(() => ({ ...actual.DEFAULT_APP_SETTINGS }));
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
  return { ...actual, useAccountDevices: () => ({ sessions: [], loading: false, error: null, load: async () => undefined, signOut: async () => true }) };
});

let renderer: ReactTestRenderer | null = null;

const phase = (name: string, detail: Record<string, unknown> = {}) => process.stdout.write(`${TAG} ${name} ${JSON.stringify(detail)}\n`);

const byTestId = (id: string): ReactTestInstance[] =>
  (renderer?.root.findAll((node) => typeof (node.type as unknown) === "string" && node.props.testID === id) ?? []) as ReactTestInstance[];
const one = (id: string): ReactTestInstance => {
  const found = byTestId(id);
  if (found.length !== 1) {
    const ids = renderer?.root.findAll((node) => typeof node.props.testID === "string").map((node) => node.props.testID);
    phase("testIDs on screen", { ids });
    throw new Error(`expected one ${id}, found ${found.length}`);
  }
  return found[0];
};
const has = (id: string): boolean => byTestId(id).length > 0;
const textOf = (node: ReactTestInstance): string =>
  node
    .findAll((child) => (child.type as unknown) === "Text")
    .map((child) => [child.props.children].flat().filter((part) => typeof part === "string" || typeof part === "number").join(""))
    .join(" | ");
/** The pane's rows, top to bottom: the test ids the remote walks with Down. */
const paneIds = (): string[] => {
  const pane = renderer!.root.find((node) => (node.type as unknown) === "TVFocusGuideView" && String(node.props.testID).startsWith("tv-settings-pane-"));
  return pane
    .findAll((node) => typeof (node.type as unknown) === "string" && node !== pane && /^(tv-)?settings-/.test(String(node.props.testID ?? "")))
    .map((node) => node.props.testID as string)
    .filter((id, index, all) => all.indexOf(id) === index);
};
const preferred = (): string[] =>
  renderer!.root
    .findAll((node) => typeof (node.type as unknown) === "string" && node.props.hasTVPreferredFocus === true)
    .map((node) => String(node.props.testID));
const settingsEvents = (name: string) => ctl.events.filter((entry) => entry.event === `tv.settings.${name}`).map((entry) => JSON.parse(String(entry.payload)));

/** A mounted host element stands in for the native view the focus guides point at. */
const createNodeMock = (element: React.ReactElement) => {
  const props = element.props;
  const testID = props && typeof props === "object" && "testID" in props ? props.testID : undefined;
  return { testID, requestTVFocus: () => undefined };
};

const render = async (group?: TvSettingsGroupId) => {
  if (group) rememberTvSettingsGroup(group);
  phase("render", { group: group ?? "default", profiles: ctl.profiles.length });
  await act(async () => {
    renderer = create(<TvSettingsScreen />, { createNodeMock });
  });
};
const unmount = async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
};
const focusGroup = async (id: TvSettingsGroupId) => {
  phase("focus group", { id });
  await act(async () => {
    one(`tv-settings-group-${id}`).props.onFocus?.({});
  });
};
const press = async (id: string) => {
  phase("press", { id });
  await act(async () => {
    one(id).props.onPress();
  });
};
const back = async () => {
  phase("back", { handlers: ctl.backHandlers.length });
  await act(async () => {
    for (const handler of [...ctl.backHandlers].reverse()) if (handler()) return;
  });
};
const leftDestination = (): unknown => {
  const destinations = one("tv-settings-groups").props.destinations as Array<{ testID?: string }> | undefined;
  return destinations?.map((view) => view.testID);
};

beforeAll(async () => {
  await initI18n("en");
});

beforeEach(() => {
  resetTvSettingsGroup();
  ctl.backHandlers = [];
  ctl.patches = [];
  ctl.events = [];
  ctl.profiles = [{ id: "p-1", name: "Main", isMain: true }];
  vi.spyOn(console, "info").mockImplementation((event: unknown, payload?: unknown) => {
    if (typeof event === "string" && event.startsWith("tv.")) ctl.events.push({ event, payload });
  });
});

afterEach(async () => {
  phase("teardown", { events: ctl.events.map((entry) => `${entry.event} ${String(entry.payload ?? "")}`) });
  await unmount();
  vi.restoreAllMocks();
});

describe("the two columns (UX-TV-42)", () => {
  it("lists the six groups in order at the left and opens Playback first, with the focus on Autoplay", async () => {
    await render();
    const groups = one("tv-settings-groups")
      .findAll((node) => typeof (node.type as unknown) === "string" && String(node.props.testID).startsWith("tv-settings-group-"))
      .map((node) => node.props.testID);
    phase("groups", { groups, preferred: preferred(), events: settingsEvents("open") });
    expect(groups).toEqual(TV_SETTINGS_GROUPS.map(({ id }) => `tv-settings-group-${id}`));
    expect(groups).toEqual([
      "tv-settings-group-profiles",
      "tv-settings-group-account",
      "tv-settings-group-playback",
      "tv-settings-group-privacy",
      "tv-settings-group-language",
      "tv-settings-group-about",
    ]);
    expect(has("tv-settings-pane-playback")).toBe(true);
    expect(one("tv-settings-group-playback").props.accessibilityState).toMatchObject({ selected: true });
    expect(one("tv-settings-group-privacy").props.accessibilityState).toMatchObject({ selected: false });
    expect(preferred()).toEqual(["tv-settings-autoplay"]);
    expect(settingsEvents("open")).toEqual([{ group: "playback" }]);
  });

  it("focusing a group opens it at the right; Left lands on the open group and Right on the pane's rows", async () => {
    await render();
    expect(leftDestination()).toEqual(["tv-settings-group-playback"]);
    expect(one("tv-settings-pane-playback").props.autoFocus).toBe(true);

    await focusGroup("privacy");
    phase("after privacy", { pane: paneIds(), left: leftDestination(), preferred: preferred() });
    expect(has("tv-settings-pane-privacy")).toBe(true);
    expect(has("tv-settings-pane-playback")).toBe(false);
    expect(paneIds()).toEqual(["tv-settings-error-reports"]);
    expect(leftDestination()).toEqual(["tv-settings-group-privacy"]);
    expect(one("tv-settings-pane-privacy").props.autoFocus).toBe(true);
    expect(one("tv-settings-group-privacy").props.accessibilityState).toMatchObject({ selected: true });
    // The remote is in the left column now: no row grabs the focus back.
    expect(preferred()).toEqual([]);
    expect(settingsEvents("group")).toEqual([{ from: "playback", to: "privacy" }]);

    // Walking Up and Down the left column opens each group in turn; a group already open logs nothing.
    await focusGroup("privacy");
    await focusGroup("language");
    expect(settingsEvents("group")).toEqual([
      { from: "playback", to: "privacy" },
      { from: "privacy", to: "language" },
    ]);
  });

  it("remembers the group last opened when Settings is left and opened again", async () => {
    await render();
    await focusGroup("account");
    await unmount();
    expect(tvSettingsOpenGroup()).toBe("account");
    await render();
    phase("reopened", { pane: paneIds(), preferred: preferred() });
    expect(has("tv-settings-pane-account")).toBe(true);
    expect(settingsEvents("open").at(-1)).toEqual({ group: "account" });
    // The first focusable row of the reopened group starts with the focus; the email is read-only.
    expect(preferred()).toEqual(["tv-settings-devices"]);
    expect(one("tv-settings-email").props.focusable).toBe(false);
  });
});

describe("every setting in its group (UX-TV-42)", () => {
  it("keeps each shipped setting in the group the mockup puts it in", async () => {
    const expected: Record<TvSettingsGroupId, string[]> = {
      profiles: ["settings-switch-profile", "settings-manage-profiles"],
      account: ["tv-settings-email", "tv-settings-devices", "tv-settings-pair", "tv-settings-sign-out"],
      playback: [
        "tv-settings-autoplay",
        "tv-settings-skip-intro",
        "tv-settings-skip-credits",
        "tv-settings-quality",
        "tv-settings-force-quality",
        "tv-settings-audio-language",
        "tv-settings-subtitle-language",
      ],
      privacy: ["tv-settings-error-reports"],
      language: ["tv-settings-app-language-row", "tv-settings-app-language", "tv-settings-title-language"],
      about: [],
    };
    ctl.profiles = [
      { id: "p-1", name: "Main", isMain: true },
      { id: "p-2", name: "Kids", isMain: false },
    ];
    await render();
    for (const { id } of TV_SETTINGS_GROUPS) {
      await focusGroup(id);
      const rows = paneIds().filter((testID) => !/^tv-settings-app-language-[a-z]{2}$/.test(testID));
      phase("group rows", { id, rows });
      expect(rows).toEqual(expected[id]);
    }
    expect(renderer!.root.findAllByType("MobileOpenSourceNotice" as never)).toHaveLength(1);
    expect(renderer!.root.findAllByType("MobileCreditsPanel" as never)).toHaveLength(1);
  });

  it("shows Switch profile only when the account has more than one profile", async () => {
    await render("profiles");
    phase("one profile", { pane: paneIds(), preferred: preferred() });
    expect(has("settings-switch-profile")).toBe(false);
    expect(preferred()).toEqual(["settings-manage-profiles"]);
    await unmount();

    ctl.profiles = [
      { id: "p-1", name: "Main", isMain: true },
      { id: "p-2", name: "Kids", isMain: false },
    ];
    await render("profiles");
    phase("two profiles", { pane: paneIds(), preferred: preferred() });
    expect(has("settings-switch-profile")).toBe(true);
    expect(textOf(one("settings-switch-profile"))).toContain("Main");
    expect(preferred()).toEqual(["settings-switch-profile"]);
  });

  it("marks the subtitle language as this profile's (ACCT-SQUAD-03)", async () => {
    await render();
    const text = textOf(one("tv-settings-subtitle-language"));
    phase("subtitle row", { text });
    expect(text).toContain("For this profile");
  });

  it("offers the five app languages side by side, the current one chosen (UX-I18N-10)", async () => {
    await render("language");
    const choices = renderer!.root
      .findAll((node) => typeof (node.type as unknown) === "string" && /^tv-settings-app-language-[a-z]{2}$/.test(String(node.props.testID)))
      .map((node) => node.props.testID);
    phase("language choices", { choices });
    expect(choices).toHaveLength(5);
    expect(new Set(choices)).toEqual(new Set(["en", "fr", "nl", "de", "es"].map((code) => `tv-settings-app-language-${code}`)));
    // Each language is a radio choice; the current one is checked.
    expect(one("tv-settings-app-language-en").props.accessibilityState).toMatchObject({ checked: true });
    expect(one("tv-settings-app-language-fr").props.accessibilityState).toMatchObject({ checked: false });
  });

  it("flips a switch row with OK", async () => {
    await render();
    expect(byTestId("tv-toggle-on").length).toBeGreaterThan(0);
    const before = one("tv-settings-autoplay").props.accessibilityState?.checked;
    await press("tv-settings-autoplay");
    const after = one("tv-settings-autoplay").props.accessibilityState?.checked;
    phase("autoplay", { before, after, patches: ctl.patches });
    expect(before).toBe(true);
    expect(after).toBe(false);
    expect(ctl.patches).toEqual([{ autoplayNextEpisode: false }]);
  });
});

describe("quality is one row with its value (UX-TV-43)", () => {
  it("reads Auto up to the quality, opens the four qualities in a window and hands the focus back to its row", async () => {
    await render();
    expect(textOf(one("tv-settings-quality"))).toContain("Auto, up to 1080p");

    await press("tv-settings-quality");
    const items = ["2160p", "1080p", "720p", "480p"].map((value) => `tv-quality-${value}`);
    phase("dialog", { open: has("tv-quality-dialog"), items: items.filter(has) });
    expect(has("tv-quality-dialog")).toBe(true);
    expect(items.every(has)).toBe(true);

    await press("tv-quality-720p");
    phase("picked", { patches: ctl.patches, open: has("tv-quality-dialog"), preferred: preferred() });
    expect(ctl.patches).toEqual([{ defaultQuality: "720p" }]);
    expect(has("tv-quality-dialog")).toBe(false);
    expect(preferred()).toEqual(["tv-settings-quality"]);
    expect(textOf(one("tv-settings-quality"))).toContain("Auto, up to 720p");

    await press("tv-settings-force-quality");
    expect(textOf(one("tv-settings-quality"))).toContain("720p");
    expect(textOf(one("tv-settings-quality"))).not.toContain("Auto, up to");
  });

  it("Back closes the window without a change, onto the quality row", async () => {
    await render();
    await press("tv-settings-quality");
    await back();
    phase("after back", { open: has("tv-quality-dialog"), preferred: preferred(), patches: ctl.patches });
    expect(has("tv-quality-dialog")).toBe(false);
    expect(ctl.patches).toEqual([]);
    expect(preferred()).toEqual(["tv-settings-quality"]);
  });
});

describe("how titles appear is one row with its value (ACCT-PROF-03)", () => {
  /** @req ACCT-PROF-03[badger-tv] */
  it("reads App language everywhere, opens both options in a window and saves the pick in the profile's settings", async () => {
    await render("language");
    expect(has("tv-settings-original-titles")).toBe(false);
    expect(textOf(one("tv-settings-title-language"))).toContain("Titles and posters");
    expect(textOf(one("tv-settings-title-language"))).toContain("App language everywhere");

    await press("tv-settings-title-language");
    phase("dialog", { open: has("tv-title-language-dialog") });
    expect(has("tv-title-language-dialog")).toBe(true);
    expect(textOf(one("tv-title-language-dialog"))).toContain("How should titles appear?");
    expect(has("tv-title-language-app")).toBe(true);
    expect(has("tv-title-language-original")).toBe(true);

    await press("tv-title-language-original");
    phase("picked", { patches: ctl.patches, open: has("tv-title-language-dialog"), preferred: preferred() });
    expect(ctl.patches).toEqual([{ titleLanguage: "original" }]);
    expect(has("tv-title-language-dialog")).toBe(false);
    expect(preferred()).toEqual(["tv-settings-title-language"]);
    expect(textOf(one("tv-settings-title-language"))).toContain("Original version");
  });
});
