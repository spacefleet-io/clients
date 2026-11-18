/**
 * The Badger design on the phone: Home's hero and "See all" scopes (UX-PHONE-01), the title page's play label and
 * version chips (UX-PHONE-04), the website links of the empty library (UX-PHONE-03).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@space/mobile-shell/i18n", () => ({ getCurrentLanguage: () => "en", translate: (k: string) => k }));
vi.mock("../src/lib/downloads/planner", () => ({ selectFileTracks: () => ({ audioTracks: [], subtitleTracks: [] }) }));

vi.mock("react-native", () => ({ Platform: { OS: "android", constants: {} } }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }));
vi.mock("@space/mobile-shell/pairing", () => ({ createPairingCompletionDeps: () => ({}) }));
vi.mock("../src/lib/crypto", () => ({ decryptBase64ToBytes: () => new Uint8Array() }));
vi.mock("../src/lib/onboarding", () => ({ setLibraryKeyAcknowledged: async () => undefined, setStoredLibraryKey: async () => undefined }));

import { phoneDeviceName } from "../src/lib/phonePairing";
import { continueHeroProgress, phoneHomeLayout, seeAllTarget, unitDurationSeconds } from "../src/lib/phoneHome";
import i18next from "i18next";
import fr from "../../../../packages/mobile-shell/src/i18n/fr.json";
import en from "../../../../packages/mobile-shell/src/i18n/en.json";
import { HERO_FADE_STOPS, filmPlayLabelKey, filmRuntime, heroArtwork, versionChips } from "../src/lib/phoneDetails";
import { websiteUrl } from "@space/shared/websiteLinks";

const row = (id: string) => ({ id }) as never;

describe("phone Home", () => {
  /** @req UX-PHONE-01 */
  it("the first continue-watching title becomes the hero and leaves its row; an emptied row is dropped", () => {
    const layout = phoneHomeLayout([
      { id: "continueWatching", items: [row("a")] } as never,
      { id: "movies", items: [row("b")] } as never,
    ]);
    expect(layout.hero).toEqual({ id: "a" });
    expect(layout.rails.map((r) => r.id)).toEqual(["movies"]);
    const kept = phoneHomeLayout([{ id: "continueWatching", items: [row("a"), row("c")] } as never]);
    expect(kept.rails[0]!.items).toEqual([{ id: "c" }]);
  });

  /** @req UX-PHONE-01 @req UX-PHONE-07 */
  it("See all opens the matching Library scope, and Favorites (a playlist) the Playlists tab", () => {
    expect(seeAllTarget("shows" as never)).toEqual({ tab: "library", scope: "tv" });
    expect(seeAllTarget("favorites" as never)).toEqual({ tab: "playlists" });
    expect(seeAllTarget("movies" as never)).toEqual({ tab: "library", scope: "movies" });
    expect(seeAllTarget("recent" as never)).toEqual({ tab: "library", scope: "movies" });
  });
});

describe("phone Continue-watching hero", () => {
  const show = {
    type: "tv",
    files: [
      { id: "f1", season: 1, episode: 1 },
      { id: "f2", season: 1, episode: 2 },
    ],
    formats: [
      { fileId: "f1", durationSeconds: 1500 },
      { fileId: "f2", durationSeconds: 2700 },
    ],
  } as never;
  const e2 = { seasonNumber: 1, episodeNumber: 2 };

  /** @req UX-PHONE-01 */
  it("a show's card names the episode Resume plays and the minutes left from its saved position", () => {
    const resume = { progressPct: 90, positionSeconds: 2520, durationSeconds: 2700, updatedAt: "x" };
    expect(continueHeroProgress({ progressPct: 12 }, show, e2, resume)).toEqual({ episodeCode: "S1 E2", progressPct: 90, minutesLeft: 3 });
  });

  /** @req UX-PHONE-01 */
  it("reads only stored data, so the text is the same after a restart; percent only without any length", () => {
    const resume = { progressPct: 90, positionSeconds: 2520, durationSeconds: 2700, updatedAt: "x" };
    const first = continueHeroProgress({ progressPct: 12 }, show, e2, resume);
    expect(continueHeroProgress({ progressPct: 12 }, show, e2, { ...resume })).toEqual(first);
    // No saved length: the episode's own format length, not the whole show's longest.
    expect(unitDurationSeconds(show, { seasonNumber: 1, episodeNumber: 1 })).toBe(1500);
    expect(continueHeroProgress({ progressPct: 0 }, show, e2, { ...resume, durationSeconds: 0 }).minutesLeft).toBe(3);
    const film = { type: "movie", files: [{ id: "m" }], formats: [{ fileId: "m", durationSeconds: 6000 }] } as never;
    expect(continueHeroProgress({ progressPct: 50 }, film, null, null)).toEqual({ episodeCode: null, progressPct: 50, minutesLeft: 50 });
    expect(continueHeroProgress({ progressPct: 50 }, null, null, null).minutesLeft).toBeNull();
  });

  /** @req UX-PHONE-01 */
  it("says 1 min restante, 2 min restantes (plural rules)", async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "fr", resources: { fr: { translation: fr }, en: { translation: en } } });
    expect(i18n.t("home.hero.minutesLeft", { count: 1 })).toBe("1 min restante");
    expect(i18n.t("home.hero.minutesLeft", { count: 2 })).toBe("2 min restantes");
    expect(i18n.t("tvShell.details.watchedLeft", { count: 1, percent: 99 })).toBe("99 % vu · 1 min restante");
    await i18n.changeLanguage("en");
    expect(i18n.t("home.hero.minutesLeft", { count: 1 })).toBe("1 min left");
  });
});

