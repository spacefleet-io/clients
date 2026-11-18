import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, Text, TextInput, type TextInputInstance, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Check, Plus } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { ProfileAvatarImage, profileAvatarRadius } from "@space/mobile-shell/profile-avatar";
import { PROFILE_AVATAR_IDS, type ProfileAvatarId } from "@space/shared/profileAvatars";
import { PROFILE_NAME_MAX } from "@space/shared/profiles";
import { profileStore } from "../../lib/profiles/profileStore";
import { useProfilesFlow } from "@space/mobile-shell/profiles-flow";
import { useLibraryActions } from "../../store/library";
import { theme } from "../../theme/theme";
import { PairingButton } from "../components/PairingButton";
import { TvFocusable } from "../components/TvFocusable";
import { TV_SAFE_MARGIN_X, TV_SAFE_MARGIN_Y } from "../lib/layout";
import { TV_RADIUS } from "../lib/tvLook";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import type { TvViewInstance } from "../lib/tvViewInstance";

const tvLog = (event: string, data: Record<string, unknown>) => console.info(`tv.profiles.${event}`, JSON.stringify(data));

/** Design sizes (scaled with the TV, UX-TV-13): about 240 px avatars on a 1080p TV, as the mockup's tiles. */
export const TV_TILE_AVATAR = 120;
const TV_CHOOSER_CELL = 64;
const TV_PREVIEW_AVATAR = 88;
const TV_MANAGE_AVATAR = 56;
/** The chooser on the TV: the 22 avatars in two rows of 11, walked with the arrows. */
export const TV_AVATAR_COLUMNS = 11;

/** How long after the keyboard's "done" a focus landing elsewhere is UIKit's update, not the user's move. */
const KEYBOARD_SETTLE_MS = 1000;

/**
 * The TV's avatar chooser (ACCT-PROF-05): the same 22 in pack order, every cell a remote focus target. The chosen one
 * keeps the accent ring and tick; the focused one gets the white ring the profile tiles use.
 *
 * `focusChosen` counts the name submits: each one sends the focus to the chosen avatar. On tvOS the keyboard closing
 * runs UIKit's own focus update, which lands on the first avatar (name field focused by the screen) or back on the name
 * field (name field reached with the remote): a focus on another cell within KEYBOARD_SETTLE_MS of the request takes it
 * back once, and if no avatar holds the focus when that time is up the chosen one asks for it again (seen on the Apple
 * TV simulator 2026-11-18, as TV-SHELL-FOCUS-002 on Home).
 */
