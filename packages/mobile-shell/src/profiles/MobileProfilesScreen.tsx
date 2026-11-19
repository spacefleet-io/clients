import React, { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ChevronLeft, Plus } from "lucide-react-native";
import { PROFILE_NAME_MAX } from "@space/shared/profiles";
import type { ProfileLibraryMoves, ProfileStore } from "@space/shared/profileStore";
import { MobileButton } from "../components/mobile-button";
import { useTranslation } from "../i18n";
import { useMobileShellTheme, type MobileShellTheme } from "../theme";
import { AvatarGrid } from "./AvatarGrid";
import { ProfileAvatarImage, profileAvatarRadius } from "./ProfileAvatarImage";
import { useProfilesFlow } from "./useProfilesFlow";

const TILE_AVATAR = 104;
const PREVIEW_AVATAR = 128;

export type MobileProfilesScreenProps = {
  store: ProfileStore;
  moves: ProfileLibraryMoves;
  /** "pick" for the profile question, "manage" when opened from Settings' "Manage profiles". */
  startMode: "pick" | "manage";
  /** Badger asks "Who's watching?" (`watching`), Parrot "Who's listening?" (`listening`), with the delete warning to match. */
  audience: "watching" | "listening";
  /** Opened from Settings: closes after a pick, and Done closes the manager it opened on. Null at the start gate. */
  onClose: (() => void) | null;
  log: (event: string, data: Record<string, unknown>) => void;
};

/**
 * The phone's profile question (UX-PROF-01): asked once at sign-in when the account has more than one profile, then
 * the phone reopens that profile until sign-out. Opened from Settings it switches profile in one tap, or adds, edits
 * (name and avatar, ACCT-PROF-05) and deletes profiles (ACCT-PROF-01, ACCT-PROF-02). Drawn in the app's own colours
 * (`MobileShellThemeProvider`).
 */
