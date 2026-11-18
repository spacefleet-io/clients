import React, { useCallback, useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { sendFeedback, type FeedbackInput } from "@space/shared/api";
import { MobileFeedbackForm } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useAuth } from "../store/auth";
import { IconButton } from "../components/IconButton";
import { SettingsGroup } from "../components/SettingsRows";
import { phoneFeedbackDevice } from "@space/mobile-shell/feedback-device";
import packageJson from "../../package.json";
import { readErrorLog, scopeLogger } from "@space/mobile-shell/logger";
import { theme } from "../theme/theme";

const log = scopeLogger("feedback");

/** "Send feedback" (UX-SUP-05), opened from Settings → Support; the form itself is shared (`@space/mobile-shell`). */
export const FeedbackScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { token } = useAuth();
  const device = useMemo(() => phoneFeedbackDevice("badger-mobile", packageJson.version), []);

  const send = useCallback(
    (input: FeedbackInput) => {
      if (!token) return Promise.reject(new Error("signed_out"));
      return sendFeedback(token, input);
    },
    [token],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <IconButton label={t("feedback.back")} onPress={() => navigation.goBack()}>
          <ArrowLeft size={22} color={theme.colors.text} />
        </IconButton>
        <Text style={styles.title} accessibilityRole="header">
          {t("feedback.title")}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <SettingsGroup>
          <View style={styles.form}>
            <MobileFeedbackForm
              device={device}
              readLog={readErrorLog}
              send={send}
              onOutcome={(outcome, details) =>
                (outcome === "sent" ? log.info : log.warn)("send.outcome", { outcome, ...details, app: device.app })
              }
            />
          </View>
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  title: { flex: 1, fontSize: 22, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  content: { paddingTop: 8, paddingBottom: 24, gap: 16 },
  form: { padding: 16 },
});
