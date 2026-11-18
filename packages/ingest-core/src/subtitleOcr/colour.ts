const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Limited-range ("CCIR") Y'CbCr → packed RGBA (r | g<<8 | b<<16 | a<<24 as bytes r,g,b,a).
 * BT.709 for HD subtitle canvases, BT.601 for SD (height ≤ 576), as ffmpeg's decoders do.
 */
export const ycbcrToRgba = (
  y: number,
  cb: number,
  cr: number,
  alpha: number,
  bt709: boolean
): [number, number, number, number] => {
  const l = 1.164 * (y - 16);
  const u = cb - 128;
  const v = cr - 128;
  if (bt709) {
    return [clampByte(l + 1.793 * v), clampByte(l - 0.534 * v - 0.213 * u), clampByte(l + 2.115 * u), alpha];
  }
  return [clampByte(l + 1.596 * v), clampByte(l - 0.813 * v - 0.391 * u), clampByte(l + 2.018 * u), alpha];
};