export const MobileProfilesScreen = ({ store, moves, startMode, audience, onClose, log }: MobileProfilesScreenProps) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const flow = useProfilesFlow({ store, moves, startMode, onPicked: onClose ?? undefined, log });
  const { snapshot, mode, errorKey } = flow;
  const error = errorKey ? <Text style={styles.error}>{t(errorKey, { max: snapshot.maxProfiles })}</Text> : null;

  let content: React.ReactNode;
  if (mode.name === "busy") {
    content = <ActivityIndicator size="large" color={theme.colors.accent} />;
  } else if (mode.name === "edit") {
    // The add / edit step is the avatar chooser (mockup `mockup-avatar-picker.png`): back and Save at the top, the
    // title on its own line under them (so a long title or Save label never cuts it, as "Choisir un a…Enregistrer"
    // did), the big preview, the name, then the grid.
    const editing = flow.profileOf(mode.profileId);
    const canSave = flow.draftName.trim().length > 0;
    content = (
      <View testID="profile-edit" accessibilityLabel={editing ? t("profiles.editTitle") : t("profiles.addTitle")} style={styles.chooser}>
        <View style={styles.chooserHeader}>
          <Pressable testID="profile-cancel" accessibilityRole="button" accessibilityLabel={t("profiles.cancel")} hitSlop={12} onPress={flow.cancel} style={styles.headerSide}>
            <ChevronLeft size={30} color={theme.colors.text} />
          </Pressable>
          <Pressable
            testID="profile-save"
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            hitSlop={12}
            onPress={() => void flow.save()}
            style={[styles.headerSide, styles.headerSideEnd]}
          >
            <Text style={[styles.saveLabel, !canSave && styles.dimmed]}>{t("profiles.save")}</Text>
          </Pressable>
        </View>
        <Text style={styles.chooserTitle} accessibilityRole="header">
          {t("profiles.chooseAvatar")}
        </Text>
        <View style={styles.preview} accessible accessibilityLabel={t("profiles.avatarLabel", { name: t(`profiles.avatars.${flow.draftAvatarId}`) })}>
          <ProfileAvatarImage avatarId={flow.draftAvatarId} size={PREVIEW_AVATAR} testID="profile-avatar-preview" />
        </View>
        <TextInput
          testID="profile-name-input"
          value={flow.draftName}
          onChangeText={flow.setDraftName}
          maxLength={PROFILE_NAME_MAX * 2}
          autoCapitalize="words"
          autoCorrect={false}
          placeholder={t("profiles.namePlaceholder")}
          placeholderTextColor={theme.colors.textDim}
          accessibilityLabel={t("profiles.nameLabel")}
          onSubmitEditing={() => (canSave ? void flow.save() : undefined)}
          style={styles.nameInput}
        />
        {error}
        <AvatarGrid value={flow.draftAvatarId} onChange={flow.chooseAvatar} />
      </View>
    );
  } else if (mode.name === "confirmDelete") {
    const target = flow.profileOf(mode.profileId);
    content = (
      <>
        <Text style={styles.title} accessibilityRole="header">
          {t("profiles.deleteTitle", { name: target?.name ?? "" })}
        </Text>
        <Text style={styles.body}>{t(audience === "listening" ? "profiles.deleteBodyListening" : "profiles.deleteBody")}</Text>
        <MobileButton testID="profile-delete-confirm" variant="danger" label={t("profiles.deleteConfirm")} onPress={() => void flow.confirmDelete()} />
        <MobileButton testID="profile-delete-cancel" variant="ghost" label={t("profiles.cancel")} onPress={flow.cancel} />
      </>
    );
  } else if (mode.name === "manage") {
    content = (
      <>
        <Text style={styles.title} accessibilityRole="header">
          {t("profiles.manageTitle")}
        </Text>
        {error}
        {snapshot.profiles.map((profile, index) => (
          // The name gets the whole width beside the avatar, with Edit and Delete on a line under it: side by side
          // they left a French name 3 letters ("Gro…").
          <View key={profile.id} style={styles.manageRow} testID={`profile-row-${index}`}>
            <ProfileAvatarImage profile={profile} size={48} />
            <View style={styles.manageBody}>
              <Text style={styles.manageName} numberOfLines={1}>
                {profile.name}
              </Text>
              <View style={styles.manageActions}>
                <Pressable
                  testID={`profile-edit-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={t("profiles.editA11y", { name: profile.name })}
                  style={styles.smallButton}
                  onPress={() => flow.startEdit(profile)}
                >
                  <Text style={styles.smallButtonLabel}>{t("profiles.edit")}</Text>
                </Pressable>
                <Pressable
                  testID={`profile-delete-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={t("profiles.deleteA11y", { name: profile.name })}
                  style={[styles.smallButton, !flow.canDelete && styles.dimmed]}
                  onPress={() => flow.askDelete(profile)}
                >
                  <Text style={[styles.smallButtonLabel, styles.dangerLabel]}>{t("profiles.delete")}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ))}
        {/* A full account keeps "Add profile" greyed with the reason under it (ACCT-PROF-01). */}
        <MobileButton testID="profile-add" variant="secondary" label={t("profiles.add")} disabled={!flow.canCreate} onPress={flow.startAdd} />
        {flow.limitNote ? (
          <Text style={styles.body} testID="profile-add-limit">
            {t(flow.limitNote.key, flow.limitNote.values)}
          </Text>
        ) : null}
        <MobileButton
          testID="profiles-done"
          label={t("profiles.done")}
          onPress={() => (onClose && startMode === "manage" ? onClose() : flow.setMode({ name: "pick" }))}
        />
      </>
    );
  } else {
    // "Who's watching?" (mockup `mockup-whos-watching.png`): big rounded avatar tiles, the "Add profile" tile with a +,
    // then the outlined "Manage profiles".
    content = (
      <>
        <Text style={styles.title} accessibilityRole="header" testID="profiles-who">
          {t(audience === "listening" ? "profiles.whoIsListening" : "profiles.whoIsWatching")}
        </Text>
        {error}
        <View style={styles.tiles}>
          {snapshot.profiles.map((profile, index) => (
            <Pressable
              key={profile.id}
              testID={`profile-tile-${index}`}
              accessibilityRole="button"
              accessibilityLabel={profile.name}
              style={styles.tile}
              onPress={() => void flow.pick(profile)}
            >
              <ProfileAvatarImage profile={profile} size={TILE_AVATAR} />
              <Text style={styles.tileName} numberOfLines={1}>
                {profile.name}
              </Text>
            </Pressable>
          ))}
          {flow.canCreate ? (
            <Pressable testID="profile-add-tile" accessibilityRole="button" accessibilityLabel={t("profiles.add")} style={styles.tile} onPress={flow.startAdd}>
              <View style={styles.addAvatar}>
                <Plus size={44} strokeWidth={1.5} color={theme.colors.textMuted} />
              </View>
              <Text style={styles.tileName}>{t("profiles.add")}</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable testID="profiles-manage" accessibilityRole="button" style={styles.manageButton} onPress={() => flow.setMode({ name: "manage" })}>
          <Text style={styles.manageButtonLabel}>{t("profiles.manage")}</Text>
        </Pressable>
      </>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} testID="profiles-screen">
      <ScrollView contentContainerStyle={[styles.content, mode.name === "edit" && styles.contentTop]} keyboardShouldPersistTaps="handled">
        {content}
      </ScrollView>
    </SafeAreaView>
  );
};

type ProfilesStyles = ReturnType<typeof createStyles>;

const createStyles = (theme: MobileShellTheme) =>
  StyleSheet.create({
    // Transparent over the app's sky (UX-SKY-04).
    safeArea: { flex: 1 },
    content: { flexGrow: 1, justifyContent: "center", padding: theme.spacing.xl, gap: theme.spacing.md },
    contentTop: { justifyContent: "flex-start", paddingTop: theme.spacing.md },
    title: { fontSize: 28, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display, textAlign: "center" },
    body: { fontSize: 15, lineHeight: 22, color: theme.colors.textMuted, textAlign: "center" },
    error: { fontSize: 15, color: theme.colors.danger, textAlign: "center" },
    tiles: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: 20, rowGap: 24, marginVertical: theme.spacing.lg },
    tile: { width: 120, alignItems: "center", gap: 10 },
    tileName: { fontSize: 16, fontWeight: "600", color: theme.colors.textMuted },
    addAvatar: {
      width: TILE_AVATAR,
      height: TILE_AVATAR,
      borderRadius: profileAvatarRadius(TILE_AVATAR),
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    manageButton: {
      alignSelf: "center",
      paddingHorizontal: 28,
      paddingVertical: 12,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: theme.colors.textMuted,
    },
    manageButtonLabel: { fontSize: 16, fontWeight: "500", color: theme.colors.textMuted },
    chooser: { gap: 20 },
    chooserHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 48 },
    headerSide: { minWidth: 64, justifyContent: "center" },
    headerSideEnd: { alignItems: "flex-end" },
    chooserTitle: { fontSize: 22, fontWeight: "600", color: theme.colors.text, textAlign: "center" },
    saveLabel: { fontSize: 20, fontWeight: "700", color: theme.colors.accent },
    preview: { alignItems: "center" },
    nameInput: {
      alignSelf: "center",
      width: "80%",
      fontSize: 18,
      paddingHorizontal: 18,
      paddingVertical: 12,
      borderRadius: 12,
      color: theme.colors.text,
      backgroundColor: theme.colors.surface,
    },
    manageRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    manageBody: { flex: 1, minWidth: 0, gap: 6 },
    manageActions: { flexDirection: "row", gap: 8 },
    manageName: { fontSize: 17, fontWeight: "700", color: theme.colors.text },
    smallButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: theme.colors.surfaceRaised },
    smallButtonLabel: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
    dangerLabel: { color: theme.colors.danger },
    dimmed: { opacity: 0.5 },
  });
