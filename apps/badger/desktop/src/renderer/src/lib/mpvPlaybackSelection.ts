import { pickStartVariant } from "@space/playback-abr";
import { trackSwitchSeeksBeforeStart } from "@space/mpv-protocol";
import type { QualityPreset } from "@/lib/config";
import type { MediaChapter, MediaDetails, MediaFormat, MediaSkipMarker, SubtitleTrack } from "@/lib/libraryDb";
import type { AudioOption, SubtitleOption } from "@/lib/playbackTypes";
import { orderPlaybackFormats } from "@/lib/mpvPlaybackMaps";
import { formatPlayerTrackLabel } from "@/lib/playerTrackLabel";
import { languagesMatch, resolveTrackSelection, type TrackDefaults, type TrackPrefs } from "@space/shared/trackPrefs";
import { isOcrTwin } from "@space/shared/subtitleTwins";

const selectEpisodeScoped = <T extends { episodeId?: string | null }>(
  items: T[],
  episodeId: string | null | undefined
) => {
  if (episodeId) {
    return items.filter((item) => item.episodeId === episodeId);
  }
  const scoped = items.filter((item) => !item.episodeId);
  return scoped.length > 0 ? scoped : items;
};

const pickFormatScore = (format: MediaFormat, blockedCodecs: ReadonlySet<string>) => ({
  unblocked: format.codec && blockedCodecs.has(format.codec) ? 0 : 1,
  playable: format.initKey && format.chunks?.length ? 1 : 0,
  chunks: format.chunks?.length ?? 0,
  bitrate: format.bitrateKbps ?? 0,
  totalSize: format.totalSize ?? 0,
});
const FORMAT_SCORE_ORDER = ["unblocked", "playable", "chunks", "bitrate", "totalSize"] as const;

/**
 * The playback ladder: one format per quality for `fileId`. When a quality
 * has several rows (e.g. HEVC and H.264 1080p), a row whose codec Auto gave
 * up on for this file (`blockedCodecs`, the decode-bound fallback, issue #25)
 * loses the slot to any other codec; then playable > chunks > bitrate > size.
 * A blocked codec alone at its quality keeps the slot.
 */
export const buildPlaybackFormatsForFile = (
  formats: MediaFormat[],
  fileId: string | null,
  blockedCodecs: ReadonlySet<string>
) => {
  if (!fileId) return [];
  const byQuality = new Map<string, MediaFormat>();
  formats
    .filter((format) => format.fileId === fileId)
    .forEach((format) => {
      const current = byQuality.get(format.quality);
      if (!current) {
        byQuality.set(format.quality, format);
        return;
      }
      const next = pickFormatScore(format, blockedCodecs);
      const held = pickFormatScore(current, blockedCodecs);
      const decisive = FORMAT_SCORE_ORDER.find((key) => next[key] !== held[key]);
      if (decisive && next[decisive] > held[decisive]) {
        byQuality.set(format.quality, format);
      }
    });
  return Array.from(byQuality.values()).sort((a, b) => orderPlaybackFormats(a.quality, b.quality));
};

export type SettingsFormatLike = { id: string; quality: string; codec?: string | null; bitrateKbps?: number | null };

/**
 * PLAY-QUAL-02: the format a playback starts on is the Settings quality, else the best one below it, else (Settings
 * below every format) the lightest one above it, never the best of the ladder. One shared decision with the phone
 * (`pickStartVariant` in `@space/playback-abr`); desktop has no decoder probes, so no caps.
 */
export const pickSettingsFormat = <T extends SettingsFormatLike>(formats: T[], playbackQuality: QualityPreset): T | null => {
  const picked = pickStartVariant(
    formats.map((format) => ({
      id: format.id,
      quality: format.quality,
      codec: format.codec ?? null,
      bitrateKbps: format.bitrateKbps ?? null,
    })),
    playbackQuality,
  );
  return picked ? (formats.find((format) => format.id === picked.id) ?? null) : null;
};

