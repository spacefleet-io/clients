/**
 * OCR twins of picture subtitles (PLAY-TRACK-05). The desktop runtime turns every picture subtitle track (PGS, VobSub,
 * DVB) into an SRT stored as an extra `media_subtitles` row: `source: "ocr"`, `derivedFromSubtitleId` = the picture
 * row's id. A twin is never a track of its own: every app lists the picture row only, and the Android TV loads the
 * twin in its place while mpv renders straight from the hardware decoder (no picture subtitles there).
 *
 * Filter twins out where tracks are LISTED or PLAYED, never where details are written back (a media upsert replaces
 * every subtitle row of the title, so dropping twins there would delete them).
 */

/** `media_subtitles.source` of an OCR twin. */
export const OCR_SUBTITLE_SOURCE = "ocr";

/** True for an OCR twin row: it carries the id of its picture row, or (a writer that dropped the link) its `ocr` source. */
export const isOcrTwin = (track: { source?: string | null; derivedFromSubtitleId?: string | null }): boolean =>
  Boolean(track.derivedFromSubtitleId) || track.source === OCR_SUBTITLE_SOURCE;

/**
 * Each picture row's OCR twin, keyed by the picture row's id (the twin's `derivedFromSubtitleId`). A twin without a
 * stored object, or without the link to its picture row, pairs with nothing.
 */
export const ocrTwinsByPictureId = <T extends { source?: string | null; derivedFromSubtitleId?: string | null; objectKey?: string | null }>(
  tracks: readonly T[],
): Map<string, T> => {
  const twins = new Map<string, T>();
  for (const track of tracks) {
    if (isOcrTwin(track) && track.derivedFromSubtitleId && track.objectKey) twins.set(track.derivedFromSubtitleId, track);
  }
  return twins;
};
