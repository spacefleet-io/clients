// The two copies of an album cover the user gives the phone (PAR-META-16, PAR-COPY-01): a large one no wider than
// 1200 px and a small one of 500 px, as the desktop makes them, resized by the phone's own image codec. A picture
// already no wider than 1200 px is kept as it is; one no wider than 500 px gets no small copy.
import { Image } from "react-native";
import { Buffer } from "buffer";
import RNFS from "react-native-fs";
import ImageResizer from "@bam.tech/react-native-image-resizer";
import { PARROT_COVER_LARGE_WIDTH, PARROT_COVER_THUMB_WIDTH, type ParrotCoverCopies } from "@space/parrot-core";

const dir = () => `${RNFS.CachesDirectoryPath}/parrot-cover-edit`;

const shrink = async (uri: string, width: number, quality: number): Promise<Uint8Array> => {
  // `contain` within width × a height no picture reaches: the width decides, the shape stays.
  const resized = await ImageResizer.createResizedImage(uri, width, width * 8, "JPEG", quality, 0, dir(), false, { mode: "contain", onlyScaleDown: true });
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
    const { width } = await Image.getSize(uri);
    return {
      large: width > PARROT_COVER_LARGE_WIDTH ? await shrink(uri, PARROT_COVER_LARGE_WIDTH, 90) : bytes,
      thumb: width > PARROT_COVER_THUMB_WIDTH ? await shrink(uri, PARROT_COVER_THUMB_WIDTH, 85) : null,
    };
  } finally {
    await RNFS.unlink(path).catch(() => undefined);
  }
};
