/**
 * @test-id TV-PAIR-SCREENS-001
 * @level component
 * @why The TV sign-in screen must put the QR, the typed code and a live countdown on screen, say clearly when
 *   pairing is declined or failed, and keep a password fallback one button away; the TV approver must take a TYPED
 *   code and ask the account password before anything is sent. Rendered with react-test-renderer under the node
 *   logic runner: react-native and react-native-svg are replaced by host-element stand-ins, the data layer is
 *   faked with the approve endpoint's password contract.
 *   Badger design (Chris 2026-11-09): one line under the title, no numbered steps, no logo at the top left, the mascot
 *   floating over the QR and "Use email and password instead" with a mail icon.
 *
 * @req ACCT-PAIR-01[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import type { PairingState } from "@space/mobile-shell/pairing";

const ctl = vi.hoisted(() => {
  // Metro turns `require("../../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
  return {
    events: [] as string[],
    hookState: null as unknown,
    restart: null as (() => void) | null,
    sent: [] as Array<string | null>,
    goBack: null as (() => void) | null,
    /** Hardware Back handlers, in registration order (the last one registered runs first, as on Android). */
    backHandlers: [] as Array<() => boolean>,
    window: { width: 960, height: 540 },
    /** testIDs of the text fields that were asked to take focus (`focus()` on the ref), in order. */
    focused: [] as string[],
    /** `user.hasPassword` of the signed-in account; false = no password (ACCT-AUTH-04). */
    hasPassword: true,
    /** The codes the approver sent (account without a password), `null` for a call without one. */
    codesSent: [] as Array<string | null>,
  };
});

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Image: host("Image"),
    TextInput: host("TextInput"),
    Pressable: host("Pressable"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Platform: { isTV: true, OS: "android", constants: {} },
    useWindowDimensions: () => ctl.window,
    BackHandler: {
      addEventListener: (_event: string, handler: () => boolean) => {
        ctl.backHandlers.push(handler);
        return { remove: () => ctl.backHandlers.splice(ctl.backHandlers.indexOf(handler), 1) };
      },
    },
  };
});
// The workspace resolves a second copy of react for packages/mobile-shell (19.2.4 against the app's 19.2.3), so
// the real hooks cannot run inside this renderer: the same i18n instance and default theme are served directly.
vi.mock("@space/mobile-shell/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/theme")>();
  return { ...actual, useMobileShellTheme: () => actual.mergeMobileShellTheme(null) };
});
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate }) };
});
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path", Rect: "Rect", Circle: "Circle" }));
vi.mock("lucide-react-native", () => ({ Mail: "MailIcon", Globe: "GlobeIcon" }));
// The TV's setup progress: the sign-in's language button saves the step back to "language" (UX-TV-31).
vi.mock("../lib/tvSetupStore", () => ({
  getTvSetup: () => ({ step: "signIn", pairedKey: false }),
  saveTvSetup: async (progress: { step: string }) => void ctl.events.push(`setup:${progress.step}`),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: () => ctl.goBack?.() }) }));
