/**
 * The skip signature of one video (META-SKIP-04, Chris 2026-11-24): what detection needs from the file, made once at
 * import inside the seek-bar preview pass and stored next to the preview sheets in each user's vault, so matching
 * a later episode fetches signatures, never videos.
 *
 * The blob is gzip JSON: the chromaprint windows (null when the video has no sound) and the picture windows.
 */
import { promisify } from "node:util";
import { gunzip, gunzipSync, gzip, gzipSync } from "node:zlib";
import type { SkipAudioAnalysisPayload } from "./audio";
import type { SkipPicturePayload } from "./picture";

export const SKIP_SIGNATURE_VERSION = 1;
/** The kind the desktop caches a decoded signature under in its local skip analysis table. */
export const SKIP_SIGNATURE_ANALYSIS_KIND = "skip-signature-v1";

export type SkipSignature = {
  version: typeof SKIP_SIGNATURE_VERSION;
  durationSeconds: number;
  audio: SkipAudioAnalysisPayload | null;
  picture: SkipPicturePayload;
};

export const encodeSkipSignature = (signature: SkipSignature): Uint8Array =>
  gzipSync(Buffer.from(JSON.stringify(signature), "utf8"), { level: 9 });

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** `encodeSkipSignature` compressing off the event loop (zlib's thread pool, MPV-PREV-07); same bytes. */
export const encodeSkipSignatureAsync = async (signature: SkipSignature): Promise<Uint8Array> =>
  gzipAsync(Buffer.from(JSON.stringify(signature), "utf8"), { level: 9 });

/** `decodeSkipSignature` decompressing off the event loop; null when it is not a readable version-1 signature. */
export const decodeSkipSignatureAsync = async (bytes: Uint8Array): Promise<SkipSignature | null> => {
  try {
    return parseSkipSignature(JSON.parse((await gunzipAsync(bytes)).toString("utf8")));
  } catch {
    return null;
  }
};

/** The signature in `bytes`, or null when it is not a readable version-1 signature. */
export const decodeSkipSignature = (bytes: Uint8Array): SkipSignature | null => {
  try {
    return parseSkipSignature(JSON.parse(gunzipSync(bytes).toString("utf8")));
  } catch {
    return null;
  }
};

export const parseSkipSignature = (raw: unknown): SkipSignature | null => {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<SkipSignature>;
  if (s.version !== SKIP_SIGNATURE_VERSION || typeof s.durationSeconds !== "number") return null;
  if (!s.picture || typeof s.picture !== "object") return null;
  if (s.audio !== null && (typeof s.audio !== "object" || s.audio === undefined)) return null;
  return s as SkipSignature;
};
