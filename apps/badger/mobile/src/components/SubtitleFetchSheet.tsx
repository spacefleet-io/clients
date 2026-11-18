import React, { memo, useEffect, useMemo, useState } from "react";
import { useMobileSheetClose } from "@space/mobile-shell/bottom-sheet";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { useLibraryActions } from "../store/library";
import { metadataClient } from "../lib/metadata/runtime";
import { useNetworkOnline } from "../lib/networkListener";
import { subtitleFetchPhoneInput } from "../lib/subtitleFetchStore";
import { BottomSheet } from "./BottomSheet";
import { SubtitleFetchPanel, type SubtitleFetchPanelProps } from "./SubtitleFetchPanel";
import { usePickerSheet } from "./usePickerSheet";

/** Which film (`episodeId` null) or episode the sheet searches for; a new object opens it again. */
export type SubtitleFetchRequest = { mediaId: string; episodeId: string | null };

/** The flow inside the sheet: its own close slides the sheet out first, then the flow unmounts. */
const SheetPanel = ({ input, offline }: Pick<SubtitleFetchPanelProps, "input" | "offline">) => {
  const close = useMobileSheetClose();
  return <SubtitleFetchPanel input={input} offline={offline} onClose={() => close()} />;
};

/**
 * "Get subtitles" from the details page (PLAY-SUBGET-01): the shared flow in a bottom sheet. The title is read again
 * on every open, so a subtitle fetched a moment ago is listed as already there (PLAY-SUBGET-18).
 */
export const SubtitleFetchSheet = memo(({ request, onClosed }: { request: SubtitleFetchRequest | null; onClosed: () => void }) => {
  const sheet = usePickerSheet();
  const online = useNetworkOnline();
  const { getMediaDetails, uploadSubtitleContent, addSubtitleTrack, setTrackPrefs } = useLibraryActions();
  const [media, setMedia] = useState<MediaDetails | null>(null);

  useEffect(() => {
    if (!request) return undefined;
    let cancelled = false;
    setMedia(null);
    void getMediaDetails(request.mediaId, { chunks: false }).then((data) => {
      if (cancelled) return;
      console.info("subtitle_fetch.sheet.open", JSON.stringify({ ...request, found: Boolean(data), online }));
      setMedia(data);
      if (data) sheet.open();
      else onClosed();
    });
    return () => {
      cancelled = true;
    };
    // Opens once per request; `online` is only logged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const input = useMemo(
    () =>
      media && request
        ? subtitleFetchPhoneInput({
            media,
            episodeId: request.episodeId,
            uiLanguage: getCurrentLanguage(),
            client: metadataClient,
            actions: { uploadSubtitleContent, addSubtitleTrack, setTrackPrefs },
          })
        : null,
    [addSubtitleTrack, media, request, setTrackPrefs, uploadSubtitleContent],
  );

  // Closed by the backdrop, the handle, Android Back or the flow itself, once slid out: the flow unmounts and a running
  // save is abandoned.
  useEffect(() => {
    if (request && media && !sheet.visible) {
      setMedia(null);
      onClosed();
    }
  }, [media, onClosed, request, sheet.visible]);

  if (!request || !input) return null;
  return (
    <BottomSheet sheet={sheet} testID="subtitle-fetch-sheet">
      {sheet.visible ? <SheetPanel input={input} offline={!online} /> : null}
    </BottomSheet>
  );
});
SubtitleFetchSheet.displayName = "SubtitleFetchSheet";
