/**
 * @test-id MOBILE-PLAYER-TOO-WEAK-NOTICE-001
 * @level unit
 *
 * The "this phone isn't powerful enough" notice (D2, PLAY-CODEC-03): its words come from the translation files (UX-I18N-02),
 * in English and accented French (UX-I18N-03), in plain language with no codec names, and the player screen raises it from
 * the controller's `too-weak` action, logs `playback.device.too_weak`, and dismisses it with "Keep watching".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../../../packages/mobile-shell/src/i18n/en.json";
import fr from "../../../../packages/mobile-shell/src/i18n/fr.json";
import nl from "../../../../packages/mobile-shell/src/i18n/nl.json";
import de from "../../../../packages/mobile-shell/src/i18n/de.json";

const read = (relative: string) => readFileSync(resolve(__dirname, "..", relative), "utf8");

describe("device too weak notice", () => {
  /** @req PLAY-CODEC-03 @req UX-I18N-01 */
  it("has English and French text, plain language, no codec words", () => {
    const messages = [en.player.deviceTooWeak.message, fr.player.deviceTooWeak.message];
    console.info(`[too-weak] en: ${en.player.deviceTooWeak.message} / ${en.player.deviceTooWeak.keepWatching}`);
    console.info(`[too-weak] fr: ${fr.player.deviceTooWeak.message} / ${fr.player.deviceTooWeak.keepWatching}`);
    expect(en.player.deviceTooWeak.message).toMatch(/isn't powerful enough/);
    expect(en.player.deviceTooWeak.keepWatching).toBe("Keep watching");
    for (const text of [...messages, en.player.deviceTooWeak.keepWatching, fr.player.deviceTooWeak.keepWatching]) {
      expect(text).not.toMatch(/hevc|h\.?26[45]|codec|decod|1080|2160|bitrate|mpv/i);
    }
  });

  /** @req PLAY-QUAL-03[badger-mobile,badger-tv] @req PLAY-CODEC-03 */
  it("the Force hint names the setting and the way out, in plain language, in both languages", () => {
    console.info(`[too-weak] en hint: ${en.player.deviceTooWeak.pinnedHint}`);
    console.info(`[too-weak] fr hint: ${fr.player.deviceTooWeak.pinnedHint}`);
    expect(en.player.deviceTooWeak.pinnedHint).toMatch(/Force this quality/);
    expect(en.player.deviceTooWeak.pinnedHint).toMatch(/lower quality/);
    expect(fr.player.deviceTooWeak.pinnedHint).toMatch(/Forcer cette qualité/);
    expect(fr.player.deviceTooWeak.pinnedHint).toMatch(/Réglages/);
    for (const text of [en.player.deviceTooWeak.pinnedHint, fr.player.deviceTooWeak.pinnedHint]) {
      expect(text).not.toMatch(/hevc|h\.?26[45]|codec|decod|1080|2160|bitrate|mpv/i);
    }
  });

  /** @req UX-I18N-03 */
  it("French text is accented", () => {
    expect(fr.player.deviceTooWeak.message).toContain("téléphone");
    expect(fr.player.deviceTooWeak.keepWatching).toContain("à");
  });

  /** @req PLAY-CODEC-03[badger-tv] */
  it("a TV says TV box, never phone, in every language", () => {
    const tv = { en: en.player.deviceTooWeak.messageTv, fr: fr.player.deviceTooWeak.messageTv, nl: nl.player.deviceTooWeak.messageTv, de: de.player.deviceTooWeak.messageTv };
    console.info(`[too-weak] tv: ${JSON.stringify(tv)}`);
    expect(tv.en).toMatch(/TV box isn't powerful enough/);
    expect(tv.fr).toMatch(/boîtier TV/);
    expect(tv.nl).toMatch(/tv-kastje/);
    expect(tv.de).toMatch(/TV-Box/);
    for (const text of Object.values(tv)) {
      expect(text).not.toMatch(/phone|téléphone|telefoon|Handy|hevc|h\.?26[45]|codec|decod|1080|2160|bitrate|mpv/i);
    }
  });

  /** @req PLAY-CODEC-03 */
  it("the player raises it from the controller action, logs it, and Keep watching dismisses it", () => {
    const screen = read("src/screens/PlayerScreen.tsx");
    expect(screen).toContain('action.kind === "too-weak"');
    expect(screen).toContain('"playback.device.too_weak"');
    expect(screen).toContain("setTooWeak({ pinned: action.pinned })");
    expect(screen).toContain("<DeviceTooWeakNotice");
    expect(screen).toContain("pinned={tooWeak.pinned}");
    expect(screen).toContain("setTooWeak(null)");
  });
});