vi.mock("../../screens/LoginScreen", () => ({ LoginScreen: "LoginScreen" }));
vi.mock("../lib/useTvPairing", () => ({
  useTvPairing: () => ({ state: ctl.hookState, restart: () => ctl.restart?.() }),
}));
vi.mock("../../store/auth", () => ({ useAuth: () => ({ token: "tok-1", user: { hasPassword: ctl.hasPassword } }) }));
// Approving records the new session, so the TV's devices dialog reloads at once (ACCT-DEV-01 @bugfix).
vi.mock("../../lib/pairing/deviceWatch", () => ({
  rememberSession: async (sessionId: string) => void ctl.events.push(`remember:${sessionId}`),
}));
vi.mock("../../lib/pairing/pairingDeps", async () => {
  const { ApiError } = await import("@space/shared/api");
  const { generateDeviceKeyPair } = await import("@space/pairing-crypto");
  const publicKey = generateDeviceKeyPair().publicKey;
  return {
    pairingDeps: {
      lookup: async () => ({
        requestId: "req-1",
        deviceType: "kodi",
        deviceName: "Living room Kodi",
        publicKey,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
      // The API's side of the contract: the password is checked first; a wrong one leaves the request pending.
      // An account without a password: no code → 401 `two_factor_required` (an email code is sent), a wrong code →
      // 401 `two_factor_invalid`, both leaving the request pending.
      approve: async (_token: string, _id: string, _sealed: unknown, password?: string, twoFactorCode?: string) => {
        if (!ctl.hasPassword) {
          ctl.codesSent.push(twoFactorCode ?? null);
          if (password !== undefined) throw new Error("an account without a password must not send one");
          if (!twoFactorCode) throw new ApiError(401, { error: "two_factor_required", method: "email" });
          if (twoFactorCode !== "123456") throw new ApiError(401, { error: "two_factor_invalid", method: "email" });
          ctl.events.push("approve");
          return { ok: true, sessionId: "s2" };
        }
        ctl.sent.push(password ?? null);
        if (password !== "hunter2") throw new ApiError(401, { error: "invalid_password" });
        ctl.events.push("approve");
        return { ok: true, sessionId: "s1" };
      },
      deny: async () => ({ ok: true }),
      getLibraryKey: async () => Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
      requireUnlock: null,
      now: () => Date.now(),
    },
  };
});

const { TvSignInView, TvSignInScreen, TV_SIGN_IN_QR } = await import("./TvSignInScreen");
const { TvApprovePairingScreen } = await import("./TvApprovePairingScreen");

beforeAll(async () => {
  await initI18n("en");
});

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.events.length = 0;
  ctl.sent.length = 0;
  ctl.backHandlers.length = 0;
  ctl.focused.length = 0;
  ctl.hasPassword = true;
  ctl.codesSent.length = 0;
  ctl.window = { width: 960, height: 540 };
  ctl.goBack = vi.fn();
  ctl.restart = vi.fn();
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  vi.useRealTimers();
});

const testIdOfProps = (props: unknown): string =>
  typeof props === "object" && props !== null && "testID" in props && typeof props.testID === "string" ? props.testID : "";

const mount = async (element: React.ReactElement) => {
  await act(async () => {
    renderer = create(element, {
      // A text field's ref is a stand-in that records which field was asked to take the focus.
      createNodeMock: (node) => (node.type === "TextInput" ? { focus: () => ctl.focused.push(testIdOfProps(node.props)) } : null),
    });
  });
};

const settleTimers = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const byTestId = (id: string): ReactTestInstance[] =>
  (renderer?.root.findAll((node) => typeof node.type === "string" && node.props.testID === id) ?? []) as ReactTestInstance[];

const one = (id: string): ReactTestInstance => {
  const found = byTestId(id);
  if (found.length !== 1) throw new Error(`expected one "${id}", found ${found.length}`);
  return found[0] as ReactTestInstance;
};

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

const allText = (): string => (renderer?.root ? textOf(renderer.root) : "");

const press = async (id: string) => {
  await act(async () => {
    one(id).props.onPress();
  });
  await flush();
};

const type = async (id: string, value: string) => {
  await act(async () => {
    one(id).props.onChangeText(value);
  });
};

const waiting = (expiresInMs: number): PairingState => ({
  phase: "waiting",
  expiresAtMs: Date.now() + expiresInMs,
  renewals: 0,
  request: {
    requestId: "req-1",
    shortCode: "ABCDEFGH",
    qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH",
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    deviceName: "Chromecast with Google TV",
  },
});

