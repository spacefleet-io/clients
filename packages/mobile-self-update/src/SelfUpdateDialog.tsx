import React from "react";
import { Modal, Platform, StyleSheet, Text, View } from "react-native";
import { MobileButtonFace } from "@space/mobile-shell/button-face";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { closeUpdateDialog, openInstallPermission, snoozeUpdate, startUpdate, useSelfUpdate } from "./controller";
import { selfUpdateText, type SelfUpdateStringKey } from "./strings";

/**
 * REL-UPD-06: the one update dialog of a hand-installed Android app, mounted once at each app's root (phone and TV).
 * "Badger 0.1.10 is available. Update?" (Update / Later), then the explanation before Android's "install unknown
 * apps" screen (first time only), the download progress, and Android's own confirmation. On a TV the remote starts on
 * the main action. It speaks the app's UI language.
 */
export const SelfUpdateDialog = () => {
  const theme = useMobileShellTheme();
  const { i18n } = useTranslation();
  const language = i18n.language;
  const { app, open, phase, newest } = useSelfUpdate();
  if (!app || !newest) return null;
  const tv = Platform.isTV === true;
  const name = app === "badger" ? "Badger" : "Parrot";
  const text = (key: SelfUpdateStringKey, values: Record<string, string | number> = {}) =>
    selfUpdateText(language, key, { app: name, version: newest.versionName, ...values });

  let title = text("promptTitle");
  let body: string;
  let actions: React.ReactNode;
  let progress: number | null = null;
  switch (phase.kind) {
    case "permission":
      title = text("permissionTitle");
      body = text("permissionBody");
      actions = (
        <>
          <MobileButtonFace label={text("cancel")} variant="secondary" onPress={closeUpdateDialog} testID="self-update-cancel" />
          <MobileButtonFace
            label={text("permissionContinue")}
            hasTVPreferredFocus
            onPress={() => void openInstallPermission()}
            testID="self-update-permission"
          />
        </>
      );
      break;
    case "downloading": {
      progress = phase.total > 0 ? Math.min(1, phase.received / phase.total) : 0;
      body = progress >= 1 ? text("verifying") : text("downloading", { percent: Math.floor(progress * 100) });
      actions = <MobileButtonFace label={text("cancel")} variant="secondary" hasTVPreferredFocus onPress={closeUpdateDialog} testID="self-update-cancel" />;
      break;
    }
    case "installing":
      body = text("installing");
      actions = <MobileButtonFace label={text("close")} variant="secondary" hasTVPreferredFocus onPress={closeUpdateDialog} testID="self-update-close" />;
      break;
    case "error":
      body = text(phase.error === "integrity" ? "errorIntegrity" : phase.error === "install" ? "errorInstall" : "errorNetwork");
      actions = <MobileButtonFace label={text("close")} variant="secondary" hasTVPreferredFocus onPress={closeUpdateDialog} testID="self-update-close" />;
      break;
    default:
      body = text("promptBody");
      actions = (
        <>
          <MobileButtonFace label={text("later")} variant="secondary" onPress={() => void snoozeUpdate()} testID="self-update-later" />
          <MobileButtonFace label={text("update")} hasTVPreferredFocus onPress={() => void startUpdate()} testID="self-update-update" />
        </>
      );
  }

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={phase.kind === "idle" ? () => void snoozeUpdate() : closeUpdateDialog}>
      <MobileRenderBoundary name="modal:self-update" onDismiss={closeUpdateDialog}>
        <View style={styles.backdrop}>
          <View
            style={[styles.card, tv && styles.cardTv, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
            testID="self-update-dialog"
          >
            <Text style={[styles.title, { color: theme.colors.text, fontFamily: theme.font.family.display }]} accessibilityRole="header">
              {title}
            </Text>
            <Text style={[styles.body, { color: theme.colors.textMuted, fontFamily: theme.font.family.sans }]} accessibilityLiveRegion="polite" testID="self-update-body">
              {body}
            </Text>
            {progress !== null ? (
              <View style={[styles.track, { backgroundColor: theme.colors.surfaceRaised }]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.floor(progress * 100) }}>
                <View style={[styles.fill, { backgroundColor: theme.colors.accent, width: `${progress * 100}%` }]} />
              </View>
            ) : null}
            <View style={styles.actions}>{actions}</View>
          </View>
        </View>
      </MobileRenderBoundary>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 24 },
  card: { width: "100%", maxWidth: 420, borderRadius: 20, borderWidth: 1, padding: 20, gap: 14 },
  cardTv: { maxWidth: 520 },
  title: { fontSize: 18, fontWeight: "800" },
  body: { fontSize: 15, lineHeight: 21 },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  actions: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 },
});
