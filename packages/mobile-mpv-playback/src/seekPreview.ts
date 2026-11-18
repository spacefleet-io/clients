/**
 * Seek-bar preview pictures (MPV-PREV-01) as the controls see them. The owner knows where the pictures are (the
 * library record) and how to fetch and decrypt a sheet; the controls only ask for the picture of a moment and draw it
 * above the bar. React Native's `Image` cannot crop, so a picture is drawn by clipping a box the size of one picture
 * (`overflow: hidden`) and offsetting the whole sheet inside it (`previewPictureLayout`).
 */

/** One picture to draw: a crop of a decoded sheet. Every size is in sheet pixels. */
export type SeekPreviewFrame = {
  /** The decoded sheet, held in memory (a `data:` URI): never a file on disk. */
  uri: string;
  sheetWidth: number;
  sheetHeight: number;
  /** Crop rectangle of the picture inside the sheet. */
  x: number;
  y: number;
  width: number;
  height: number;
};

/** What the owner hands the controls for one playback. No source (null / undefined) = no previews, the bar as before. */
export type SeekPreviewSource = {
  /** The picture for `seconds` when its sheet is already loaded, else null (nothing is drawn, no placeholder). */
  frameAt: (seconds: number) => SeekPreviewFrame | null;
  /** The bar points at `seconds`: load that sheet (once per playback) and the next / previous one near its edges. */
  want: (seconds: number) => void;
  /** `listener` runs when a sheet finished loading; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
};

/** Width the picture takes on screen, in dp: about its own 160 pixels on a phone, a little more across a TV room. */
export const SEEK_PREVIEW_WIDTH_PHONE = 160;
export const SEEK_PREVIEW_WIDTH_TV = 208;

export type SeekPreviewLayout = {
  /** The clipping box: one picture scaled to `displayWidth`. */
  box: { width: number; height: number };
  /** The whole sheet inside the box, shifted so only the picture shows. */
  image: { width: number; height: number; left: number; top: number };
};

export const previewPictureLayout = (frame: SeekPreviewFrame, displayWidth: number): SeekPreviewLayout => {
  const scale = displayWidth / frame.width;
  return {
    box: { width: displayWidth, height: Math.round(frame.height * scale) },
    image: {
      width: frame.sheetWidth * scale,
      height: frame.sheetHeight * scale,
      left: -frame.x * scale,
      top: -frame.y * scale,
    },
  };
};

/**
 * Left edge of the picture inside the bar, centred on the pointed position (`pointerX`, from the bar's left edge) and
 * kept over the bar.
 */
export const previewLeft = (pointerX: number, pictureWidth: number, barWidth: number): number =>
  Math.max(0, Math.min(Math.max(0, barWidth - pictureWidth), pointerX - pictureWidth / 2));
