/**
 * REL-CD-29: the screen Badger and Parrot show on the phone (and Badger on the TV) once the API refused this build as
 * too old (426 `app_update_required`, from any call, sign-in included). The phone counterpart of the desktop's
 * `DesktopUpdateRequiredScreen`: the same title, the app's mascot over the app's sky, and how to update. A store app
 * cannot replace itself, so it names no store and has no button: the new version comes from where the app came from
 * (Play, the App Store, F-Droid or our APK). Nothing closes it; `useAppUpdateRequired` never clears.
 */
import React, { useSyncExternalStore } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { getAppUpdateRequired, onAppUpdateRequired, type AppUpdateRequiredPayload } from "@space/shared/appVersion";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";

/** The API's "please update" refusal once any call of this app got it, or null. It never clears. */
export const useAppUpdateRequired = (): AppUpdateRequiredPayload | null =>
  useSyncExternalStore(onAppUpdateRequired, getAppUpdateRequired);

export const MobileUpdateRequiredScreen = () => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const app = theme.brandName;
  return (
    <View testID="update-required" accessibilityRole="alert" style={[styles.root, { padding: theme.spacing.xl }]}>
      <Image source={theme.mascotSource} style={styles.mascot} resizeMode="contain" accessible={false} />
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: theme.colors.text, fontSize: theme.font.size.xl, fontFamily: theme.font.family.display }]}
      >
        {t("appUpdate.title", { app })}
      </Text>
      <Text style={[styles.body, { color: theme.colors.textMuted, fontSize: theme.font.size.md, fontFamily: theme.font.family.sans }]}>
        {t("appUpdate.body", { app })}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  mascot: { width: 140, height: 140, marginBottom: 8 },
  title: { fontWeight: "700", textAlign: "center" },
  body: { textAlign: "center", lineHeight: 24, maxWidth: 420 },
});
