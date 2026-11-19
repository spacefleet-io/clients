/**
 * Zod schemas for the five `script-message` JSON envelopes shared between
 * the desktop renderer (mpvExternalMetadata.ts) and the in-mpv Lua scripts
 * (packages/mpv/resources/osc/sf.lua + sf-select.lua).
 *
 * Without a shared schema, dropping or renaming a field has no compile-time
 * signal — the renderer just stops sending it and the Lua side silently
 * does the wrong thing. The schemas below are the contract that lets the
 * desktop side parse outgoing payloads in dev (catching shape drift fast)
 * and the test suite assert that field accesses in sf.lua / sf-select.lua
 * still line up with what the renderer sends.
 *
 * Each schema is intentionally PERMISSIVE on extra fields (`.passthrough()`
 * where applicable) because the renderer historically attaches fields the
 * Lua side ignores (e.g. `format` on subtitles, `orderIndex` on chapters)
 * and removing them would change wire payloads on the same release where
 * the schemas land.
 */

import { z } from "zod";

/**
 * sf-subtitles-json — an array of external subtitle entries.
 *
 * Lua side (sf.lua: apply_subtitles_json + maybe_add_subtitle):
 *   reads `sub.url`, `sub.title`, `sub.lang`, `sub.selected`.
 *
 * CRITICAL — `selected: boolean` is the field plumbed by commit 7d42d8ff
 * to fix the refresh-seek loop. At most ONE entry per payload should be
 * `selected: true`; the renderer enforces this in
 * useMpvPlaybackEngine.ts:466+. Dropping or weakening this field
 * resurrects the 1–4s replay loop bug. Locked at
 * apps/badger/desktop/tests/mpv-external-metadata.test.ts:121+.
 */
export const subtitleEntrySchema = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  lang: z.string().nullable().optional(),
  format: z.string().nullable().optional(),
  selected: z.boolean().optional(),
});

export const subtitlesPayloadSchema = z.array(subtitleEntrySchema);

export type SubtitleEntry = z.infer<typeof subtitleEntrySchema>;
export type SubtitlesPayload = z.infer<typeof subtitlesPayloadSchema>;

/**
 * sf-chapters-json — an array of chapter entries.
 *
 * Lua side (sf.lua: apply_chapters_json):
 *   reads `chapter.startSeconds`, `chapter.title`.
 *
 * Renderer also attaches `endSeconds` (nullable) and `orderIndex` for the
 * record — the Lua side ignores these but they remain on the wire and
 * therefore in the schema.
 */
export const chapterEntrySchema = z.object({
  title: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number().nullable().optional(),
  orderIndex: z.number().int().optional(),
});

export const chaptersPayloadSchema = z.array(chapterEntrySchema);

export type ChapterEntry = z.infer<typeof chapterEntrySchema>;
export type ChaptersPayload = z.infer<typeof chaptersPayloadSchema>;

/**
 * sf-audio-json — an array of audio-track display overrides keyed by ordinal.
 *
 * Lua side (sf-select.lua: apply_audio_json + rebuild_audio_label_overrides):
 *   reads `payload.title` and `payload.label` to render the override label.
 *   `lang` is part of the renderer's wire shape (mpvExternalMetadata.ts:48)
 *   but the Lua side currently ignores it.
 */
export const audioEntrySchema = z.object({
  title: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  lang: z.string().nullable().optional(),
});

export const audioPayloadSchema = z.array(audioEntrySchema);

export type AudioEntry = z.infer<typeof audioEntrySchema>;
export type AudioPayload = z.infer<typeof audioPayloadSchema>;

/**
 * sf-labels-json — UI-language strings the OSC menus show.
 *
 * Lua side (sf-select.lua: apply_labels_json):
 *   reads `payload.subtitlesOff`, the label of the subtitle menu's "Off" row
 *   (i18n `player.subtitlesOff`); the menu falls back to "Off" until it arrives.
 *   reads `payload.getMoreSubtitles`, the subtitle menu's last row (PLAY-SUBGET-02);
 *   absent or "" hides the row.
 *   reads `payload.tryAnotherVersion`, the "Try another version" row after it (PLAY-SUBGET-07),
 *   sent non-empty only while the selected subtitle is a fetched one; "" hides the row.
 *   reads `payload.addSubtitleFile`, the menu's last row "Add a subtitle file…" (PLAY-SUBGET-23);
 *   absent or "" hides the row.
 *   reads the track menus' prompts and empty-state lines (`selectSubtitle`,
 *   `selectSecondarySubtitle`, `selectAudioTrack`, `selectVideoTrack`,
 *   `noSubtitles`, `noAudioTracks`, `noVideoTracks`; i18n `player.menu*`);
 *   absent or "" keeps the previous text, English until the first payload.
 * Lua side (sf.lua): reads the audio notice's text (MPV-AUDIO-01/02: `audioRetry`, `audioRetrying`,
 *   `audioStallExplanation`, `audioNoOutputExplanation`, `audioOutputLabel`; i18n `player.audio*`), same rule.
 */
