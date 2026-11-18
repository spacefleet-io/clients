import { useEffect, useState } from "react";
import type { ArtworkSource } from "@space/shared/artworkImage";
import { useAuth } from "@/auth";
import { getStoredLibraryKey } from "@/lib/onboarding";
import { getDecryptedAssetUrl } from "@/lib/assets";
import { getDesktopArtworkHealer } from "@/lib/artworkHeal";
import { currentArtworkSession, getRendererArtworkStore, mayWriteArtwork } from "@/lib/artworkCache";
import { objectUrlToDataUrl } from "@/lib/playbackBackdrop";
import { isMissingObjectError } from "@space/library-db-definition/artworkHeal";
import { artworkDisplaySource } from "@space/library-db-definition/artworkCopy";
import type { ImageKind } from "@space/metadata-client";

/** Key of a decrypted copy in the local artwork cache. */
export const vaultArtworkCacheKey = (assetRef: string) => `vault|${assetRef}`;

const PENDING: ArtworkSource = { kind: "pending" };
const NONE: ArtworkSource = { kind: "none" };

/**
 * What browsing shows (META-ART-01/02): the user's own copy of a title's artwork, never the metadata service.
 * The decrypted copy is kept in the local artwork cache (bounded by bytes, kept across restarts, cleared on
 * sign-out), so it is read from the user's storage once per device. Answers where the picture stands for the tile
 * (UX-WAIT-03): `pending` while it is read, decrypted or fetched back, and for a title whose copy is not made yet (a
 * provider path: the copy queue makes it and the path becomes an asset reference); `url` once it is here; `none`
 * for a title with no picture or a copy that could not be read. `kind` is kept for callers; a copy already has its size.
 */
export const useMediaImageSource = (path: string | null, _kind: ImageKind = "poster"): ArtworkSource => {
  const { token } = useAuth();
  // The answer is kept with the path it is for, so a tile handed another title never draws the previous picture.
  const [answer, setAnswer] = useState<{ path: string | null; source: ArtworkSource }>({ path, source: path ? PENDING : NONE });

  useEffect(() => {
    let cancelled = false;
    const setSource = (source: ArtworkSource) => setAnswer({ path, source });
    if (!path || artworkDisplaySource(path) !== "vault") return () => undefined;
    const store = getRendererArtworkStore();

    const decrypt = async (libraryKey: string, ref: string): Promise<string | null> => {
      try {
        return await getDecryptedAssetUrl(token as string, libraryKey, ref);
      } catch (error) {
        // Pending while the copy is fetched back (STOR-PLACE-09); any other failure has no picture to show.
        const healer = isMissingObjectError(error) ? getDesktopArtworkHealer() : null;
        const healedRef = healer ? await healer.reportMissing(ref) : null;
        if (!healedRef || cancelled) return null;
        return getDecryptedAssetUrl(token as string, libraryKey, healedRef);
      }
    };

    const load = async () => {
      const session = currentArtworkSession();
      const cached = await store.get(vaultArtworkCacheKey(path)).catch(() => null);
      if (cancelled) return;
      if (cached) {
        setSource({ kind: "url", url: cached });
        return;
      }
      if (!token) return;
      const libraryKey = await getStoredLibraryKey();
      if (!libraryKey || cancelled) return;
      const objectUrl = await decrypt(libraryKey, path).catch(() => null);
      if (cancelled) return;
      if (!objectUrl) {
        setSource(NONE);
        return;
      }
      setSource({ kind: "url", url: objectUrl });
      const dataUrl = await objectUrlToDataUrl(objectUrl);
      // Never write a decrypted copy back after sign-out cleared the cache (unmounted tiles still cache their copy).
      if (dataUrl && mayWriteArtwork(session)) await store.put(vaultArtworkCacheKey(path), dataUrl).catch(() => undefined);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [path, token]);

  return answer.path === path ? answer.source : path ? PENDING : NONE;
};

/** The picture's address alone, for a layer that has no loading look (the blurred glow behind the hero). */
export const useMediaImage = (path: string | null, kind: ImageKind = "poster"): string | null => {
  const source = useMediaImageSource(path, kind);
  return source.kind === "url" ? source.url : null;
};
