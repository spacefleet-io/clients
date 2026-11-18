import React, { memo, useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { useTranslation } from "@space/mobile-shell/i18n";
import { answerDownloadQuality, useDownloadQualityRequest } from "../lib/downloads/qualityPrompt";
import { formatBytes } from "../lib/downloads/decisions";
import { theme } from "../theme/theme";
import { BottomSheet } from "./BottomSheet";
import { usePickerSheet } from "./usePickerSheet";

/**
 * The download quality prompt (OFFL-QUAL-01): every quality of the title or
 * batch with its size, highest first, and for a batch which episodes get
 * another quality. Mounted once on the details page; answers the request
 * that `startDownload` made through `askDownloadQuality`. Dismissing the
 * sheet (backdrop, drag) cancels the download.
 */
export const DownloadQualitySheet = memo(() => {
  const { t } = useTranslation();
  const sheet = usePickerSheet();
  const choices = useDownloadQualityRequest();
  const shown = useRef(false);
  // A quality was picked: the sheet slides out, then answers; it must not reopen meanwhile.
  const picked = useRef(false);

  useEffect(() => {
    if (choices && !sheet.visible && !picked.current) {
      if (shown.current) {
        // Closed without a pick (backdrop / drag): the download does not start.
        shown.current = false;
        console.info("downloads.quality.dismissed");
        answerDownloadQuality(null);
        return;
      }
      shown.current = true;
      sheet.open();
    }
    if (!choices) {
      shown.current = false;
      picked.current = false;
    }
  }, [choices, sheet]);

  if (!choices) return null;
  return (
    <BottomSheet sheet={sheet} testID="download-quality-sheet">
      <Text style={styles.title} accessibilityRole="header">
        {t("downloads.quality.title")}
      </Text>
      <Text style={styles.muted}>{t("downloads.quality.hint")}</Text>
      <MobileSheetScrollView contentContainerStyle={styles.list}>
        {choices.map((choice) => (
          <Pressable
            key={choice.quality}
            testID={`download-quality-${choice.quality}`}
            style={styles.row}
            onPress={() => {
              console.info("downloads.quality.picked", JSON.stringify({ quality: choice.quality }));
              shown.current = false;
              picked.current = true;
              sheet.close(() => answerDownloadQuality(choice.quality));
            }}
            accessibilityRole="button"
            accessibilityLabel={`${choice.quality} ${formatBytes(choice.totalBytes)}`}
          >
            <View style={styles.rowMain}>
              <Text style={styles.quality}>{choice.quality}</Text>
              <Text style={styles.size}>{formatBytes(choice.totalBytes)}</Text>
            </View>
            {choice.fallbacks.map((fallback) => (
              <Text key={fallback.quality} style={styles.note}>
                {t("downloads.quality.fallback", { count: fallback.count, chosen: choice.quality, quality: fallback.quality })}
              </Text>
            ))}
          </Pressable>
        ))}
      </MobileSheetScrollView>
    </BottomSheet>
  );
});
DownloadQualitySheet.displayName = "DownloadQualitySheet";

const styles = StyleSheet.create({
  title: { color: theme.colors.text, fontSize: 16, fontWeight: "800", fontFamily: theme.font.family.display },
  muted: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 4 },
  list: { gap: 8, paddingBottom: 8 },
  row: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowMain: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  quality: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  size: { color: theme.colors.textMuted, fontSize: 13, fontWeight: "600" },
  note: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 17 },
});
