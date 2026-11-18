import type { SubtitlePicture } from "./types";

export type GrayImage = { width: number; height: number; gray: Uint8Array };

export const OCR_PADDING_PX = 20;
/** Gray level below which a pixel counts as ink for cropping. */
const INK_THRESHOLD = 128;

/**
 * Composites the picture over black, takes luminance × alpha, inverts it to
 * dark-on-white, crops to the inked bounding box and pads 20 px of white —
 * native size, no upscaling. Null when the picture holds no ink.
 */
export const pictureToOcrImage = (picture: SubtitlePicture): GrayImage | null => {
  const { width, height, rgba } = picture;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const full = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const lum = ((0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) * rgba[p + 3]) / 255;
      const g = 255 - Math.min(255, Math.round(lum));
      full[i] = g;
      if (g < INK_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const paddedWidth = cropWidth + 2 * OCR_PADDING_PX;
  const gray = new Uint8Array(paddedWidth * (cropHeight + 2 * OCR_PADDING_PX)).fill(255);
  for (let y = 0; y < cropHeight; y++) {
    gray.set(full.subarray((minY + y) * width + minX, (minY + y) * width + maxX + 1), (y + OCR_PADDING_PX) * paddedWidth + OCR_PADDING_PX);
  }
  return { width: paddedWidth, height: cropHeight + 2 * OCR_PADDING_PX, gray };
};

/** Binary PGM (P5): a format Leptonica reads straight from memory. */
export const encodePgm = (image: GrayImage): Buffer =>
  Buffer.concat([Buffer.from(`P5\n${image.width} ${image.height}\n255\n`, "latin1"), Buffer.from(image.gray)]);
