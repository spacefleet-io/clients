import type { TitleDetails } from "@/api";
import { uploadEncryptedAssetFromMetadata } from "@/lib/assets";
import { attachAssets, type CatalogAssetOptions } from "@/lib/catalogAssetsCore";

export type { CatalogAssetOptions };

/** Copies a title's artwork into the user's encrypted library (poster, backdrop, cast, seasons); episode stills and anything left follow in the background copy (`lib/artworkCopy.ts`, META-ART-01). */
export const attachCatalogAssets = (token: string, keyBase64: string, details: TitleDetails, options: CatalogAssetOptions = {}) =>
  attachAssets(
    details,
    { upload: (kind, path) => uploadEncryptedAssetFromMetadata(token, keyBase64, kind, path) },
    options
  );
