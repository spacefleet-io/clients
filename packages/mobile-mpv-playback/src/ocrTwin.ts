import type { PlaybackSnapshot, SubtitleTrack } from "./types";

/**
 * Picture subtitles under direct rendering (PLAY-TRACK-05). On Android TV mpv renders straight from the hardware
 * decoder (`vo=mediacodec_embed`, PLAT-TV-06): it has no OSD, the app draws text lines from `sub-text`, and a picture
 * subtitle (PGS, VobSub, DVB) has no text, so it never shows. When the desktop runtime made an OCR twin of the picture
 * track (an SRT row, `SubtitleTrack.ocrTwin`), the twin is loaded in its place. The menu row, the remembered choice and
 * the track title in mpv stay the picture track's; only the file `sub-add` loads changes. A picture track without a
 * twin (never OCR'd, e.g. CJK) stays in the menu greyed out, can't be picked and is never started from a remembered
 * choice. Phones, Apple TV and the TV's `vo=gpu` fallback draw pictures themselves and always load the picture track.
 */

/** mpv `current-vo` while it renders straight from the hardware decoder. */
export const DIRECT_RENDER_VO = "mediacodec_embed";

/**
 * Direct rendering, from a snapshot's `current-vo`: true under `vo=mediacodec_embed`, false on any other VO, null while
 * there is no VO yet (before the first frame, or between files) — unknown, never "off".
 */
export const directRenderOf = (snapshot: Pick<PlaybackSnapshot, "currentVo"> | null | undefined): boolean | null => {
  const vo = snapshot?.currentVo ?? "";
  return vo ? vo === DIRECT_RENDER_VO : null;
};

/** The track is a picture subtitle (PGS / VobSub-in-Matroska) with an OCR twin, and direct rendering can't show it. */
export const loadsOcrTwin = (sub: Pick<SubtitleTrack, "format" | "ocrTwin">, directRender: boolean): boolean =>
  directRender && (sub.format === "pgs" || sub.format === "vobsub") && Boolean(sub.ocrTwin);

/** A picture subtitle (PGS / VobSub-in-Matroska) without an OCR twin: under direct rendering it can't show at all. */
export const unplayableUnderDirectRender = (sub: Pick<SubtitleTrack, "format" | "ocrTwin">, directRender: boolean): boolean =>
  directRender && (sub.format === "pgs" || sub.format === "vobsub") && !sub.ocrTwin;

/** Why a sidecar is being loaded; logged with every picture-track resolution. */
export type SidecarReason = "start" | "pick" | "quality_switch" | "render_switch";

/**
 * Object key of the file to `sub-add` for `sub`: its OCR twin's SRT when {@link loadsOcrTwin}, else the track's own
 * object. Every picture track is logged (`[mpv-subtitles] sidecar.resolve`) with the decision and its reason; a picture
 * track without a twin under direct rendering is greyed out in the menu, so only a stray caller reaches the `no_twin` case.
 */
export const sidecarObjectKey = (sub: SubtitleTrack, directRender: boolean, reason: SidecarReason): string => {
  if (sub.format !== "pgs" && sub.format !== "vobsub") return sub.url;
  const twin = sub.ocrTwin ?? null;
  const useTwin = loadsOcrTwin(sub, directRender);
  console.info(
    "[mpv-subtitles] sidecar.resolve",
    JSON.stringify({
      reason,
      pickedId: sub.id,
      format: sub.format,
      twinId: twin?.id ?? null,
      directRender,
      load: useTwin ? "ocr_twin" : "picture",
      why: !directRender ? "not_direct_render" : twin ? "direct_render" : "no_twin",
    }),
  );
  return useTwin && twin ? twin.url : sub.url;
};