describe("TV sign-in screen", () => {
  it("shows the QR code, the typed code, the countdown and the TV's name", async () => {
    console.info("[tv-screens:phase] sign-in waiting");
    await mount(<TvSignInView state={waiting(4 * 60_000 + 7_000)} onRetry={() => undefined} onUsePassword={() => undefined} />);
    const text = allText();
    console.info("[tv-screens:state]", { text });

    expect(textOf(one("tv-pairing-short-code"))).toBe("ABCDEFGH");
    expect(textOf(one("tv-pairing-countdown"))).toMatch(/^A new code appears by itself in 4:0[0-9]$/);
    expect(textOf(one("tv-pairing-device-name"))).toBe("This TV shows up as “Chromecast with Google TV”");
    const qr = renderer?.root.findAll((node) => String(node.type) === "Path") ?? [];
    expect(String(qr[0]?.props.d ?? "").length).toBeGreaterThan(100);
    expect(byTestId("tv-pairing-failure")).toHaveLength(0);
  });

  it("counts down every second while the code is on screen", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-20T10:00:00Z") });
    await mount(<TvSignInView state={waiting(125_000)} onRetry={() => undefined} onUsePassword={() => undefined} />);
    expect(textOf(one("tv-pairing-countdown"))).toContain("2:05");
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    console.info("[tv-screens:state]", { countdown: textOf(one("tv-pairing-countdown")) });
    expect(textOf(one("tv-pairing-countdown"))).toContain("2:00");
  });

  it.each([
    ["starting", { phase: "starting" } as PairingState, "Getting a pairing code"],
    ["completing", { phase: "completing" } as PairingState, "Signing in"],
  ])("says what is happening while %s", async (_label, state, expected) => {
    await mount(<TvSignInView state={state} onRetry={() => undefined} onUsePassword={() => undefined} />);
    expect(textOf(one("tv-pairing-progress"))).toContain(expected);
  });

  it.each([
    ["denied", { phase: "denied" } as PairingState, "declined"],
    // @req ACCT-AUTH-11: the shared sign-in sentence with the API's wait.
    ["rate limited", { phase: "error", reason: "rate_limited", retryAfterMinutes: 4 } as PairingState, "Too many attempts. Try again in 4 minutes."],
    ["unreachable", { phase: "error", reason: "unreachable" } as PairingState, "couldn't reach"],
    ["key mismatch", { phase: "error", reason: "key_mismatch" } as PairingState, "Nothing was saved"],
  ])("explains a %s pairing and offers a new code and the password form", async (_label, state, expected) => {
    const onRetry = vi.fn();
    const onUsePassword = vi.fn();
    await mount(<TvSignInView state={state} onRetry={onRetry} onUsePassword={onUsePassword} />);
    console.info("[tv-screens:state]", { text: allText() });
    expect(allText()).toContain(expected);
    await press("tv-pairing-retry");
    await press("tv-pairing-use-password");
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onUsePassword).toHaveBeenCalledTimes(1);
  });

  it("@req UX-TV-31 shows the badger, the title, one line, then one card with the QR and the code side by side", async () => {
    await mount(<TvSignInView state={waiting(4 * 60_000 + 7_000)} onRetry={() => undefined} onUsePassword={() => undefined} />);
    const text = allText();
    console.info("[tv-screens:state] tv redesign", { text });
    // No numbered steps and no logo or app name at the top left: the badger alone, over the title.
    expect(text).not.toMatch(/Step 1|1\./);
    expect(renderer?.root.findAll((node) => String(node.type) === "Image").map((node) => node.props.testID)).toEqual(["tv-pairing-mascot"]);
    expect(text).toContain("Sign in to Badger");
    // The card: the QR with "Scan with your phone", then "Or type this code", the code, the ring, the renewal and the name.
    const card = one("tv-pairing-card");
    const cardText = textOf(card);
    expect(cardText.indexOf("Scan with your phone")).toBeGreaterThanOrEqual(0);
    expect(cardText.indexOf("Or type this code")).toBeGreaterThan(cardText.indexOf("Scan with your phone"));
    expect(cardText.indexOf("ABCDEFGH")).toBeGreaterThan(cardText.indexOf("Or type this code"));
    expect(cardText.indexOf("A new code appears")).toBeGreaterThan(cardText.indexOf("ABCDEFGH"));
    expect(cardText.indexOf("This TV shows up as")).toBeGreaterThan(cardText.indexOf("A new code appears"));
    expect(card.findAll((node) => String(node.type) === "Svg").map((node) => node.props.testID ?? "qr")).toEqual(["qr", "tv-pairing-code-life"]);
    // @bugfix @regression-proof Chris 2026-11-18: the code is two groups of 4 with a gap, never a dash (ACCT-PAIR-01),
    // even when an older API still sends "ABCD-EFGH".
    const halves = (code: ReactTestInstance) => code.findAll((node) => String(node.type) === "Text").map(textOf);
    expect(halves(one("tv-pairing-short-code"))).toEqual(["ABCD", "EFGH"]);
    expect(one("tv-pairing-short-code").props.accessibilityLabel).toBe("A B C D E F G H");
    const legacy = waiting(300_000) as Extract<PairingState, { phase: "waiting" }>;
    await mount(<TvSignInView state={{ ...legacy, request: { ...legacy.request, shortCode: "ABCD-EFGH" } }} onRetry={() => undefined} onUsePassword={() => undefined} />);
    expect(halves(one("tv-pairing-short-code"))).toEqual(["ABCD", "EFGH"]);
    expect(textOf(one("tv-pairing-short-code"))).not.toContain("-");
    // Under the card, one pill with the mail icon; the language button alone, with a globe.
    const button = one("tv-pairing-use-password");
    expect(textOf(button)).toContain("Use email and password instead");
    expect(button.findAll((node) => String(node.type) === "MailIcon")).toHaveLength(1);
    expect(one("tv-pairing-language").findAll((node) => String(node.type) === "GlobeIcon")).toHaveLength(1);
  });

  it("@req UX-TV-31 the ring empties as the code ages", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-12T10:00:00Z") });
    await mount(<TvSignInView state={waiting(240_000)} onRetry={() => undefined} onUsePassword={() => undefined} />);
    const arc = () => {
      const circles = one("tv-pairing-code-life").findAll((node) => String(node.type) === "Circle");
      const [shown, length] = String(circles[1]?.props.strokeDasharray).split(" ").map(Number);
      return (shown ?? 0) / (length ?? 1);
    };
    expect(arc()).toBeCloseTo(1, 2);
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    console.info("[tv-screens:state]", { left: arc() });
    expect(arc()).toBeCloseTo(0.5, 2);
  });

  it("switches to the password login and back to the code", async () => {
    ctl.hookState = waiting(300_000);
    await mount(<TvSignInScreen />);
    expect(byTestId("tv-pairing-short-code")).toHaveLength(1);
    await press("tv-pairing-use-password");
    expect(renderer?.root.findAll((node) => String(node.type) === "LoginScreen")).toHaveLength(1);
    expect(byTestId("tv-pairing-short-code")).toHaveLength(0);
    await press("tv-pairing-use-code");
    expect(byTestId("tv-pairing-short-code")).toHaveLength(1);
  });
});

