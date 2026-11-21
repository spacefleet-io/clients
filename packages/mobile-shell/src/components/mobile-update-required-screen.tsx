/**
 * REL-CD-29: the screen Badger and Parrot show on the phone (and Badger on the TV) once the API refused this build as
 * too old (426 `app_update_required`, from any call, sign-in included). The phone counterpart of the desktop's
 * `DesktopUpdateRequiredScreen`: the same title, the app's mascot over the app's sky, and how to update. A store app
 * cannot replace itself, so the screen names where this install's new version comes from (Play, the App Store,
 * TestFlight, the Amazon Appstore, F-Droid, Obtainium or our APK download, `../updateSource.ts`) and its one button
 * opens it. Nothing closes it; `useAppUpdateRequired` never clears.
 */
import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import type { SpaceAppId } from "@space/shared/appScope";
import { getAppUpdateRequired, onAppUpdateRequired, type AppUpdateRequiredPayload } from "@space/shared/appVersion";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { deviceUpdateSource, openUpdateSource } from "../updateSource";
import { MobileButtonFace } from "./mobile-button-face";

/** The API's "please update" refusal once any call of this app got it, or null. It never clears. */
export const useAppUpdateRequired = (): AppUpdateRequiredPayload | null =>
  useSyncExternalStore(onAppUpdateRequired, getAppUpdateRequired);

/**
 * Where the update comes from, said and opened: the "how" sentence (`appUpdate.how.<kind>`) and, when there is
 * something to open, one button (`appUpdate.open.<kind>`). Shared by this screen and Badger's library-too-new screen.
 */
export const UpdateSourceHow = ({ app, lead }: { app: SpaceAppId; lead?: string }) => {
  const theme = useMobileShellTheme();
  const { t, i18n } = useTranslation();
  const source = useMemo(() => deviceUpdateSource(app, i18n.language), [app, i18n.language]);
  const name = theme.brandName;
  const open = useCallback(() => void openUpdateSource(source), [source]);
  const how = t(`appUpdate.how.${source.kind}`, { app: name });
  return (
    <>
      <Text
        testID="update-source-how"
        style={[styles.body, { color: theme.colors.textMuted, fontSize: theme.font.size.md, fontFamily: theme.font.family.sans }]}
      >
        {lead ? `${lead} ${how}` : how}
      </Text>
      {source.url ? (
        <View style={styles.action}>
          <MobileButtonFace testID={`update-source-open-${source.kind}`} label={t(`appUpdate.open.${source.kind}`)} onPress={open} hasTVPreferredFocus />
        </View>
      ) : null}
    </>
  );
};

export const MobileUpdateRequiredScreen = ({ app }: { app: SpaceAppId }) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const name = theme.brandName;
  return (
    <View testID="update-required" accessibilityRole="alert" style={[styles.root, { padding: theme.spacing.xl }]}>
      <Image source={theme.mascotSource} style={styles.mascot} resizeMode="contain" accessible={false} />
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: theme.colors.text, fontSize: theme.font.size.xl, fontFamily: theme.font.family.display }]}
      >
        {t("appUpdate.title", { app: name })}
      </Text>
      <UpdateSourceHow app={app} lead={t("appUpdate.tooOld", { app: name })} />
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  mascot: { width: 140, height: 140, marginBottom: 8 },
  title: { fontWeight: "700", textAlign: "center" },
  body: { textAlign: "center", lineHeight: 24, maxWidth: 420 },
  // The column centres its children, so the button gets its own width (a form's full-width button, capped).
  action: { width: "100%", maxWidth: 360 },
});
