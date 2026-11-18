import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useMobileShellTheme } from "../theme";

type MobileNoticeToastProps = {
  title: string;
  hint?: string;
  /** Read for the whole card; tapping it runs `onOpen`. */
  accessibilityLabel: string;
  closeLabel: string;
  onOpen: () => void;
  onClose: () => void;
  testID?: string;
};

/**
 * An in-app notice floating over the top of the page (UX-NOTICE-01): absolutely positioned under the status bar, so the
 * page underneath never moves. Tapping the card opens what it is about; the cross closes it. The timer lives in
 * `useNoticeQueue`; this only draws. The wrapper lets touches outside the card reach the page.
 */
export const MobileNoticeToast = ({
  title,
  hint,
  accessibilityLabel,
  closeLabel,
  onOpen,
  onClose,
  testID = "notice-toast",
}: MobileNoticeToastProps) => {
  const theme = useMobileShellTheme();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.layer, { top: insets.top + 8 }]} testID={`${testID}-layer`}>
      <View
        style={[styles.card, { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent }]}
        testID={testID}
      >
        <Pressable
          style={styles.body}
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={`${testID}-open`}
        >
          <Text style={[styles.title, { color: theme.colors.accent }]}>{title}</Text>
          {hint ? <Text style={[styles.hint, { color: theme.colors.textMuted }]}>{hint}</Text> : null}
        </Pressable>
        <Pressable
          style={styles.close}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          hitSlop={8}
          testID={`${testID}-close`}
        >
          <X size={18} color={theme.colors.textMuted} />
        </Pressable>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 12, right: 12, zIndex: 20, elevation: 20 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 14,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  body: { flex: 1, paddingLeft: 14, paddingVertical: 10, gap: 2 },
  title: { fontSize: 14, fontWeight: "800" },
  hint: { fontSize: 12 },
  close: { padding: 12 },
});
