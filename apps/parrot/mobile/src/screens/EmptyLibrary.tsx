// The empty library on the phone (PAR-EMPTY-01, UX-EMPTY-01): the computer's screen (the shared `MobileEmptyLibrary`,
// the same one Badger's phone and TV draw) with Parrot's accent and words. A phone adds no music, so its one button
// opens the download page of Parrot for computer; pulling the page down reads the library again.
import React, { useState } from "react";
import { Linking, RefreshControl, ScrollView, StyleSheet } from "react-native";
import { Download } from "lucide-react-native";
import { MobileEmptyLibrary, MobileEmptyLibraryAction, useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { websiteUrl } from "@space/shared/websiteLinks";
import { useSession } from "../state/session";
import { PARROT_MASCOT } from "../brand";
import { colors, spacing } from "../theme";

export const EmptyLibrary = () => {
  const { t, i18n } = useTranslation();
  const { reloadLibrary } = useSession();
  const skyScroll = useSkyScroll();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.accent}
          colors={[colors.accent]}
          onRefresh={() => {
            setRefreshing(true);
            void reloadLibrary().finally(() => setRefreshing(false));
          }}
        />
      }
      {...skyScroll}
    >
      <MobileEmptyLibrary
        kind="music"
        mascotSource={PARROT_MASCOT}
        eyebrow={t("parrot.empty.eyebrow")}
        title={t("parrot.empty.title")}
        subtitle={t("parrot.empty.subtitle")}
        actions={
          <MobileEmptyLibraryAction
            label={t("parrot.empty.getDesktop")}
            icon={<Download size={16} color={colors.accentText} />}
            onPress={() => void Linking.openURL(websiteUrl("downloads", i18n.language)).catch(() => undefined)}
          />
        }
        steps={[
          { title: t("parrot.empty.step1Title"), body: t("parrot.empty.step1Body") },
          { title: t("parrot.empty.step2Title"), body: t("parrot.empty.step2Body") },
          { title: t("parrot.empty.step3Title"), body: t("parrot.empty.step3Body") },
        ]}
      />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: "center", paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xl },
});
