import type { AudioOption } from "@/lib/playbackTypes";
import type { MediaFormat } from "@/lib/libraryDb";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import { formatPlayerTrackLabel } from "@/lib/playerTrackLabel";
import { SKIP_SOURCE_DETECTED } from "@space/shared/skipMarkers";
import {
  buildScriptMessageCommand,
  type EnvelopeChannel,
  LUA_CHANNELS,
  type ScriptMessageCommand,
} from "@space/mpv-protocol";

/**
 * The OSC's text in the UI language: the track menus' prompts and empty-state lines (sf-select.lua) and the audio
 * notice (sf.lua, MPV-AUDIO-01/02), all sent on `sf-labels-json`.
 */
export type OscMenuPrompts = {
  selectSubtitle: string;
  selectSecondarySubtitle: string;
  selectAudioTrack: string;
  selectVideoTrack: string;
  noSubtitles: string;
  noAudioTracks: string;
  noVideoTracks: string;
  audioRetry: string;
  audioRetrying: string;
  audioStallExplanation: string;
  audioNoOutputExplanation: string;
  audioOutputLabel: string;
};

export const oscMenuPrompts = (t: (key: string) => string): OscMenuPrompts => ({
  selectSubtitle: t("player.menuSelectSubtitle"),
  selectSecondarySubtitle: t("player.menuSelectSecondarySubtitle"),
  selectAudioTrack: t("player.menuSelectAudioTrack"),
  selectVideoTrack: t("player.menuSelectVideoTrack"),
  noSubtitles: t("player.menuNoSubtitles"),
  noAudioTracks: t("player.menuNoAudioTracks"),
  noVideoTracks: t("player.menuNoVideoTracks"),
  audioRetry: t("player.audioRetry"),
  audioRetrying: t("player.audioRetrying"),
  audioStallExplanation: t("player.audioStallExplanation"),
  audioNoOutputExplanation: t("player.audioNoOutputExplanation"),
  audioOutputLabel: t("player.audioOutputLabel"),
});

/** The skip pill, the "Was it right?" line, the bar button's menu and the Change times panel (sf.lua), i18n `player.skipUi.*`. */
export const OSC_SKIP_LABEL_KEYS = [
  "skipIntro",
  "skipCredits",
  "nextEpisode",
  "nextEpisodeIn",
  "openingNextEpisode",
  "enterKey",
  "askedIntro",
  "askedCredits",
  "yes",
  "changeTimes",
  "thanks",
  "changeIntroTimes",
  "changeCreditsTimes",
  "start",
  "end",
  "hint",
  "save",
  "cancel",
  "back",
  "scopeQuestion",
  "thisSeason",
  "onlyThisEpisode",
  "farNote",
  "savedSeason",
  "savedEpisode",
  "menuPrompt",
  "introEndsHere",
  "creditsStartHere",
] as const;
export type OscSkipLabelKey = (typeof OSC_SKIP_LABEL_KEYS)[number];
export type OscSkipLabels = Record<OscSkipLabelKey, string>;

export const oscSkipLabels = (t: (key: string) => string): OscSkipLabels => {
  const labels: Partial<OscSkipLabels> = {};
  for (const key of OSC_SKIP_LABEL_KEYS) labels[key] = t(`player.skipUi.${key}`);
  // Every key of OSC_SKIP_LABEL_KEYS was set by the loop above.
  return labels as OscSkipLabels;
};

