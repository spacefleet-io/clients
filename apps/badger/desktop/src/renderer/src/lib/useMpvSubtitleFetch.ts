import { useEffect, useMemo, useRef } from "react";
import i18n from "i18next";
import type { MediaDetails, SubtitleTrack } from "@space/shared/libraryTypes";
import {
  isFetchedSubtitleSource,
  replaceFetchedSubtitle,
  storeFetchedSubtitle,
  subtitleFetchCopy,
  subtitleFetchTarget,
  type SubtitleFetchEntry,
} from "@space/shared/subtitleFetch";
import { tryAnotherSubtitleVersion } from "@space/shared/subtitleFetchFlow";
import type { TrackPrefsPatch } from "@space/shared/trackPrefs";
import { buildScriptMessageCommand, LUA_CHANNELS, type MpvCommand, type SubtitleFetchView } from "@space/mpv-protocol";
import { deleteStorageObjects } from "@/api";
import { metadataClient } from "@/lib/metadataTickets";
import type { AddSubtitleTrack } from "@/lib/playbackTypes";
import { createMpvSubtitleFetch, parseSubtitleFetchMessage, type MpvSubtitleFetch } from "@/lib/mpvSubtitleFetch";
import { subtitleFetchStoreDeps } from "@/lib/subtitleFetchStore";
import { useOnline } from "@space/desktop-shell/hooks";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "mpv-subtitle-fetch" });

/**
 * "Get more subtitles…" in the mpv subtitle menu (PLAY-SUBGET-02): pauses on the row, runs the shared flow through
 * sf-select.lua's panels and list, stores like the "Get subtitles" dialog, then resumes; `onAdded` switches the new
 * subtitle on. Returns the row's label for the metadata payload ("" hides the row). The subtitles button always opens
 * the menu first; only this row searches (PLAY-SUBGET-24). Offline the row stays, marked "Needs an internet connection",
 * and picking it only shows that line over the video (PLAY-SUBGET-12).
 *
 * While a fetched subtitle is on, the menu also offers "Try another version" (PLAY-SUBGET-07): the next-best file of
 * that subtitle's entry replaces it (same name and language, one track), shown through the same panels. The old
 * subtitle's stored file is then deleted unless the library still names it.
 */
