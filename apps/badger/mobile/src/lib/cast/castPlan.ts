/**
 * Decides what the phone sends to a cast target for one title (UX-TV-03): which video version, which audio, which
 * subtitle, or why it refuses. Pure: the player session (`usePlayerSession`) hands over the ingest metadata of the played
 * file and the start-track plan (`planStartTracks`); the result is the trimmed metadata the native cast server serves.
 *
 * What the rule says, and where it lives here:
 * - "repackages the video": the stored video is already segmented fMP4 (CMAF) that Google Cast and Apple HLS play; the
 *   native server only decrypts it and writes an HLS playlist of the ONE version chosen here (`video`).
 * - "converts the sound only when the device cannot play it": `audioVerdict`. The phone has no transcoder; today ingest
 *   stores every audio track as AAC (`encodeDashAudio` in packages/ingest-core encodes non-AAC sources; keeping the
 *   original tracks too for MPV-TV-03 is issue #755), which both targets play. A track whose codec the target does not
 *   list is left out of the cast (`omittedAudio`); if no track is left the title is refused (`no-playable-audio`).
 * - "turns text subtitles into the device's subtitle format": the chosen text subtitle is converted to WebVTT by
 *   `strictWebVtt` (@space/shared/subtitleVtt, shared with the web player) before the server hands it over.
 * - "A title whose video the device cannot play, or whose chosen subtitles are images (PGS, VobSub), is not cast".
 */
import type { AudioTrack, IngestMetadata, SubtitleTrack, VideoFormat } from "@space/mobile-mpv-playback";
import { QUALITY_HEIGHT_PX } from "@space/playback-abr";
import { audioVerdict, videoVerdict, type CastProfile } from "./castProfiles";

/** Why a title is not cast: the suffix of the `cast.refused.<reason>` i18n key. */
export type CastRefusalReason = "video-unsupported" | "image-subtitles" | "no-playable-audio" | "no-video";

/** What the player picked at start for this title (`planStartTracks`): indexes into the metadata's track lists. */
export type CastStartTracks = {
  audioIdx: number | null;
  subtitle: { mode: "off" } | { mode: "default" } | { mode: "track"; idx: number };
};

export type CastPlan =
  | {
      ok: true;
      profile: CastProfile;
      video: VideoFormat;
      /** Playable audio, the chosen one first and flagged default. */
      audio: AudioTrack[];
      omittedAudio: { id: string; reason: string }[];
      /** The one text subtitle to show (converted to WebVTT by the caller), or null. */
      subtitle: SubtitleTrack | null;
      /** Versions that were not playable on this target, for the log. */
      skippedVideos: { id: string; reason: string }[];
      /** What the native cast server is started with: one video, the playable audio, the chosen subtitle, no chapters. */
      serverMetadata: IngestMetadata;
    }
  | { ok: false; reason: CastRefusalReason; detail: string };

const heightOf = (video: VideoFormat): number => video.height ?? QUALITY_HEIGHT_PX[video.quality] ?? 0;

const isImageSubtitle = (track: SubtitleTrack): boolean => track.format === "pgs" || track.format === "vobsub";

/** The version to send: the tallest the target plays; at the same height H.264 first (it plays everywhere), then bitrate. */
const compareVideos = (a: VideoFormat, b: VideoFormat): number => {
  const byHeight = heightOf(b) - heightOf(a);
  if (byHeight !== 0) return byHeight;
  const aAvc = /avc|h\.?264/i.test(`${a.codec} ${a.codecString}`) ? 0 : 1;
  const bAvc = /avc|h\.?264/i.test(`${b.codec} ${b.codecString}`) ? 0 : 1;
  if (aAvc !== bAvc) return aAvc - bAvc;
  return (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
};

export const planCast = (input: { metadata: IngestMetadata; startTracks: CastStartTracks; profile: CastProfile }): CastPlan => {
  const { metadata, startTracks, profile } = input;
  if (metadata.videos.length === 0) return { ok: false, reason: "no-video", detail: "the file has no video version" };

  const skippedVideos: { id: string; reason: string }[] = [];
  const playable: VideoFormat[] = [];
  for (const video of metadata.videos) {
    const verdict = videoVerdict(profile, { codec: video.codec, codecString: video.codecString, height: heightOf(video) || null });
    if (verdict.playable) playable.push(video);
    else skippedVideos.push({ id: video.id, reason: verdict.reason });
  }
  console.info("[cast.plan] video", JSON.stringify({ profile: profile.id, playable: playable.map((v) => v.id), skipped: skippedVideos }));
  if (playable.length === 0) {
    return { ok: false, reason: "video-unsupported", detail: skippedVideos.map((s) => `${s.id}: ${s.reason}`).join("; ") };
  }
  const video = [...playable].sort(compareVideos)[0]!;

  // Subtitle: only an explicit pick, or the file's default subtitle, is shown; a chosen image subtitle (picked or default) refuses.
  let subtitle: SubtitleTrack | null = null;
  if (startTracks.subtitle.mode === "track") {
    const picked = metadata.subtitleTracks[startTracks.subtitle.idx] ?? null;
    if (picked && isImageSubtitle(picked)) {
      return { ok: false, reason: "image-subtitles", detail: `chosen subtitle ${picked.id} is ${picked.format}` };
    }
    subtitle = picked;
  } else if (startTracks.subtitle.mode === "default") {
    // The file's default subtitle is the one the player would show, so it is a chosen subtitle too: an image one refuses.
    const fileDefault = metadata.subtitleTracks.find((track) => track.isDefault) ?? null;
    if (fileDefault && isImageSubtitle(fileDefault)) {
      return { ok: false, reason: "image-subtitles", detail: `default subtitle ${fileDefault.id} is ${fileDefault.format}` };
    }
    subtitle = fileDefault;
  }

  // Audio: playable tracks only; the track the player would start with leads and is the default rendition.
  const chosenAudio = startTracks.audioIdx != null ? metadata.audioTracks[startTracks.audioIdx] ?? null : null;
  const omittedAudio: { id: string; reason: string }[] = [];
  const audioPlayable: AudioTrack[] = [];
  for (const track of metadata.audioTracks) {
    if (audioVerdict(profile, { codec: track.codec, codecString: track.codecString }) === "play") audioPlayable.push(track);
    else omittedAudio.push({ id: track.id, reason: `codec ${track.codec || track.codecString || "unknown"} is not in the device's list` });
  }
  if (metadata.audioTracks.length > 0 && audioPlayable.length === 0) {
    return { ok: false, reason: "no-playable-audio", detail: omittedAudio.map((o) => `${o.id}: ${o.reason}`).join("; ") };
  }
  const lead =
    (chosenAudio && audioPlayable.find((track) => track.id === chosenAudio.id)) ??
    audioPlayable.find((track) => track.isDefault) ??
    audioPlayable[0] ??
    null;
  const audio = audioPlayable
    .map((track) => ({ ...track, isDefault: lead != null && track.id === lead.id }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

  const serverMetadata: IngestMetadata = {
    encryptionKeyBase64: metadata.encryptionKeyBase64,
    videos: [video],
    audioTracks: audio,
    subtitleTracks: subtitle ? [{ ...subtitle, isDefault: true }] : [],
    chapters: [],
  };
  console.info(
    "[cast.plan] ok",
    JSON.stringify({ profile: profile.id, video: video.id, audio: audio.map((a) => a.id), omittedAudio, subtitle: subtitle?.id ?? null }),
  );
  return { ok: true, profile, video, audio, omittedAudio, subtitle, skippedVideos, serverMetadata };
};
