/**
 * The TV's notice history (UX-NOTICE-04): a "Notifications" row in Settings with the number of unread entries at its
 * end, "9+" above 9 and none when all are seen (UX-NOTICE-12), opening a `TvListDialog` with the entries, newest first.
 * Opening it marks every entry seen, and so does an entry arriving while it is open. OK on an entry follows its target;
 * Back closes. Entries are drawn from their text keys in the language of the moment (UX-NOTICE-13).
 */
import React, { useEffect, useMemo } from "react";
import { Bell } from "lucide-react-native";
import { badgeLabel, type NoticeHistory } from "@space/notify-core/history";
import { partText, titleText, type Translate } from "@space/notify-core/texts";
import { useTranslation } from "../i18n";
import { noticeEntryTime, useNoticeHistory } from "../notice-history";
import { TvListDialog, type TvListDialogItem } from "./TvListDialog";
import { TvRow } from "./TvRow";

type TvNotificationsRowProps = {
  history: NoticeHistory | null;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
};

/** The Settings row that opens the history; its end shows the unread count, its grey line says how many there are. */
export const TvNotificationsRow = ({ history, onPress, hasTVPreferredFocus }: TvNotificationsRowProps) => {
  const { t } = useTranslation();
  const entries = useNoticeHistory(history);
  const unread = entries.filter((entry) => !entry.read).length;
  const badge = badgeLabel(unread);
  const description =
    unread > 0 ? t("notify.unread", { count: unread }) : entries.length > 0 ? t("notify.recent", { count: entries.length }) : t("notify.empty");
  return (
    <TvRow
      testID="tv-settings-notifications"
      icon={Bell}
      title={t("notify.tv.settingsRow")}
      description={description}
      end={badge ? { kind: "value", value: badge } : { kind: "chevron" }}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onPress={onPress}
    />
  );
};

type TvNoticeHistoryDialogProps = {
  history: NoticeHistory | null;
  onClose: () => void;
  /** Follows an entry's button or target; the caller closes the dialog or replaces it. */
  onOpenTarget: (target: string) => void;
};

/** The history over Settings: one item per entry (title, then message and time), then "Clear all" when there are any. */
export const TvNoticeHistoryDialog = ({ history, onClose, onOpenTarget }: TvNoticeHistoryDialogProps) => {
  const { t, i18n } = useTranslation();
  const entries = useNoticeHistory(history);
  useEffect(() => {
    history?.markAllRead();
  }, [history, entries]);
  const items = useMemo<TvListDialogItem[]>(() => {
    const tr: Translate = (key, vars) => t(key, vars);
    const list: TvListDialogItem[] = entries.map((entry) => {
      const target = entry.action?.target ?? entry.target;
      const message = partText(tr, entry.message);
      const time = noticeEntryTime(entry.timestamp, i18n.language);
      return {
        key: entry.id,
        label: titleText(tr, entry),
        detail: message ? `${message} · ${time}` : time,
        testID: `notice-entry-${entry.key}`,
        onPress: () => {
          if (target) onOpenTarget(target);
        },
      };
    });
    if (list.length > 0) {
      list.push({ key: "clear-all", label: t("notify.clearAll"), danger: true, testID: "notice-history-clear", onPress: () => history?.clearAll() });
    }
    return list;
  }, [entries, history, i18n.language, onOpenTarget, t]);
  return (
    <TvListDialog
      testID="notice-history"
      title={t("notify.title")}
      message={entries.length > 0 ? t("notify.tv.openOrClose") : t("notify.empty")}
      items={items}
      onClose={onClose}
    />
  );
};