/**
 * Decide which format id the playback engine should select when the previous
 * stream's `selectedFormatId` no longer matches the current format list — the
 * next-episode auto-advance transition (the new episode's formats have fresh
 * ids), or any other format-list swap.
 *
 * Product rule: a NEW episode always aims for the user's configured
 * `playbackQuality` (the Settings default), REGARDLESS of what the previous
 * episode was playing at. Neither input below is carried across the boundary:
 *
 *   - `priorEffectiveQuality` — the quality ABR happened to be sitting at when
 *     the previous episode ended. The demuxer cache drains as playback nears
 *     EOF, so ABR emergency-downshifts to the lowest tier (e.g. "360p") on
 *     essentially every episode end. Carrying it pinned every auto-advanced
 *     episode at 360p even though Settings say 1080p — the reported bug.
 *   - `userTargetQuality` — an explicit one-off menu pick on the previous
 *     episode (e.g. the user bumped that episode up to 4K). A per-episode pick
 *     does NOT carry; the next episode reverts to the Settings default. A
 *     persistent quality preference belongs in Settings, not in a transient
 *     per-episode override. (Note: the caller also clears userTargetQualityRef
 *     on file change so ABR's ceiling reverts to playbackQuality too — otherwise
 *     ABR would climb the new episode back up to the old 4K pick.)
 *
 * Both prior-quality inputs are accepted (not dropped from the signature) so
 * this decision stays explicit and unit-testable: the regression tests pass
 * poisoned values for BOTH and assert the Settings ceiling still wins. This
 * decision point has regressed once already (the ABR-transient carry), so the
 * "deliberately ignored" inputs are kept visible as a guard.
 *
 * @bugfix next-episode-360p-abr-transient-carry
 * @regression-proof
 */
export const resolveNextEpisodeFormatId = ({
  userTargetQuality,
  priorEffectiveQuality,
  playbackQuality,
  formats,
}: {
  userTargetQuality: string | null;
  priorEffectiveQuality: string | null;
  playbackQuality: QualityPreset;
  formats: Array<SettingsFormatLike>;
}): string | null => {
  // Both prior-quality inputs are intentionally ignored — see the doc comment.
  // Referenced here so they stay load-bearing parameters of the contract (any
  // future change that resurrects cross-episode carry must touch this line).
  void userTargetQuality;
  void priorEffectiveQuality;
  return pickSettingsFormat(formats, playbackQuality)?.id ?? null;
};

export const resolvePlaybackAudioState = ({
  audioTracks,
  preferredAudioLanguage,
  episodeId,
  selectedAudioId,
}: {
  audioTracks: MediaDetails["audioTracks"];
  preferredAudioLanguage?: string | null;
  episodeId: string | null | undefined;
  selectedAudioId: string | null;
}) => {
  const options: AudioOption[] = selectEpisodeScoped(audioTracks, episodeId).map((track) => ({
    id: track.id,
    label: formatPlayerTrackLabel(track.language, track.label),
    language: track.language,
    isDefault: track.isDefault,
    codec: track.codec,
    codecString: track.codecString ?? null,
    initKey: track.initKey,
    initSize: track.initSize,
    durationSeconds: track.durationSeconds,
    totalSize: track.totalSize,
    chunks: track.chunks,
  }));
  const playable = options.filter((option) => Boolean(option.initKey && option.chunks?.length));
  let nextSelectedAudioId = selectedAudioId;
  if (!(nextSelectedAudioId && playable.some((option) => option.id === nextSelectedAudioId))) {
    if (preferredAudioLanguage) {
      nextSelectedAudioId =
        playable.find((option) => languagesMatch(option.language, preferredAudioLanguage))?.id ?? null;
    }
    if (!nextSelectedAudioId) {
      nextSelectedAudioId =
        (playable.find((option) => option.isDefault) ?? playable[0] ?? options[0])?.id ?? null;
    }
  }
  return { options, selectedAudioId: nextSelectedAudioId };
};

