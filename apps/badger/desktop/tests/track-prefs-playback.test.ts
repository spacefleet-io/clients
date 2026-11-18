/**
 * @req PLAY-TRACK-04
 *
 * Desktop side of the synced per-media track memory:
 *  - play start applies the remembered audio/subtitle of the movie or SHOW
 *    (next episode keeps the tracks when it has them, else the profile's
 *    "Default audio language" when the file has it (PLAY-TRACK-01), else the
 *    library default);
 *  - an mpv OSC pick becomes a prefs patch for that movie/show.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AudioTrack, SubtitleTrack } from "@/lib/libraryDb";
import { mergeTrackPrefs } from "@space/shared/trackPrefs";
import {
  resolvePlaybackAudioState,
  resolvePlaybackStartTracks,
} from "../src/renderer/src/lib/mpvPlaybackSelection";
import { trackPrefsPatchForPick } from "../src/renderer/src/lib/oscTrackPicks";

const TAG = "[track-prefs-playback]";
const NOW = "2026-10-16T12:00:00.000Z";

const audio = (fields: Pick<AudioTrack, "id" | "language" | "isDefault" | "episodeId">): AudioTrack =>
  ({
    mediaId: "show-1",
    fileId: null,
    label: fields.language,
    source: "ingest",
    codec: null,
    initKey: `init-${fields.id}`,
    initSize: null,
    durationSeconds: null,
    totalSize: null,
    chunks: [{ key: `${fields.id}-1`, sizeBytes: 1, startSeconds: 0 }],
    ...fields,
  }) as AudioTrack;

const sub = (fields: Pick<SubtitleTrack, "id" | "language" | "isDefault" | "episodeId"> & Partial<SubtitleTrack>): SubtitleTrack =>
  ({
    mediaId: "show-1",
    fileId: null,
    label: fields.language,
    objectKey: `obj-${fields.id}`,
    format: "srt",
    source: "ingest",
    createdAt: NOW,
    ...fields,
  }) as SubtitleTrack;

const ep1Audio = [audio({ id: "e1-en", language: "eng", isDefault: true, episodeId: "ep-1" }), audio({ id: "e1-fr", language: "fre", isDefault: false, episodeId: "ep-1" })];
const ep1Subs = [sub({ id: "e1-sub-en", language: "eng", isDefault: true, episodeId: "ep-1" }), sub({ id: "e1-sub-fr", language: "fre", isDefault: false, episodeId: "ep-1" })];
// Episode 2 only has English audio and no subtitles at all.
const ep2Audio = [audio({ id: "e2-en", language: "eng", isDefault: true, episodeId: "ep-2" })];

describe("play start applies the remembered tracks (PLAY-TRACK-04)", () => {
  it("@req PLAY-TRACK-04 remembered French audio + Off beat the library default tracks", () => {
    const prefs = mergeTrackPrefs(mergeTrackPrefs(null, { audioLanguage: "fr" }, NOW), { subtitle: "off" }, NOW);
    const start = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs });
    console.info(`${TAG} start(prefs fr + off)=${JSON.stringify(start)}`);
    expect(start).toEqual({ audioDefault: "e1-fr", audioSource: "prefs", subDefault: "off", subtitlesOffRemembered: true });
  });

  it("@req PLAY-TRACK-04 remembered subtitle language selects that track", () => {
    const prefs = mergeTrackPrefs(null, { subtitle: { language: "fr" } }, NOW);
    const start = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs });
    expect(start).toEqual({ audioDefault: "e1-en", audioSource: "none", subDefault: "e1-sub-fr", subtitlesOffRemembered: false });
  });

  it("@req PLAY-TRACK-04 no record, or tracks the episode lacks, fall back to the library default", () => {
    const none = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs: null });
    expect(none).toEqual({ audioDefault: "e1-en", audioSource: "none", subDefault: "e1-sub-en", subtitlesOffRemembered: false });
    const prefs = mergeTrackPrefs(mergeTrackPrefs(null, { audioLanguage: "fr" }, NOW), { subtitle: { language: "fr" } }, NOW);
    const next = resolvePlaybackStartTracks({ audioTracks: ep2Audio, subtitleTracks: [], episodeId: "ep-2", prefs });
    console.info(`${TAG} next episode lacking fr=${JSON.stringify(next)}`);
    expect(next).toEqual({ audioDefault: "e2-en", audioSource: "none", subDefault: "off", subtitlesOffRemembered: false });
  });

  it("@req PLAY-TRACK-04 the audio resolver matches the remembered language across eng/en spellings", () => {
    const resolved = resolvePlaybackAudioState({
      audioTracks: ep1Audio,
      preferredAudioLanguage: "fr",
      episodeId: "ep-1",
      selectedAudioId: null,
    });
    expect(resolved.selectedAudioId).toBe("e1-fr");
  });
});

// ACCT-SQUAD-03: the subtitle language is a profile setting. A title with no
// remembered subtitle starts in it when the file has that language.
describe("play start falls back to the profile's subtitle language (ACCT-SQUAD-03)", () => {
  const T = `${TAG}[default-subtitle]`;

  it("@req ACCT-SQUAD-03[badger-desktop] no remembered subtitle: starts in the profile's subtitle language", () => {
    console.info(`${T} phase=no-prefs default=fr`);
    const start = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs: null, defaults: { subtitle: { language: "fr" } } });
    console.info(`${T} start=${JSON.stringify(start)}`);
    expect(start).toMatchObject({ subDefault: "e1-sub-fr", subtitlesOffRemembered: false });
  });

  it("@req ACCT-SQUAD-03[badger-desktop] the title's remembered subtitle beats the profile's language", () => {
    const off = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs: mergeTrackPrefs(null, { subtitle: "off" }, NOW), defaults: { subtitle: { language: "fr" } } });
    const en = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs: mergeTrackPrefs(null, { subtitle: { language: "en" } }, NOW), defaults: { subtitle: { language: "fr" } } });
    console.info(`${T} off=${JSON.stringify(off)} en=${JSON.stringify(en)}`);
    expect(off).toMatchObject({ subDefault: "off", subtitlesOffRemembered: true });
    expect(en).toMatchObject({ subDefault: "e1-sub-en" });
  });

  it("@req ACCT-SQUAD-03[badger-desktop] no preference, or a language the file lacks, keeps the file's default subtitle", () => {
    const none = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs: null, defaults: { subtitle: null } });
    const missing = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs: null, defaults: { subtitle: { language: "de" } } });
    console.info(`${T} none=${JSON.stringify(none)} missing(de)=${JSON.stringify(missing)}`);
    expect(none).toMatchObject({ subDefault: "e1-sub-en" });
    expect(missing).toMatchObject({ subDefault: "e1-sub-en" });
  });
});

// @bugfix default-subs-lang (Chris 2026-11-12, Coco): English subtitles picked in the player, then Settings
// "Subtitle language" set to French; reopening Coco still started in English because the title's remembered
// choice always beat the profile's language, whatever was changed last. @regression-proof
describe("a subtitle language changed after the title's choice wins (PLAY-TRACK-11)", () => {
  const T = `${TAG}[newer-default-subtitle]`;
  const PICKED_AT = "2026-11-12T20:00:00.000Z";
  const SETTINGS_AT = "2026-11-12T20:05:00.000Z";
  const english = mergeTrackPrefs(null, { subtitle: { language: "en", format: "srt" } }, PICKED_AT);

  it("@req PLAY-TRACK-11[badger-desktop] Coco: English picked, then Settings set to French, starts in French", () => {
    const start = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs: english, defaults: { subtitle: { language: "fr" }, subtitleSetAt: SETTINGS_AT } });
    console.info(`${T} picked=${PICKED_AT} settings=${SETTINGS_AT} start=${JSON.stringify(start)}`);
    expect(start).toMatchObject({ subDefault: "e1-sub-fr", subtitlesOffRemembered: false });
  });

  it("@req PLAY-TRACK-11[badger-desktop] English picked after the French setting keeps English; no French track keeps English", () => {
    const older = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: ep1Subs, episodeId: "ep-1", prefs: english, defaults: { subtitle: { language: "fr" }, subtitleSetAt: "2026-11-12T19:00:00.000Z" } });
    const noFrench = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: [ep1Subs[0]!], episodeId: "ep-1", prefs: english, defaults: { subtitle: { language: "fr" }, subtitleSetAt: SETTINGS_AT } });
    console.info(`${T} older=${JSON.stringify(older)} noFrench=${JSON.stringify(noFrench)}`);
    expect(older).toMatchObject({ subDefault: "e1-sub-en" });
    expect(noFrench).toMatchObject({ subDefault: "e1-sub-en" });
  });

  it("@req PLAY-TRACK-11[badger-desktop] the controller passes when the profile's subtitle language was changed", () => {
    const controller = readFileSync(resolve(process.cwd(), "src/renderer/src/components/MediaPlaybackController.tsx"), "utf8");
    const context = readFileSync(resolve(process.cwd(), "src/renderer/src/lib/libraryContext.tsx"), "utf8");
    const call = controller.slice(controller.indexOf("resolvePlaybackStartTracks({"), controller.indexOf("resolvePlaybackStartTracks({") + 400);
    console.info(`${T} controller call=${JSON.stringify(call)}`);
    expect(controller).toMatch(/getActiveProfileSettingsRef\.current\?\.\(\)\?\.fieldUpdatedAt\?\.subtitleLanguage/);
    expect(call).toMatch(/subtitleSetAt,/);
    // The saved profile row reaches the player's settings map right away, not at the next snapshot refresh.
    expect(context).toMatch(/const result = await db\.setSetting\(key, value, updatedAt\);\s*setSettingsMap/);
  });
});

// #459: desktop had no "Default audio language", so a title with no remembered
// audio (or a next episode lacking it) always started on the library default.
describe("play start falls back to the profile's default audio language (PLAY-TRACK-01, PLAY-TRACK-04)", () => {
  const T = `${TAG}[default-audio]`;
  // Episode 3: Japanese original (library default), English and French dubs.
  const ep3Audio = [
    audio({ id: "e3-ja", language: "jpn", isDefault: true, episodeId: "ep-3" }),
    audio({ id: "e3-en", language: "eng", isDefault: false, episodeId: "ep-3" }),
    audio({ id: "e3-fr", language: "fre", isDefault: false, episodeId: "ep-3" }),
  ];

  it("@req PLAY-TRACK-01[badger-desktop] no remembered audio: starts in the default audio language when the file has it", () => {
    console.info(`${T} phase=no-prefs default=fr`);
    const start = resolvePlaybackStartTracks({ audioTracks: ep3Audio, subtitleTracks: [], episodeId: "ep-3", prefs: null, defaults: { audioLanguage: "fr" } });
    console.info(`${T} start=${JSON.stringify(start)}`);
    expect(start).toMatchObject({ audioDefault: "e3-fr", audioSource: "defaults" });
  });

  it("@req PLAY-TRACK-01[badger-desktop] Original (null) or a language the file lacks keeps the file's own default track", () => {
    const original = resolvePlaybackStartTracks({ audioTracks: ep3Audio, subtitleTracks: [], episodeId: "ep-3", prefs: null, defaults: { audioLanguage: null } });
    const missing = resolvePlaybackStartTracks({ audioTracks: ep3Audio, subtitleTracks: [], episodeId: "ep-3", prefs: null, defaults: { audioLanguage: "de" } });
    console.info(`${T} original=${JSON.stringify(original)} missing(de)=${JSON.stringify(missing)}`);
    expect(original).toMatchObject({ audioDefault: "e3-ja", audioSource: "none" });
    expect(missing).toMatchObject({ audioDefault: "e3-ja", audioSource: "none" });
  });

  it("@req PLAY-TRACK-04[badger-desktop] the title's remembered audio beats the default language", () => {
    const prefs = mergeTrackPrefs(null, { audioLanguage: "en" }, NOW);
    const start = resolvePlaybackStartTracks({ audioTracks: ep3Audio, subtitleTracks: [], episodeId: "ep-3", prefs, defaults: { audioLanguage: "fr" } });
    console.info(`${T} prefs=en default=fr start=${JSON.stringify(start)}`);
    expect(start).toMatchObject({ audioDefault: "e3-en", audioSource: "prefs" });
  });

  it("@req PLAY-TRACK-04[badger-desktop] a next episode without the remembered audio falls back to the default language settings", () => {
    // Remembered Spanish (picked on an earlier episode); episode 3 has no Spanish track.
    const prefs = mergeTrackPrefs(null, { audioLanguage: "es" }, NOW);
    console.info(`${T} phase=next-episode prefs=es default=fr`);
    const start = resolvePlaybackStartTracks({ audioTracks: ep3Audio, subtitleTracks: [], episodeId: "ep-3", prefs, defaults: { audioLanguage: "fr" } });
    console.info(`${T} start=${JSON.stringify(start)}`);
    expect(start).toMatchObject({ audioDefault: "e3-fr", audioSource: "defaults" });
  });

  it("@req PLAY-TRACK-01[badger-desktop] @req PLAY-TRACK-04[badger-desktop] @req ACCT-SQUAD-03[badger-desktop] the controller passes the profile's default audio and subtitle languages at play start", () => {
    const controller = readFileSync(resolve(process.cwd(), "src/renderer/src/components/MediaPlaybackController.tsx"), "utf8");
    const call = controller.slice(controller.indexOf("resolvePlaybackStartTracks({"), controller.indexOf("resolvePlaybackStartTracks({") + 400);
    console.info(`${T} controller call=${JSON.stringify(call)}`);
    expect(controller).toMatch(/defaultAudioLanguageRef\.current = clientConfig\.defaultAudioLanguage/);
    expect(controller).toMatch(/defaultSubtitleLanguageRef\.current = clientConfig\.defaultSubtitleLanguage/);
    expect(call).toMatch(/audioLanguage: defaultAudioLanguage,/);
    expect(call).toMatch(/subtitle: defaultSubtitleLanguage \? \{ language: defaultSubtitleLanguage \} : null/);
  });
});

describe("an OSC pick becomes a prefs patch (PLAY-TRACK-04)", () => {
  const trackList = [
    { id: 1, type: "audio", lang: "eng" },
    { id: 2, type: "audio", lang: "fre" },
    { id: 3, type: "sub", lang: "fre" },
    { id: 4, type: "sub", lang: "ger" },
  ];
  const subtitleOptions = [{ id: "off", label: "Off", language: "off", isDefault: false, objectKey: null }, { id: "e1-sub-fr", label: "French", language: "fre", isDefault: false, objectKey: "o", format: "srt" }];

  it("@req PLAY-TRACK-04 audio pick → the picked track's language", () => {
    expect(trackPrefsPatchForPick({ pick: { property: "aid", value: 2 }, trackList, subtitleOptions, subtitleOptionId: null })).toEqual({ audioLanguage: "fre" });
    expect(trackPrefsPatchForPick({ pick: { property: "aid", value: 9 }, trackList, subtitleOptions, subtitleOptionId: null })).toBeNull();
  });

  it("@req PLAY-TRACK-04 subtitle pick: Off, an app option, or a raw embedded track", () => {
    expect(trackPrefsPatchForPick({ pick: { property: "sid", value: "no" }, trackList, subtitleOptions, subtitleOptionId: "off" })).toEqual({ subtitle: "off" });
    expect(trackPrefsPatchForPick({ pick: { property: "sid", value: 3 }, trackList, subtitleOptions, subtitleOptionId: "e1-sub-fr" })).toEqual({
      subtitle: { language: "fre", format: "srt" },
    });
    expect(trackPrefsPatchForPick({ pick: { property: "sid", value: 4 }, trackList, subtitleOptions, subtitleOptionId: null })).toEqual({ subtitle: { language: "ger" } });
  });
});

describe("the controller applies the remembered tracks at play start (source guard)", () => {
  const controller = readFileSync(resolve(process.cwd(), "src/renderer/src/components/MediaPlaybackController.tsx"), "utf8");
  it("@req PLAY-TRACK-04 reset effect resolves the show's prefs and keeps Off pinned", () => {
    expect(controller).toMatch(/resolvePlaybackStartTracks\(/);
    expect(controller).toMatch(/trackPrefsKey\(m\.id\)/);
    expect(controller).toMatch(/subtitlesOffRemembered/);
  });
});

describe("a remembered choice never starts an OCR twin on desktop (PLAY-TRACK-05)", () => {
  // @req PLAY-TRACK-05
  it("a remembered French SRT choice picks the French picture track, not its OCR twin", () => {
    const picture = sub({ id: "e1-sub-fr-pgs", language: "fre", isDefault: false, episodeId: "ep-1", format: "sup" });
    const twin = sub({
      id: "e1-sub-fr-ocr",
      language: "fre",
      isDefault: false,
      episodeId: "ep-1",
      format: "srt",
      source: "ocr",
      derivedFromSubtitleId: "e1-sub-fr-pgs",
    });
    const prefs = mergeTrackPrefs(null, { subtitle: { language: "fr", format: "srt" } }, NOW);
    const start = resolvePlaybackStartTracks({ audioTracks: ep1Audio, subtitleTracks: [ep1Subs[0]!, picture, twin], episodeId: "ep-1", prefs });
    console.info(`${TAG} start(prefs fr/srt, picture + twin)=${JSON.stringify(start)}`);
    expect(start.subDefault).toBe("e1-sub-fr-pgs");
  });
});
