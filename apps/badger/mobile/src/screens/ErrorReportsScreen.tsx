import React, { useCallback } from "react";
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { MobileAppBackdrop, MobileErrorReportsLink } from "@space/mobile-shell/components";
import { Button, SectionHeader } from "../components/ui";
import { Screen } from "../components/Screen";
import { useAppSettings } from "../lib/appSettings";
import { scopeLogger } from "@space/mobile-shell/logger";
import { theme } from "../theme/theme";
import { PairingButton } from "../tv/components/PairingButton";
import { TV_PANEL_BORDER, TV_RADIUS } from "../tv/lib/tvLook";
import { IS_TV } from "../tv/lib/tvRuntime";
import { TvSetupStepHeader } from "../tv/components/TvSetupStepHeader";
import { useTvScale } from "../tv/lib/tvScale";
import { scaleStyleSheet } from "@space/mobile-mpv-playback/uiScale";
import { useTranslation } from "@space/mobile-shell/i18n";

const log = scopeLogger("onboarding");

/** The SpaceBadger astronaut badger (UX-TV-04: the brand picture of the TV app). */
const MASCOT = require("../assets/mascot.webp");

/**
 * Setup step asked once, after the library key (REL-LOG-06): send error reports to SpaceFleet or not. Neither answer is
 * styled as the preferred one. On TV both answers are remote buttons that show a ring while they have the focus (the
 * phone button shows none, which left the remote with no visible choice), and the remote starts on "No" (UX-TV-14):
 * a screen with no focused button leaves OK doing nothing, and starting on "No" keeps sending off unless the user
 * moves to "Yes". The answer is saved on this device only; the Settings screen has the same switch for changing it later.
 */
export const ErrorReportsScreen = () => {
  const [, update] = useAppSettings();

  const answer = useCallback(
    (errorReports: boolean) => {
      log.info("error_reports.answered", { errorReports, tv: IS_TV });
      update({ errorReports });
    },
    [update],
  );

  return IS_TV ? <TvErrorReports onAnswer={answer} /> : <PhoneErrorReports onAnswer={answer} />;
};

type AnswerProps = { onAnswer: (errorReports: boolean) => void };

const PhoneErrorReports = ({ onAnswer }: AnswerProps) => {
  const { t } = useTranslation();
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll}>
        <SectionHeader title={t("errorReports.title")} />
        <View style={styles.card}>
          <Text style={styles.description}>{t("errorReports.description")}</Text>
          <MobileErrorReportsLink />
        </View>
        <Button testID="error-reports-send" label={t("errorReports.send")} variant="secondary" onPress={() => onAnswer(true)} />
        <Button testID="error-reports-decline" label={t("errorReports.decline")} variant="secondary" onPress={() => onAnswer(false)} />
      </ScrollView>
    </Screen>
  );
};

/**
 * The TV question as approved in the TV design (UX-TV-04): one square panel over the starry sky, the astronaut badger,
 * the one-line explanation (REL-LOG-06) and the two answers side by side. No "What's in a report?" link here: a TV has
 * no browser to open the privacy policy in, so the link lives on the phone and desktop screens only. The setup's last
 * numbered step: "STEP N OF M" and the step bar on top (UX-SETUP-08).
 */
const TvErrorReports = ({ onAnswer }: AnswerProps) => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = scaleStyleSheet(baseTvStyles, scale);
  return (
    <View style={styles.tvScreen}>
      <MobileAppBackdrop />
      <View style={styles.tvPanel}>
        <View style={styles.tvStepBar}>
          <TvSetupStepHeader step="errorReports" />
        </View>
        <Image source={MASCOT} style={styles.tvMascot} resizeMode="contain" accessible={false} />
        <Text style={styles.tvTitle} accessibilityRole="header">
          {t("tvShell.errorReports.title")}
        </Text>
        <Text style={styles.tvBody}>{t("tvShell.errorReports.body")}</Text>
        <View style={styles.tvActions}>
          <PairingButton compact testID="error-reports-send" label={t("tvShell.errorReports.send")} onPress={() => onAnswer(true)} />
          <PairingButton compact preferredFocus testID="error-reports-decline" label={t("tvShell.errorReports.decline")} onPress={() => onAnswer(false)} />
        </View>
        <Text style={styles.tvFooter}>{t("tvShell.errorReports.footer")}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  scroll: {
    gap: theme.spacing.lg,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing.sm,
  },
  description: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
  },
});

/** The TV question in design dp (960x540), drawn at the window's TV scale (UX-TV-13). */
const baseTvStyles = StyleSheet.create({
  tvScreen: { flex: 1, alignItems: "center", justifyContent: "center" },
  tvPanel: {
    width: 560,
    alignItems: "center",
    paddingTop: 36,
    paddingBottom: 32,
    paddingHorizontal: 44,
    borderRadius: TV_RADIUS.panel,
    // Nearly opaque (#242638eb in the design): the question must read clearly over the stars.
    backgroundColor: "rgba(36, 38, 56, 0.92)",
    borderWidth: 1,
    borderColor: TV_PANEL_BORDER,
  },
  tvMascot: { width: 84, height: 84 },
  tvStepBar: { alignSelf: "stretch", marginBottom: 8 },
  tvTitle: {
    marginTop: 18,
    marginBottom: 10,
    fontSize: 30,
    lineHeight: 35,
    fontWeight: "700",
    color: theme.colors.text,
    fontFamily: theme.font.family.display,
    textAlign: "center",
  },
  tvBody: { maxWidth: 440, fontSize: 15, lineHeight: 22, color: theme.colors.textMuted, textAlign: "center" },
  // The focused button grows 6% around its centre: the gap keeps the two apart.
  tvActions: { flexDirection: "row", justifyContent: "center", gap: 16, marginTop: 26 },
  tvFooter: { marginTop: 16, fontSize: 12, color: theme.colors.textDim, textAlign: "center" },
});