/**
 * The audio + subtitle selection a play request starts from (PLAY-TRACK-04):
 * the remembered choice of the movie / show (`prefs`) when this episode has a
 * matching track, else the profile's "Default audio language" and "Subtitle
 * language" (`defaults`, PLAY-TRACK-01, ACCT-SQUAD-03) when the file has them,
 * else the library's default track. `subtitlesOffRemembered`
 * tells the engine the "off" is the user's choice, so a default subtitle track
 * must not flip it back on.
 */
export const resolvePlaybackStartTracks = ({
  audioTracks,
  subtitleTracks,
  episodeId,
  prefs,
  defaults = null,
}: {
  audioTracks: MediaDetails["audioTracks"];
  subtitleTracks: SubtitleTrack[];
  episodeId: string | null | undefined;
  prefs: TrackPrefs | null;
  defaults?: TrackDefaults | null;
}) => {
  const inScope = <T extends { episodeId?: string | null }>(track: T) => (episodeId ? track.episodeId === episodeId : !track.episodeId);
  const scopedAudio = audioTracks.filter(inScope);
  // OCR twins (PLAY-TRACK-05) are for the Android TV's direct rendering only: the desktop plays the picture track.
  const scopedSubtitles = subtitleTracks.filter((track) => inScope(track) && Boolean(track.objectKey) && !isOcrTwin(track));
  const selection = resolveTrackSelection({
    prefs,
    defaults,
    audioTracks: scopedAudio.filter((track) => Boolean(track.initKey && track.chunks?.length)),
    subtitleTracks: scopedSubtitles,
  });
  const libraryAudioDefault = scopedAudio.find((track) => track.isDefault)?.id ?? null;
  const libraryDefaultSubtitle = scopedSubtitles.find((track) => track.isDefault)?.id ?? "off";
  const subtitle = selection.subtitle;
  return {
    audioDefault: selection.audioTrackId ?? libraryAudioDefault,
    audioSource: selection.audioSource,
    subDefault: subtitle.mode === "off" ? "off" : subtitle.mode === "track" ? subtitle.id : libraryDefaultSubtitle,
    subtitlesOffRemembered: subtitle.mode === "off",
  };
};

/**
 * The mpv `aid` the app's audio choice has in the HLS master (PLAY-TRACK-04): `createHlsSession` lists the playable
 * audio options in order, and mpv numbers those renditions from 1. Null when the choice is not in the master.
 * The master's DEFAULT flag does not choose for mpv (FFmpeg marks every AUTOSELECT rendition default and mpv takes
 * the first), so a remembered audio choice reaches mpv only through this `aid`.
 */
export const hlsAudioTrackFor = (
  audioOptions: ReadonlyArray<Pick<AudioOption, "id" | "initKey" | "chunks">>,
  audioId: string | null,
): number | null => {
  if (!audioId) return null;
  const index = audioOptions.filter((option) => Boolean(option.initKey && option.chunks?.length)).findIndex((option) => option.id === audioId);
  return index < 0 ? null : index + 1;
};

/**
 * Resolves true once an `aid` switch on the playing HLS stream is safe (`time-pos` at least
 * MPV_TRACK_SWITCH_SAFE_SECONDS), false when `cancelled()` turns true first. Paused before that point, it keeps
 * waiting: a switch then would break playback the same way.
 *
 * @bugfix @regression-proof #2762: the app set `aid` ~0.2 s into a replay; mpv's refresh seek for the new track
 * (`time-pos - 1 s`) failed in FFmpeg 8.1's HLS demuxer and the replay never started (or jumped ahead).
 */
