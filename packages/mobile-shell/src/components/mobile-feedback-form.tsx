import React, { useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { FeedbackInput } from "@space/shared/api";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { FEEDBACK_MESSAGE_MAX, buildFeedback, feedbackFailure, type FeedbackDevice, type FeedbackFailure } from "../feedback";
import { MobileButtonFace } from "./mobile-button-face";

type Props = {
  device: FeedbackDevice;
  /** The app's error log, read only when the user ticked the box. */
  readLog: () => string;
  send: (input: FeedbackInput) => Promise<unknown>;
  /** Reports each outcome to the app's log (never the message itself). */
  onOutcome?: (outcome: "sent" | FeedbackFailure | "empty", details: { attachLog: boolean; length: number }) => void;
};

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; reason: FeedbackFailure | "empty" };

/** "Send feedback" (UX-SUP-05): a message, an error-log box unticked by default (UX-SUP-02), and Send. */
export const MobileFeedbackForm = ({ device, readLog, send, onOutcome }: Props) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const [message, setMessage] = useState("");
  const [attachLog, setAttachLog] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const submit = async () => {
    const body = buildFeedback({ message, attachLog }, device, readLog);
    const details = { attachLog, length: message.trim().length };
    if (!body) {
      setStatus({ kind: "error", reason: "empty" });
      onOutcome?.("empty", details);
      return;
    }
    setStatus({ kind: "sending" });
    try {
      await send(body);
      setStatus({ kind: "sent" });
      setMessage("");
      setAttachLog(false);
      onOutcome?.("sent", details);
    } catch (error) {
      const reason = feedbackFailure(error);
      setStatus({ kind: "error", reason });
      onOutcome?.(reason, details);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={[styles.intro, { color: theme.colors.textMuted }]}>{t("feedback.intro")}</Text>
      <TextInput
        testID="feedback-message"
        style={[styles.input, { borderColor: theme.colors.controlBorder, color: theme.colors.text, backgroundColor: theme.colors.surfaceRaised }]}
        value={message}
        onChangeText={(value) => {
          setMessage(value);
          if (status.kind !== "sending") setStatus({ kind: "idle" });
        }}
        placeholder={t("feedback.placeholder")}
        placeholderTextColor={theme.colors.textMuted}
        multiline
        maxLength={FEEDBACK_MESSAGE_MAX}
        textAlignVertical="top"
        accessibilityLabel={t("feedback.placeholder")}
      />
      <Pressable style={styles.logRow} onPress={() => setAttachLog((v) => !v)} accessibilityRole="switch" accessibilityState={{ checked: attachLog }}>
        <View style={styles.logText}>
          <Text style={[styles.logTitle, { color: theme.colors.text }]}>{t("feedback.attachLog")}</Text>
          <Text style={[styles.logHint, { color: theme.colors.textMuted }]}>{t("feedback.attachLogHint")}</Text>
        </View>
        <Switch testID="feedback-attach-log" value={attachLog} onValueChange={setAttachLog} />
      </Pressable>
      {status.kind === "sent" ? (
        <Text testID="feedback-sent" style={[styles.status, { color: theme.colors.success }]}>{t("feedback.sent")}</Text>
      ) : status.kind === "error" ? (
        <Text testID="feedback-error" style={[styles.status, { color: theme.colors.danger }]}>{t(`feedback.errors.${status.reason}`)}</Text>
      ) : null}
      <MobileButtonFace
        testID="feedback-send"
        label={status.kind === "sending" ? t("feedback.sending") : t("feedback.send")}
        loading={status.kind === "sending"}
        disabled={status.kind === "sending"}
        onPress={() => void submit()}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  intro: { fontSize: 14, lineHeight: 20 },
  input: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, minHeight: 160 },
  logRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  logText: { flex: 1, gap: 2 },
  logTitle: { fontSize: 15, fontWeight: "600" },
  logHint: { fontSize: 13 },
  status: { fontSize: 14 },
});
