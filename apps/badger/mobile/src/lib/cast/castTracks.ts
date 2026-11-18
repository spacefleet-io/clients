/**
 * The audio and subtitle pickers of the cast screen (UX-TV-03): which tracks the user can pick while a title plays on a Cast
 * or AirPlay device, and what a pick changes. Pure: the cast hook (`useCastPlayback`) re-plans and reloads the device with
 * the start-track plan these functions return. Indexes are into the played file's own track lists (`IngestMetadata`), the
 * same ones `planStartTracks` and `planCast` use.
 */
import type { AudioTrack, IngestMetadata, SubtitleTrack } from "@space/mobile-mpv-playback";
import type { CastPlan, CastStartTracks } from "./castPlan";
import { audioVerdict, type CastProfile } from "./castProfiles";

export type CastTrackChoices = {
  /** Every audio track of the file the device plays (`audioVerdict`), with its index in the file. */
  audio: { idx: number; track: AudioTrack }[];
  /** Every subtitle of the file; picture ones (PGS, VobSub) stay listed but cannot be cast (`castable: false`). */
  subtitles: { idx: number; track: SubtitleTrack; castable: boolean }[];
};

export const castTrackChoices = (metadata: IngestMetadata, profile: CastProfile): CastTrackChoices => ({
  audio: metadata.audioTracks
    .map((track, idx) => ({ idx, track }))
    .filter(({ track }) => audioVerdict(profile, { codec: track.codec, codecString: track.codecString }) === "play"),
  subtitles: metadata.subtitleTracks.map((track, idx) => ({ idx, track, castable: track.format === "vtt" })),
});

/** What is on the device now, as indexes into the file: the lead audio of the plan and its subtitle (-1 = off). */
export type CastActiveTracks = { audioIdx: number | null; subtitleIdx: number };

export const activeCastTracks = (metadata: IngestMetadata, plan: Extract<CastPlan, { ok: true }>): CastActiveTracks => {
  const lead = plan.audio.find((track) => track.isDefault) ?? plan.audio[0] ?? null;
  const audioIdx = lead ? metadata.audioTracks.findIndex((track) => track.id === lead.id) : -1;
  const subtitleIdx = plan.subtitle ? metadata.subtitleTracks.findIndex((track) => track.id === plan.subtitle?.id) : -1;
  return { audioIdx: audioIdx >= 0 ? audioIdx : null, subtitleIdx };
};

/**
 * The start-track plan that keeps what is on the device and changes one track, or null when the pick changes nothing
 * (same track, an index out of range, a track the device cannot play, a picture subtitle). Subtitle -1 = off.
 */
export const pickCastTrack = (
  choices: CastTrackChoices,
  active: CastActiveTracks,
  pick: { kind: "audio"; idx: number } | { kind: "subtitle"; idx: number },
): CastStartTracks | null => {
  const subtitleOf = (idx: number): CastStartTracks["subtitle"] => (idx >= 0 ? { mode: "track", idx } : { mode: "off" });
  if (pick.kind === "audio") {
    if (pick.idx === active.audioIdx || !choices.audio.some((choice) => choice.idx === pick.idx)) return null;
    return { audioIdx: pick.idx, subtitle: subtitleOf(active.subtitleIdx) };
  }
  if (pick.idx === active.subtitleIdx) return null;
  if (pick.idx >= 0 && !choices.subtitles.some((choice) => choice.idx === pick.idx && choice.castable)) return null;
  return { audioIdx: active.audioIdx, subtitle: subtitleOf(pick.idx) };
};
