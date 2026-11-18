import React, { useCallback, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMobileShellTheme } from "../theme";
import { MobileRenderBoundary } from "./mobile-render-boundary";

type MobileApiHostModalProps = {
  visible: boolean;
  onClose: () => void;
  currentHost: string;
  onSave: (host: string) => Promise<void>;
  labels: {
    title: string;
    subtitle: string;
    label: string;
    placeholder: string;
    hint: string;
    useDefault: string;
    save: string;
    saving: string;
    error: string;
  };
};

export const MobileApiHostModal = ({
  visible,
  onClose,
  currentHost,
  onSave,
  labels,
}: MobileApiHostModalProps) => {
  const theme = useMobileShellTheme();
  const [host, setHost] = useState(currentHost);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(host.trim());
      onClose();
    } catch {
      setError(labels.error);
    } finally {
      setSaving(false);
    }
  }, [host, labels.error, onClose, onSave]);

  const handleDefault = useCallback(async () => {
    setHost("");
    setSaving(true);
    setError(null);
    try {
      await onSave("");
      onClose();
    } catch {
      setError(labels.error);
    } finally {
      setSaving(false);
    }
  }, [labels.error, onClose, onSave]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {/* UX-CRASH-01: a crash inside the dialog closes it; the window guard says why. */}
      <MobileRenderBoundary name="modal:api-host" onDismiss={onClose}>
      {/* Backdrop and card are tap targets only; `accessible={false}` keeps iOS from folding the field and buttons into one element. */}
      <Pressable style={styles.backdrop} onPress={onClose} accessible={false}>
        <Pressable
          style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
          onPress={() => {}}
          accessible={false}
        >
          <Text style={[styles.title, { color: theme.colors.text }]}>{labels.title}</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>{labels.subtitle}</Text>

          <View style={styles.fieldGroup}>
            <Text style={[styles.label, { color: theme.colors.textDim }]}>{labels.label}</Text>
            <TextInput
              testID="api-host-field"
              accessibilityLabel={labels.label}
              value={host}
              onChangeText={setHost}
              placeholder={labels.placeholder}
              placeholderTextColor={theme.colors.textDim}
              style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.controlBorder, backgroundColor: theme.colors.surfaceRaised }]}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={[styles.hint, { color: theme.colors.textDim }]}>{labels.hint}</Text>
          </View>

          {error ? (
            <View style={[styles.errorWrap, { borderColor: "rgba(255,99,99,0.4)", backgroundColor: "rgba(255,99,99,0.1)" }]}>
              <Text style={[styles.errorText, { color: "#ff7f7f" }]}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              style={[styles.actionBtn, styles.outlineBtn, { borderColor: theme.colors.border }]}
              onPress={() => void handleDefault()}
              disabled={saving}
            >
              <Text style={[styles.actionLabel, { color: theme.colors.textMuted }]}>{labels.useDefault}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.actionBtn, { backgroundColor: theme.colors.accent }]}
              onPress={() => void handleSave()}
              disabled={saving}
            >
              <Text style={[styles.actionLabel, { color: theme.accentTextHex }]}>
                {saving ? labels.saving : labels.save}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
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
    maxWidth: 400,
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  title: {
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 18,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  input: {
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 13,
  },
  hint: {
    fontSize: 11,
    lineHeight: 16,
  },
  errorWrap: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
  },
  errorText: {
    fontSize: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  outlineBtn: {
    borderWidth: 1,
  },
  actionLabel: {
    fontWeight: "900",
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
});
