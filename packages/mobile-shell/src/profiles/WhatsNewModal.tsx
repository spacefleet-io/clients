/**
 * "New in this update" on the phones (UX-UPDATE-01, `phone-modal.png`): a window over the dimmed app, right after the
 * profile is picked, for an older profile that never answered a new feature: the badge, the feature's art, its title,
 * a line with the profile's name in bold, the feature's setup button ("Choose my avatar") and "Later".
 */
import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { AppFeatureId } from "@space/shared/appFeatures";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { ProfileAvatarImage } from "./ProfileAvatarImage";
import { UPDATE_FEATURES } from "./profileSetup";

const ART_SIZE = 60;
/** The window's card, the setup card's colour: the art's rim matches it so the overlapping avatars read as cut out. */
const CARD = "#252738";
/** The badge: the app's own accent at 10% on the card (`phone-modal.png`'s amber badge at its alpha), so Parrot's is green. */
const BADGE_FILL_ALPHA = "1a";

/** `name` is drawn in bold inside the translated line, wherever the language puts it. */
const boldName = (text: string, name: string, bold: object) => {
  const at = text.indexOf(name);
  if (at < 0) return text;
  return [
    text.slice(0, at),
    <Text key="name" style={bold} testID="whats-new-name">
      {name}
    </Text>,
    text.slice(at + name.length),
  ];
};

export type WhatsNewModalProps = {
  feature: AppFeatureId;
  profileName: string;
  onChoose: () => void;
  onLater: () => void;
};

export const WhatsNewModal = ({ feature, profileName, onChoose, onLater }: WhatsNewModalProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const entry = UPDATE_FEATURES[feature];
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={onLater}>
      <View style={styles.scrim} testID={`whats-new-${feature}`}>
        <View style={[styles.card, { borderColor: theme.colors.border }]} accessibilityViewIsModal>
          <View testID="whats-new-badge" style={[styles.badge, { backgroundColor: `${theme.colors.accent}${BADGE_FILL_ALPHA}` }]}>
            <Text style={[styles.badgeText, { color: theme.colors.accent }]}>{t("profiles.whatsNew.badge").toUpperCase()}</Text>
          </View>
          <View style={styles.art} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {entry.art.map((id) => (
              <ProfileAvatarImage key={id} avatarId={id} size={ART_SIZE} style={styles.artAvatar} testID={`whats-new-art-${id}`} />
            ))}
          </View>
          <Text accessibilityRole="header" style={[styles.title, { color: theme.colors.text, fontFamily: theme.font.family.display }]}>
            {t(entry.titleKey)}
          </Text>
          <Text style={[styles.text, { color: theme.colors.textMuted }]} testID="whats-new-text">
            {boldName(t(entry.textKey, { name: profileName }), profileName, [styles.bold, { color: theme.colors.text }])}
          </Text>
          <Pressable
            testID="whats-new-choose"
            accessibilityRole="button"
            onPress={onChoose}
            style={[styles.main, { backgroundColor: theme.colors.accent }]}
          >
            <Text style={[styles.mainLabel, { color: theme.accentTextHex }]}>{t(entry.ctaKey)}</Text>
          </Pressable>
          <Pressable testID="whats-new-later" accessibilityRole="button" onPress={onLater} style={styles.later}>
            <Text style={[styles.laterLabel, { color: theme.colors.textMuted }]}>{t("profiles.whatsNew.later")}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(10,11,20,0.72)", paddingHorizontal: 20, paddingTop: 170 },
  card: {
    backgroundColor: "rgba(37,39,56,0.92)",
    borderWidth: 1,
    borderRadius: 28,
    paddingTop: 28,
    paddingHorizontal: 22,
    paddingBottom: 22,
    alignItems: "center",
  },
  badge: { borderRadius: 999, paddingVertical: 5, paddingHorizontal: 12, marginBottom: 14 },
  badgeText: { fontSize: 12, fontWeight: "700", letterSpacing: 12 * 0.08 },
  art: { flexDirection: "row", justifyContent: "center", marginTop: 6, marginBottom: 18 },
  artAvatar: { borderRadius: ART_SIZE / 2, borderWidth: 3, borderColor: CARD, marginHorizontal: -6, backgroundColor: "#2c2f45" },
  title: { fontSize: 26, fontWeight: "600", textAlign: "center" },
  text: { fontSize: 15, lineHeight: 15 * 1.45, textAlign: "center", marginTop: 10, marginBottom: 24 },
  bold: { fontWeight: "700" },
  main: { alignSelf: "stretch", height: 54, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  mainLabel: { fontSize: 18, fontWeight: "700" },
  later: { alignSelf: "stretch", height: 48, marginTop: 8, alignItems: "center", justifyContent: "center" },
  laterLabel: { fontSize: 16, fontWeight: "700" },
});