describe("TV sign-in layout and Back", () => {
  it("Back on the password form returns to the code and is not handled on the code screen", async () => {
    ctl.hookState = waiting(300_000);
    await mount(<TvSignInScreen />);
    console.info("[tv-screens:phase] code screen", { backHandlers: ctl.backHandlers.length });
    expect(ctl.backHandlers).toHaveLength(0);
    await press("tv-pairing-use-password");
    console.info("[tv-screens:phase] password form", { backHandlers: ctl.backHandlers.length });
    expect(ctl.backHandlers).toHaveLength(1);
    let handled: boolean | undefined;
    await act(async () => {
      handled = ctl.backHandlers[0]?.();
    });
    console.info("[tv-screens:state]", { handled, shortCodes: byTestId("tv-pairing-short-code").length, backHandlers: ctl.backHandlers.length });
    expect(handled).toBe(true);
    expect(byTestId("tv-pairing-short-code")).toHaveLength(1);
    expect(ctl.backHandlers).toHaveLength(0);
  });

  it("keeps the short code on one line and draws the QR at the TV's scale", async () => {
    ctl.window = { width: 1920, height: 1080 };
    await mount(<TvSignInView state={waiting(300_000)} onRetry={() => undefined} onUsePassword={() => undefined} />);
    const halves = one("tv-pairing-short-code").findAll((node) => String(node.type) === "Text");
    console.info("[tv-screens:state]", { halves: halves.map((half) => [half.props.numberOfLines, half.props.adjustsFontSizeToFit]) });
    expect(halves).toHaveLength(2);
    for (const half of halves) {
      expect(half.props.numberOfLines).toBe(1);
      expect(half.props.adjustsFontSizeToFit).toBe(true);
    }
    const qr = renderer?.root.findAll((node) => String(node.type) === "Svg" && node.props.testID !== "tv-pairing-code-life") ?? [];
    expect(qr[0]?.props.width).toBe(TV_SIGN_IN_QR * 2);
  });
});

