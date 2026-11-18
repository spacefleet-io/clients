/**
 * The device's pieces of the title-language pass (`titleVariants.ts`, ACCT-PROF-03) for one open library: the
 * metadata service's `details` op, the artwork copy's upload into the user's storage (META-ART-01), the ticket floor
 * the artwork copy keeps, the profile list and the app (= account) language. Kept apart from the library store so the
 * store does not load the tunnel and ticket modules.
 */
import { createVaultArtworkUpload } from "@space/library-db-definition/artworkCopy";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { ARTWORK_COPY_TICKET_FLOOR } from "./artworkCopy";
import { storeEncryptedArtwork } from "./libraryArtworkCopy";
import { fetchArtworkImage, metadataClient, onTicketsArrived, ticketsHeld } from "./metadata/runtime";
import { profileStore } from "./profiles/profileStore";
import { startTitleVariants, type TitleVariantsDb, type TitleVariantsRunner } from "./titleVariants";

const log = scopeLogger("title-variants");

export const startLibraryTitleVariants = (options: {
  db: TitleVariantsDb;
  token: string;
  keyBase64: string;
  onRowArtChanged: (mediaId: string) => void;
  onChanged: () => void;
}): TitleVariantsRunner => {
  const runner = startTitleVariants({
    db: options.db,
    profiles: () => profileStore.getSnapshot().profiles,
    accountLanguage: getCurrentLanguage,
    details: (type, tmdbId, language) => metadataClient.details(type, tmdbId, language),
    canSpend: async () => (await ticketsHeld()) > ARTWORK_COPY_TICKET_FLOOR,
    uploadArtwork: createVaultArtworkUpload({
      fetchImage: fetchArtworkImage,
      storeEncrypted: (bytes, contentType) => storeEncryptedArtwork(options.token, options.keyBase64, bytes, contentType),
      onError: (stage, error) => log.warn("upload.failed", { stage, reason: error instanceof Error ? error.message : String(error) }),
    }),
    onRowArtChanged: options.onRowArtChanged,
    onChanged: options.onChanged,
    log: (event, detail) => log.info(event, detail),
  });
  // A pass stopped for want of tickets resumes when a batch lands.
  const unsubscribeTickets = onTicketsArrived(() => runner.request("tickets"));
  return {
    ...runner,
    stop: () => {
      unsubscribeTickets();
      runner.stop();
    },
  };
};
