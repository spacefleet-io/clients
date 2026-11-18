import { SPACE_APP_NAMES } from "@space/shared/appScope";
import { describe, expect, it } from "vitest";
import { pairDeviceStrings, pairDeviceText } from "../src/components/pair-device-strings";

// @req ACCT-PAIR-05
describe("[pair-dialog-strings] the approve question names the app asking to sign in", () => {
  it("[pair-dialog-strings-1] reads '<App> on <device> (<type>) wants to sign in to your account.'", () => {
    const t = pairDeviceText("en");
    const question = t("confirm.question", { app: SPACE_APP_NAMES.parrot, name: "test-laptop", type: t("type.desktop") });
    console.info("[pair-dialog-strings-1]", question);
    expect(question).toBe("Parrot on test-laptop (Computer) wants to sign in to your account.");
  });

  it("[pair-dialog-strings-2] every language carries the app, the device and its type", () => {
    for (const [language, strings] of Object.entries(pairDeviceStrings)) {
      console.info("[pair-dialog-strings-2]", language, strings["confirm.question"]);
      expect(strings["confirm.question"]).toContain("{app}");
      expect(strings["confirm.question"]).toContain("{name}");
      expect(strings["confirm.question"]).toContain("{type}");
    }
    expect(pairDeviceText("fr")("confirm.question", { app: "Badger", name: "Salon", type: "TV" })).toBe(
      "Badger sur Salon (TV) veut se connecter à votre compte.",
    );
  });
});

// @req ACCT-PAIR-01
describe("[pair-dialog-strings] a key-only request asks for the library key", () => {
  it("[pair-dialog-strings-3] every language names the app, the device and its type, and says the key", () => {
    for (const [language, strings] of Object.entries(pairDeviceStrings)) {
      console.info("[pair-dialog-strings-3]", language, strings["confirm.keyQuestion"], "|", strings["done.keySent"]);
      expect(strings["confirm.keyQuestion"]).toContain("{app}");
      expect(strings["confirm.keyQuestion"]).toContain("{name}");
      expect(strings["confirm.keyQuestion"]).toContain("{type}");
      expect(strings["done.keySent"]).toContain("{name}");
    }
    expect(pairDeviceText("en")("confirm.keyQuestion", { app: "Badger", name: "test-laptop", type: "Computer" })).toBe(
      "Badger on test-laptop (Computer) is signed in to your account and wants your media library key.",
    );
  });
});