export type ExternalPlaybackMetadataPayload = {
  // `selected: true` tells sf.lua to sub-add this entry with mpv's "select"
  // flag (vs the default "auto"). Setting sid at sub-add time avoids a
  // refresh-seek that the user perceives as a 1–4s replay loop near launch.
  // At most one entry should be `selected: true` per payload; if none is,
  // sid stays "no" and the renderer's applyExternalSubtitle effect handles
  // it (which IS allowed to refresh-seek for genuine user mid-stream picks).
  subtitles: Array<{ url: string; title?: string | null; lang?: string | null; format?: string | null; selected?: boolean }>;
  chapters: Array<{ title: string; startSeconds: number; endSeconds: number | null; orderIndex: number }>;
  audio: Array<{ title?: string | null; label?: string | null; lang?: string | null }>;
  /** UI-language strings the OSC menus show (sf-select.lua: apply_labels_json). */
  labels: {
    subtitlesOff: string;
    getMoreSubtitles: string;
    tryAnotherVersion?: string;
    addSubtitleFile?: string;
    /** sf.lua's skip texts (pill, asked line, bar menu, Change times panel); omitted, sf.lua keeps its English ones. */
    skip?: OscSkipLabels;
  } & Partial<OscMenuPrompts>;
  playback: {
    markers: Array<{
      type: "intro" | "credits";
      startSeconds: number;
      endSeconds: number;
      autoSkip: boolean;
      ask: boolean;
    }>;
    /** The overlay's "what's playing" line (PLAY-OVL-01); sf.lua sets it as force-media-title. */
    title: string;
    /** The line under the title (MPV-OSC-04): film year, or "S1 · E3 “Name” · 2024"; the OSC appends the runtime. */
    meta: string;
    /** Centre previous-episode button target (PLAY-OVL-03); null hides the button. */
    previousEpisode: { id: string; label: string } | null;
    nextEpisode: { id: string; label: string } | null;
    autoplayNextEpisode: boolean;
    /**
     * Drives the 5s-pre-roll auto-fire on the "Next episode" pill when there
     * is no credits marker (the end-of-media fallback path). Set from the
     * desktop's creditsSkipEnabled toggle. Distinct from `autoplayNextEpisode`
     * which gates whether the existing 0.35s-before-end fire happens at all.
     */
    autoSkipNextEpisode: boolean;
    fallbackCountdownSeconds: number;
    /**
     * PLAY-SKIP-10: the control bar's skip button and its menu (change or mark intro / credits times). True for every
     * episode of a show in the library; a movie or an offline copy without a library row gets no button.
     */
    skipMenu: boolean;
  };
};

export const buildExternalPlaybackMetadataPayload = (params: {
  subtitles: Array<{ url: string; title?: string | null; lang?: string | null; format?: string | null; selected?: boolean }>;
  chapters: Array<{ title: string; startSeconds: number }>;
  audioOptions: AudioOption[];
  /** i18n `player.subtitlesOff` in the current UI language: the OSC subtitle menu's "Off" row. */
  subtitlesOffLabel: string;
  /**
   * The subtitle menu's "Get more subtitles…" row (PLAY-SUBGET-02, shared copy `getMore`); empty or omitted hides
   * the row (no catalog id and no title to search by, an offline copy playing).
   */
  getMoreSubtitlesLabel?: string;
  /** The subtitle menu's "Try another version" row (PLAY-SUBGET-07); non-empty only while a fetched subtitle is on. */
  tryAnotherVersionLabel?: string;
  /** The subtitle menu's last row, "Add a subtitle file…" (PLAY-SUBGET-23); empty or omitted hides it. */
  addSubtitleFileLabel?: string;
  /** Track-menu prompts in the UI language (`oscMenuPrompts(t)`); omitted, the OSC keeps its English ones. */
  menuPrompts?: OscMenuPrompts;
  /** The skip texts in the UI language (`oscSkipLabels(t)`). */
  skipLabels?: OscSkipLabels;
  /** PLAY-SKIP-10: show the control bar's skip button (an episode in the library). */
  skipMenu?: boolean;
  skipMarkers: Array<{ type: "intro" | "credits"; startSeconds: number; endSeconds: number; source?: string; confidence?: number | null }>;
  title: string;
  meta: string;
  previousEpisode: { id: string; label: string } | null;
  nextEpisode: { id: string; label: string } | null;
  autoplayNextEpisode: boolean;
  autoSkipIntro: boolean;
  autoSkipCredits: boolean;
}): ExternalPlaybackMetadataPayload => {
  const { subtitles, chapters, audioOptions, skipMarkers, nextEpisode, autoplayNextEpisode } = params;
  return {
    subtitles,
    chapters: chapters.map((chapter, index) => ({
      title: chapter.title,
      startSeconds: chapter.startSeconds,
      endSeconds: null,
      orderIndex: index,
    })),
    audio: audioOptions.map((track) => {
      const display = formatPlayerTrackLabel(track.language, track.label, "Audio");
      return {
        title: display,
        label: display,
        lang: track.language || "und",
      };
    }),
    labels: {
      subtitlesOff: params.subtitlesOffLabel,
      getMoreSubtitles: params.getMoreSubtitlesLabel ?? "",
      tryAnotherVersion: params.tryAnotherVersionLabel ?? "",
      addSubtitleFile: params.addSubtitleFileLabel ?? "",
      ...params.menuPrompts,
      ...(params.skipLabels ? { skip: params.skipLabels } : {}),
    },
    playback: {
      markers: skipMarkers.map((marker) => ({
        type: marker.type,
        startSeconds: marker.startSeconds,
        endSeconds: marker.endSeconds,
        // PLAY-SKIP-02: credits are never skipped on their own; the pill offers "Skip credits" and the user presses it.
        autoSkip: marker.type === "intro" ? params.autoSkipIntro : false,
        // PLAY-SKIP-03: "Was it right?" only for times this device detected and is unsure of (Chris 2026-11-24).
        ask: marker.source === SKIP_SOURCE_DETECTED && (marker.confidence ?? 0) < 1,
      })),
      title: params.title,
      meta: params.meta,
      previousEpisode: params.previousEpisode ?? null,
      nextEpisode: nextEpisode ?? null,
      autoplayNextEpisode,
      autoSkipNextEpisode: params.autoSkipCredits,
      fallbackCountdownSeconds: 15,
      skipMenu: params.skipMenu === true,
    },
  };
};

