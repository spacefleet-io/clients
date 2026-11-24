/**
 * Seek-bar preview pictures (MPV-PREV-01). The desktop runtime makes them at import from the local file: one picture
 * every `intervalSeconds` (5), `pictureWidth` (160) pixels wide with the height following the video's shape, packed
 * `columns` x `rows` (10 x 10) per JPEG sheet, left to right then top to bottom. Each sheet is one encrypted object on
 * the media's silo, stored like a subtitle object (`/playback/object/<objectKey>` decrypts it). The record sits on the
 * video's source format (`MediaFormat.previewSheets`, column `media_formats.preview_sheets`, JSON).
 *
 * Picture `i` shows the video at about `i * intervalSeconds` and stands for the moment range
 * `[i * intervalSeconds, (i + 1) * intervalSeconds)`. Sheet `s` holds pictures `firstPicture .. firstPicture +
 * pictureCount - 1`; every sheet is `columns` pictures wide, and the last one only as many rows as it needs.
 */
export type MediaPreviewSheet = {
  objectKey: string;
  /** Sheet size as the upload reports it (the JPEG's own bytes), same convention as video chunks and subtitles. */
  sizeBytes: number;
  /** Index of the sheet's first picture in the whole video. */
  firstPicture: number;
  pictureCount: number;
};

export type MediaPreviewSheets = {
  version: 1;
  intervalSeconds: number;
  pictureWidth: number;
  pictureHeight: number;
  /** Pictures per sheet row. */
  columns: number;
  /** Rows of a full sheet (the last sheet may have fewer). */
  rows: number;
  /** Pictures across all sheets: ceil(duration / intervalSeconds). */
  pictureCount: number;
  sheets: MediaPreviewSheet[];
  /**
   * The video's skip signature (META-SKIP-04), made by the same decode: one encrypted gzip JSON object on the same
   * silo. Absent on records made before it existed (the catch-up makes it then, MPV-PREV-03).
   */
  skipSignature?: MediaSkipSignatureRef;
};

export type MediaSkipSignatureRef = { objectKey: string; sizeBytes: number; version: number };

export const PREVIEW_SHEETS_VERSION = 1;
export const PREVIEW_INTERVAL_SECONDS = 5;
export const PREVIEW_PICTURE_WIDTH = 160;
export const PREVIEW_SHEET_COLUMNS = 10;
export const PREVIEW_SHEET_ROWS = 10;

export type PreviewPictureLocation = {
  sheet: MediaPreviewSheet;
  sheetIndex: number;
  /** Index of the picture in the whole video (not within its sheet). */
  pictureIndex: number;
  /** Crop rectangle of the picture inside the decoded sheet, in pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Where the picture for `seconds` sits: which sheet, and the rectangle to crop from it. Null when there is none. */
export const locatePreviewPicture = (
  previews: MediaPreviewSheets | null | undefined,
  seconds: number
): PreviewPictureLocation | null => {
  if (!previews || previews.pictureCount <= 0 || previews.sheets.length === 0) return null;
  if (!Number.isFinite(seconds) || previews.intervalSeconds <= 0) return null;
  const pictureIndex = Math.min(
    previews.pictureCount - 1,
    Math.max(0, Math.floor(seconds / previews.intervalSeconds))
  );
  const sheetIndex = previews.sheets.findIndex(
    (entry) => pictureIndex >= entry.firstPicture && pictureIndex < entry.firstPicture + entry.pictureCount
  );
  if (sheetIndex < 0) return null;
  const sheet = previews.sheets[sheetIndex]!;
  const within = pictureIndex - sheet.firstPicture;
  return {
    sheet,
    sheetIndex,
    pictureIndex,
    x: (within % previews.columns) * previews.pictureWidth,
    y: Math.floor(within / previews.columns) * previews.pictureHeight,
    width: previews.pictureWidth,
    height: previews.pictureHeight,
  };
};

/** Parse the stored JSON column; anything malformed reads as "no previews". */
export const parsePreviewSheets = (raw: unknown): MediaPreviewSheets | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const candidate = value as Partial<MediaPreviewSheets> | null;
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.sheets)) return null;
  const numbers = [candidate.intervalSeconds, candidate.pictureWidth, candidate.pictureHeight, candidate.columns, candidate.rows, candidate.pictureCount];
  if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0)) return null;
  const sheets = candidate.sheets.filter(
    (sheet): sheet is MediaPreviewSheet =>
      Boolean(sheet) && typeof sheet.objectKey === "string" && sheet.objectKey.length > 0 && Number.isFinite(sheet.firstPicture) && Number.isFinite(sheet.pictureCount)
  );
  if (sheets.length === 0) return null;
  const { skipSignature, ...rest } = candidate as MediaPreviewSheets;
  const signature =
    skipSignature &&
    typeof skipSignature === "object" &&
    typeof skipSignature.objectKey === "string" &&
    skipSignature.objectKey.length > 0 &&
    Number.isFinite(skipSignature.sizeBytes) &&
    Number.isFinite(skipSignature.version)
      ? { objectKey: skipSignature.objectKey, sizeBytes: skipSignature.sizeBytes, version: skipSignature.version }
      : null;
  return { ...rest, version: PREVIEW_SHEETS_VERSION, sheets, ...(signature ? { skipSignature: signature } : {}) };
};

/** Object keys of every sheet and of the skip signature (deletion walks, storage checks). */
export const previewSheetKeys = (previews: MediaPreviewSheets | null | undefined): string[] =>
  previews
    ? [...previews.sheets.map((sheet) => sheet.objectKey), ...(previews.skipSignature ? [previews.skipSignature.objectKey] : [])]
    : [];