export const labelsPayloadSchema = z.object({
  subtitlesOff: z.string(),
  getMoreSubtitles: z.string().optional(),
  tryAnotherVersion: z.string().optional(),
  addSubtitleFile: z.string().optional(),
  selectSubtitle: z.string().optional(),
  selectSecondarySubtitle: z.string().optional(),
  selectAudioTrack: z.string().optional(),
  selectVideoTrack: z.string().optional(),
  noSubtitles: z.string().optional(),
  noAudioTracks: z.string().optional(),
  noVideoTracks: z.string().optional(),
  audioRetry: z.string().optional(),
  audioRetrying: z.string().optional(),
  audioStallExplanation: z.string().optional(),
  audioNoOutputExplanation: z.string().optional(),
  audioOutputLabel: z.string().optional(),
});

export type LabelsPayload = z.infer<typeof labelsPayloadSchema>;

/**
 * sf-playback-json — the playback metadata bundle (skip markers, next-
 * episode CTA state, autoplay flag).
 *
 * Lua side (sf.lua: apply_playback_json):
 *   reads `parsed.markers[].type/startSeconds/endSeconds`,
 *   `parsed.nextEpisode.id/label`,
 *   `parsed.autoplayNextEpisode`,
 *   `parsed.fallbackCountdownSeconds`.
 */
export const skipMarkerSchema = z.object({
  type: z.enum(["intro", "credits"]),
  startSeconds: z.number(),
  endSeconds: z.number(),
});

export const nextEpisodeSchema = z.object({
  id: z.string(),
  label: z.string(),
});

export const playbackPayloadSchema = z.object({
  markers: z.array(skipMarkerSchema),
  /** "What's playing" line; sf.lua applies it as `force-media-title` (PLAY-OVL-01). */
  title: z.string(),
  /** Target of the overlay's centre previous-episode button (PLAY-OVL-03). */
  previousEpisode: nextEpisodeSchema.nullable(),
  nextEpisode: nextEpisodeSchema.nullable(),
  autoplayNextEpisode: z.boolean(),
  fallbackCountdownSeconds: z.number(),
});

export type SkipMarker = z.infer<typeof skipMarkerSchema>;
export type NextEpisode = z.infer<typeof nextEpisodeSchema>;
export type PlaybackPayload = z.infer<typeof playbackPayloadSchema>;

/**
 * Seek-bar preview pictures (MPV-PREV-01), main process → tog4in1.lua. `sf-preview-sheets`: the playing video has
 * previews of this size, one every `intervalSeconds`; or `{hint}`: it has none yet but they are still to come, and the
 * OSC writes `hint` (UI language, "Previews are being prepared") above the hover time instead of a picture
 * (MPV-PREV-06); or null: none (also once generation gave up), nothing is drawn above the hover time.
 * `sf-preview-picture`: the answer to the OSC's `sf-preview-hover <token> <seconds>`, a raw BGRA file of
 * `width` x `height` pixels, or `path: null` when that moment has no picture to show (the sheet failed to fetch or
 * decode): the OSC then removes the previous picture rather than keep a wrong moment on screen. The OSC drops it
 * unless `token` is its latest request.
 */
export const previewSheetsPayloadSchema = z
  .union([
    z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      intervalSeconds: z.number().positive(),
    }),
    z.object({ hint: z.string().min(1) }),
  ])
  .nullable();

export const previewPicturePayloadSchema = z.union([
  z.object({
    token: z.number().int(),
    path: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ token: z.number().int(), path: z.null() }),
]);

export type PreviewSheetsPayload = z.infer<typeof previewSheetsPayloadSchema>;
export type PreviewPicturePayload = z.infer<typeof previewPicturePayloadSchema>;

/**
 * Audio notice, main process → sf.lua `sf-audio-stall`. `stalled`: the player plays without sound, and the OSC shows
 * the notice with its "Retry with sound" action, naming the output and device mpv reported. `reason` says why:
 * `frozen` (absent too, MPV-AUDIO-01) the audio output stopped taking sound and the player dropped to no sound so the
 * picture keeps moving; `no-output` (MPV-AUDIO-02) no sound output could be opened and mpv plays on its null output.
 * `cleared`: sound is being retried (or the user picked an audio track), the OSC removes the notice. The OSC answers
 * the action with `sf-audio-retry` (LUA_OUTBOUND_CHANNELS).
 */