describe("TV sign-in focus (remote)", () => {
  const focusable = (): string[] =>
    (renderer?.root.findAll((node) => String(node.type) === "Pressable") ?? []).map((node) => String(node.props.testID ?? ""));
  const preferred = (): string[] =>
    (renderer?.root.findAll((node) => String(node.type) === "Pressable" && node.props.hasTVPreferredFocus === true) ?? []).map((node) =>
      String(node.props.testID),
    );

  it("@req UX-TV-31 starts on \"Use email and password instead\"; the language button is the only other stop", async () => {
    await mount(<TvSignInView state={waiting(300_000)} onRetry={() => undefined} onUsePassword={() => undefined} />);
    console.info("[tv-screens:focus]", { focusable: focusable(), preferred: preferred() });
    expect(preferred()).toEqual(["tv-pairing-use-password"]);
    expect(focusable()).toEqual(["tv-pairing-use-password", "tv-pairing-language"]);
  });

  it.each([
    ["denied", { phase: "denied" } as PairingState],
    ["rate limited", { phase: "error", reason: "rate_limited", retryAfterMinutes: 4 } as PairingState],
  ])("@req UX-TV-31 starts on \"Get a new code\" when %s, next to the password", async (_label, state) => {
    await mount(<TvSignInView state={state} onRetry={() => undefined} onUsePassword={() => undefined} />);
    console.info("[tv-screens:focus]", { focusable: focusable(), preferred: preferred() });
    expect(preferred()).toEqual(["tv-pairing-retry"]);
    expect(focusable()).toEqual(["tv-pairing-retry", "tv-pairing-use-password", "tv-pairing-language"]);
    expect(textOf(one("tv-pairing-card"))).toContain(textOf(one("tv-pairing-failure")));
  });

  it("@req UX-TV-31 the language button reopens \"Choose your language\"", async () => {
    ctl.hookState = waiting(300_000);
    await mount(<TvSignInScreen />);
    await press("tv-pairing-language");
    console.info("[tv-screens:state]", { events: ctl.events });
    expect(ctl.events).toEqual(["setup:language"]);
  });
});

