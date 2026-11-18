/**
 * @test-id PARROT-MOBILE-PHONE-DESIGN-001
 * @level unit
 * @req PAR-HOME-01[parrot]
 * @req PAR-NAV-02[parrot]
 * @why The phone's Home and Playlists: Home reads this phone's own listening history (a new song
 *   counts a play, the same song moves its position, a song without an album changes nothing); "Liked songs" always
 *   comes first among the playlists, even before the library has any; and the texts every Parrot surface shares are
 *   read under `shell.` with i18next placeholders. The Library's search is the shared one (packages/parrot-core).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
vi.mock("@space/mobile-shell/i18n", () => ({ addAppTranslations: () => undefined, changeLanguage: async () => undefined, initI18n: async () => undefined, isMobileUiLanguage: () => true }));
vi.mock("@space/mobile-shell/i18n/deviceLanguage", () => ({ pickStartLanguage: () => "en", readDeviceLocale: () => "en" }));

import { emptyHistory } from "@space/parrot-core";
import { historyStep } from "../src/lib/history";
import { PARROT_LIKED_PLAYLIST_ID as LIKED_PLAYLIST_ID } from "@space/parrot-core";
import { phonePlaylists } from "../src/lib/playlists";
import { shellTree, PARROT_TRANSLATIONS } from "../src/lib/i18n";

const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-PHONE-DESIGN-001] ${step}`, JSON.stringify(detail));

describe("Home's listening history on the phone", () => {
  const titles = new Map([
    ["t1", { title: "One", artist: "Nova", album: "Low Orbit", albumId: "al-1", artistId: "ar-1" }],
    ["t2", { title: "Two", artist: "Nova", album: "Low Orbit", albumId: "al-1", artistId: "ar-1" }],
    ["t9", { title: "Loose", artist: "", album: "", albumId: "" }],
  ]);

  it("counts a play when a new song starts and keeps the position while it plays", () => {
    const started = historyStep(emptyHistory(), null, { mediaId: "t1", positionMs: 0, playing: true }, titles, 1000);
    const moved = historyStep(started, "t1", { mediaId: "t1", positionMs: 42_000, playing: true }, titles, 6000);
    const next = historyStep(moved, "t1", { mediaId: "t2", positionMs: 0, playing: true }, titles, 9000);
    log("history", { started, moved, next });
    expect(started.albums[0]).toMatchObject({ albumId: "al-1", trackId: "t1" });
    expect(started.artistPlays).toEqual({ "ar-1": 1 });
    expect(moved.albums[0]).toMatchObject({ trackId: "t1", positionMs: 42_000 });
    expect(next.albums[0]).toMatchObject({ trackId: "t2" });
    expect(next.artistPlays).toEqual({ "ar-1": 2 });
  });

  it("changes nothing for a song without an album, or with nothing queued", () => {
    const history = emptyHistory();
    expect(historyStep(history, null, { mediaId: "t9", positionMs: 0, playing: true }, titles, 1)).toBe(history);
    expect(historyStep(history, null, { mediaId: null, positionMs: 0, playing: false }, titles, 1)).toBe(history);
  });
});

describe("the playlists", () => {
  it("put Liked songs first, then the others by name, and show Liked songs even before any playlist exists", () => {
    const row = (id: string, name: string, createdAt = 1) => ({ id, name, createdAt, updatedAt: createdAt });
    const ordered = phonePlaylists([row("p2", "road trip"), row(LIKED_PLAYLIST_ID, "Liked songs"), row("p1", "Evening")], [
      { playlistId: LIKED_PLAYLIST_ID, trackId: "t1" },
      { playlistId: "p1", trackId: "t2" },
    ]);
    log("playlists", ordered);
    expect(ordered.map((playlist) => playlist.id)).toEqual([LIKED_PLAYLIST_ID, "p1", "p2"]);
    expect(ordered[0]).toMatchObject({ trackIds: ["t1"], trackCount: 1 });
    expect(phonePlaylists([], []).map((playlist) => playlist.id)).toEqual([LIKED_PLAYLIST_ID]);
  });
});

describe("the shared Parrot texts", () => {
  it("nest under shell. with i18next placeholders, in all five languages", () => {
    const tree = shellTree({ "home.resume": "Resume {time}", "nav.home": "Home" });
    expect(tree).toEqual({ home: { resume: "Resume {{time}}" }, nav: { home: "Home" } });
    for (const language of ["en", "fr", "nl", "de", "es"] as const) {
      const shell = PARROT_TRANSLATIONS[language].shell as { home: { resume: string } };
      log("resume", { language, text: shell.home.resume });
      expect(shell.home.resume).toContain("{{time}}");
    }
  });
});
