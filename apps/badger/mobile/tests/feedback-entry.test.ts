/**
 * @test-id MOBILE-FEEDBACK-ENTRY-001
 * @level unit
 * @why The Play closed test needs the phone's "Send feedback" entry (UX-SUP-05): Settings must lead to it and the form
 *   must reach the API's feedback inbox as `badger-mobile`, with the session token, the app version and the kind of
 *   phone, and the error log only when the user ticked the box (UX-SUP-02). The test renders the real Settings and
 *   Feedback screens with react-test-renderer and the real translation files; the network is a stubbed `fetch`.
 */
import { createElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import { setApiBaseUrl } from "@space/shared/api";
import { SettingsScreen } from "../src/screens/SettingsScreen";
import { FeedbackScreen } from "../src/screens/FeedbackScreen";
import packageJson from "../package.json";
import type { KeyRotationReadiness } from "@space/shared/keyChange";

const ctl = vi.hoisted(() => ({ navigate: vi.fn(), goBack: vi.fn() }));
// ACCT-KEYCHG-04: the server's answer to "would a key rotation be accepted now", driven per case.
const server = vi.hoisted(() => ({ readiness: null as KeyRotationReadiness | null }));
vi.mock("@space/shared/useKeyRotationReadiness", () => ({ useKeyRotationReadiness: () => server.readiness }));

vi.mock("react-native", () => {
  const host = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  return {
    View: host("View"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    Pressable: host("Pressable"),
    ScrollView: host("ScrollView"),
    Switch: host("Switch"),
    ActivityIndicator: host("ActivityIndicator"),
    StyleSheet: { create: <T>(styles: T): T => styles, hairlineWidth: 1, absoluteFillObject: {} },
    useWindowDimensions: () => ({ width: 390, height: 800 }),
    Alert: { alert: () => undefined },
    // No native module linked: Settings' self-update block (REL-UPD-06) stays empty.
    NativeModules: {},
    Platform: {
      OS: "android",
      Version: 35,
      isTV: false,
      constants: { Release: "15", Model: "Pixel 8", Manufacturer: "Google" },
      select: <T>(spec: { android?: T; default?: T }) => spec.android ?? spec.default,
    },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: (props: { children?: ReactNode }) => createElement("SafeAreaView", null, props.children),
}));
// The shell package ships its own copy of React, so react-i18next's hook cannot run inside this app's renderer; the
// real i18next instance and the real translation files stay, only the hook is bound to them directly.
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: "en" } }) };
});
vi.mock("@space/mobile-shell/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/theme")>();
  return { ...actual, useMobileShellTheme: () => actual.defaultMobileShellTheme };
});
// The real shared form; the rest of the components barrel pulls native animation modules. (vi.mock factories are
// hoisted above the static imports, so the form module is loaded inside the factory.)
vi.mock("@space/mobile-shell/components", async () => {
  const { MobileFeedbackForm } = await import("../../../../packages/mobile-shell/src/components/mobile-feedback-form");
  // Settings → About credits the outside data sources (UX-SET-02); not under test here.
  return { MobileFeedbackForm, MobileCreditsPanel: () => null, MobileOpenSourceNotice: () => null, MobileErrorReportsLink: () => null, MobileFounderBadge: () => null, useSkyScroll: () => ({}) };
});
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ctl }));
vi.mock("lucide-react-native", () => ({ ArrowLeft: () => null, ChevronDown: () => null, ChevronUp: () => null }));
vi.mock("../src/components/SettingsRows", () => {
  const passthrough = (props: { children?: ReactNode }) => createElement("Group", null, props.children);
  return {
    SettingsGroup: passthrough,
    LinkRow: (props: object) => createElement("LinkRow", props),
    SwitchRow: () => null,
    ChoiceRow: () => null,
    Divider: () => null,
  };
});
vi.mock("../src/lib/metadata/runtime", () => ({ mobileCreditsSource: { load: null, store: null } }));
vi.mock("../src/components/IconButton", () => ({
  IconButton: (props: { children?: ReactNode }) => createElement("IconButton", props, props.children),
}));
vi.mock("../src/components/AccountSecurity", () => ({ PasswordChangeSection: () => null }));
vi.mock("../src/components/DevicesSection", () => ({ DevicesSection: () => null }));
vi.mock("../src/components/PosterCard", () => ({ RIPPLE: {} }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ user: { email: "tester@example.test" }, token: "tok" }) }));
vi.mock("../src/lib/useSignOut", () => ({ useSignOut: () => async () => undefined }));
vi.mock("../src/lib/apiConfig", () => ({
  getStoredApiHost: async () => null,
  serverPickerAllowed: () => false,
  setStoredApiHost: async () => undefined,
}));
vi.mock("../src/lib/appSettings", () => ({
  ANIMATED_BACKGROUND_CHOICES: [],
  AUDIO_LANGUAGE_ORIGINAL: "original",
  audioLanguageFromChoice: (choice: string) => choice,
  audioLanguageToChoice: () => "original",
  useAppSettings: () => [{ defaultQuality: "1080p", errorReports: false, animatedBackground: "auto" }, () => undefined],
}));
vi.mock("../src/lib/skyMode", () => ({ automaticSkyMode: () => "static" }));
vi.mock("../src/lib/uiLanguage", () => ({ chooseUiLanguage: async () => undefined }));
vi.mock("../src/lib/profiles/profileStore", () => ({ useProfiles: () => ({ profiles: [], activeId: null }) }));

