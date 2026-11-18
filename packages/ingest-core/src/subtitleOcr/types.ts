/** One decoded subtitle picture, cropped to the drawn area, straight (non-premultiplied) RGBA. */
export type SubtitlePicture = {
  startMs: number;
  endMs: number;
  width: number;
  height: number;
  rgba: Uint8Array;
};

export type PictureSubtitleCodec = "hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle";

export type DecodedPictureSubtitles = {
  codec: PictureSubtitleCodec;
  pictures: SubtitlePicture[];
  /** Display sets / packets that could not be decoded and were skipped. */
  failures: number;
};

/** Structured log sink: `event` carries the `[subtitle-ocr]` prefix, `payload` the fields. */
export type SubtitleOcrLog = (event: string, payload: Record<string, unknown>) => void;

/** One JSON line on the OCR child's stdout. */
export type SubtitleOcrChildMessage =
  | { type: "progress"; done: number; total: number }
  | { type: "log"; event: string; payload: Record<string, unknown> }
  | { type: "result"; codec: string; pictures: number; cues: number; empty: number; failures: number; ms: number }
  | { type: "error"; message: string };

/** Fallback cue length when a picture's end time is unknown and no later picture exists. */
export const DEFAULT_PICTURE_DURATION_MS = 4000;

/**
 * Open-ended pictures (end unknown) end at the next picture's start, or after
 * DEFAULT_PICTURE_DURATION_MS for the last one. Pictures are sorted by start first.
 */
export const closePictureTimeline = (
  pictures: Array<Omit<SubtitlePicture, "endMs"> & { endMs: number | null }>
): SubtitlePicture[] => {
  const sorted = [...pictures].sort((a, b) => a.startMs - b.startMs);
  return sorted.map((picture, i) => {
    const next = sorted[i + 1];
    const endMs =
      picture.endMs !== null && picture.endMs > picture.startMs
        ? picture.endMs
        : next && next.startMs > picture.startMs
          ? next.startMs
          : picture.startMs + DEFAULT_PICTURE_DURATION_MS;
    return { ...picture, endMs };
  });
};
