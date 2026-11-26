/**
 * @test-id PARROT-TV-SETTINGS-SIGN-OUT-001
 * @level unit
 * @req ACCT-DEV-03[parrot]
 * @bugfix #3350 S49: on a TV that holds the library key, Sign out asks whether the key was saved. The row stayed
 *   disabled until a failure, so Cancel left Sign out dead until the app restarted.
 * @covers apps/parrot/mobile/src/tv/TvSettingsSection.tsx
 *
 * REL-FAM-05: Parrot TV asks in the shared TV dialog (`@space/mobile-shell/tv/TvSignOutKeyDialog`, Badger TV's), not
 * the phone `Alert.alert`.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type DialogProps = { text: { title: string; body: string; cancel: string; confirm: string }; onCancel: () => void; onConfirm: () => void };

const h = vi.hoisted(() => ({
  signOut: vi.fn((): Promise<void> => Promise.resolve()),
  key: (() => Promise.resolve("user-1")) as () => Promise<string | null>,
  rows: new Map<string, { disabled?: boolean; hasTVPreferredFocus?: boolean; onPress?: () => void }>(),
  groups: new Map<string, { onPress?: () => void }>(),
  dialog: null as DialogProps | null,
  /** Draws its children only: the layout views and text the test does not look at. */
  Pass: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  ScrollView: h.Pass,
  Text: h.Pass,
  TVFocusGuideView: h.Pass,
  View: h.Pass,
}));
vi.mock("lucide-react-native", () => ({ ChevronRight: () => null, Globe: () => null, Info: () => null, LogOut: () => null, ShieldCheck: () => null, SlidersHorizontal: () => null, UserRound: () => null, Users: () => null }));
vi.mock("@space/mobile-shell/components", () => ({ MobileCreditsPanel: () => null, MobileOpenSourceNotice: () => null, useSkyScroll: () => ({}) }));
vi.mock("@space/mobile-shell/error-reports-offered", () => ({ errorReportsOffered: () => false }));
vi.mock("@space/mobile-shell/flag", () => ({ MobileFlag: () => null }));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => "en",
  MOBILE_UI_LANGUAGES: [],
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => {}, warn: () => {} }) }));
vi.mock("@space/mobile-shell/tv/TvChip", () => ({ TvSegmented: () => null }));
vi.mock("@space/mobile-shell/tv/TvFocusable", () => ({
  TvFocusable: ({ testID, onPress, children }: { testID: string; onPress?: () => void; children?: React.ReactNode }) => {
    h.groups.set(testID, { onPress });
    return <>{children}</>;
  },
}));
vi.mock("@space/mobile-shell/tv/TvRow", () => ({
  TvRow: (props: { testID: string; disabled?: boolean; hasTVPreferredFocus?: boolean; onPress?: () => void }) => {
    h.rows.set(props.testID, props);
    return null;
  },
  TvRowList: h.Pass,
}));
vi.mock("@space/mobile-shell/tv/TvSignOutKeyDialog", () => ({
  TvSignOutKeyDialog: (props: DialogProps) => {
    h.dialog = props;
    return null;
  },
}));
vi.mock("@space/mobile-shell/tv/TvText", () => ({ TvBody: h.Pass, TvTitle: h.Pass }));
vi.mock("@space/mobile-shell/tv/tokens", () => ({ TV_COLOR: {}, TV_SPACE: {}, TV_TYPE: { body: {} }, useTvAccent: () => ({ color: "#0f0" }) }));
vi.mock("@space/mobile-shell/tv/tvViewInstance", () => ({ focusDestination: () => [] }));
vi.mock("@space/mobile-shell/tv/tvScale", () => ({ useTvScale: () => 1, useTvStyles: <T,>(styles: T) => styles }));
vi.mock("@space/mobile-media-proxy/app-info", () => ({ nativeAppInfo: () => ({ version: "1" }) }));
vi.mock("@space/mobile-self-update", () => ({ SelfUpdateSettings: () => null }));
vi.mock("@space/parrot-core", () => ({ PARROT_EVEN_VOLUME_LEVELS: [] }));
vi.mock("../src/lib/accountLanguage", () => ({ pickSignedInLanguage: async () => {} }));
vi.mock("../src/lib/errorReports", () => ({ getErrorReportsSetting: () => ({ errorReports: false }), setErrorReports: async () => {}, subscribeErrorReportsSetting: () => () => {} }));
vi.mock("../src/lib/evenVolume", () => ({ getEvenVolume: () => ({ on: false }), setEvenVolume: async () => {}, subscribeEvenVolume: () => () => {} }));
vi.mock("../src/lib/lookup", () => ({ parrotCreditsSource: {} }));
vi.mock("../src/lib/profiles", () => ({ useProfiles: () => ({ profiles: [], activeId: null }) }));
vi.mock("../src/lib/stores", () => ({ libraryKeyStore: { get: () => h.key() } }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ session: { token: "t", user: { email: "a@b.c" } }, signOut: () => h.signOut() }) }));
vi.mock("../src/tv/tvModel", () => ({ tvSettingsGroupIds: () => ["profiles", "account"] }));
vi.mock("../src/tv/tvPages", () => ({ useTvPages: () => ({ push: () => {} }) }));

