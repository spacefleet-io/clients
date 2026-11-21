/**
 * PAR-META-22 (Main 2026-11-21): main cuts JPEG and PNG covers to their square itself; a picture it cannot decode
 * (WebP, GIF) is sent here, the window decodes it (a GIF's first frame), draws its square on a canvas at most 1200 px
 * and answers a JPEG, or a PNG when the picture is see-through. Null when the picture does not decode.
 */
import { PARROT_COVER_LARGE_WIDTH, parrotCoverSquare } from "@space/parrot-core";
import type { ParrotCoverCutRequest } from "../../shared/ipc";

const encode = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, type === "image/jpeg" ? 0.9 : undefined));

export const cutCover = async ({ bytes, mime, crop }: ParrotCoverCutRequest): Promise<Uint8Array | null> => {
  const picture = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const square = parrotCoverSquare(picture.width, picture.height, crop);
    const side = Math.min(square.side, PARROT_COVER_LARGE_WIDTH);
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(picture, square.x, square.y, square.side, square.side, 0, 0, side, side);
    const pixels = context.getImageData(0, 0, side, side).data;
    let seeThrough = false;
    for (let at = 3; at < pixels.length; at += 4) {
      if (pixels[at] < 255) {
        seeThrough = true;
        break;
      }
    }
    const blob = await encode(canvas, seeThrough ? "image/png" : "image/jpeg");
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    picture.close();
  }
};

/** Answers main's cut requests for as long as the window lives. */
export const answerCoverCuts = () =>
  window.parrot.onCoverCut((request) => {
    void cutCover(request).then(
      (bytes) => {
        console.info(`[covers] cut ${request.id}: ${bytes ? `${bytes.length} bytes` : "not decoded"}`);
        return window.parrot.coverCut(request.id, bytes);
      },
      (error: unknown) => {
        console.warn(`[covers] cut ${request.id} failed`, error);
        return window.parrot.coverCut(request.id, null);
      },
    );
  });
