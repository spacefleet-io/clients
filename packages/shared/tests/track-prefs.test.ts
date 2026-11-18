/**
 * @req PLAY-TRACK-04
 *
 * Pure logic of the synced per-media audio/subtitle preference
 * (`track_prefs_v1:<mediaId>` setting): parsing, per-field merge, language
 * normalisation (library tracks carry ISO 639-2 like `eng`/`fre`, the app
 * stores 639-1) and the prefs -> default-settings resolution a player runs on
 * playback start.
 */
import { describe, expect, it } from "vitest";
import {
  TRACK_PREFS_KEY_PREFIX,
  languagesMatch,
  mergeTrackPrefs,
  normalizeLanguageCode,
  parseTrackPrefs,
  resolveTrackSelection,
  serializeTrackPrefs,
  trackPrefsKey,
} from "../src/trackPrefs";

const NOW = "2026-10-16T12:00:00.000Z";

describe("track prefs (PLAY-TRACK-04)", () => {
  it("@req PLAY-TRACK-04 keys the record by the movie or show id", () => {
    expect(TRACK_PREFS_KEY_PREFIX).toBe("track_prefs_v1:");
    expect(trackPrefsKey("show-1")).toBe("track_prefs_v1:show-1");
  });

  it("@req PLAY-TRACK-04 normalises 639-2 and region codes to 639-1", () => {
    console.info("[track-prefs:normalize] eng/fre/fra/en-US/JPN/und/''");
    expect(normalizeLanguageCode("eng")).toBe("en");
    expect(normalizeLanguageCode("fre")).toBe("fr");
    expect(normalizeLanguageCode("fra")).toBe("fr");
    expect(normalizeLanguageCode("en-US")).toBe("en");
    expect(normalizeLanguageCode(" JPN ")).toBe("ja");
    expect(normalizeLanguageCode("xx")).toBe("xx");
    expect(normalizeLanguageCode("und")).toBeNull();
    expect(normalizeLanguageCode("")).toBeNull();
    expect(languagesMatch("eng", "en")).toBe(true);
    expect(languagesMatch("fre", "de")).toBe(false);
    expect(languagesMatch("und", "und")).toBe(false);
  });

  it("@req PLAY-TRACK-04 parses the contract JSON and rejects malformed values", () => {
    const raw = JSON.stringify({ audioLanguage: "fr", subtitle: { language: "en", format: "srt", forced: false }, updatedAt: NOW, future: 1 });
    const parsed = parseTrackPrefs(raw);
    expect(parsed).toEqual({ audioLanguage: "fr", subtitle: { language: "en", format: "srt", forced: false }, updatedAt: NOW, future: 1 });
    expect(parseTrackPrefs(JSON.stringify({ audioLanguage: null, subtitle: "off", updatedAt: NOW }))?.subtitle).toBe("off");
    expect(parseTrackPrefs(JSON.stringify({ audioLanguage: null, subtitle: null, updatedAt: NOW }))?.subtitle).toBeNull();
    expect(parseTrackPrefs(null)).toBeNull();
    expect(parseTrackPrefs("not json")).toBeNull();
    expect(parseTrackPrefs(JSON.stringify({ audioLanguage: 3, subtitle: null, updatedAt: NOW }))).toBeNull();
    expect(parseTrackPrefs(JSON.stringify({ audioLanguage: null, subtitle: { format: "srt" }, updatedAt: NOW }))).toBeNull();
    expect(parseTrackPrefs(JSON.stringify({ audioLanguage: null, subtitle: null }))).toBeNull();
  });

  it("@req PLAY-TRACK-04 a patch changes only the field it names and keeps unknown fields", () => {
    const first = mergeTrackPrefs(null, { audioLanguage: "eng" }, NOW);
    expect(first).toEqual({ audioLanguage: "en", subtitle: null, updatedAt: NOW });
    const withSub = mergeTrackPrefs({ ...first, future: "keep" }, { subtitle: { language: "fre", forced: true } }, "2026-10-16T12:00:01.000Z");
    expect(withSub).toEqual({
      audioLanguage: "en",
      subtitle: { language: "fr", forced: true },
      updatedAt: "2026-10-16T12:00:01.000Z",
      future: "keep",
    });
    const off = mergeTrackPrefs(withSub, { subtitle: "off" }, NOW);
    expect(off.subtitle).toBe("off");
    expect(off.audioLanguage).toBe("en");
    const cleared = mergeTrackPrefs(off, { audioLanguage: null, subtitle: null }, NOW);
    expect(cleared.audioLanguage).toBeNull();
    expect(cleared.subtitle).toBeNull();
    expect(parseTrackPrefs(serializeTrackPrefs(withSub))).toEqual(withSub);
  });

  const audio = [
    { id: "a-en", language: "eng", isDefault: true },
    { id: "a-fr", language: "fre", isDefault: false },
  ];
  const subs = [
    { id: "s-en", language: "eng", format: "srt", forced: false },
    { id: "s-en-forced", language: "eng", format: "srt", forced: true },
    { id: "s-fr", language: "fre", format: "vtt" },
  ];

  it("@req PLAY-TRACK-04 picks the remembered audio language across 639-1/639-2 spellings", () => {
    const prefs = mergeTrackPrefs(null, { audioLanguage: "fr" }, NOW);
    const sel = resolveTrackSelection({ prefs, audioTracks: audio, subtitleTracks: subs });
    expect(sel.audioTrackId).toBe("a-fr");
    expect(sel.audioSource).toBe("prefs");
  });

  it("@req PLAY-TRACK-04 next episode without the remembered audio falls back to the default language setting, then to no choice", () => {
    const prefs = mergeTrackPrefs(null, { audioLanguage: "ja" }, NOW);
    const viaDefaults = resolveTrackSelection({ prefs, defaults: { audioLanguage: "fr" }, audioTracks: audio, subtitleTracks: subs });
    expect(viaDefaults.audioTrackId).toBe("a-fr");
    expect(viaDefaults.audioSource).toBe("defaults");
    const none = resolveTrackSelection({ prefs, audioTracks: audio, subtitleTracks: subs });
    expect(none.audioTrackId).toBeNull();
    expect(none.audioSource).toBe("none");
    expect(resolveTrackSelection({ prefs: null, audioTracks: audio, subtitleTracks: subs }).audioTrackId).toBeNull();
  });

  it("@req PLAY-TRACK-04 remembered Off holds; remembered language picks the matching track, preferring same forced then same format", () => {
    const off = resolveTrackSelection({ prefs: mergeTrackPrefs(null, { subtitle: "off" }, NOW), audioTracks: audio, subtitleTracks: subs });
    expect(off.subtitle).toEqual({ mode: "off", source: "prefs" });
    const forced = resolveTrackSelection({
      prefs: mergeTrackPrefs(null, { subtitle: { language: "en", forced: true } }, NOW),
      audioTracks: audio,
      subtitleTracks: subs,
    });
    expect(forced.subtitle).toEqual({ mode: "track", id: "s-en-forced", source: "prefs" });
    const plain = resolveTrackSelection({
      prefs: mergeTrackPrefs(null, { subtitle: { language: "en" } }, NOW),
      audioTracks: audio,
      subtitleTracks: subs,
    });
    expect(plain.subtitle).toEqual({ mode: "track", id: "s-en", source: "prefs" });
  });

  it("@req PLAY-TRACK-04 a subtitle the next episode lacks falls back to the default setting, else the library default", () => {
    const prefs = mergeTrackPrefs(null, { subtitle: { language: "ja" } }, NOW);
    const viaDefaults = resolveTrackSelection({ prefs, defaults: { subtitle: { language: "fr" } }, audioTracks: audio, subtitleTracks: subs });
    expect(viaDefaults.subtitle).toEqual({ mode: "track", id: "s-fr", source: "defaults" });
    const defaultOff = resolveTrackSelection({ prefs, defaults: { subtitle: "off" }, audioTracks: audio, subtitleTracks: subs });
    expect(defaultOff.subtitle).toEqual({ mode: "off", source: "defaults" });
    const library = resolveTrackSelection({ prefs, audioTracks: audio, subtitleTracks: subs });
    expect(library.subtitle).toEqual({ mode: "default" });
  });
});

