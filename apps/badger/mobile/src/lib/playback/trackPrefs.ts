/**
 * PLAY-TRACK-04 on the phone: the synced per-movie / per-SHOW audio + subtitle memory
 * (`track_prefs_v1:<mediaId>`, see `@space/shared/trackPrefs`) turned into a play-start plan and
 * into prefs patches for the user's picks. Pure: the player applies the plan through `MpvControl`.
 */
import type { AudioTrack, MpvTrack, SubtitleTrack } from "@space/mobile-mpv-playback";
import { unplayableUnderDirectRender } from "@space/mobile-mpv-playback/ocrTwin";
import {
  audioPickPatch,
  languagesMatch,
  resolveTrackSelection,
  subtitlePickPatch,
  type TrackPrefs,
  type TrackPrefsPatch,
} from "@space/shared/trackPrefs";
import { sidecarSubtitleUrl } from "./sidecarSubtitle";

export type StartTrackPlan = {
  /** Index into the file's audio tracks to switch to, or null to keep mpv's default audio. */
  audioIdx: number | null;
  /** `off`/`default` change nothing at start (subtitles start off); `track` loads that sidecar. */
  subtitle: { mode: "off" } | { mode: "default" } | { mode: "track"; idx: number };
};

/**
 * The profile's Settings defaults (PLAY-TRACK-01 audio, ACCT-SQUAD-03 subtitles); `null` / absent = no preference.
 * `subtitleSetAt`: when the subtitle language was last changed; newer than the title's choice, it wins (PLAY-TRACK-11).
 */
export type StartTrackDefaults = { audioLanguage?: string | null; subtitleLanguage?: string | null; subtitleSetAt?: string | null };

/**
 * What to start with, per title: the remembered choice of the movie / show when this file has a matching track,
 * else the Settings "Default audio language" / "Subtitle language" when this file has it, else nothing is forced
 * (mpv's own default audio, subtitles off). Audio and subtitles fall back separately. A "Subtitle language" changed
 * after the title's last choice comes first for subtitles when the file has it (PLAY-TRACK-11).
 * A remembered track the file lacks is simply not applied (the record is never rewritten).
 * `directRender` (Android TV `vo=mediacodec_embed`): a picture subtitle without an OCR twin can't show, so it is never
 * started — the remembered choice falls to another matching track, else to nothing (PLAY-TRACK-05).
 */
export const planStartTracks = (
  prefs: TrackPrefs | null,
  audioTracks: readonly AudioTrack[],
  subtitleTracks: readonly SubtitleTrack[],
  defaults: StartTrackDefaults = {},
  directRender = false,
): StartTrackPlan => {
  const startable = subtitleTracks.filter((track) => !unplayableUnderDirectRender(track, directRender));
  if (startable.length !== subtitleTracks.length) {
    console.info(
      "[mpv-subtitles] start.unplayable_skipped",
      JSON.stringify({ directRender, skippedIds: subtitleTracks.filter((track) => !startable.includes(track)).map((track) => track.id) }),
    );
  }
  const selection = resolveTrackSelection({
    prefs,
    defaults: {
      audioLanguage: defaults.audioLanguage ?? null,
      subtitle: defaults.subtitleLanguage ? { language: defaults.subtitleLanguage } : null,
      subtitleSetAt: defaults.subtitleSetAt ?? null,
    },
    audioTracks: audioTracks.map((track) => ({ id: track.id, language: track.language })),
    subtitleTracks: startable.map((track) => ({ id: track.id, language: track.language, format: track.format })),
  });
  const audioIdx = selection.audioSource !== "none" ? audioTracks.findIndex((track) => track.id === selection.audioTrackId) : -1;
  const { subtitle } = selection;
  const subtitleIdx = subtitle.mode === "track" ? subtitleTracks.findIndex((track) => track.id === subtitle.id) : -1;
  return {
    audioIdx: audioIdx >= 0 ? audioIdx : null,
    subtitle:
      subtitle.mode === "off"
        ? { mode: "off" }
        : subtitleIdx >= 0
          ? { mode: "track", idx: subtitleIdx }
          : { mode: "default" },
  };
};

