import { useEffect, useRef } from "react";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { buildScriptMessageCommand, LUA_CHANNELS, type MpvCommand, type SkipEditAnswer } from "@space/mpv-protocol";
import { queueSkipContribution } from "@space/metadata-client";
import { applySkipEdit, parseSkipEditMessage, preselectSkipEdit, type SkipEditDeps } from "@/lib/mpvSkipEdit";
import type { SkipEditLibrary } from "@/lib/playbackTypes";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "mpv-skip-edit" });

/**
 * PLAY-SKIP-03/05: answers sf.lua's "Was it right?" line and Change times panel (`sf-skip-edit`) for the episode
 * playing: stores the times, reports them for the metadata service, then refreshes the media so the next envelope
 * carries the new times. Without `library` (a host that cannot store) the messages are ignored.
 */
export const useMpvSkipEdit = (params: {
  open: boolean;
  isExternalPlayer: () => boolean;
  media: MediaDetails;
  episodeId: string | null;
  library?: SkipEditLibrary;
  sendExternalCommand: (command: MpvCommand) => Promise<boolean>;
}): void => {
  const latest = useRef(params);
  latest.current = params;

  useEffect(() => {
    if (!params.open) return;
    const answer = (value: SkipEditAnswer) =>
      void latest.current.sendExternalCommand(buildScriptMessageCommand(LUA_CHANNELS.SKIP_EDIT_JSON, value));
    const unsubscribe = window.sf?.onMpvExternalMessage?.((msg) => {
      const message = parseSkipEditMessage(msg);
      if (!message || !latest.current.isExternalPlayer()) return;
      const { media, episodeId, library } = latest.current;
      if (!episodeId || !library) {
        log.warn({ mediaId: media.id, episodeId, action: message.action }, "[sf-skip] edit ignored: no episode or no library");
        answer({ kind: "failed" });
        return;
      }
      const deps: SkipEditDeps = {
        media,
        episodeId,
        listSkipAnalysis: library.listSkipAnalysis,
        upsertSkipAnalysis: library.upsertSkipAnalysis,
        replaceSkipMarkers: library.replaceSkipMarkers,
        queueSkipContribution,
        log: (text, data) => log.info({ mediaId: media.id, episodeId, ...data }, `[sf-skip] ${text}`),
      };
      log.info({ mediaId: media.id, episodeId, message }, "[sf-skip] edit message");
      void (async () => {
        try {
          if (message.action === "preselect") {
            answer(await preselectSkipEdit(message, deps));
            return;
          }
          const result = await applySkipEdit(message, deps);
          answer(result);
          if (message.action === "save") await library.onChanged();
        } catch (error) {
          log.error({ mediaId: media.id, episodeId, action: message.action, err: error }, "[sf-skip] edit failed");
          answer({ kind: "failed" });
        }
      })();
    });
    return () => unsubscribe?.();
  }, [params.open]);
};