// @bugfix default-subs-lang (Chris 2026-11-12, Coco): English picked in the player, then Settings "Subtitle language"
// set to French; the next play of Coco still started in English. A default changed after the title's last choice wins.
// @regression-proof
describe("a subtitle language changed after the title's choice wins (PLAY-TRACK-11)", () => {
  const T = "[track-prefs][PLAY-TRACK-11]";
  const PICKED_AT = "2026-11-12T20:00:00.000Z";
  const SETTINGS_AT = "2026-11-12T20:05:00.000Z";
  const audio = [{ id: "a-en", language: "eng" }];
  const subs = [
    { id: "s-en", language: "eng", format: "srt" },
    { id: "s-fr", language: "fre", format: "srt" },
  ];
  const english = mergeTrackPrefs(null, { subtitle: { language: "en", format: "srt" } }, PICKED_AT);

  it("@req PLAY-TRACK-11 Settings changed to French after English was picked: French starts", () => {
    const sel = resolveTrackSelection({ prefs: english, defaults: { subtitle: { language: "fr" }, subtitleSetAt: SETTINGS_AT }, audioTracks: audio, subtitleTracks: subs });
    console.info(`${T} picked=${PICKED_AT} settings=${SETTINGS_AT} sel=${JSON.stringify(sel.subtitle)}`);
    expect(sel.subtitle).toEqual({ mode: "track", id: "s-fr", source: "defaults" });
  });

  it("@req PLAY-TRACK-11 English picked after Settings changed to French: English starts", () => {
    const sel = resolveTrackSelection({ prefs: english, defaults: { subtitle: { language: "fr" }, subtitleSetAt: "2026-11-12T19:00:00.000Z" }, audioTracks: audio, subtitleTracks: subs });
    console.info(`${T} default older sel=${JSON.stringify(sel.subtitle)}`);
    expect(sel.subtitle).toEqual({ mode: "track", id: "s-en", source: "prefs" });
  });

  it("@req PLAY-TRACK-11 a newer default turns on subtitles the title had turned Off", () => {
    const off = mergeTrackPrefs(null, { subtitle: "off" }, PICKED_AT);
    const sel = resolveTrackSelection({ prefs: off, defaults: { subtitle: { language: "fr" }, subtitleSetAt: SETTINGS_AT }, audioTracks: audio, subtitleTracks: subs });
    console.info(`${T} off then fr sel=${JSON.stringify(sel.subtitle)}`);
    expect(sel.subtitle).toEqual({ mode: "track", id: "s-fr", source: "defaults" });
  });

  it("@req PLAY-TRACK-11 a newer default the file lacks, or No preference, keeps the title's choice", () => {
    const enOnly = subs.filter((track) => track.id === "s-en");
    const lacking = resolveTrackSelection({ prefs: english, defaults: { subtitle: { language: "fr" }, subtitleSetAt: SETTINGS_AT }, audioTracks: audio, subtitleTracks: enOnly });
    const none = resolveTrackSelection({ prefs: english, defaults: { subtitle: null, subtitleSetAt: SETTINGS_AT }, audioTracks: audio, subtitleTracks: subs });
    const unknownTime = resolveTrackSelection({ prefs: english, defaults: { subtitle: { language: "fr" } }, audioTracks: audio, subtitleTracks: subs });
    console.info(`${T} lacking=${JSON.stringify(lacking.subtitle)} none=${JSON.stringify(none.subtitle)} unknownTime=${JSON.stringify(unknownTime.subtitle)}`);
    expect(lacking.subtitle).toEqual({ mode: "track", id: "s-en", source: "prefs" });
    expect(none.subtitle).toEqual({ mode: "track", id: "s-en", source: "prefs" });
    expect(unknownTime.subtitle).toEqual({ mode: "track", id: "s-en", source: "prefs" });
  });
});