/** The slice of `LibraryDb.setTrackPrefs` a pick needs (a fake in tests). */
export type TrackPrefsSaver = (mediaId: string, patch: TrackPrefsPatch) => Promise<unknown>;

const saveFailed = (err: unknown) => console.warn("playback.tracks.save_failed", JSON.stringify({ error: String(err) }));

/**
 * The player's audio picker callback: remembers the pick for the movie / show (overwriting its previous audio choice).
 * A track without a usable language writes nothing; a failed write is logged, never thrown into the player.
 */
export const rememberAudioPick = async (save: TrackPrefsSaver, mediaId: string, track: Pick<AudioTrack, "language">): Promise<void> => {
  const patch = audioPickPatch(track);
  if (patch) await save(mediaId, patch).catch(saveFailed);
};

/** The player's subtitle picker callback (`null` = Off); same contract as `rememberAudioPick`. */
export const rememberSubtitlePick = async (
  save: TrackPrefsSaver,
  mediaId: string,
  track: Pick<SubtitleTrack, "language" | "format"> | null,
): Promise<void> => {
  const patch = subtitlePickPatch(track);
  if (patch) await save(mediaId, patch).catch(saveFailed);
};

/**
 * mpv's id (1-based per type) for the library audio track at `idx`. A file often carries several tracks in
 * one language (English, then English commentary), so the pick is the same-language track of the same rank:
 * the second English library track is mpv's second English track. Else by position.
 */
export const resolveMpvAudioId = (
  mpvTracks: readonly MpvTrack[],
  audioTracks: readonly Pick<AudioTrack, "language">[],
  idx: number,
): number => {
  const audioMpvTracks = mpvTracks.filter((mpvTrack) => mpvTrack.type === "audio");
  const language = audioTracks[idx]?.language;
  const rank = audioTracks.slice(0, idx).filter((track) => languagesMatch(track.language, language)).length;
  const sameLanguage = audioMpvTracks.filter((mpvTrack) => languagesMatch(mpvTrack.lang, language));
  return sameLanguage[rank]?.id ?? audioMpvTracks[idx]?.id ?? idx + 1;
};

/** The slice of `MpvControl` the start plan needs (a fake in tests). */
export type StartTrackPlayer = {
  getTrackList: () => Promise<MpvTrack[]>;
  setAudioTrack: (id: number) => Promise<unknown>;
  addSubtitle: (url: string, language: string | null, title: string | null) => Promise<unknown>;
};

/**
 * Apply the plan to the running player once, after the first frame. `null` audio / `off` / `default` change
 * nothing (mpv keeps its default audio, subtitles start off), so a title with no usable record plays exactly as before.
 * `directRender` (Android TV `vo=mediacodec_embed`): a picture subtitle with an OCR twin starts on the twin's SRT
 * (PLAY-TRACK-05); the plan, the title in mpv and the remembered choice stay the picture track's.
 */
export const applyStartTracks = async (input: {
  plan: StartTrackPlan;
  audioTracks: readonly AudioTrack[];
  subtitleTracks: readonly SubtitleTrack[];
  playUrl: string;
  directRender: boolean;
  player: StartTrackPlayer;
}): Promise<void> => {
  const { plan, audioTracks, subtitleTracks, playUrl, directRender, player } = input;
  if (plan.audioIdx !== null) {
    if (audioTracks[plan.audioIdx]) {
      await player.setAudioTrack(resolveMpvAudioId(await player.getTrackList(), audioTracks, plan.audioIdx));
    }
  }
  if (plan.subtitle.mode === "track") {
    const sub = subtitleTracks[plan.subtitle.idx];
    if (sub) {
      await player.addSubtitle(sidecarSubtitleUrl(playUrl, sub, directRender, "start"), sub.language ?? null, sub.label ?? null);
    }
  }
};
