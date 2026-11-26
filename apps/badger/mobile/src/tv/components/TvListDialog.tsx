import React, { useEffect, useMemo, useRef } from "react";
import { BackHandler, ScrollView, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import { Check } from "lucide-react-native";
import { SkyCover } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { theme } from "../../theme/theme";
import { useTvMenuKeyHold } from "@space/mobile-shell/tv/useTvMenuKey";
import { TV_SAFE_MARGIN_X, TV_SAFE_MARGIN_Y } from "@space/mobile-shell/tv/layout";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
import { TV_RADIUS } from "../lib/tvLook";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";

export type TvListDialogItem = {
  key: string;
  label: string;
  /** Second line (a device's type and last seen, a hint). */
  detail?: string;
  /** The current choice: marked, and the focus starts on it. */
  selected?: boolean;
  danger?: boolean;
  testID?: string;
  onPress: () => void;
};

type TvListDialogProps = {
  title: string;
  /** Text above the list (an explanation, an error). */
  message?: string;
  /** Second message, shown in the danger colour (a failed load or sign-out). */
  error?: string | null;
  items: readonly TvListDialogItem[];
  /** Key of the item the focus starts on; else the selected item, else the first. */
  initialFocusKey?: string;
  onClose: () => void;
  testID: string;
};

/** Where the focus starts: the named item, else the selected one, else the first (or the Close button when empty). */
export const dialogInitialFocusIndex = (items: readonly Pick<TvListDialogItem, "key" | "selected">[], initialFocusKey?: string): number => {
  const named = initialFocusKey ? items.findIndex((item) => item.key === initialFocusKey) : -1;
  if (named >= 0) return named;
  const selected = items.findIndex((item) => item.selected === true);
  if (selected >= 0) return selected;
  return items.length > 0 ? 0 : -1;
};

/**
 * A TV window over the page that holds a list and scrolls on its own (UX-LIST-01): a long choice (the default audio
 * language), a list that grows with the user's data ("Your devices") or a confirmation. The focus is trapped inside it,
 * starts on the current choice, and Back (Menu on Apple TV) or the Close button closes it (UX-TV-01, UX-A11Y-04). Render
 * it as the last child of a full-size container: it covers that container.
 */
export const TvListDialog = ({ title, message, error, items, initialFocusKey, onClose, testID }: TvListDialogProps) => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const focusIndex = useMemo(() => dialogInitialFocusIndex(items, initialFocusKey), [initialFocusKey, items]);
  // Logged once per opening, with the list as it was then (what the e2e reads); later changes log tv.dialog.items.
  const opened = useRef({ items: items.length, focusIndex });
  useEffect(() => {
    console.info("tv.dialog.open", JSON.stringify({ dialog: testID, ...opened.current }));
    return () => console.info("tv.dialog.close", JSON.stringify({ dialog: testID }));
  }, [testID]);
  useEffect(() => {
    console.info("tv.dialog.items", JSON.stringify({ dialog: testID, items: items.map((item) => item.testID ?? item.key) }));
  }, [items, testID]);
  // Back closes the window before anything behind it sees the key (the last handler added runs first).
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      console.info("tv.dialog.back", JSON.stringify({ dialog: testID }));
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, testID]);
  useTvMenuKeyHold("tv-dialog", true);

  return (
    // The dimmed backdrop covers the whole page: no shooting star while the dialog is open (UX-SKY-01).
    <SkyCover style={styles.backdrop} testID={testID}>
      <TVFocusGuideView style={styles.panel} trapFocusUp trapFocusDown trapFocusLeft trapFocusRight accessibilityViewIsModal>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator>
          {items.map((item, index) => (
            <TvFocusable
              key={item.key}
              style={[styles.row, item.selected && styles.rowSelected]}
              scale={1.02}
              hasTVPreferredFocus={index === focusIndex}
              onPress={item.onPress}
              testID={item.testID}
              accessibilityLabel={item.detail ? `${item.label}, ${item.detail}` : item.label}
              accessibilityState={{ selected: item.selected === true }}
            >
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, item.selected && styles.rowLabelSelected, item.danger && styles.rowLabelDanger]} numberOfLines={1}>
                  {item.label}
                </Text>
                {item.detail ? (
                  <Text style={styles.rowDetail} numberOfLines={2}>
                    {item.detail}
                  </Text>
                ) : null}
              </View>
              {item.selected ? <Check size={22 * scale} color={theme.colors.accent} /> : null}
            </TvFocusable>
          ))}
        </ScrollView>
        <TvFocusable
          style={styles.close}
          scale={1.04}
          hasTVPreferredFocus={focusIndex < 0}
          onPress={onClose}
          testID={`${testID}-close`}
          accessibilityLabel={t("tvShell.dialog.close")}
        >
          <Text style={styles.closeLabel}>{t("tvShell.dialog.close")}</Text>
        </TvFocusable>
      </TVFocusGuideView>
    </SkyCover>
  );
};

/** Sizes in design dp (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: TV_SAFE_MARGIN_X,
    paddingVertical: TV_SAFE_MARGIN_Y,
  },
  panel: {
    width: "100%",
    maxWidth: 760,
    maxHeight: "100%",
    // A square window, like desktop dialogs (UX-TV-04); opaque, as it sits over the dimmed page.
    borderRadius: TV_RADIUS.panel,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 24,
    paddingVertical: 20,
    gap: 12,
  },
  title: { fontSize: 24, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  message: { fontSize: 16, lineHeight: 22, color: theme.colors.textMuted },
  error: { fontSize: 16, lineHeight: 22, color: theme.colors.danger },
  list: { flexGrow: 0, flexShrink: 1 },
  listContent: { gap: 6, paddingVertical: 6 },
  row: {
    borderRadius: TV_RADIUS.button,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  rowSelected: { backgroundColor: theme.colors.accentSoft },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 18, fontWeight: "700", color: theme.colors.text },
  rowLabelSelected: { color: theme.colors.accent },
  rowLabelDanger: { color: theme.colors.danger },
  rowDetail: { fontSize: 14, lineHeight: 20, color: theme.colors.textMuted },
  close: {
    alignSelf: "flex-end",
    paddingHorizontal: 28,
    paddingVertical: 10,
    borderRadius: TV_RADIUS.button,
    backgroundColor: theme.colors.surfaceRaised,
  },
  closeLabel: { fontSize: 18, fontWeight: "700", color: theme.colors.text },
});
