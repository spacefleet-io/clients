/**
 * @test-id MOBILE-SHELL-SIGN-OUT-HOOK-001
 * @level unit
 * @req ACCT-DEV-03
 * @why Badger's and Parrot's phones share one Sign out hook and pass only their key store, their sign-out and the
 *   i18n prefix of their texts. A phone holding the key asks with the app's texts under that prefix, Cancel first and
 *   signing nothing out, the destructive confirm signs out once; a phone with no key signs out at once.
 *
 * Mounts the hook with react-test-renderer; react-native's Alert, i18n and the logger are fakes.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileSignOut } from "../src/signOut";

type AlertButton = { text: string; style: string; onPress?: () => void };

const ctl = vi.hoisted(() => ({
  storedKey: null as string | null,
  alerts: [] as { title: string; body: string; buttons: AlertButton[] }[],
  signOuts: 0,
  events: [] as string[],
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, body: string, buttons: AlertButton[]) => void ctl.alerts.push({ title, body, buttons }),
  },
}));
vi.mock("../src/i18n", () => ({ useTranslation: () => ({ t: (key: string) => `t(${key})` }) }));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ info: (event: string) => void ctl.events.push(event) }) }));

const TEST_ID = "MOBILE-SHELL-SIGN-OUT-HOOK-001";
const log = (step: string, detail: Record<string, unknown> = {}) => console.info(`[${TEST_ID}] ${step}`, JSON.stringify(detail));

const readStoredKey = async () => ctl.storedKey;
const signOutFake = async () => {
  ctl.signOuts += 1;
};

let renderer: ReactTestRenderer | null = null;
let signOut: (() => Promise<void>) | null = null;

const Probe = () => {
  signOut = useMobileSignOut({ readStoredKey, signOut: signOutFake, keyPrefix: "app.signOutKey" });
  return null;
};

const pressSignOut = async () => {
  await act(async () => {
    await signOut!();
  });
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.storedKey = "b".repeat(43) + "=";
  ctl.alerts = [];
  ctl.signOuts = 0;
  ctl.events = [];
  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
});

afterEach(async () => {
  log("teardown", { alerts: ctl.alerts.map((a) => a.title), signOuts: ctl.signOuts, events: ctl.events });
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  signOut = null;
});

describe("useMobileSignOut asks a key holder whether the key was saved (ACCT-DEV-03)", () => {
  it("holder: asks with the app's texts, Cancel first and signs nothing out", async () => {
    await pressSignOut();
    expect(ctl.alerts).toHaveLength(1);
    const [alert] = ctl.alerts;
    expect([alert.title, alert.body]).toEqual(["t(app.signOutKey.title)", "t(app.signOutKey.body)"]);
    expect(alert.buttons.map((b) => [b.text, b.style])).toEqual([
      ["t(app.signOutKey.cancel)", "cancel"],
      ["t(app.signOutKey.confirm)", "destructive"],
    ]);
    alert.buttons[0].onPress?.();
    expect(ctl.signOuts).toBe(0);
    expect(ctl.events).toEqual(["asked", "cancelled"]);
  });

  it("holder: the destructive confirm signs out once", async () => {
    await pressSignOut();
    await act(async () => {
      ctl.alerts[0].buttons[1].onPress?.();
    });
    expect(ctl.signOuts).toBe(1);
    expect(ctl.events).toEqual(["asked", "confirmed"]);
  });

  it("no key on the phone: signs out at once without asking", async () => {
    ctl.storedKey = null;
    await pressSignOut();
    expect(ctl.alerts).toEqual([]);
    expect(ctl.signOuts).toBe(1);
    expect(ctl.events).toEqual(["signedOutAtOnce"]);
  });
});
