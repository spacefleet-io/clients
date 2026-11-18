/**
 * @test-id MOBILE-SIGN-OUT-KEY-QUESTION-001
 * @level component
 * @req ACCT-DEV-03[badger-mobile]
 * @why Sign out forgets the media library key, and without it the only way back in is typing it (QR sign-in needs
 *   another device that still holds the key). Settings › Sign out and the key screen's Sign out go through
 *   `useSignOut`: a phone holding the key asks first, in the app's words, with Cancel first; Cancel keeps the phone
 *   signed in, only the destructive confirm calls `logout("signOut")`, once. A phone with no key signs out at once.
 *
 * Mounts the hook with react-test-renderer; react-native's Alert, the auth store and the key store are fakes.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MobileI18n from "@space/mobile-shell/i18n";

type AlertButton = { text: string; style: string; onPress?: () => void };

const ctl = vi.hoisted(() => ({
  storedKey: null as string | null,
  alerts: [] as { title: string; body: string; buttons: AlertButton[] }[],
  logouts: [] as string[],
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, body: string, buttons: AlertButton[]) => void ctl.alerts.push({ title, body, buttons }),
  },
}));
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof MobileI18n>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: "en" } }) };
});
vi.mock("@space/mobile-shell/logger", () => ({
  scopeLogger: () => ({ info: (event: string) => console.info(`[MOBILE-SIGN-OUT-KEY-QUESTION-001] app ${event}`) }),
}));
vi.mock("../src/store/auth", () => ({
  useAuth: () => ({
    logout: async (reason: string) => void ctl.logouts.push(reason),
  }),
}));
vi.mock("../src/lib/onboarding", () => ({ getStoredLibraryKey: async () => ctl.storedKey }));

const { initI18n, translate } = await import("@space/mobile-shell/i18n");
const { useSignOut } = await import("../src/lib/useSignOut");

const log = (step: string, detail: Record<string, unknown> = {}) =>
  console.info(`[MOBILE-SIGN-OUT-KEY-QUESTION-001] ${step}`, JSON.stringify(detail));

let renderer: ReactTestRenderer | null = null;
let signOut: (() => Promise<void>) | null = null;

const Probe = () => {
  signOut = useSignOut();
  return null;
};

const pressSignOut = async () => {
  await act(async () => {
    await signOut!();
  });
};

beforeAll(async () => {
  await initI18n("en");
});

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.storedKey = "b".repeat(43) + "=";
  ctl.alerts = [];
  ctl.logouts = [];
  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
});

afterEach(async () => {
  log("teardown", { alerts: ctl.alerts.map((a) => a.title), logouts: ctl.logouts });
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("phone Sign out asks a key holder whether the key was saved (ACCT-DEV-03)", () => {
  it("holder: the question shows, Cancel first; Cancel keeps the phone signed in", async () => {
    await pressSignOut();
    log("question", { alerts: ctl.alerts, logouts: ctl.logouts });
    expect(ctl.logouts).toEqual([]);
    expect(ctl.alerts).toHaveLength(1);
    const [alert] = ctl.alerts;
    expect(alert!.title).toBe(translate("account.signOutKey.title"));
    expect(alert!.title).toContain("media library key");
    expect(alert!.body).toBe(translate("account.signOutKey.body"));
    expect(alert!.body).toContain("QR code");
    expect(alert!.buttons.map((b) => [b.text, b.style])).toEqual([
      [translate("account.signOutKey.cancel"), "cancel"],
      [translate("account.signOutKey.confirm"), "destructive"],
    ]);

    alert!.buttons[0]!.onPress?.();
    log("cancelled", { logouts: ctl.logouts });
    expect(ctl.logouts).toEqual([]);
  });

  it("holder: the confirm signs out once, as the user's own Sign out", async () => {
    await pressSignOut();
    await act(async () => {
      ctl.alerts[0]!.buttons[1]!.onPress?.();
    });
    log("confirmed", { logouts: ctl.logouts });
    expect(ctl.logouts).toEqual(["signOut"]);
  });

  it("no key on the phone: signs out at once, no question", async () => {
    ctl.storedKey = null;
    await pressSignOut();
    log("noKey", { alerts: ctl.alerts.length, logouts: ctl.logouts });
    expect(ctl.alerts).toHaveLength(0);
    expect(ctl.logouts).toEqual(["signOut"]);
  });
});
