/**
 * STOR-PLACE-09 on the desktop: artwork of a title still in the library whose stored copy is gone is fetched back
 * from the metadata service, encrypted, stored again and swapped into the library (shared logic:
 * `@space/library-db-definition/artworkHeal`). One healer per open library; `useMediaImage` reports a failed
 * download to it, the library context runs the background sweep.
 */
import { createArtworkHealer, type ArtworkHealer, type ArtworkRefChange } from "@space/library-db-definition/artworkHeal";
import { deleteStorageObjects, headStorageObjects } from "@/api";
import { uploadEncryptedAssetBytes } from "@/lib/assets";
import { getStoredLibraryKey } from "@/lib/onboarding";
import { getTitleDetailsForLibrary } from "@/lib/metadata";
import { resolveArtwork } from "@/lib/metadataTickets";
import type { LibraryDb } from "@/lib/libraryDb";
import { rendererLogger } from "@/logger";

const healLog = rendererLogger.child({ scope: "artworkHeal" });

let current: ArtworkHealer | null = null;

/** The healer of the open library, null while signed out or before the library opens. */
export const getDesktopArtworkHealer = () => current;

export const setDesktopArtworkHealer = (healer: ArtworkHealer | null) => {
  current = healer;
};

export const createDesktopArtworkHealer = ({
  db,
  token,
  language,
  onHealed,
}: {
  db: LibraryDb;
  token: string;
  /** The account's language (UX-I18N-07), read when a title's details are fetched (ACCT-PROF-03). */
  language: () => { accountLanguage: string };
  onHealed: (mediaId: string, changes: ArtworkRefChange[]) => void;
}) =>
  createArtworkHealer({
    exists: (keys) => headStorageObjects(token, keys),
    listMediaIds: async () => (await db.listMedia()).map((media) => media.id),
    loadMedia: (mediaId) => db.getMediaDetails(mediaId),
    fetchDetails: (media) => getTitleDetailsForLibrary(token, media.type, media.catalogId as number, language()),
    fetchImage: async (kind, path) => {
      const outcome = await resolveArtwork(kind, path);
      if (outcome.status !== "ok") {
        healLog.info({ kind, path, status: outcome.status }, "artworkHeal.image_unavailable");
        return null;
      }
      const res = await fetch(outcome.url);
      if (!res.ok) return null;
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("Content-Type") ?? "image/jpeg" };
    },
    store: async (image) => {
      const key = await getStoredLibraryKey();
      if (!key) throw new Error("KEY_REQUIRED");
      return uploadEncryptedAssetBytes(token, key, image.bytes, image.contentType);
    },
    replaceRefs: async (mediaId, changes) => {
      const result = await db.applyArtworkCopies(mediaId, changes);
      const unapplied = result.unapplied.flatMap((copy) =>
        copy.value === null ? [] : [{ target: copy.target, id: copy.id, path: copy.path, value: copy.value }]
      );
      return { applied: result.applied, unapplied };
    },
    // STOR-PLACE-10: a picture stored again for a title deleted meanwhile is deleted at once.
    discard: (keys) => deleteStorageObjects(token, keys),
    onHealed,
    log: (event, detail) => healLog.info(detail, event),
  });