import { TvSettingsSection } from "../src/tv/TvSettingsSection";

const SUITE = "[PARROT-TV-SETTINGS-SIGN-OUT-001]";
let renderer: ReactTestRenderer | null = null;

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  h.rows.clear();
  h.groups.clear();
  h.dialog = null;
  h.signOut.mockReset();
  h.signOut.mockImplementation(() => Promise.resolve());
  h.key = () => Promise.resolve("user-1");
});

const openAccount = async () => {
  await act(async () => {
    renderer = create(<TvSettingsSection />);
  });
  await act(async () => h.groups.get("tv-settings-group-account")?.onPress?.());
};
const signOutRow = () => h.rows.get("tv-settings-sign-out")!;
const pressSignOut = () => act(async () => signOutRow().onPress?.());

describe(`${SUITE} Parrot TV Sign out`, () => {
  it("asks in the shared TV dialog when the TV holds the key, and the row comes back", async () => {
    await openAccount();
    expect(signOutRow().disabled).toBe(false);
    await pressSignOut();
    console.info(SUITE, "asked", { dialog: h.dialog?.text, disabled: signOutRow().disabled });
    expect(h.dialog?.text).toEqual({
      title: "parrot.settings.signOutKey.title",
      body: "parrot.settings.signOutKey.body",
      cancel: "parrot.settings.signOutKey.cancel",
      confirm: "parrot.settings.signOutKey.confirm",
    });
    expect(h.signOut).not.toHaveBeenCalled();
    expect(signOutRow().disabled).toBe(false);
  });

  it("Cancel closes the question, keeps the session and gives the focus back to Sign out", async () => {
    await openAccount();
    await pressSignOut();
    await act(async () => h.dialog?.onCancel());
    expect(h.signOut).not.toHaveBeenCalled();
    expect(signOutRow().hasTVPreferredFocus).toBe(true);
    expect(signOutRow().disabled).toBe(false);
    h.dialog = null;
    await act(async () => {});
    expect(h.dialog).toBeNull();
  });

  it("Confirm signs out", async () => {
    await openAccount();
    await pressSignOut();
    await act(async () => h.dialog?.onConfirm());
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });

  it("signs out at once on a TV without the key", async () => {
    h.key = () => Promise.resolve(null);
    await openAccount();
    await pressSignOut();
    expect(h.dialog).toBeNull();
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(signOutRow().disabled).toBe(false);
  });

  it("asks when the key store cannot be read", async () => {
    h.key = () => Promise.reject(new Error("keychain locked"));
    await openAccount();
    await pressSignOut();
    expect(h.dialog).not.toBeNull();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it("comes back after a failed sign-out", async () => {
    h.key = () => Promise.resolve(null);
    h.signOut.mockImplementation(() => Promise.reject(new Error("offline")));
    await openAccount();
    await pressSignOut();
    expect(signOutRow().disabled).toBe(false);
  });
});
