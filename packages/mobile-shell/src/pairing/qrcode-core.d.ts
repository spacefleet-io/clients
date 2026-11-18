/** The platform-free QR encoder inside `qrcode` (no typings ship for the deep path). */
declare module "qrcode/lib/core/qrcode" {
  export type QrSymbol = {
    modules: { size: number; get: (row: number, col: number) => number };
  };
  export function create(text: string, options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" }): QrSymbol;
}
