import { encodeCompressedFrame } from "@space/library-db-definition/payloadCompression";
import { encryptBytesToBytes } from "../crypto";
import { fflateCodec } from "@space/mobile-shell/libraryOps";

/** One library change, compressed then encrypted (LIB-FMT-07); every change is framed, small ones too. */
export const encryptOpPayload = (keyBase64: string, opJsonBytes: Uint8Array) =>
  encryptBytesToBytes(keyBase64, encodeCompressedFrame(opJsonBytes, fflateCodec));
