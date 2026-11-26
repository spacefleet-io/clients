/**
 * @test-id NOTIFY-CORE-TEXTS-001
 * @level unit
 * @req UX-NOTICE-13[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv,badger-web-player,parrot-web-player,web]
 * @req UX-NOTICE-14[badger-kodi,badger-jellyfin]
 * @why Chris 2026-11-26 (chat, notifications draft questions 11 and 12): every notice is shown in the app language from
 *   one shared set of texts, no built-in title stays English-only, and Kodi and Jellyfin show each kind with their
 *   host's closest pop-up. Checks every language has every text, the default titles are translated, the plural and
 *   value filling, and the kind-to-pop-up table.
 */
import { describe, expect, it } from "vitest";
import {
  jellyfinPopupFor,
  kodiPopupFor,
  liveRegionFor,
  liveRoleFor,
  NOTIFY_LANGUAGES,
  notifyLanguage,
  notifyTexts,
  notifyTranslator,
  partText,
  titleText,
  withNotifyTexts,
} from "../src/index";

const ID = "NOTIFY-CORE-TEXTS-001";

const leaves = (node: unknown, prefix = ""): string[] =>
  typeof node === "object" && node !== null
    ? Object.entries(node).flatMap(([key, value]) => leaves(value, prefix ? `${prefix}.${key}` : key))
    : [prefix];

describe("shared notice texts (UX-NOTICE-13)", () => {
  it("has every text in all five app languages, none empty", () => {
    const english = leaves(notifyTexts.en).sort();
    console.info(`[${ID}] keys`, english.length);
    for (const lang of NOTIFY_LANGUAGES) {
      expect(leaves(notifyTexts[lang]).sort(), lang).toEqual(english);
      const t = notifyTranslator(lang);
      for (const key of english) expect(t(`notify.${key}`).trim(), `${lang} ${key}`).not.toBe("");
    }
  });

  it("translates the default titles: no level keeps an English title outside English", () => {
    for (const lang of NOTIFY_LANGUAGES.filter((l) => l !== "en")) {
      const titles = notifyTexts[lang].defaultTitle;
      console.info(`[${ID}] ${lang} default titles`, JSON.stringify(titles));
      expect(titles.warning).not.toBe(notifyTexts.en.defaultTitle.warning);
      expect(titles.success).not.toBe(notifyTexts.en.defaultTitle.success);
    }
    expect(titleText(notifyTranslator("fr"), { level: "error" })).toBe("Erreur");
    expect(titleText(notifyTranslator("de"), { level: "warning", title: "Eigener Titel" })).toBe("Eigener Titel");
  });

  it("fills values and picks the plural form without Intl.PluralRules", () => {
    const original = Intl.PluralRules;
    try {
      // Hermes (phone and TV) has no Intl.PluralRules.
      Object.defineProperty(Intl, "PluralRules", { value: undefined, configurable: true });
      expect(notifyTranslator("fr")("notify.unread", { count: 1 })).toBe("1 non lue");
      expect(notifyTranslator("fr")("notify.unread", { count: 3 })).toBe("3 non lues");
    } finally {
      Object.defineProperty(Intl, "PluralRules", { value: original, configurable: true });
    }
    expect(notifyTranslator("en")("notify.unread", { count: 12 })).toBe("12 unread");
    // The tray's subtitle (the computers' wording Chris likes).
    expect(notifyTranslator("en")("notify.recent", { count: 1 })).toBe("1 recent item");
    expect(notifyTranslator("de")("notify.recent", { count: 4 })).toBe("4 neue Einträge");
    expect(notifyTranslator("nl")("notify.account.newDeviceMessage", { name: "Woonkamer", type: "TV" })).toBe("Woonkamer (TV)");
    expect(notifyTranslator("es")("notify.nope")).toBe("notify.nope");
  });

  it("turns a notice part into words: keys translated, plain text as it is", () => {
    const t = notifyTranslator("es");
    expect(partText(t, { key: "notify.job.downloadFailed" })).toBe("La descarga falló");
    expect(partText(t, "Matrix.mkv")).toBe("Matrix.mkv");
    expect(partText(t, undefined)).toBe("");
    // A value that is a text key (the device type of an account notice) is translated in the reader's language too.
    const message = { key: "notify.account.newDeviceMessage", vars: { name: "Salon", type: { key: "notify.account.deviceType.tv" } } };
    expect(partText(notifyTranslator("de"), message)).toBe("Salon (Fernseher)");
    expect(partText(notifyTranslator("fr"), { ...message, vars: { name: { key: "notify.account.unnamedDevice" }, type: { key: "notify.account.deviceType.desktop" } } })).toBe(
      "Appareil sans nom (Ordinateur)",
    );
  });

  it("maps a language tag to a notify language and merges the texts into an i18next translation", () => {
    expect(["fr-BE", "nl_NL", "DE", "es", "pt", undefined].map(notifyLanguage)).toEqual(["fr", "nl", "de", "es", "en", "en"]);
    const merged = withNotifyTexts({ app: { hello: "Hallo" } }, "de");
    expect(merged.app.hello).toBe("Hallo");
    expect(merged.notify.bell).toBe("Benachrichtigungen");
  });

  it("announces errors assertively and everything else politely", () => {
    expect(liveRegionFor("error")).toBe("assertive");
    expect(liveRegionFor("warning")).toBe("polite");
    expect(liveRoleFor("error")).toBe("alert");
    expect(liveRoleFor("success")).toBe("status");
  });
});

describe("host pop-ups for Kodi and Jellyfin (UX-NOTICE-14)", () => {
  it("shows passing notices as the host's toast with the kind's time, one-time messages as OK, decisions as yes/no", () => {
    const table = {
      confirmation: kodiPopupFor({ kind: "confirmation", level: "success" }),
      headsUp: kodiPopupFor({ kind: "headsUp", level: "warning" }),
      problem: kodiPopupFor({ kind: "headsUp", level: "error" }),
      jobFailed: kodiPopupFor({ kind: "job", outcome: "failed", level: "error" }),
      oneTime: kodiPopupFor({ kind: "headsUp", level: "info", oneTime: true }),
      decision: kodiPopupFor({ kind: "decision", level: "warning" }),
    };
    console.info(`[${ID}] kodi`, JSON.stringify(table));
    expect(table).toEqual({
      confirmation: { type: "notification", icon: "info", ms: 4_000 },
      headsUp: { type: "notification", icon: "warning", ms: 8_000 },
      problem: { type: "notification", icon: "error", ms: 8_000 },
      jobFailed: { type: "notification", icon: "error", ms: 8_000 },
      oneTime: { type: "ok" },
      decision: { type: "yesno" },
    });
    expect(jellyfinPopupFor({ kind: "headsUp", level: "error" })).toEqual({ type: "toast", level: "error" });
    expect(jellyfinPopupFor({ kind: "headsUp", level: "info", oneTime: true })).toEqual({ type: "alert" });
    expect(jellyfinPopupFor({ kind: "decision", level: "info" })).toEqual({ type: "confirm" });
  });
});
