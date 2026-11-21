import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@space/ui";
import { OfflineContentList } from "@space/ui/offline-content";
import { formatLocalizedStorage } from "@space/shared/format";
import { groupBadgerOffline, type OfflineManageRow } from "@space/shared/offlineManage";
import MediaImage from "@/components/MediaImage";
import { useLibraryActions, useLibraryData } from "@/lib/libraryContext";
import { callOfflineDeleteLocal, isOfflineIpcError, type OfflineDeletePayload } from "@/lib/offlineIpc";
import { refreshOfflineState, useOfflineState } from "@/lib/offlineState";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "offline-content-settings" });

/** What `badger.offline.delete_local` removes for a row: the whole title, one season, or one file. */
export const deleteScopeFor = (row: OfflineManageRow): OfflineDeletePayload["scope"] => {
  if (row.kind === "season" && row.seasonNumber !== undefined) return { type: "season", mediaId: row.id, seasonNumber: row.seasonNumber };
  if (row.kind === "episode" && row.fileId) return { type: "file", fileId: row.fileId };
  return { type: "media", mediaId: row.id };
};

/**
 * Settings › Manage offline content (OFFL-MANAGE-01): every film, show, season and episode saved on this computer to
 * play offline, with its size and the total, a remove button on each and "Remove all". Removing frees the space at
 * once (`badger.offline.delete_local`); the offline store is read again so the library's badges follow.
 */
export default function OfflineContentSection() {
  const { t, i18n } = useTranslation();
  const store = useOfflineState();
  const { media } = useLibraryData();
  const { getMediaDetails, fetchMediaDetails } = useLibraryActions();
  const asked = useRef(new Set<string>());

  const entries = useMemo(() => [...store.byFileId.values()], [store.byFileId]);
  // A saved title whose details the library has not read yet: read them once, so its seasons and episodes show.
  useEffect(() => {
    for (const mediaId of new Set(entries.map((entry) => entry.mediaId))) {
      if (getMediaDetails(mediaId) || asked.current.has(mediaId)) continue;
      asked.current.add(mediaId);
      void fetchMediaDetails(mediaId).catch((error: unknown) =>
        log.warn({ mediaId, error: error instanceof Error ? error.message : String(error) }, "details_fetch_failed")
      );
    }
  }, [entries, getMediaDetails, fetchMediaDetails]);

  const list = useMemo(
    () =>
      groupBadgerOffline(entries, (mediaId) => {
        const details = getMediaDetails(mediaId);
        if (details) return details;
        const row = media.find((item) => item.id === mediaId);
        return row ? { type: row.type, title: row.title, posterPath: row.posterPath, files: [] } : null;
      }),
    [entries, getMediaDetails, media]
  );

  const locale = i18n.language;
  const nameOf = (row: OfflineManageRow) => {
    if (row.title) return row.title;
    if (row.kind === "season") return t("settings.offlineContent.season", { n: row.seasonNumber ?? 0 });
    if (row.kind === "episode") return t("settings.offlineContent.unknownEpisode");
    return t("settings.offlineContent.unknownTitle");
  };
  const detailOf = (row: OfflineManageRow) =>
    row.kind === "episode" && row.seasonNumber !== undefined && row.episodeNumber !== undefined
      ? t("settings.offlineContent.episodeNumber", { season: row.seasonNumber, episode: row.episodeNumber })
      : null;

  const remove = async (scope: OfflineDeletePayload["scope"]) => {
    const result = await callOfflineDeleteLocal({ scope });
    if (isOfflineIpcError(result)) {
      log.warn({ scope, errorCode: result.errorCode, message: result.message }, "delete_local_failed");
      toast.error(t("settings.offlineContent.removeFailed"));
      return false;
    }
    log.info({ scope, deleted: result.deleted, freedBytes: result.freedBytes }, "delete_local_ok");
    return true;
  };

  return (
    <OfflineContentList
      rows={list.rows}
      loading={store.loading && entries.length === 0}
      totalText={formatLocalizedStorage(list.totalBytes, locale)}
      sizeText={(bytes) => formatLocalizedStorage(bytes, locale)}
      nameOf={nameOf}
      detailOf={detailOf}
      imageOf={(row) => (row.imagePath ? <MediaImage path={row.imagePath} alt="" className="h-full w-full object-cover" /> : null)}
      labels={{
        total: t("settings.offlineContent.total"),
        empty: t("settings.offlineContent.empty"),
        remove: (name) => t("settings.offlineContent.remove", { name }),
        removeAll: t("settings.offlineContent.removeAll"),
        expand: (name) => t("settings.offlineContent.expand", { name }),
        confirmTitle: t("settings.offlineContent.confirmTitle"),
        confirmBody: t("settings.offlineContent.confirmBody"),
        confirmCancel: t("settings.offlineContent.confirmCancel"),
        confirmRemove: t("settings.offlineContent.confirmRemove"),
      }}
      onRemove={async (row) => {
        await remove(deleteScopeFor(row));
        refreshOfflineState();
      }}
      onRemoveAll={async () => {
        for (const row of list.rows) await remove(deleteScopeFor(row));
        refreshOfflineState();
      }}
    />
  );
}
