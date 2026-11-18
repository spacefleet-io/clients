// @req UX-I18N-07 @req ACCT-SQUAD-03
import { describe, expect, it, vi } from "vitest";
import {
  accountLanguageOf,
  accountLanguagePrompt,
  decideAccountLanguage,
  reconcileAccountLanguage,
} from "../src/accountLanguage";

const run = async (device: "en" | "fr" | "nl" | "de", account: string | null, picked?: "en" | "fr" | "nl" | "de") => {
  const ask = vi.fn(async () => picked ?? device);
  const saveAccount = vi.fn(async () => {});
  const applyDevice = vi.fn(async () => {});
  const result = await reconcileAccountLanguage({ device, account, ask, saveAccount, applyDevice });
  console.info("reconcile", { device, account, picked, result, ask: ask.mock.calls, save: saveAccount.mock.calls, apply: applyDevice.mock.calls });
  return { result, ask, saveAccount, applyDevice };
};

describe("account language reconcile after sign-in", () => {
  it("an account without a language takes the step-0 choice, without asking", async () => {
    const { result, ask, saveAccount, applyDevice } = await run("fr", null);
    expect(result).toBe("fr");
    expect(ask).not.toHaveBeenCalled();
    expect(saveAccount).toHaveBeenCalledWith("fr");
    expect(applyDevice).not.toHaveBeenCalled();
  });

  it("an account already in the device's language changes nothing", async () => {
    const { result, ask, saveAccount, applyDevice } = await run("de", "de");
    expect(result).toBe("de");
    expect(ask).not.toHaveBeenCalled();
    expect(saveAccount).not.toHaveBeenCalled();
    expect(applyDevice).not.toHaveBeenCalled();
  });

  it("different languages ask; picking the device's saves it on the account", async () => {
    const { result, ask, saveAccount, applyDevice } = await run("fr", "en", "fr");
    expect(ask).toHaveBeenCalledWith({ device: "fr", account: "en" });
    expect(result).toBe("fr");
    expect(saveAccount).toHaveBeenCalledWith("fr");
    expect(applyDevice).not.toHaveBeenCalled();
  });

  it("different languages ask; picking the account's switches the device only", async () => {
    const { result, saveAccount, applyDevice } = await run("fr", "en", "en");
    expect(result).toBe("en");
    expect(saveAccount).not.toHaveBeenCalled();
    expect(applyDevice).toHaveBeenCalledWith("en");
  });

  it("decides from an unknown stored value as from no language", () => {
    expect(decideAccountLanguage("nl", "xx")).toEqual({ kind: "adopt-device", language: "nl" });
  });

  it("reads the account language from /auth/me", () => {
    expect(accountLanguageOf({ uiLanguage: "fr" })).toBe("fr");
    expect(accountLanguageOf({ preferences: { uiLanguage: "de" } })).toBe("de");
    expect(accountLanguageOf(null)).toBeNull();
  });

  it("words the prompt in the device's language with both names", () => {
    const fr = accountLanguagePrompt("fr", { device: "fr", account: "en" });
    expect(fr.title).toBe("Quelle langue voulez-vous ?");
    expect(fr.body).toContain("Votre compte est en anglais et cet appareil en français.");
    expect(accountLanguagePrompt("de", { device: "de", account: "es" }).body).toContain("auf Spanisch eingestellt, dieses Gerät auf Deutsch.");
    expect(accountLanguagePrompt("en", { device: "en", account: "nl" }).body).toContain("set to Dutch, and this device to English.");
    expect(accountLanguagePrompt("xx", { device: "de", account: "nl" }).title).toBe("Which language do you want?");
  });
});
