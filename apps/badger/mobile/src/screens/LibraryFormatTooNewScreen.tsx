import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { UpdateSourceHow } from "@space/mobile-shell/update-required";
import { Screen } from "../components/Screen";
import { theme } from "../theme/theme";

/**
 * Blocking screen shown when the library is at a format version newer than
 * this build of Badger supports (Part D3, mobile counterpart of the desktop
 * `LibraryFormatTooNewModal`).
 *
 * It is a full-screen route, not a modal — the navigator renders it instead of
 * the app shell, so there is no behind-content to dismiss to. A store app
 * cannot replace itself, so the screen says where this install's update comes
 * from and its one button opens it (REL-CD-29, `UpdateSourceHow`).
 */
export const LibraryFormatTooNewScreen = () => {
  const { t } = useTranslation();
  return (
    <Screen>
      <View style={styles.container}>
        <Text style={styles.title}>{t("libraryFormat.title")}</Text>
        <UpdateSourceHow app="badger" lead={t("libraryFormat.body")} />
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
});
