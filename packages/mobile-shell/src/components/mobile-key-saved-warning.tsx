import React from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import type { KeySavedWarningText } from "@space/shared/keySavedWarning";
import { useMobileShellTheme } from "../theme";
import { MobileButtonFace } from "./mobile-button-face";
import { MobileRenderBoundary } from "./mobile-render-boundary";

/**
 * ACCT-DEV-04, shared by the phone and TV apps that make a new library key: pressing "I've saved my key" opens this
 * warning instead of moving on. "Yes, I understand" is the only way forward; "Go back" (first, so a TV remote lands
 * on it) and the system back both return to the key screen, with the key still shown.
 */
export const MobileKeySavedWarning = ({
  visible,
  text,
  onConfirm,
  onBack,
}: {
  visible: boolean;
  text: KeySavedWarningText;
  onConfirm: () => void;
  onBack: () => void;
}) => {
  const theme = useMobileShellTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onBack}>
      {/* UX-CRASH-01: a crash inside the dialog closes it; the window guard says why. */}
      <MobileRenderBoundary name="modal:key-saved-warning" onDismiss={onBack}>
        <View style={styles.backdrop}>
          <View
            style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
            testID="key-saved-warning"
          >
            <Text style={[styles.title, { color: theme.colors.text }]} accessibilityRole="header">
              {text.title}
            </Text>
            <Text style={[styles.line, { color: theme.colors.textMuted }]}>{`\u2022 ${text.needed}`}</Text>
            <Text style={[styles.line, { color: theme.colors.textMuted }]}>{`\u2022 ${text.noReset}`}</Text>
            <Text style={[styles.line, styles.strong, { color: theme.colors.text }]}>{`\u2022 ${text.lost}`}</Text>
            <View style={styles.actions}>
              <MobileButtonFace label={text.back} variant="secondary" onPress={onBack} testID="key-saved-warning-back" />
              <MobileButtonFace label={text.confirm} onPress={onConfirm} testID="key-saved-warning-confirm" />
            </View>
          </View>
        </View>
      </MobileRenderBoundary>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: "800",
  },
  line: {
    fontSize: 14,
    lineHeight: 20,
  },
  strong: {
    fontWeight: "700",
  },
  actions: {
    gap: 10,
    marginTop: 6,
  },
});
