/**
 * @test-id MOBILE-DL-LABELS-001
 * @level unit
 * @why The native download notifications (Android progress notification and channel, iOS completion and failure
 *   notifications) cannot read the app's translation files, so the app hands them their text in the app language
 *   through `configure` (UX-I18N-02). Every label must be translated in each app language and keep the `{count}`
 *   and `{percent}` tokens the native code replaces; the Android progress text ("28%") must follow the app language,
 *   not the phone's (French writes "28 %").
 */
import { describe, expect, it } from "vitest";
import { changeLanguage, initI18n, MOBILE_UI_LANGUAGES, translate } from "@space/mobile-shell/i18n";
import { downloadNotificationLabels } from "@space/mobile-media-proxy/downloads";

describe("download notification labels", () => {
  /** @req UX-I18N-02[badger-mobile] */
  it("gives native code every notification text in the app language", async () => {
    await initI18n("en");
    const english = downloadNotificationLabels(translate);
    console.info(`[MOBILE-DL-LABELS-001] en=${JSON.stringify(english)}`);
    expect(english.activeItems).toBe("Downloading {count} items");
    expect(english.completed).toBe("Download complete");
    expect(english.percent).toBe("{percent}%");

    for (const { code } of MOBILE_UI_LANGUAGES.filter((option) => option.code !== "en")) {
      await changeLanguage(code);
      const labels = downloadNotificationLabels(translate);
      console.info(`[MOBILE-DL-LABELS-001] ${code}=${JSON.stringify(labels)}`);
      const entries = Object.entries(labels);
      expect(entries.every(([, value]) => value.trim().length > 0 && !value.includes("downloads."))).toBe(true);
      expect(labels.activeItems).toContain("{count}");
      expect(labels.activeItems).not.toBe(english.activeItems);
      expect(labels.completed).not.toBe(english.completed);
      expect(labels.waitingWifi).not.toBe(english.waitingWifi);
      expect(labels.insufficientSpace).not.toBe(english.insufficientSpace);
      expect(labels.percent.replace("{percent}", "28"), `${code} percent text`).toMatch(/^28\s?%$/);
    }
    await changeLanguage("fr");
    expect(downloadNotificationLabels(translate).percent).toBe("{percent} %");
    await changeLanguage("en");
  });
});