const TvAvatarGrid = ({ value, onChange, focusChosen }: { value: ProfileAvatarId; onChange: (id: ProfileAvatarId) => void; focusChosen: number }) => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const [focused, setFocused] = useState<ProfileAvatarId | null>(null);
  const focusedRef = useRef<ProfileAvatarId | null>(null);
  const chosenRef = useRef<TvViewInstance>(null);
  const requestedAt = useRef<number | null>(null);
  useEffect(() => {
    if (focusChosen === 0) return undefined;
    requestedAt.current = Date.now();
    tvLog("avatar.focus", { step: "request", submit: focusChosen });
    chosenRef.current?.requestTVFocus();
    const settle = setTimeout(() => {
      if (focusedRef.current !== null) return;
      tvLog("avatar.focus", { step: "settle" });
      chosenRef.current?.requestTVFocus();
    }, KEYBOARD_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [focusChosen]);
  const setCellFocus = (id: ProfileAvatarId | null) => {
    focusedRef.current = id;
    setFocused(id);
  };
  const onCellFocus = (id: ProfileAvatarId) => {
    setCellFocus(id);
    const at = requestedAt.current;
    if (at === null) return;
    requestedAt.current = null;
    const sinceMs = Date.now() - at;
    if (id === value || sinceMs > KEYBOARD_SETTLE_MS) return;
    tvLog("avatar.focus", { step: "retake", landed: id, sinceMs });
    chosenRef.current?.requestTVFocus();
  };
  return (
    <View testID="avatar-chooser" style={styles.chooserGrid}>
      {PROFILE_AVATAR_IDS.map((id) => {
        const selected = id === value;
        return (
          <TvFocusable
            key={id}
            ref={selected ? chosenRef : undefined}
            testID={`avatar-option-${id}`}
            ring="none"
            hasTVPreferredFocus={focusChosen > 0 && selected}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={t(`profiles.avatars.${id}`)}
            onFocus={() => onCellFocus(id)}
            onBlur={() => {
              if (focusedRef.current === id) setCellFocus(null);
            }}
            onPress={() => onChange(id)}
            style={[styles.chooserCell, selected && styles.chooserCellSelected, focused === id && styles.focusRing]}
          >
            <ProfileAvatarImage avatarId={id} size={(TV_CHOOSER_CELL - 10) * scale} testID={`avatar-option-image-${id}`} />
            {selected ? (
              <View style={styles.tick} testID="avatar-option-tick">
                <Check size={14 * scale} strokeWidth={3.5} color={theme.accentTextHex} />
              </View>
            ) : null}
          </TvFocusable>
        );
      })}
    </View>
  );
};

/**
 * "Who's watching?" on the TV (UX-PROF-01, UX-PROF-02): asked at every start of the app when the account has more than
 * one profile, and reopened from Settings to switch or manage profiles (route `Profiles`, `{ mode: "manage" }` or
 * `{ mode: "pick" }`). Everything works with the remote: arrows move between the profiles, OK picks, Back steps out
 * of a sub-step. Adding, editing (name and avatar, ACCT-PROF-05) and deleting (ACCT-PROF-01, ACCT-PROF-02) are
 * reachable from here too. Each profile shows its avatar from the pack, the focused tile ringed in white with its name
 * in bold (mockup `mockup-whos-watching.png`).
 */
export const TvProfilesScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const route = useRoute();
  const params = (route.params ?? {}) as { mode?: "pick" | "manage" };
  // Inside the app (Settings) the screen sits on the stack and closes after a pick; at start it is the start gate.
  const inApp = route.name === "SwitchProfile";
  const { profileMoves } = useLibraryActions();
  const flow = useProfilesFlow({
    store: profileStore,
    moves: profileMoves,
    startMode: params.mode ?? "pick",
    onPicked: inApp ? () => navigation.goBack() : undefined,
    log: tvLog,
  });
  const { snapshot, mode, errorKey } = flow;
  const inputRef = useRef<TextInputInstance>(null);
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  // The focused "Who's watching?" tile (`add` for the Add profile tile): white ring and bold name.
  const [focusedTile, setFocusedTile] = useState<string | null>(null);
  const tileFocus = (key: string) => ({
    onFocus: () => setFocusedTile(key),
    onBlur: () => setFocusedTile((current) => (current === key ? null : current)),
  });
  // Each name submit from the keyboard sends the focus on to the chosen avatar instead of saving. On tvOS the
  // keyboard's "done" is the only key that keeps the typed text (Menu drops it), so a submit that saved left no way to
  // type a name and then pick an avatar (ACCT-PROF-05). A count, not a flag: a second "done" must move the focus again.
  const [nameSubmits, setNameSubmits] = useState(0);

  useEffect(() => {
    tvLog("shown", { inApp, mode: params.mode ?? "pick", count: snapshot.profiles.length, maxProfiles: snapshot.maxProfiles });
    // Shown once per mount (the flow re-reads the list); the list itself re-renders through the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    tvLog("list", { mode: mode.name, count: snapshot.profiles.length, activeId: snapshot.activeId, ids: snapshot.profiles.map((p) => p.id) });
  }, [mode.name, snapshot.activeId, snapshot.profiles]);

  // TextInput ignores hasTVPreferredFocus: give it the focus explicitly when the name step opens (as pairing does).
  useEffect(() => {
    setNameSubmits(0);
    if (mode.name !== "edit") return undefined;
    const id = setTimeout(() => {
      tvLog("input.focus", { found: inputRef.current !== null });
      inputRef.current?.focus();
    }, 80);
    return () => clearTimeout(id);
  }, [mode.name]);

  // Back leaves a sub-step first; on the picker itself the navigator (or the system) handles it.
  const { cancel } = flow;
  const onBack = useCallback(() => {
    if (mode.name === "pick" || mode.name === "busy") return false;
    if (mode.name === "manage" && inApp && params.mode === "manage") return false;
    tvLog("back", { mode: mode.name });
    cancel();
    return true;
  }, [cancel, inApp, mode.name, params.mode]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => subscription.remove();
  }, [onBack]);

  const error = errorKey ? (
    <Text style={styles.error} testID="profiles-error">
      {t(errorKey, { max: snapshot.maxProfiles })}
    </Text>
  ) : null;

  let content: React.ReactNode;
  if (mode.name === "busy") {
    content = <ActivityIndicator size="large" color={theme.colors.accent} />;
  } else if (mode.name === "edit") {
    const editing = flow.profileOf(mode.profileId);
    content = (
      // Tighter than the other steps: title, preview and name, the two rows of avatars and the buttons fit one screen.
      <View style={styles.editColumn}>
        <Text style={styles.title} accessibilityRole="header" testID="profile-edit">
          {editing ? t("profiles.editTitle") : t("profiles.addTitle")}
        </Text>
        {error}
        <View style={styles.editTop}>
          <View accessible accessibilityLabel={t("profiles.avatarLabel", { name: t(`profiles.avatars.${flow.draftAvatarId}`) })}>
            <ProfileAvatarImage avatarId={flow.draftAvatarId} size={TV_PREVIEW_AVATAR * scale} testID="profile-avatar-preview" />
          </View>
          <TextInput
            ref={inputRef}
            testID="profile-name-input"
            focusable
            value={flow.draftName}
            onChangeText={flow.setDraftName}
            maxLength={PROFILE_NAME_MAX * 2}
            autoCorrect={false}
            placeholder={t("profiles.namePlaceholder")}
            placeholderTextColor={theme.colors.textDim}
            accessibilityLabel={t("profiles.nameLabel")}
            onSubmitEditing={() => {
              tvLog("name.submit", { length: flow.draftName.trim().length });
              setNameSubmits((count) => count + 1);
            }}
            style={styles.input}
          />
        </View>
        <Text style={styles.chooserLabel}>{t("profiles.chooseAvatar")}</Text>
        <TvAvatarGrid value={flow.draftAvatarId} onChange={flow.chooseAvatar} focusChosen={nameSubmits} />
        <View style={styles.actions}>
          <PairingButton testID="profile-save" variant="primary" label={t("profiles.save")} disabled={!flow.draftName.trim()} onPress={() => void flow.save()} />
          <PairingButton testID="profile-cancel" label={t("profiles.cancel")} onPress={flow.cancel} />
        </View>
      </View>
    );
  } else if (mode.name === "confirmDelete") {
    const target = flow.profileOf(mode.profileId);
    content = (
      <>
        <Text style={styles.title} accessibilityRole="header">
          {t("profiles.deleteTitle", { name: target?.name ?? "" })}
        </Text>
        <Text style={styles.body}>{t("profiles.deleteBody")}</Text>
        <View style={styles.actions}>
          <PairingButton testID="profile-delete-confirm" variant="primary" label={t("profiles.deleteConfirm")} onPress={() => void flow.confirmDelete()} />
          <PairingButton testID="profile-delete-cancel" preferredFocus label={t("profiles.cancel")} onPress={flow.cancel} />
        </View>
      </>
    );
  } else if (mode.name === "manage") {
    content = (
      <>
        <Text style={styles.title} accessibilityRole="header">
          {t("profiles.manageTitle")}
        </Text>
        {error}
        <ScrollView style={styles.manageList} contentContainerStyle={styles.manageListContent}>
          {snapshot.profiles.map((profile, index) => (
            <View key={profile.id} style={styles.manageRow} testID={`profile-row-${index}`}>
              <ProfileAvatarImage profile={profile} size={TV_MANAGE_AVATAR * scale} />
              <Text style={styles.manageName} numberOfLines={1}>
                {profile.name}
              </Text>
              <TvFocusable
                testID={`profile-edit-${index}`}
                hasTVPreferredFocus={index === 0}
                accessibilityLabel={t("profiles.editA11y", { name: profile.name })}
                style={styles.smallButton}
                onPress={() => flow.startEdit(profile)}
              >
                <Text style={styles.smallButtonLabel}>{t("profiles.edit")}</Text>
              </TvFocusable>
              <TvFocusable
                testID={`profile-delete-${index}`}
                accessibilityLabel={t("profiles.deleteA11y", { name: profile.name })}
                style={[styles.smallButton, !flow.canDelete && styles.dimmed]}
                onPress={() => flow.askDelete(profile)}
              >
                <Text style={[styles.smallButtonLabel, styles.dangerLabel]}>{t("profiles.delete")}</Text>
              </TvFocusable>
            </View>
          ))}
        </ScrollView>
        <View style={styles.actions}>
          <PairingButton testID="profile-add" label={t("profiles.add")} disabled={!flow.canCreate} onPress={flow.startAdd} />
          <PairingButton
            testID="profiles-done"
            variant="primary"
            label={t("profiles.done")}
            onPress={() => (inApp && params.mode === "manage" ? navigation.goBack() : flow.setMode({ name: "pick" }))}
          />
        </View>
        {/* A full account keeps "Add profile" greyed with the reason under it (ACCT-PROF-01). */}
        {flow.limitNote ? (
          <Text style={styles.body} testID="profile-add-limit">
            {t(flow.limitNote.key, flow.limitNote.values)}
          </Text>
        ) : null}
      </>
    );
  } else {
    content = (
      <>
        <Text style={styles.title} accessibilityRole="header" testID="profiles-who">
          {t("profiles.whoIsWatching")}
        </Text>
        {error}
        <View style={styles.tiles}>
          {snapshot.profiles.map((profile, index) => {
            const focused = focusedTile === profile.id;
            return (
              <TvFocusable
                key={profile.id}
                testID={`profile-tile-${index}`}
                hasTVPreferredFocus={index === 0}
                accessibilityLabel={profile.name}
                ring="none"
                style={styles.tile}
                {...tileFocus(profile.id)}
                onPress={() => void flow.pick(profile)}
              >
                <View style={[styles.tileFrame, focused && styles.focusRing]}>
                  <ProfileAvatarImage profile={profile} size={TV_TILE_AVATAR * scale} />
                </View>
                <Text style={[styles.tileName, focused && styles.tileNameFocused]} numberOfLines={1}>
                  {profile.name}
                </Text>
              </TvFocusable>
            );
          })}
          {flow.canCreate ? (
            <TvFocusable testID="profile-add-tile" accessibilityLabel={t("profiles.add")} ring="none" style={styles.tile} {...tileFocus("add")} onPress={flow.startAdd}>
              <View style={[styles.tileFrame, focusedTile === "add" && styles.focusRing]}>
                <View style={styles.addAvatar}>
                  <Plus size={56 * scale} strokeWidth={1.5} color={theme.colors.textMuted} />
                </View>
              </View>
              <Text style={[styles.tileName, focusedTile === "add" && styles.tileNameFocused]}>{t("profiles.add")}</Text>
            </TvFocusable>
          ) : null}
        </View>
        <TvFocusable
          testID="profiles-manage"
          accessibilityLabel={t("profiles.manage")}
          style={styles.manageButton}
          focusedStyle={styles.manageButtonFocused}
          onPress={() => flow.setMode({ name: "manage" })}
        >
          <Text style={styles.manageButtonLabel}>{t("profiles.manage")}</Text>
        </TvFocusable>
      </>
    );
  }

  return (
    <View style={styles.screen} testID="profiles-screen">
      {content}
    </View>
  );
};