export const useMpvSubtitleFetch = (params: {
  open: boolean;
  /** mpv runs as the external player (the row's messages come from its sf-select.lua). */
  isExternalPlayer: () => boolean;
  media: MediaDetails;
  episodeId: string | null;
  token: string | null;
  /** Absent: the host cannot store a subtitle, so the row is not offered. */
  addSubtitleTrack?: AddSubtitleTrack;
  /** Absent: the host cannot delete a track, so "Try another version" is not offered. Resolves once the library has. */
  removeSubtitleTrack?: (trackId: string) => Promise<void>;
  /** The stored files the library names for a media; absent, a replaced subtitle's file is kept. */
  getMediaObjectKeys?: (mediaId: string) => Promise<string[]>;
  /** The library subtitle that is on; null when Off or not a library track. */
  selectedSubtitle: SubtitleTrack | null;
  setTrackPrefs: (mediaId: string, patch: TrackPrefsPatch) => Promise<void>;
  sendExternalCommand: (command: MpvCommand) => Promise<boolean>;
  sendPauseCommand: (paused: boolean) => Promise<unknown>;
  /** The menu's "Off" label, re-sent with the row's label when going on- or offline mid-playback. */
  subtitlesOffLabel: string;
  onAdded: (entry: SubtitleFetchEntry, episodeId: string | null) => void;
  /**
   * Another version replaced `track` (deleted from the library by now): the player drops it from mpv and switches
   * the new one (same language and name) on; playback resumes once this settles.
   */
  onReplaced: (track: SubtitleTrack, episodeId: string | null) => Promise<void>;
}): { getMoreSubtitlesLabel: string; tryAnotherVersionLabel: string } => {
  const online = useOnline();
  const uiLanguage = i18n.language || "en";
  const target = useMemo(() => subtitleFetchTarget(params.media, params.episodeId), [params.media, params.episodeId]);
  const latest = useRef({ ...params, online, uiLanguage, target });
  latest.current = { ...params, online, uiLanguage, target };

  useEffect(() => {
    if (!params.open) return;
    let flow: MpvSubtitleFetch | null = null;
    // Offline, "Get subtitles" / "Try another version" only says why it cannot (#2500); Escape closes that line.
    let offlineNotice = false;
    const send = (view: SubtitleFetchView) =>
      void latest.current.sendExternalCommand(buildScriptMessageCommand(LUA_CHANNELS.SUBTITLE_FETCH_JSON, view));
    const unsubscribe = window.sf?.onMpvExternalMessage?.((msg) => {
      const message = parseSubtitleFetchMessage(msg);
      if (!message || !latest.current.isExternalPlayer()) return;
      if (message.action === "cancel" && offlineNotice) {
        offlineNotice = false;
        send({ close: true });
        return;
      }
      if (message.action === "open" || message.action === "version") {
        const now = latest.current;
        const { media, episodeId, token, addSubtitleTrack, removeSubtitleTrack, getMediaObjectKeys, setTrackPrefs, selectedSubtitle } = now;
        if (!addSubtitleTrack) return;
        if (!now.online) {
          log.info({ mediaId: media.id, episodeId, action: message.action }, "get more subtitles: offline, saying so");
          flow?.dispose();
          flow = null;
          offlineNotice = true;
          send({ panel: subtitleFetchCopy(now.uiLanguage).offline, dismissable: true });
          return;
        }
        offlineNotice = false;
        const replacing =
          message.action === "version" && removeSubtitleTrack && selectedSubtitle && isFetchedSubtitleSource(selectedSubtitle.source)
            ? selectedSubtitle
            : null;
        if (message.action === "version" && !replacing) {
          log.warn({ mediaId: media.id, episodeId, selected: selectedSubtitle?.id ?? null }, "try another version: no fetched subtitle on");
          return;
        }
        flow?.dispose();
        log.info(
          { mediaId: media.id, episodeId, action: message.action, searchable: now.target !== null, trackId: replacing?.id },
          "get more subtitles: opened, pausing"
        );
        void now.sendPauseCommand(true);
        const resume = () => void latest.current.sendPauseCommand(false);
        const storeDeps = subtitleFetchStoreDeps({ media, episodeId, token, addSubtitleTrack, setTrackPrefs });
        const target = now.target;
        flow = createMpvSubtitleFetch({
          uiLanguage: now.uiLanguage,
          target: now.target,
          search: (request) => metadataClient.subtitles(request),
          store: (entry, report, signal) => storeFetchedSubtitle(entry, report, storeDeps, signal),
          tryAnother:
            replacing && removeSubtitleTrack
              ? {
                  name: replacing.label,
                  run: (report, signal) =>
                    tryAnotherSubtitleVersion(
                      {
                        uiLanguage: now.uiLanguage,
                        libraryFileName: target?.libraryFileName,
                        track: replacing,
                        search: () =>
                          target ? metadataClient.subtitles(target.request) : Promise.resolve({ reachable: false, subtitles: [] }),
                        replace: (file, stage, replaceSignal) =>
                          replaceFetchedSubtitle(
                            replacing,
                            file,
                            stage,
                            {
                              ...storeDeps,
                              removeTrack: removeSubtitleTrack,
                              objectInUse: async (key) => !getMediaObjectKeys || (await getMediaObjectKeys(media.id)).includes(key),
                              deleteObject: async (key) => {
                                if (!token) throw new Error("NO_TOKEN");
                                await deleteStorageObjects(token, [key]);
                                log.info({ mediaId: media.id, episodeId, trackId: replacing.id, key }, "try another version: old file deleted");
                              },
                              onDeleteFailed: (key, error) =>
                                log.warn({ mediaId: media.id, episodeId, key, error: String(error) }, "try another version: old file kept"),
                            },
                            replaceSignal
                          ),
                      },
                      (step) => {
                        log.info({ mediaId: media.id, episodeId, trackId: replacing.id, step }, "try another version: step");
                        report(step);
                      },
                      signal
                    ),
                }
              : undefined,
          onReplaced: () => {
            log.info({ mediaId: media.id, episodeId, trackId: replacing?.id }, "try another version: replaced, resuming");
            if (!replacing) return resume();
            void latest.current
              .onReplaced(replacing, episodeId)
              .catch((error: unknown) => log.warn({ err: error, trackId: replacing.id }, "try another version: player swap failed"))
              .finally(resume);
          },
          show: send,
          onAdded: (entry) => {
            log.info({ mediaId: media.id, episodeId, language: entry.language, trackName: entry.trackName }, "get more subtitles: added, resuming");
            latest.current.onAdded(entry, episodeId);
            resume();
          },
          onCancelled: () => {
            log.info({ mediaId: media.id, episodeId }, "get more subtitles: left, resuming");
            resume();
          },
        });
      }
      flow?.handle(message);
    });
    return () => {
      flow?.dispose();
      unsubscribe?.();
    };
  }, [params.open]);

  const copy = subtitleFetchCopy(uiLanguage);
  const withOffline = (label: string) => (online ? label : `${label} · ${copy.offline}`);
  const getMoreSubtitlesLabel = params.addSubtitleTrack && target ? withOffline(copy.getMore) : "";
  const tryAnotherVersionLabel =
    getMoreSubtitlesLabel && params.removeSubtitleTrack && isFetchedSubtitleSource(params.selectedSubtitle?.source)
      ? withOffline(copy.tryAnother)
      : "";

  // The launch payload carries the labels; a change while playing (going on- or offline, another subtitle switched
  // on) is re-sent on its own.
  const sentLabels = useRef(`${getMoreSubtitlesLabel}\n${tryAnotherVersionLabel}`);
  useEffect(() => {
    const key = `${getMoreSubtitlesLabel}\n${tryAnotherVersionLabel}`;
    if (!params.open || sentLabels.current === key) return;
    sentLabels.current = key;
    if (!latest.current.isExternalPlayer()) return;
    const labels = {
      subtitlesOff: latest.current.subtitlesOffLabel,
      getMoreSubtitles: getMoreSubtitlesLabel,
      tryAnotherVersion: tryAnotherVersionLabel,
    };
    log.info({ getMoreSubtitles: getMoreSubtitlesLabel, tryAnotherVersion: tryAnotherVersionLabel }, "menu labels re-sent");
    void latest.current.sendExternalCommand(buildScriptMessageCommand(LUA_CHANNELS.LABELS_JSON, labels));
  }, [params.open, getMoreSubtitlesLabel, tryAnotherVersionLabel]);

  return { getMoreSubtitlesLabel, tryAnotherVersionLabel };
};
