/**
 * Settings › Downloads › "Manage offline content" (OFFL-MANAGE-01): every film and episode saved on this phone with the
 * space it takes on disk, grouped show › season › episode, a remove per row and "Remove all". The saved files are the
 * completed downloads; the sizes are the download engine's (`listItems`), the names the library's, or the download's
 * own when the library is not open. Downloads still running stay on the Downloads screen.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MobileOfflineContent } from "@space/mobile-shell/offline-content";
import { scopeLogger } from "@space/mobile-shell/logger";
import {
  groupBadgerOffline,
  type BadgerOfflineTitle,
  type OfflineManageList,
  type OfflineManageRow,
} from "@space/shared/offlineManage";
import { nativeListItems, nativeRemoveAll, type DownloadItem } from "@space/mobile-media-proxy/downloads";
import { useDownloads } from "../lib/downloads/downloadsStore";
import { removeDownloads } from "../lib/downloads/downloadActions";
import { useLibraryActions } from "../store/library";
import { MediaArtwork } from "../components/MediaArtwork";

const log = scopeLogger("offline-content");

/** The file ids under a row: a film or episode is its file, a show or season every episode below it. */
const fileIdsOf = (row: OfflineManageRow): string[] => (row.fileId ? [row.fileId] : row.children.flatMap(fileIdsOf));

/** A title named by the downloads themselves, for when the library is not open or no longer has it. */
const titleFromDownloads = (items: readonly DownloadItem[]): BadgerOfflineTitle => ({
  type: items.some((item) => item.seasonNumber !== null) ? "tv" : "movie",
  title: items[0]!.title,
  posterPath: null,
  files: items.map((item) => ({ id: item.id, season: item.seasonNumber, episode: item.episodeNumber })),
});

export const OfflineContentScreen = () => {
  const navigation = useNavigation();
  const { items } = useDownloads();
  const { getMediaDetails } = useLibraryActions();
  const completed = useMemo(() => items.filter((item) => item.status === "completed"), [items]);
  // The list is read again whenever a download finishes or one is removed.
  const signature = completed.map((item) => `${item.id}:${item.completedAt}`).join(",");
  const [list, setList] = useState<OfflineManageList | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const inventory = await nativeListItems();
      const bytes = new Map(inventory.items.map((item) => [item.itemId, item.bytes]));
      const byMedia = new Map<string, DownloadItem[]>();
      for (const item of completed) byMedia.set(item.mediaId, [...(byMedia.get(item.mediaId) ?? []), item]);
      const titles = new Map<string, BadgerOfflineTitle>();
      for (const [mediaId, downloads] of byMedia) {
        const details = await getMediaDetails(mediaId, { chunks: false }).catch((err: unknown) => {
          log.warn("details.failed", { mediaId, error: String(err) });
          return null;
        });
        titles.set(mediaId, details ?? titleFromDownloads(downloads));
      }
      const grouped = groupBadgerOffline(
        completed.map((item) => ({ mediaId: item.mediaId, fileId: item.id, totalBytes: bytes.get(item.id) ?? item.storedBytes })),
        (mediaId) => titles.get(mediaId) ?? null
      );
      log.info("listed", { items: completed.length, rows: grouped.rows.length, totalBytes: inventory.totalBytes });
      // The engine counts an object two files share once; the rows' sum would count it twice.
      if (!cancelled) setList({ rows: grouped.rows, totalBytes: inventory.totalBytes });
    })().catch((err: unknown) => {
      log.warn("list.failed", { error: String(err) });
      if (!cancelled) setList({ rows: [], totalBytes: 0 });
    });
    return () => {
      cancelled = true;
    };
    // `completed` changes identity on every progress tick of a running download; the signature only when a file lands.
  }, [signature, getMediaDetails]);

  const onRemove = useCallback((row: OfflineManageRow) => removeDownloads(fileIdsOf(row)), []);
  const onRemoveAll = useCallback(async () => {
    log.info("removeAll");
    await nativeRemoveAll();
  }, []);
  const renderArtwork = useCallback(
    (row: OfflineManageRow) =>
      row.imagePath ? <MediaArtwork path={row.imagePath} kind="poster" label={row.title ?? undefined} style={styles.artwork} /> : null,
    []
  );

  return (
    <SafeAreaView style={styles.safe}>
      <MobileOfflineContent
        app="badger"
        list={list}
        onRemove={onRemove}
        onRemoveAll={onRemoveAll}
        onBack={() => navigation.goBack()}
        renderArtwork={renderArtwork}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  artwork: { width: "100%", height: "100%" },
});
