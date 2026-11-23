import React, { useCallback } from "react";
import { Linking, Platform, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { Button } from "../components/ui";
import { Screen } from "../components/Screen";
import { theme } from "../theme/theme";
import { scopeLogger } from "@space/mobile-shell/logger";

const log = scopeLogger("library-format-too-new");

/**
 * Store listing the "Update Now" CTA opens. Mobile has no in-app updater
 * (store releases only — see the plan's Out of scope), so the gate deep-links
 * to TestFlight / Play Store. iOS uses the `itms-apps://` scheme so the App
 * Store app opens directly rather than a browser tab.
 */
const STORE_URL = Platform.select({
  ios: "itms-apps://apps.apple.com/app/id0000000000",
  android: "https://play.google.com/store/apps/details?id=io.spacebadger.android",
  default: "https://play.google.com/store/apps/details?id=io.spacebadger.android",
});

/**
 * Blocking screen shown when the library is at a format version newer than
 * this build of Badger supports (Part D3, mobile counterpart of the desktop
 * `LibraryFormatTooNewModal`).
 *
 * It is a full-screen route, not a modal — the navigator renders it instead of
 * the app shell, so there is no behind-content to dismiss to. The single CTA
 * deep-links to the app store; mobile updates ship through the store, not an
 * in-app updater.
 */
export const LibraryFormatTooNewScreen = () => {
  const { t } = useTranslation();
  const handleUpdate = useCallback(() => {
    if (!STORE_URL) return;
    Linking.openURL(STORE_URL).catch((err) => {
      log.warn("store_open_failed", { message: String(err) });
    });
  }, []);

  return (
    <Screen>
      <View style={styles.container}>
        <Text style={styles.title}>{t("libraryFormat.title")}</Text>
        <Text style={styles.body}>{t("libraryFormat.body")}</Text>
        <Button label={t("libraryFormat.update")} onPress={handleUpdate} />
      </View>
    </Screen>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.lg,
    paddingHorizontal: theme.spacing.xl,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.font.size.xl,
    fontWeight: "700",
    textAlign: "center",
  },
  body: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.md,
    textAlign: "center",
    lineHeight: 22,
  },
});
