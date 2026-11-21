import { useCallback, useEffect, useMemo, useState } from "react";
import { OfflineContentList } from "@space/ui/offline-content";
import { formatLocalizedStorage } from "@space/shared/format";
import { groupParrotOffline, type OfflineManageRow, type ParrotOfflineKind } from "@space/shared/offlineManage";
import type { KeptKind } from "@space/parrot-core";
import type { ParrotKeptSizes, ParrotLanguage } from "../../shared/ipc";
import type { Translate } from "./i18n";

/** The name, artist line and cover of a kept album, playlist or song, from the library the window holds. */
export type DescribeKept = (kind: ParrotOfflineKind, id: string) => { title: string; subtitle?: string | null; imagePath?: string | null } | null;

/**
 * Settings › Manage offline content (OFFL-MANAGE-01): every album, playlist and song kept on this computer, with the
 * space each takes here and the total (a song two kept items hold counts once). The bin removes one item from this
 * computer (`unkeep`, the same as its "Remove from this computer" button); "Remove all" asks first, then removes each
 * kept item the same way. It never calls the sign-out `clear`, which also drops the library copy (agent reading).
 */
export function OfflineContent({ t, language, describe }: { t: Translate; language: ParrotLanguage; describe: DescribeKept }) {
  const [sizes, setSizes] = useState<ParrotKeptSizes | null>(null);
  const [failed, setFailed] = useState(false);

  const read = useCallback(() => {
    void window.parrot.getKeptSizes().then(setSizes, () => setSizes({ entries: [], bytes: {} }));
  }, []);
  useEffect(() => {
    read();
    return window.parrot.onKept(() => read());
  }, [read]);

  const list = useMemo(() => groupParrotOffline(sizes?.entries ?? [], (fileId) => sizes?.bytes[fileId] ?? 0, describe), [sizes, describe]);

  const unkeep = async (row: OfflineManageRow) => {
    try {
      await window.parrot.unkeep(row.kind as KeptKind, row.id);
    } catch {
      setFailed(true);
    }
  };

  return (
    <>
      {failed ? (
        <p role="alert" className="mb-3 text-sm text-destructive" data-testid="offline-content-error">
          {t("offline.removeFailed")}
        </p>
      ) : null}
      <OfflineContentList
        rows={list.rows}
        loading={sizes === null}
        imageShape="square"
        totalText={formatLocalizedStorage(list.totalBytes, language)}
        sizeText={(bytes) => formatLocalizedStorage(bytes, language)}
        nameOf={(row) => row.title ?? t("offline.unknown")}
        detailOf={(row) => row.subtitle ?? null}
        imageOf={(row) => (row.imagePath ? <img src={row.imagePath} alt="" className="h-full w-full object-cover" /> : null)}
        labels={{
          total: t("offline.total"),
          empty: t("offline.empty"),
          remove: (name) => t("offline.remove", { name }),
          removeAll: t("offline.removeAll"),
          expand: (name) => name,
          confirmTitle: t("offline.confirmTitle"),
          confirmBody: t("offline.confirmBody"),
          confirmCancel: t("offline.confirmCancel"),
          confirmRemove: t("offline.confirmRemove"),
        }}
        onRemove={async (row) => {
          setFailed(false);
          await unkeep(row);
          read();
        }}
        onRemoveAll={async () => {
          setFailed(false);
          for (const row of list.rows) await unkeep(row);
          read();
        }}
      />
    </>
  );
}
