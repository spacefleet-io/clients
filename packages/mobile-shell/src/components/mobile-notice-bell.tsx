/**
 * The phone's bell and the history screen it opens (UX-NOTICE-04): the bell sits in the shell's header with the number
 * of unread entries on it, "9+" above 9 and none when all are seen (UX-NOTICE-12). It opens the history full screen;
 * opening it marks every entry seen, and so does an entry arriving while it is open. Entries are drawn from their text
 * keys in the language of the moment (UX-NOTICE-13); an entry's button follows its target, the cross removes it.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Bell, X } from "lucide-react-native";
import { badgeLabel, type HistoryEntry, type NoticeHistory } from "@space/notify-core/history";
import { partText, titleText, type Translate } from "@space/notify-core/texts";
import { useTranslation } from "../i18n";
import { noticeEntryTime, useNoticeHistory } from "../notice-history";
import { useMobileShellTheme } from "../theme";
import { MobileIconButton } from "./mobile-icon-button";

export type MobileNoticeBellProps = {
  /** `null` before sign-in: the bell shows an empty history. */
  history: NoticeHistory | null;
  /** Follows an entry's button or target; the history screen closes first. */
  onOpenTarget?: (target: string) => void;
};

export const MobileNoticeBell = ({ history, onOpenTarget }: MobileNoticeBellProps) => {
  const theme = useMobileShellTheme();
  const { t, i18n } = useTranslation();
  const tr: Translate = (key, vars) => t(key, vars);
  const [open, setOpen] = useState(false);
  const entries = useNoticeHistory(history);
  useEffect(() => {
    if (open) history?.markAllRead();
  }, [open, history, entries]);
  const unread = entries.filter((entry) => !entry.read).length;
  const badge = badgeLabel(unread);
  const close = useCallback(() => setOpen(false), []);
  const label = unread > 0 ? `${t("notify.bell")}, ${t("notify.unread", { count: unread })}` : t("notify.bell");
  return (
    <>
      <MobileIconButton label={label} onPress={() => setOpen(true)} testID="nav-notifications">
        <Bell size={22} color={theme.colors.text} />
        {badge ? (
          <View pointerEvents="none" style={[styles.badge, { backgroundColor: theme.colors.accent }]} testID="nav-notifications-count">
            <Text style={[styles.badgeText, { color: theme.colors.bg }]}>{badge}</Text>
          </View>
        ) : null}
      </MobileIconButton>
      <MobileNoticeHistory
        visible={open}
        entries={entries}
        t={tr}
        language={i18n.language}
        onClose={close}
        onRemove={(id) => history?.remove(id)}
        onClearAll={() => history?.clearAll()}
        onOpenTarget={
          onOpenTarget
            ? (target) => {
                setOpen(false);
                onOpenTarget(target);
              }
            : undefined
        }
      />
    </>
  );
};

type MobileNoticeHistoryProps = {
  visible: boolean;
  entries: readonly HistoryEntry[];
  t: Translate;
  language: string;
  onClose: () => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  onOpenTarget?: (target: string) => void;
};

/** The history screen: newest first, each entry with its time, its button when it leads somewhere, and a cross. */
const MobileNoticeHistory = ({ visible, entries, t, language, onClose, onRemove, onClearAll, onOpenTarget }: MobileNoticeHistoryProps) => {
  const theme = useMobileShellTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={[styles.screen, { backgroundColor: theme.colors.bg, paddingTop: insets.top + 4, paddingBottom: insets.bottom }]} testID="notice-history">
        <View style={styles.top}>
          <MobileIconButton label={t("notify.close")} onPress={onClose} testID="notice-history-close">
            <X size={22} color={theme.colors.text} />
          </MobileIconButton>
          <View style={styles.heading}>
            <Text style={[styles.title, { color: theme.colors.text }]} accessibilityRole="header">
              {t("notify.title")}
            </Text>
            <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>{t("notify.recent", { count: entries.length })}</Text>
          </View>
          {entries.length > 0 ? (
            <Pressable onPress={onClearAll} accessibilityRole="button" hitSlop={8} style={styles.clearAll} testID="notice-history-clear">
              <Text style={[styles.clearAllText, { color: theme.colors.accent }]}>{t("notify.clearAll")}</Text>
            </Pressable>
          ) : null}
        </View>
        {entries.length === 0 ? (
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: theme.colors.textMuted }]} testID="notice-history-empty">
              {t("notify.empty")}
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            {entries.map((entry) => {
              const title = titleText(t, entry);
              const message = partText(t, entry.message);
              const target = entry.action?.target ?? entry.target;
              return (
                <View
                  key={entry.id}
                  style={[styles.entry, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
                  testID={`notice-entry-${entry.key}`}
                >
                  <View style={styles.entryBody}>
                    <Text style={[styles.entryTitle, { color: theme.colors.text }]}>{title}</Text>
                    {message ? <Text style={[styles.entryMessage, { color: theme.colors.textMuted }]}>{message}</Text> : null}
                    <Text style={[styles.entryTime, { color: theme.colors.textDim }]}>{noticeEntryTime(entry.timestamp, language)}</Text>
                    {target && onOpenTarget ? (
                      <Pressable
                        onPress={() => onOpenTarget(target)}
                        accessibilityRole="button"
                        hitSlop={8}
                        style={styles.entryOpen}
                        testID={`notice-entry-open-${entry.key}`}
                      >
                        <Text style={[styles.entryOpenText, { color: theme.colors.accent }]}>
                          {entry.action ? partText(t, entry.action.label) : t("notify.open")}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <MobileIconButton label={t("notify.remove")} onPress={() => onRemove(entry.id)} testID={`notice-entry-remove-${entry.key}`}>
                    <X size={18} color={theme.colors.textMuted} />
                  </MobileIconButton>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  badge: {
    position: "absolute",
    top: 6,
    right: 4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 11, fontWeight: "900" },
  screen: { flex: 1 },
  top: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, gap: 4 },
  heading: { flex: 1, gap: 2 },
  title: { fontSize: 20, fontWeight: "800" },
  subtitle: { fontSize: 13 },
  clearAll: { paddingHorizontal: 12, paddingVertical: 12 },
  clearAllText: { fontSize: 14, fontWeight: "700" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { fontSize: 15 },
  list: { padding: 16, gap: 10 },
  entry: { flexDirection: "row", alignItems: "flex-start", borderWidth: 1, borderRadius: 14, paddingLeft: 14, paddingVertical: 4 },
  entryBody: { flex: 1, paddingVertical: 8, gap: 3 },
  entryTitle: { fontSize: 15, fontWeight: "800" },
  entryMessage: { fontSize: 14 },
  entryTime: { fontSize: 12 },
  entryOpen: { alignSelf: "flex-start", paddingVertical: 6 },
  entryOpenText: { fontSize: 14, fontWeight: "700" },
});