const FRAME_PAD = 5;

const baseStyles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: TV_SAFE_MARGIN_X,
    paddingVertical: TV_SAFE_MARGIN_Y,
    gap: 32,
  },
  title: { fontSize: 40, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display, textAlign: "center" },
  body: { fontSize: 20, lineHeight: 28, color: theme.colors.textMuted, textAlign: "center", maxWidth: 900 },
  error: { fontSize: 20, color: theme.colors.danger, textAlign: "center" },
  tiles: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 32 },
  tile: { width: TV_TILE_AVATAR + 2 * FRAME_PAD + 16, alignItems: "center", gap: 12 },
  // The avatar sits in a frame whose border is the focus ring: nothing moves when the focus arrives.
  tileFrame: { padding: FRAME_PAD - 3, borderWidth: 3, borderColor: "transparent", borderRadius: profileAvatarRadius(TV_TILE_AVATAR) + FRAME_PAD },
  focusRing: { borderColor: "#ffffff" },
  tileName: { fontSize: 22, fontWeight: "400", color: theme.colors.textMuted },
  tileNameFocused: { fontWeight: "700", color: theme.colors.text },
  addAvatar: {
    width: TV_TILE_AVATAR,
    height: TV_TILE_AVATAR,
    borderRadius: profileAvatarRadius(TV_TILE_AVATAR),
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  manageButton: { paddingHorizontal: 32, paddingVertical: 12, borderRadius: 8, borderWidth: 1.5, borderColor: theme.colors.textMuted },
  manageButtonFocused: { borderColor: theme.colors.text },
  manageButtonLabel: { fontSize: 20, fontWeight: "500", color: theme.colors.textMuted },
  actions: { flexDirection: "row", gap: 20 },
  editColumn: { alignItems: "center", gap: 18 },
  editTop: { flexDirection: "row", alignItems: "center", gap: 28 },
  input: {
    minWidth: 520,
    fontSize: 26,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: TV_RADIUS.button,
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceRaised,
  },
  chooserLabel: { fontSize: 20, fontWeight: "600", color: theme.colors.textMuted },
  chooserGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 10,
    width: TV_AVATAR_COLUMNS * TV_CHOOSER_CELL + (TV_AVATAR_COLUMNS - 1) * 10,
  },
  chooserCell: {
    width: TV_CHOOSER_CELL,
    height: TV_CHOOSER_CELL,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "transparent",
    borderRadius: profileAvatarRadius(TV_CHOOSER_CELL) + 3,
  },
  chooserCellSelected: { borderColor: theme.colors.accent },
  tick: {
    position: "absolute",
    top: -7,
    right: -7,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  manageList: { maxHeight: 520, alignSelf: "stretch" },
  // Rows fill the safe area (960 − 2 × 48 dp); the padding keeps the focus ring of the last button inside the list.
  manageListContent: { gap: 16, paddingHorizontal: 8 },
  manageRow: { flexDirection: "row", alignItems: "center", gap: 20, alignSelf: "stretch" },
  manageName: { flex: 1, fontSize: 24, fontWeight: "700", color: theme.colors.text },
  smallButton: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: TV_RADIUS.button, backgroundColor: theme.colors.surfaceRaised },
  smallButtonLabel: { fontSize: 20, fontWeight: "700", color: theme.colors.text },
  dangerLabel: { color: theme.colors.danger },
  dimmed: { opacity: 0.5 },
});
