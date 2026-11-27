// The two copies of an album cover or an artist photo the user gives the phone (PAR-META-16/30, PAR-COPY-01): the
// picture's centre square, re-encoded by the phone's own image codec as a JPEG no wider than 1200 px and a small one
// of 500 px, as the desktop makes them. The picked original is never stored: whatever its size, the library keeps the
// standard copies (PAR-META-31); one no wider than 500 px gets no small copy. The phone's form has no framing, so the
// centre square is the one kept (PAR-META-22).
import { Image } from "react-native";
import { Buffer } from "buffer";
import RNFS from "react-native-fs";
import ImageResizer from "@bam.tech/react-native-image-resizer";
import { PARROT_COVER_LARGE_WIDTH, PARROT_COVER_THUMB_WIDTH, type ParrotCoverCopies } from "@space/parrot-core";

const dir = () => `${RNFS.CachesDirectoryPath}/parrot-cover-edit`;

const square = async (uri: string, side: number, quality: number): Promise<Uint8Array> => {
  // `cover` into side × side fills the square and cuts what sticks out on both sides: the centre square.
  const resized = await ImageResizer.createResizedImage(uri, side, side, "JPEG", quality, 0, dir(), false, { mode: "cover", onlyScaleDown: false });
  try {
    return new Uint8Array(Buffer.from(await RNFS.readFile(resized.path, "base64"), "base64"));
  } finally {
    await RNFS.unlink(resized.path).catch(() => undefined);
  }
};

export const phoneCoverCopies = async (bytes: Uint8Array): Promise<ParrotCoverCopies | null> => {
  await RNFS.mkdir(dir());
  const path = `${dir()}/picked-${Date.now()}`;
  await RNFS.writeFile(path, Buffer.from(bytes).toString("base64"), "base64");
  try {
    const uri = `file://${path}`;
    const { width, height } = await Image.getSize(uri);
    const side = Math.min(width, height);
    return {
      large: await square(uri, Math.min(side, PARROT_COVER_LARGE_WIDTH), 90),
      thumb: side > PARROT_COVER_THUMB_WIDTH ? await square(uri, PARROT_COVER_THUMB_WIDTH, 85) : null,
    };
  } finally {
    await RNFS.unlink(path).catch(() => undefined);
  }
};
