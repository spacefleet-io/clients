import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@space/ui";
import { SubtitleFetchFlow } from "@space/ui/badger/subtitle-fetch";
import type { MediaDetails } from "@space/shared/libraryTypes";
import {
  storeFetchedSubtitle,
  subtitleFetchCopy,
  subtitleFetchNeedsTitle,
  subtitleFetchTarget,
  subtitleTitleMatches,
  type SubtitleFetchEntry,
  type SubtitleTitleMatch,
} from "@space/shared/subtitleFetch";
import { useAuth } from "@/auth";
import { useLibraryActions } from "@/lib/libraryContext";
import { metadataClient } from "@/lib/metadataTickets";
import { subtitleFetchStoreDeps } from "@/lib/subtitleFetchStore";

type SubtitleFetchDialogProps = {
  media: MediaDetails;
  /** The episode to get subtitles for; null for a film. */
  episodeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offline: boolean;
  /** The subtitle was stored (the player selects it and resumes, PLAY-SUBGET-02). */
  onAdded?: (entry: SubtitleFetchEntry) => void;
  /** Close by itself this long after "added" (the player); omit to wait for Done (the subtitles tab). */
  autoCloseAfterAddedMs?: number;
};

/**
 * "Get subtitles" on the computer app (PLAY-SUBGET-01, -02): the shared flow in a dialog, searching and downloading
 * through the metadata service (PLAY-SUBGET-03) and storing like an added subtitle file, encrypted in the vault.
 * Without a catalog id the user names the film or show first; its match is searched, the media's identification stays
 * as is (PLAY-SUBGET-24).
 */
export default function SubtitleFetchDialog({
  media,
  episodeId,
  open,
  onOpenChange,
  offline,
  onAdded,
  autoCloseAfterAddedMs,
}: SubtitleFetchDialogProps) {
  const { i18n } = useTranslation();
  const { token } = useAuth();
  const { addSubtitleTrack, setTrackPrefs } = useLibraryActions();
  const uiLanguage = i18n.language || "en";
  const copy = subtitleFetchCopy(uiLanguage);
  const target = useMemo(() => subtitleFetchTarget(media, episodeId), [media, episodeId]);
  const needsTitle = useMemo(() => (target ? null : subtitleFetchNeedsTitle(media, episodeId)), [target, media, episodeId]);
  // The file name and the subtitles the media has don't depend on the catalog id: read with a stand-in one when it has none.
  const listing = useMemo(
    () => target ?? (needsTitle ? subtitleFetchTarget(media, episodeId, 0) : null),
    [target, needsTitle, media, episodeId]
  );
  const findTitle = useMemo(
    () =>
      needsTitle
        ? {
            query: needsTitle.query,
            find: async (query: string) => subtitleTitleMatches((await metadataClient.search(needsTitle.type, query)).results),
          }
        : undefined,
    [needsTitle]
  );

  const search = useCallback(
    async (match?: SubtitleTitleMatch) => {
      const searched = match ? subtitleFetchTarget(media, episodeId, match.catalogId) : target;
      if (!searched) return { reachable: true, subtitles: [] };
      return metadataClient.subtitles(searched.request);
    },
    [target, media, episodeId]
  );

  const store = useCallback(
    (entry: SubtitleFetchEntry, report: (stage: "downloading" | "saving") => void) =>
      storeFetchedSubtitle(entry, report, subtitleFetchStoreDeps({ media, episodeId, token, addSubtitleTrack, setTrackPrefs })),
    [addSubtitleTrack, episodeId, media, setTrackPrefs, token]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="subtitle-fetch-dialog">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>
        {open ? (
          <SubtitleFetchFlow
            uiLanguage={uiLanguage}
            libraryFileName={listing?.libraryFileName ?? null}
            existingTracks={listing?.existingTracks ?? []}
            offline={offline}
            findTitle={findTitle}
            search={search}
            store={store}
            onAdded={onAdded}
            onClose={() => onOpenChange(false)}
            autoCloseAfterAddedMs={autoCloseAfterAddedMs}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