const render = (element: ReactElement) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
};

const text = (node: ReactTestInstance): string => node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");

const stubFetch = (status: number, body: unknown) => {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (input: Request) => {
    calls.push(input);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return calls;
};

/** Types the message, presses Send and waits for the form's answer (`outcome` is the testID it shows). */
const sendFrom = async (tree: ReactTestRenderer, message: string, outcome: "feedback-sent" | "feedback-error") => {
  const input = tree.root.find((n) => n.props.testID === "feedback-message" && typeof n.props.onChangeText === "function");
  act(() => input.props.onChangeText(message));
  const send = tree.root.find((n) => n.props.testID === "feedback-send" && typeof n.props.onPress === "function");
  await act(async () => send.props.onPress());
  return vi.waitFor(() => tree.root.find((n) => n.props.testID === outcome && typeof n.type === "string"));
};

beforeAll(async () => {
  await initI18n("en");
  setApiBaseUrl("https://api.lane.test");
});
afterEach(() => vi.unstubAllGlobals());

describe("@req UX-SUP-05[badger-mobile] Badger phone Send feedback", () => {
  it("Settings → Support has a Send feedback entry that opens the Feedback screen", () => {
    const tree = render(createElement(SettingsScreen));
    const entry = tree.root.find((n) => String(n.type) === "LinkRow" && n.props.title === "Send feedback");
    expect(entry.props.description).toBe("Ideas, what you like, what bothers you");
    act(() => entry.props.onPress());
    expect(ctl.navigate).toHaveBeenCalledWith("Feedback");
  });

  it("sends the message to POST /feedback as badger-mobile with the token, the version and the phone, then thanks", async () => {
    const calls = stubFetch(201, { id: "f1" });
    const tree = render(createElement(FeedbackScreen));
    expect(text(tree.root.find((n) => n.props.accessibilityRole === "header" && typeof n.type === "string"))).toBe("Send feedback");
    const thanks = await sendFrom(tree, "  the cast button is hard to find  ", "feedback-sent");

    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.lane.test/feedback");
    expect(request.headers.get("authorization")).toBe("Bearer tok");
    const sent = await request.json();
    console.info(`[badger-feedback] body=${JSON.stringify(sent)}`);
    expect(sent).toEqual({
      message: "the cast button is hard to find",
      app: "badger-mobile",
      appVersion: packageJson.version,
      platform: "android 15",
      deviceModel: "Google Pixel 8",
      log: null,
      requestIds: [],
    });
    expect(text(thanks)).toBe("Thank you! Your message has been sent.");
  });

  it("says so when the API refuses (10 messages an hour)", async () => {
    stubFetch(429, { error: "rate_limited" });
    const tree = render(createElement(FeedbackScreen));
    const refusal = await sendFrom(tree, "again", "feedback-error");
    expect(text(refusal)).toBe("You've sent many messages in the last hour. Please try again later.");
  });
});

describe("@req ACCT-KEYCHG-04[badger-mobile] Badger phone Settings offer a key change only when the server accepts it", () => {
  const advancedRows = (readiness: KeyRotationReadiness | null) => {
    server.readiness = readiness;
    const tree = render(createElement(SettingsScreen));
    const toggle = tree.root.find((n) => n.props.accessibilityLabel === "Advanced" && typeof n.props.onPress === "function");
    act(() => toggle.props.onPress());
    expect(tree.root.find((n) => n.props.accessibilityLabel === "Advanced" && typeof n.props.onPress === "function").props.accessibilityState).toEqual({ expanded: true });
    const rows = tree.root.findAll((n) => String(n.type) === "LinkRow").map((n) => String(n.props.title));
    console.info(`[key-change-hidden] readiness=${JSON.stringify(readiness)} rows=${JSON.stringify(rows)}`);
    expect(rows).toContain("Send feedback");
    return { tree, rows };
  };

  it.each([
    ["the server's answer is not known (loading, offline)", null],
    ["the account stores media", { needsMediaReseal: true }],
  ])("offers no way to change the media library key when %s, even with Advanced open", (_label, readiness) => {
    const { rows } = advancedRows(readiness);
    expect(rows).not.toContain("Reset encryption key");
    expect(ctl.navigate).not.toHaveBeenCalledWith("ResetKey");
  });

  it("offers Reset encryption key to an account without media", () => {
    const { tree, rows } = advancedRows({ needsMediaReseal: false });
    expect(rows).toContain("Reset encryption key");
    const row = tree.root.find((n) => String(n.type) === "LinkRow" && n.props.title === "Reset encryption key");
    act(() => row.props.onPress());
    expect(ctl.navigate).toHaveBeenCalledWith("ResetKey");
  });
});