/**
 * MPV-PREV-01: the seek-bar preview record of the playing file, which the import stores on the file's source format
 * (the quality the pictures were made from). Null when the file has none; the main process parses it again and treats
 * anything malformed as none.
 */
export const sourcePreviewSheets = (formats: MediaFormat[], fileId: string | null): MediaPreviewSheets | null => {
  if (!fileId) return null;
  return formats.find((format) => format.fileId === fileId && format.isSource === true)?.previewSheets ?? null;
};

/**
 * MPV-PREV-06: what the main process needs when the playing file has no preview record: its source format (the row
 * the runtime's catch-up pass keys its tries on, MPV-PREV-03) and the hint text in the UI language. `formatId` null
 * (no file or no source row) means nobody can say previews are coming, so the OSC draws nothing.
 */
export const missingPreviewsFor = (
  formats: MediaFormat[],
  fileId: string | null,
  hint: string,
): { formatId: string | null; hint: string } => ({
  formatId: fileId ? (formats.find((format) => format.fileId === fileId && format.isSource === true)?.id ?? null) : null,
  hint,
});

export const buildExternalMetadataCommands = (
  payload: ExternalPlaybackMetadataPayload,
): ScriptMessageCommand<EnvelopeChannel>[] => {
  const commands: ScriptMessageCommand<EnvelopeChannel>[] = [];
  // Always send subtitles — even an empty list — for the same cache-coherence
  // reason as chapters below: sf.lua caches the last-sent list and re-applies
  // it on `file-loaded` after a reload / next file, so a subtitle-less episode
  // following a subtitled one must send [] to clear that cache.
  // @bugfix mpv-subtitles-lost-after-reload
  commands.push(buildScriptMessageCommand(LUA_CHANNELS.SUBTITLES_JSON, payload.subtitles));
  // Always send chapters — even an empty list — exactly like PLAYBACK_JSON
  // below. sf.lua caches the last-sent chapters and re-applies them on
  // `file-loaded` to survive a reload's second `start-file` (which wipes its
  // pending_chapters). Sending unconditionally keeps that cache coherent with
  // the CURRENT file: a chapterless episode following a chaptered one sends []
  // and clears the cache, so stale chapters never leak across a same-process
  // next-episode reload.
  // @bugfix mpv-chapters-disappear-after-reload
  commands.push(buildScriptMessageCommand(LUA_CHANNELS.CHAPTERS_JSON, payload.chapters));
  if (payload.audio.length > 0) {
    commands.push(buildScriptMessageCommand(LUA_CHANNELS.AUDIO_JSON, payload.audio));
  }
  // The subtitle menu's "Off" and "Get more subtitles…" row labels, on every send like the lists above.
  commands.push(buildScriptMessageCommand(LUA_CHANNELS.LABELS_JSON, payload.labels));
  commands.push(buildScriptMessageCommand(LUA_CHANNELS.PLAYBACK_JSON, payload.playback));
  return commands;
};
