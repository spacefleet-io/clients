/**
 * @test-id PARROT-TV-SETTINGS-SIGN-OUT-001
 * @level unit
 * @req ACCT-DEV-03[parrot-tv]
 * @bugfix #3350 S49: on a TV that holds the library key, Sign out asks whether the key was saved
 *   (`signOutAskingForSavedKey` resolves "asked" as soon as the question is shown). The row stayed disabled until a
 *   failure, so Cancel left Sign out dead until the app restarted.
 * @covers apps/parrot/mobile/src/tv/TvSettingsSection.tsx
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  signOut: (() => Promise.resolve()) as () => Promise<void>,
  rows: new Map<string, { disabled?: boolean; onPress?: () => void }>(),
  groups: new Map<string, { onPress?: () => void }>(),
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
  TvRow: (props: { testID: string; disabled?: boolean; onPress?: () => void }) => {
    h.rows.set(props.testID, props);
    return null;
  },
  TvRowList: h.Pass,
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
vi.mock("../src/state/session", () => ({ useSession: () => ({ session: { token: "t", user: { email: "a@b.c" } } }) }));
vi.mock("../src/state/useSignOut", () => ({ useSignOut: () => () => h.signOut() }));
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
});

const openAccount = async () => {
  await act(async () => {
    renderer = create(<TvSettingsSection />);
  });
  await act(async () => h.groups.get("tv-settings-group-account")?.onPress?.());
};
const signOutRow = () => h.rows.get("tv-settings-sign-out")!;

describe(`${SUITE} Parrot TV Sign out row`, () => {
  it("comes back after the key question is shown, so Cancel never leaves it disabled", async () => {
    const asked = Promise.withResolvers<void>();
    h.signOut = () => asked.promise;
    await openAccount();
    expect(signOutRow().disabled).toBe(false);

    await act(async () => signOutRow().onPress?.());
    console.info(SUITE, "while asking", { disabled: signOutRow().disabled });
    expect(signOutRow().disabled).toBe(true);

    await act(async () => asked.resolve());
    console.info(SUITE, "after the question", { disabled: signOutRow().disabled });
    expect(signOutRow().disabled).toBe(false);
  });

  it("comes back after a failed sign-out", async () => {
    h.signOut = () => Promise.reject(new Error("offline"));
    await openAccount();
    await act(async () => signOutRow().onPress?.());
    expect(signOutRow().disabled).toBe(false);
  });
});
