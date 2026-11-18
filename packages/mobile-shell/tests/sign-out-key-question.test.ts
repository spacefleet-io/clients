/**
 * @test-id MOBILE-SHELL-SIGN-OUT-KEY-001
 * @level unit
 * @req ACCT-DEV-03
 * @why Sign out forgets the library key, and without it the only way back in is typing it (QR sign-in needs another
 *   device that still holds it). Badger's and Parrot's phones share one Sign out: a phone holding the key asks first
 *   with Cancel as the first, safe choice and signs out only on the destructive confirm; a phone with no key signs out
 *   at once; a key store that cannot be read still asks.
 */
import { describe, expect, it } from "vitest";
import { asksKeySavedBeforeSigningOut, signOutAskingForSavedKey, type SignOutKeyAlert } from "../src/libraryKey";

const TEXT = { title: "Saved?", body: "Typing it is the only way back.", cancel: "Cancel", confirm: "I saved it, sign out" };
const log = (step: string, detail: Record<string, unknown> = {}) =>
  console.info(`[MOBILE-SHELL-SIGN-OUT-KEY-001] ${step}`, JSON.stringify(detail));

const harness = (storedKey: () => Promise<string | null>) => {
  const alerts: Parameters<SignOutKeyAlert>[] = [];
  const events: string[] = [];
  let signOuts = 0;
  const run = () =>
    signOutAskingForSavedKey({
      readStoredKey: storedKey,
      text: TEXT,
      alert: (...args) => void alerts.push(args),
      signOut: async () => {
        signOuts += 1;
      },
      log: (event) => void events.push(event),
    });
  return { run, alerts, events, signOuts: () => signOuts };
};

describe("signOutAskingForSavedKey (ACCT-DEV-03)", () => {
  it("a key holder is asked; Cancel comes first and changes nothing; confirm signs out once", async () => {
    const h = harness(async () => "k".repeat(43) + "=");
    const outcome = await h.run();
    log("asked", { outcome, alerts: h.alerts, events: h.events });
    expect(outcome).toBe("asked");
    expect(h.signOuts()).toBe(0);
    expect(h.alerts).toHaveLength(1);
    const [title, body, buttons] = h.alerts[0]!;
    expect([title, body]).toEqual([TEXT.title, TEXT.body]);
    expect(buttons.map((b) => [b.text, b.style])).toEqual([
      [TEXT.cancel, "cancel"],
      [TEXT.confirm, "destructive"],
    ]);

    buttons[0]!.onPress?.();
    log("cancelled", { signOuts: h.signOuts(), events: h.events });
    expect(h.signOuts()).toBe(0);

    buttons[1]!.onPress?.();
    await Promise.resolve();
    log("confirmed", { signOuts: h.signOuts(), events: h.events });
    expect(h.signOuts()).toBe(1);
    expect(h.events).toEqual(["asked", "cancelled", "confirmed"]);
  });

  it("no key on the phone: signs out at once, no question", async () => {
    for (const stored of [null, ""]) {
      const h = harness(async () => stored);
      const outcome = await h.run();
      log("noKey", { stored, outcome, alerts: h.alerts.length, signOuts: h.signOuts() });
      expect(outcome).toBe("signedOut");
      expect(h.alerts).toHaveLength(0);
      expect(h.signOuts()).toBe(1);
    }
  });

  it("a key store that cannot be read counts as holding the key", async () => {
    const failing = async (): Promise<string | null> => {
      throw new Error("keychain locked");
    };
    expect(await asksKeySavedBeforeSigningOut(failing)).toBe(true);
    const h = harness(failing);
    expect(await h.run()).toBe("asked");
    log("unreadable", { alerts: h.alerts.length, signOuts: h.signOuts() });
    expect(h.signOuts()).toBe(0);
  });
});