describe("phone title page", () => {
  /** @req UX-PHONE-04 */
  it("a film's Play button says Play, Resume or Play again", () => {
    expect(filmPlayLabelKey(0)).toBe("details.play");
    expect(filmPlayLabelKey(40)).toBe("details.resume");
    expect(filmPlayLabelKey(97)).toBe("details.playAgain");
  });

  /** @req UX-PHONE-04 */
  it("a film shows one chip per quality, the original first, and its runtime; a show none", () => {
    const film = {
      id: "m",
      type: "movie",
      files: [{ id: "f" }],
      formats: [
        { fileId: "f", quality: "1080p", codec: "h264", codecString: "avc1", isSource: false, durationSeconds: 9180 },
        { fileId: "f", quality: "2160p", codec: "hevc", codecString: "hvc1", isSource: true, durationSeconds: 9180 },
      ],
    } as never;
    expect(versionChips(film)).toEqual(["2160p", "1080p"]);
    expect(filmRuntime(film)).toEqual({ hours: 2, minutes: 33 });
    expect(versionChips({ ...(film as object), type: "tv" } as never)).toEqual([]);
  });

  /** @req UX-PHONE-04 */
  it("the edge-to-edge hero uses the poster, the backdrop only when there is no poster", () => {
    expect(heroArtwork("poster.jpg", "backdrop.jpg")).toBe("poster.jpg");
    expect(heroArtwork(null, "backdrop.jpg")).toBe("backdrop.jpg");
    expect(heroArtwork(null, null)).toBeNull();
  });

  /** @req UX-PHONE-04 */
  it("the hero fades out to see-through at its bottom edge, so it melts into the sky with no band", () => {
    console.log("hero fade stops", JSON.stringify(HERO_FADE_STOPS));
    expect(HERO_FADE_STOPS[0]).toEqual({ offset: 0, opacity: 1 });
    expect(HERO_FADE_STOPS.at(-1)).toEqual({ offset: 1, opacity: 0 });
    for (let i = 1; i < HERO_FADE_STOPS.length; i += 1) {
      expect(HERO_FADE_STOPS[i].offset).toBeGreaterThan(HERO_FADE_STOPS[i - 1].offset);
      expect(HERO_FADE_STOPS[i].opacity).toBeLessThanOrEqual(HERO_FADE_STOPS[i - 1].opacity);
    }
  });
});

describe("empty library links", () => {
  /** @req UX-PHONE-03 */
  it("point at the website in the app's language, English otherwise", () => {
    expect(websiteUrl("downloads", "fr")).toBe("https://spacebadger.io/fr/downloads");
    expect(websiteUrl("downloads", "es")).toBe("https://spacebadger.io/es/downloads");
    expect(websiteUrl("downloads", "pt")).toBe("https://spacebadger.io/en/downloads");
  });
});

describe("phone sign-in with a code", () => {
  /** @req UX-PHONE-05 @req ACCT-PAIR-01[badger-mobile] */
  it("the phone asks to be added as Badger on its model, so the approver sees which app asks", () => {
    expect(phoneDeviceName("Pixel 8")).toBe("Badger (Pixel 8)");
    expect(phoneDeviceName("  ")).toBe("Badger (phone)");
    expect(phoneDeviceName(null)).toBe("Badger (phone)");
  });
});
