/**
 * @test-id PARROT-MOBILE-I18N-START-001
 * @level unit
 * @bugfix @regression-proof
 * @why Found on a Pixel 8 and the emulator (2026-11-08): Parrot started i18next only from LoginScreen's module, so
 *   after a restart with a saved session Settings showed raw keys ("feedback.intro") and the shared texts never
 *   followed the phone's language. The app now starts i18n at launch in the phone's language.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({ locale: "fr_FR", saved: new Map<string, string>() }));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Settings: { get: () => undefined },
  I18nManager: { getConstants: () => ({ localeIdentifier: device.locale }) },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => device.saved.get(key) ?? null,
    setItem: async (key: string, value: string) => void device.saved.set(key, value),
  },
}));

afterEach(() => {
  vi.resetModules();
  device.saved.clear();
});

describe("Parrot phone start language", () => {
  it.each([
    ["fr_FR", "Envoyer les rapports d'erreur"],
    ["nl_NL", "Foutmeldingen versturen"],
    ["de_DE", "Fehlerberichte senden"],
    ["ja_JP", "Send error reports"],
  ])("a phone in %s gets the shared texts in its language without the sign-in screen", async (locale, expected) => {
    device.locale = locale;
    // Imported per case after resetModules: i18n init is once per module instance, so each phone needs fresh ones.
    const { startI18n } = await import("../src/lib/i18n");
    const { translate } = await import("@space/mobile-shell/i18n");
    await startI18n();
    console.info("[i18n-start]", locale, "->", translate("settings.privacy.errorReports.title"));
    expect(translate("settings.privacy.errorReports.title")).toBe(expected);
  });
  it("a language picked in setup or Settings wins over the phone's on the next start, Parrot's own texts included", async () => {
    device.locale = "fr_FR";
    const first = await import("../src/lib/i18n");
    await first.startI18n();
    await first.setParrotLanguage("de");
    vi.resetModules();
    const { startI18n } = await import("../src/lib/i18n");
    const { translate } = await import("@space/mobile-shell/i18n");
    await startI18n();
    console.info("[i18n-start] saved de on a French phone ->", translate("parrot.nav.settings"));
    expect(translate("parrot.nav.settings")).toBe("Einstellungen");
    expect(translate("setup.next")).toBe("Weiter");
  });
  it("the shared key-step messages say Parrot's word for the collection, not Badger's media library (UX-NAME-03, UX-KEY-01)", async () => {
    device.locale = "ja_JP";
    const { startI18n, setParrotLanguage } = await import("../src/lib/i18n");
    const { translate } = await import("@space/mobile-shell/i18n");
    await startI18n();
    console.info("[i18n-start] en wrong key ->", translate("libraryKeyStep.wrongKey"));
    expect(translate("libraryKeyStep.wrongKey")).toBe("That key doesn’t open your library. Check the 12 words and try again.");
    await setParrotLanguage("fr");
    console.info("[i18n-start] fr wrong key ->", translate("libraryKeyStep.wrongKey"));
    expect(translate("libraryKeyStep.wrongKey")).toContain("bibliothèque");
    expect(translate("libraryKeyStep.wrongKey")).not.toContain("médiathèque");
  });
});