describe("TV approver screen", () => {
  it("takes a typed code, warns, and approves only with the account password the API accepts", async () => {
    console.info("[tv-screens:phase] approver");
    await mount(<TvApprovePairingScreen />);
    expect(byTestId("tv-approve-lookup")[0]?.props.disabled).toBe(true);

    await type("tv-approve-code", "abcd-efgh");
    await press("tv-approve-lookup");
    console.info("[tv-screens:state]", { afterLookup: allText() });
    expect(allText()).toContain("Living room Kodi");
    expect(allText()).toContain("Only approve a code shown on a screen in front of you");
    expect(ctl.sent).toEqual([]);

    await press("tv-approve-approve");
    // The password prompt is on screen; nothing has been sent yet and the field hides what is typed.
    expect(one("tv-approve-secret").props.secureTextEntry).toBe(true);
    expect(byTestId("tv-approve-secret-submit")[0]?.props.disabled).toBe(true);
    expect(ctl.sent).toEqual([]);

    await type("tv-approve-secret", "wrong");
    await press("tv-approve-secret-submit");
    console.info("[tv-screens:state]", { afterWrong: allText(), sent: ctl.sent });
    expect(allText()).toContain("That password is not right");
    expect(ctl.events).toEqual([]);
    expect(one("tv-approve-secret").props.value).toBe("");

    await type("tv-approve-secret", "hunter2");
    await press("tv-approve-secret-submit");
    console.info("[tv-screens:state]", { events: ctl.events, sent: ctl.sent, text: allText() });
    expect(ctl.sent).toEqual(["wrong", "hunter2"]);
    expect(ctl.events).toEqual(["approve", "remember:s1"]);
    expect(byTestId("tv-approve-done")).toHaveLength(1);
  });

  it("sends nothing when the password prompt is cancelled, and goes back to the confirmation", async () => {
    await mount(<TvApprovePairingScreen />);
    await type("tv-approve-code", "ABCDEFGH");
    await press("tv-approve-lookup");
    await press("tv-approve-approve");
    await press("tv-approve-secret-cancel");
    console.info("[tv-screens:state]", { sent: ctl.sent, text: allText() });
    expect(ctl.sent).toEqual([]);
    expect(byTestId("tv-approve-approve")).toHaveLength(1);
    expect(byTestId("tv-approve-secret")).toHaveLength(0);
  });

  it("asks the code field, then the password field, for the focus when each one appears", async () => {
    console.info("[tv-screens:phase] approver focus");
    await mount(<TvApprovePairingScreen />);
    await settleTimers(150);
    console.info("[tv-screens:state]", { afterMount: [...ctl.focused] });
    expect(ctl.focused).toEqual(["tv-approve-code"]);

    await type("tv-approve-code", "abcd-efgh");
    await press("tv-approve-lookup");
    await settleTimers(150);
    // The confirmation step has no text field: nothing is asked for the focus there.
    expect(ctl.focused).toEqual(["tv-approve-code"]);

    await press("tv-approve-approve");
    await settleTimers(150);
    console.info("[tv-screens:state]", { afterPasswordStage: [...ctl.focused] });
    expect(ctl.focused).toEqual(["tv-approve-code", "tv-approve-secret"]);

    // A wrong password: the request goes back to the password step and the (re-appeared) field is focused again.
    await type("tv-approve-secret", "wrong");
    await press("tv-approve-secret-submit");
    await settleTimers(150);
    console.info("[tv-screens:state]", { afterWrongPassword: [...ctl.focused] });
    expect(ctl.focused.at(-1)).toBe("tv-approve-secret");
    expect(ctl.focused.length).toBeGreaterThanOrEqual(3);
  });

  it("@req ACCT-PAIR-02 an account without a password approves with the emailed code, not a password", async () => {
    console.info("[tv-screens:phase] approver without a password");
    ctl.hasPassword = false;
    await mount(<TvApprovePairingScreen />);
    await type("tv-approve-code", "abcd-efgh");
    await press("tv-approve-lookup");
    expect(allText()).toContain("You'll be asked for a code to confirm it's you");
    expect(allText()).not.toContain("account password");

    // Approve asks the API without a proof: it emails a code and answers `two_factor_required`.
    await press("tv-approve-approve");
    console.info("[tv-screens:state]", { afterApprove: allText(), codes: ctl.codesSent });
    expect(ctl.codesSent).toEqual([null]);
    expect(allText()).toContain("Enter the code");
    expect(allText()).toContain("We emailed you a code");
    expect(one("tv-approve-secret").props.secureTextEntry).toBe(false);
    expect(one("tv-approve-secret").props.keyboardType).toBe("number-pad");

    await type("tv-approve-secret", "000000");
    await press("tv-approve-secret-submit");
    console.info("[tv-screens:state]", { afterWrongCode: allText(), codes: ctl.codesSent });
    expect(allText()).toContain("That code is wrong or expired");
    expect(ctl.events).toEqual([]);
    expect(one("tv-approve-secret").props.value).toBe("");

    await type("tv-approve-secret", "123456");
    await press("tv-approve-secret-submit");
    console.info("[tv-screens:state]", { events: ctl.events, codes: ctl.codesSent });
    expect(ctl.codesSent).toEqual([null, "000000", "123456"]);
    expect(ctl.sent).toEqual([]);
    expect(ctl.events).toEqual(["approve", "remember:s2"]);
    expect(byTestId("tv-approve-done")).toHaveLength(1);
  });
});
