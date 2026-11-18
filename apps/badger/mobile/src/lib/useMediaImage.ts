import { useEffect, useState } from "react";
import { artworkDisplaySource, type ArtworkKind } from "@space/library-db-definition/artworkCopy";
import type { ArtworkSource } from "@space/shared/artworkImage";
import { useAuth } from "../store/auth";
import { getStoredLibraryKey } from "./onboarding";
import { getCachedAssetUrl, getDecryptedAssetUrl } from "./assets";

const PENDING: ArtworkSource = { kind: "pending" };
const NONE: ArtworkSource = { kind: "none" };

/** Sync seed: a picture already shown this session paints without a spinner flash. */
const seed = (path: string | null): ArtworkSource => {
  if (!path) return NONE;
  const cached = artworkDisplaySource(path) === "vault" ? getCachedAssetUrl(path) : null;
  return cached ? { kind: "url", url: cached } : PENDING;
};

/**
 * Where a poster, backdrop, still or profile picture stands for its tile (UX-WAIT-03), from the user's own encrypted
 * copy only (META-ART-01/02): the decrypted file on this device first, the user's storage on a miss. `url` is a local
 * `file://` URL; `none` means no picture or a failed read; `pending` covers the read and a picture whose copy is not
 * made yet (a metadata-service path still in the library): screens never ask the metadata service for a picture, the
 * artwork copy (`lib/artworkCopy.ts`) fills the library in and the tile follows, and the tile's stall clock shows the
 * fallback meanwhile. `kind` only documents the slot: the reference already names the stored picture.
 */
export const useMediaImageSource = (path: string | null, _kind: ArtworkKind): ArtworkSource => {
  const { token } = useAuth();
  // Kept with the path it is for, so a tile handed another title never draws the previous picture.
  const [answer, setAnswer] = useState<{ path: string | null; source: ArtworkSource }>(() => ({ path, source: seed(path) }));

  useEffect(() => {
    if (!path || artworkDisplaySource(path) !== "vault") return () => undefined;
    const cached = getCachedAssetUrl(path);
    if (cached) {
      setAnswer({ path, source: { kind: "url", url: cached } });
      return () => undefined;
    }

    let cancelled = false;
    // The file on this device needs no session; the token and key are read only for a download from the user's storage.
    const credentials = async () => {
      if (!token) return null;
      const keyBase64 = await getStoredLibraryKey();
      return keyBase64 ? { token, keyBase64 } : null;
    };
    void getDecryptedAssetUrl(path, credentials).then((assetUrl) => {
      if (!cancelled) setAnswer({ path, source: assetUrl ? { kind: "url", url: assetUrl } : NONE });
    });
    return () => {
      cancelled = true;
    };
  }, [path, token]);

  return answer.path === path ? answer.source : seed(path);
};

/** The picture's local URL alone, or null: for layers with no loading look (a hero glow, the player backdrop, the OS media panel). */
export const useMediaImage = (path: string | null, kind: ArtworkKind): string | null => {
  const source = useMediaImageSource(path, kind);
  return source.kind === "url" ? source.url : null;
};
