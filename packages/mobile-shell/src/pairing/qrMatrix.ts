/// <reference path="./qrcode-core.d.ts" />
/**
 * QR code for a pairing screen: the `qrcode` package's pure encoder (the same package the desktop app and the
 * API use), imported from its core so Metro and the logic tests load the identical platform-free module,
 * not the Node (`fs`/`pngjs`) or browser (`canvas`) entry. react-native-svg draws the result.
 */
import { create } from "qrcode/lib/core/qrcode";

/** Quiet zone in modules; scanners need 4, a dark screen background makes the white frame carry it. */
export const QR_QUIET_ZONE = 4;

export type QrMatrix = { size: number; dark: (row: number, col: number) => boolean };

export const encodeQr = (payload: string): QrMatrix => {
  const symbol = create(payload, { errorCorrectionLevel: "M" });
  const { size } = symbol.modules;
  return { size, dark: (row, col) => symbol.modules.get(row, col) !== 0 };
};

/**
 * SVG path of every dark module as a 1x1 square, offset by the quiet zone, so the whole code is ONE
 * <Path> (a few thousand tiny <Rect>s would stall a Fire TV Stick).
 */
export const qrPathData = (matrix: QrMatrix, quietZone = QR_QUIET_ZONE): string => {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.dark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < matrix.size && matrix.dark(row, col)) col += 1;
      parts.push(`M${start + quietZone} ${row + quietZone}h${col - start}v1h-${col - start}z`);
    }
  }
  return parts.join("");
};

/** Side of the whole drawing in modules, quiet zone included. */
export const qrViewSize = (matrix: QrMatrix, quietZone = QR_QUIET_ZONE): number => matrix.size + quietZone * 2;
