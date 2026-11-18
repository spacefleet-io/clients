import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@space/ui";
import { SubtitleFetchFlow } from "@space/ui/badger/subtitle-fetch";
import type { MediaDetails } from "@space/shared/libraryTypes";
import {
  storeFetchedSubtitle,
  subtitleFetchCopy,
  subtitleFetchTarget,
  type SubtitleFetchEntry,
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

  const search = useCallback(async () => {
    if (!target) return { reachable: true, subtitles: [] };
    return metadataClient.subtitles(target.request);
  }, [target]);

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
            libraryFileName={target?.libraryFileName ?? null}
            existingTracks={target?.existingTracks ?? []}
            offline={offline}
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