export const waitForSafeTrackSwitch = async (
  readTimePos: () => Promise<unknown>,
  cancelled: () => boolean,
  intervalMs = 250,
): Promise<boolean> => {
  while (!cancelled()) {
    if (!trackSwitchSeeksBeforeStart(await readTimePos())) return !cancelled();
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
  return false;
};

/**
 * Whether the media has at least one streamable audio track for this episode.
 * Derived straight from the library tracks (not from engine state that is
 * populated by an effect), so silent media is distinguishable from "audio
 * options not resolved yet".
 */
export const hasPlayableAudioTrack = (
  audioTracks: MediaDetails["audioTracks"],
  episodeId: string | null | undefined
): boolean =>
  selectEpisodeScoped(audioTracks, episodeId).some((track) => Boolean(track.initKey && track.chunks?.length));

export const resolvePlaybackSubtitleState = ({
  subtitleTracks,
  episodeId,
  selectedSubtitleId,
  subtitlesOffPicked = false,
  subtitlesOffLabel,
}: {
  subtitleTracks: SubtitleTrack[];
  episodeId: string | null | undefined;
  selectedSubtitleId: string;
  /**
   * The user chose Off (app menu or OSC). The engine seeds `selectedSubtitleId`
   * with "off" and lets this resolver fall through to the default track, so "off"
   * alone cannot tell "unset" from "the user turned subtitles off": without this
   * flag a user's Off was flipped back to the default track on the next run
   * (@bugfix #25 Orchard, one default French subtitle: Off never held).
   */
  subtitlesOffPicked?: boolean;
  subtitlesOffLabel: string;
}) => {
  const usableTracks = selectEpisodeScoped(subtitleTracks, episodeId).filter((track) => track.objectKey && !isOcrTwin(track));
  const options: SubtitleOption[] = [
    { id: "off", label: subtitlesOffLabel, language: "off", isDefault: false, objectKey: null },
    ...usableTracks.map((track) => ({
      id: track.id,
      label: formatPlayerTrackLabel(track.language, track.label),
      language: track.language,
      isDefault: Boolean(track.isDefault),
      objectKey: track.objectKey,
      format: track.format ?? null,
    })),
  ];
  let nextSelectedSubtitleId = selectedSubtitleId;
  if (subtitlesOffPicked && nextSelectedSubtitleId === "off") return { options, selectedSubtitleId: "off" };
  if (!(nextSelectedSubtitleId && nextSelectedSubtitleId !== "off" && options.some((option) => option.id === nextSelectedSubtitleId))) {
    nextSelectedSubtitleId =
      options.find((option) => option.id !== "off" && option.isDefault && option.objectKey)?.id ?? "off";
  }
  return { options, selectedSubtitleId: nextSelectedSubtitleId };
};

export const buildPlaybackChapters = ({
  chapters,
  fileId,
  formats,
  effectiveFormatId,
}: {
  chapters: MediaChapter[];
  fileId: string | null;
  formats: MediaFormat[];
  effectiveFormatId: string | null;
}) => {
  if (!fileId) return [];
  const fallback = formats[0]?.id ?? null;
  const chapterFormatId = effectiveFormatId ?? fallback;
  if (!chapterFormatId) return [];
  // Formats of one file are transcodes of the same timeline, but the runtime
  // writes chapter rows only for the source job's format; a format-job output
  // (e.g. 360p) has none. Use the rows of another format of this file then.
  // @bugfix chapters-missing-on-format-job-output
  const rowsFormatId = chapters.some((chapter) => chapter.formatId === chapterFormatId)
    ? chapterFormatId
    : formats.find((format) => chapters.some((chapter) => chapter.formatId === format.id))?.id ?? chapterFormatId;
  return chapters
    .filter((chapter) => chapter.formatId === rowsFormatId)
    .sort((a, b) => a.startSeconds - b.startSeconds);
};

export const buildPlaybackSkipMarkers = (
  skipMarkers: MediaSkipMarker[],
  episodeId: string | null | undefined
) =>
  selectEpisodeScoped(skipMarkers, episodeId)
    .slice()
    .sort((left, right) => left.startSeconds - right.startSeconds);
