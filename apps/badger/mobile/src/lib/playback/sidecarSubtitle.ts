import type { MpvTrack, SubtitleTrack } from "@space/mobile-mpv-playback";
import { sidecarObjectKey, type SidecarReason } from "@space/mobile-mpv-playback/ocrTwin";

/**
 * The sidecar (`sub-add`) subtitle mpv is currently showing, matched back to the library's
 * subtitle list by the title/language the controls passed to `addSubtitle`. `loadfile replace`
 * drops sidecars, so a reload must re-add this one (see `PlayerScreen.switchVariant`). An OCR twin is loaded under
 * its picture track's title, so this returns the picture track (which carries the twin).
 */
export const findActiveSidecar = (tracks: MpvTrack[], subtitleTracks: SubtitleTrack[]): SubtitleTrack | null => {
  const selected = tracks.find((track) => track.type === "sub" && track.selected && track.external === true);
  if (!selected) return null;
  const byTitle = selected.title ? subtitleTracks.find((sub) => sub.label === selected.title) : undefined;
  if (byTitle) return byTitle;
  const lang = selected.lang?.toLowerCase();
  return (lang && subtitleTracks.find((sub) => sub.language.toLowerCase() === lang)) || null;
};

/** The playback proxy's URL for one stored object, decrypted on the way (subtitle sidecars, seek-bar preview sheets). */
export const playbackObjectUrl = (playUrl: string, objectKey: string): string =>
  `${playUrl.split("/playback/")[0]}/playback/object/${encodeURIComponent(objectKey)}`;

/**
 * Same URL shape `PlayerControls` uses when the user picks a subtitle. Under direct rendering a picture track with an
 * OCR twin loads the twin's SRT instead (PLAY-TRACK-05, `sidecarObjectKey`).
 */
export const sidecarSubtitleUrl = (playUrl: string, sub: SubtitleTrack, directRender: boolean, reason: SidecarReason): string =>
  playbackObjectUrl(playUrl, sidecarObjectKey(sub, directRender, reason));