export const audioStallPayloadSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("stalled"),
    reason: z.enum(["frozen", "no-output"]).optional(),
    output: z.string(),
    device: z.string(),
  }),
  z.object({ state: z.literal("cleared") }),
]);

export type AudioStallPayload = z.infer<typeof audioStallPayloadSchema>;

/**
 * sf-subtitle-fetch-json — what the "Get more subtitles…" / "Add a subtitle file…" flows show in mpv
 * (PLAY-SUBGET-02, -23, -24).
 *
 * Lua side (sf-select.lua: apply_subtitle_fetch_json):
 *   `panel` draws a centred message box (`dismissable`: Escape sends `cancel`);
 *   `list` opens mpv's select menu (a pick sends `pick <key>`, closing sends `cancel`);
 *   `title` opens mpv's text field (`input.get`) prefilled with `query`, for a media without a catalog id
 *   (PLAY-SUBGET-24): Enter sends `title <text>`, closing sends `cancel`;
 *   `close` removes whatever is shown.
 */
export const subtitleFetchViewSchema = z.union([
  z.object({ panel: z.string(), dismissable: z.boolean() }),
  z.object({
    list: z.object({ prompt: z.string(), items: z.array(z.object({ key: z.string(), label: z.string() })) }),
  }),
  z.object({ title: z.object({ prompt: z.string(), field: z.string(), query: z.string() }) }),
  z.object({ close: z.literal(true) }),
]);

export type SubtitleFetchView = z.infer<typeof subtitleFetchViewSchema>;

/**
 * OSC action file — written by sf.lua, read by the Electron main process
 * via a 150ms file-watch poll. This is the lone non-`script-message`
 * envelope: Lua writes the JSON to a temp file path (passed in via
 * --script-opts=sf-actions_file=...) and the main process polls the file
 * for changes.
 *
 * Lua side (sf.lua: write_episode_action):
 *   writes `{"type":"next_episode"|"previous_episode","requestedAt":<unix_ms>,"timePos":<s>}`
 *   (next/previous: the overlay's centre episode buttons, the Next-episode
 *   pill and auto-play next). `timePos` is mpv's time-pos when the action
 *   was written (absent when mpv has none): the place in the episode left,
 *   which the renderer saves before it switches (PLAY-RESUME-02).
 *
 * Main side (apps/badger/desktop/src/main/externalMpv.ts: startOscActionPolling):
 *   reads the file, JSON.parses, validates against this schema,
 *   forwards to the renderer via the multiplexed `sf-mpv-external-message`
 *   IPC channel as `{ type: "osc_action", action }` (Tier-4 retired the
 *   former per-event `sf-mpv-external-osc-action` channel).
 *
 * The schema is intentionally a closed shape, and a Tier-6 candidate is to
 * migrate this to `script-message` outright. Until then, the schema catches
 * malformed writes (truncated during the next file-write race, future
 * Lua-side field changes).
 */
export const oscActionFileSchema = z.object({
  type: z.union([z.literal("next_episode"), z.literal("previous_episode")]),
  requestedAt: z.number(),
  timePos: z.number().optional(),
});

export type OscActionFile = z.infer<typeof oscActionFileSchema>;

/**
 * Registry of script-message channel names → payload schemas.
 *
 * `buildScriptMessageCommand` (in commands.ts) keys off this map to
 * validate outgoing payloads in dev mode.
 */
export const ENVELOPE_SCHEMAS = {
  "sf-subtitles-json": subtitlesPayloadSchema,
  "sf-chapters-json": chaptersPayloadSchema,
  "sf-audio-json": audioPayloadSchema,
  "sf-labels-json": labelsPayloadSchema,
  "sf-playback-json": playbackPayloadSchema,
  "sf-preview-sheets": previewSheetsPayloadSchema,
  "sf-preview-picture": previewPicturePayloadSchema,
  "sf-audio-stall": audioStallPayloadSchema,
  "sf-subtitle-fetch-json": subtitleFetchViewSchema,
} as const;

export type EnvelopeChannel = keyof typeof ENVELOPE_SCHEMAS;

export type EnvelopePayload<C extends EnvelopeChannel> = z.infer<typeof ENVELOPE_SCHEMAS[C]>;
