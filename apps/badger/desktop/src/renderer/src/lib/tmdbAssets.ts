import type { TmdbDetails } from "@/api";
import { uploadEncryptedAssetFromMetadata } from "@/lib/assets";
import { attachAssets, type TmdbAssetOptions } from "@/lib/tmdbAssetsCore";

export type { TmdbAssetOptions };

/** Copies a title's artwork into the user's encrypted library (poster, backdrop, cast, seasons); episode stills and anything left follow in the background copy (`lib/artworkCopy.ts`, META-ART-01). */
export const attachTmdbAssets = (token: string, keyBase64: string, details: TmdbDetails, options: TmdbAssetOptions = {}) =>
  attachAssets(
    details,
    { upload: (kind, path) => uploadEncryptedAssetFromMetadata(token, keyBase64, kind, path) },
    options
  );
