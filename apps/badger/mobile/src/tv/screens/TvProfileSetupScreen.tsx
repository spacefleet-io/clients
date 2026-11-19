import React, { useEffect, useRef, useState } from "react";
import { BackHandler, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import { MobileAppBackdrop } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { ProfileAvatarImage } from "@space/mobile-shell/profile-avatar";
import { saveProfileSetup } from "@space/mobile-shell/profile-setup";
import {
  MobileSetupHeader,
  MobileSetupMascot,
  MobileSetupTvHeaderPart,
  setupMascotOverlap,
  TV_SETUP_CARD_TOP,
  TV_SETUP_MASCOT_SIZE,
} from "@space/mobile-shell/setup-step";
import { profileAvatarIdOf, type ProfileAvatarId } from "@space/shared/profileAvatars";
import { ProfileActionError, profileErrorKey } from "@space/shared/profileStore";
import type { ApiProfile } from "@space/shared/profiles";
import { TvAvatarGrid } from "../components/TvAvatarGrid";
import { TvFocusable } from "../components/TvFocusable";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { focusDestination, type TvViewInstance } from "../lib/tvViewInstance";
import { useTvMenuKeyHold } from "../lib/useTvMenuKey";
import { markTvProfileSetupAnswered } from "../lib/tvSetupStore";
import { TV_COLOR, TV_FONT, TV_RADII } from "../ui/tokens";

const log = scopeLogger("tv.profile_setup");

/** The big avatar of the left column, in design dp (the design's 120 px at 1280 wide). */
export const TV_PROFILE_SETUP_PREVIEW = 90;

/** The card's top edge in design dp: low enough for the setup mascot over it (UX-SETUP-08). */
const CARD_TOP = 64;

export type TvProfileSetupScreenProps = {
  profile: ApiProfile;
  /** "Step N of M" while the TV's first setup is open; undefined shows the step alone, with no count. */
  stepPosition?: { current: number; total: number };
  /** Back (button and the remote's Back key); no Back button without it. */
  onBack?: () => void;
  /** Called once the name and avatar are saved on the profile. */
  onDone: () => void;
};

/**
 * "Your profile" on the TV (UX-SETUP-10, design `tv-step.png`): one card over the sky, the setup mascot half over its
 * top border as on every setup step (UX-SETUP-08). Left, the step count, the title,
 * one line, the big avatar (it follows the remote's focus in the grid, so the viewer sees each avatar large before
 * choosing) and the profile's name, which the TV does not edit (no keyboard: "Rename on your phone or in Settings").
 * Right, the 22 avatars in six columns, the focus starting on the profile's current one, and Back / Next. Next saves
 * the name and the chosen avatar in one request that also marks the profile's avatar as set (even unchanged), so no
 * other app asks again.
 */
export const TvProfileSetupScreen = ({ profile, stepPosition, onBack, onDone }: TvProfileSetupScreenProps) => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const [chosen, setChosen] = useState<ProfileAvatarId>(() => profileAvatarIdOf(profile));
  const [focusedAvatar, setFocusedAvatar] = useState<ProfileAvatarId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Down from any avatar of the last rows lands on Next: the buttons sit right, under only the last columns.
  const [nextButton, setNextButton] = useState<TvViewInstance | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!onBackRef.current) return false;
      onBackRef.current();
      return true;
    });
    return () => subscription.remove();
  }, []);
  // Apple TV: the system keeps Menu (and leaves the app) unless a screen holds it.
  useTvMenuKeyHold("tv-profile-setup", onBack !== undefined);

  const next = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    log.info("save", { avatarId: chosen, changed: chosen !== profileAvatarIdOf(profile), numbered: stepPosition !== undefined });
    try {
      await saveProfileSetup(profile, { name: profile.name, avatarId: chosen });
      if (stepPosition) await markTvProfileSetupAnswered();
    } catch (cause) {
      const code = cause instanceof ProfileActionError ? cause.code : "unknown";
      log.warn("save.failed", { code });
      setError(t(profileErrorKey(code)));
      setBusy(false);
      return;
    }
    setBusy(false);
    onDone();
  };

  // The big avatar shows the one under the focus; once the focus leaves the grid, the chosen one.
  const preview = focusedAvatar ?? chosen;
  return (
    <View style={styles.screen} testID="tv-profile-setup">
      <MobileAppBackdrop />
      <View style={styles.card} testID="tv-profile-setup-card">
        <View style={styles.side}>
          {/* "STEP N OF M" and the bar at the card's top left, above the title, as on every numbered TV setup step
              (UX-SETUP-08, the approved `tv-step.png`). */}
          {stepPosition ? (
            <View style={styles.step} testID="profile-setup-step">
              <MobileSetupTvHeaderPart part="steps" scale={scale}>
                <MobileSetupHeader step={stepPosition.current} total={stepPosition.total} />
              </MobileSetupTvHeaderPart>
            </View>
          ) : null}
          <Text accessibilityRole="header" style={styles.title}>
            {t("profiles.setup.title")}
          </Text>
          <Text style={styles.lead}>{t("profiles.setup.lead")}</Text>
          <ProfileAvatarImage
            avatarId={preview}
            size={TV_PROFILE_SETUP_PREVIEW * scale}
            style={styles.preview}
            testID="profile-setup-preview"
          />
          <Text style={styles.name} numberOfLines={1} testID="profile-setup-name">
            {profile.name}
          </Text>
          <Text style={styles.rename}>{t("profiles.setup.tvRename")}</Text>
        </View>
        <View style={styles.main}>
          <TvAvatarGrid variant="setup" focusChosen={1} value={chosen} onChange={setChosen} onFocusAvatar={setFocusedAvatar} />
          <TVFocusGuideView style={styles.actions} destinations={focusDestination(nextButton)} testID="profile-setup-actions">
            {error ? (
              <Text accessibilityRole="alert" style={styles.error} testID="profile-setup-error">
                {error}
              </Text>
            ) : null}
            {onBack ? (
              <TvFocusable
                testID="profile-setup-back"
                accessibilityLabel={t("setup.back")}
                disabled={busy}
                focusable={!busy}
                onFocus={() => setFocusedAvatar(null)}
                onPress={onBack}
                style={[styles.button, styles.ghost, busy && styles.disabled]}
              >
                <Text style={[styles.label, styles.ghostLabel]}>{t("setup.back")}</Text>
              </TvFocusable>
            ) : null}
            <TvFocusable
              ref={setNextButton}
              testID="profile-setup-next"
              accessibilityLabel={t("setup.next")}
              accessibilityState={{ disabled: busy, busy }}
              disabled={busy}
              onFocus={() => setFocusedAvatar(null)}
              onPress={() => void next()}
              style={[styles.button, styles.next, busy && styles.disabled]}
            >
              <Text style={[styles.label, styles.nextLabel]}>{t("setup.next")}</Text>
            </TvFocusable>
          </TVFocusGuideView>
        </View>
      </View>
      {/* After the card, so it draws over the card's border; it takes no touch or focus. */}
      <View style={styles.mascotRow} pointerEvents="none">
        <MobileSetupMascot size={TV_SETUP_MASCOT_SIZE * scale} testID="profile-setup-mascot" />
      </View>
    </View>
  );
};

/**
 * Design `tv-step.html` (1280x720 px) times 0.75 for the 960x540 design screen, scaled with the TV (UX-TV-13). The
 * grid keeps its six columns at full size and the left column takes the rest, as the design's flex layout draws it.
 */
const baseStyles = StyleSheet.create({
  screen: { flex: 1 },
  // The mascot's lower part (its overlap) over the card's top edge, centred over the centred card.
  mascotRow: {
    position: "absolute",
    left: 0,
    right: 0,
    top: CARD_TOP - TV_SETUP_MASCOT_SIZE + setupMascotOverlap(TV_SETUP_MASCOT_SIZE),
    alignItems: "center",
  },
  card: {
    position: "absolute",
    left: 112.5,
    right: 112.5,
    top: CARD_TOP,
    bottom: 28,
    flexDirection: "row",
    gap: 42,
    paddingTop: TV_SETUP_CARD_TOP,
    paddingBottom: 30,
    paddingHorizontal: 42,
    borderRadius: 21,
    borderWidth: 0.75,
    borderColor: "#3b3e54",
    backgroundColor: "rgba(37, 39, 56, 0.92)",
  },
  side: { flex: 1, minWidth: 0 },
  step: { marginBottom: 12 },
  // `white-space: nowrap` in the design: the title may run on into the gap before the grid (column + gap wide).
  title: { width: 199.5, fontFamily: TV_FONT.display, fontSize: 30, fontWeight: "600", color: "#e6e9f5" },
  lead: { marginTop: 9, marginBottom: 21, fontFamily: TV_FONT.body, fontSize: 14.25, lineHeight: 20, color: TV_COLOR.muted },
  preview: { borderRadius: TV_PROFILE_SETUP_PREVIEW / 2, marginBottom: 10.5, backgroundColor: "#2c2f45" },
  name: { fontFamily: TV_FONT.body, fontSize: 19.5, fontWeight: "600", color: TV_COLOR.text },
  rename: { marginTop: 4.5, fontFamily: TV_FONT.body, fontSize: 12, lineHeight: 15, color: TV_COLOR.muted },
  main: { justifyContent: "center", alignItems: "center" },
  actions: { alignSelf: "stretch", flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 13.5, marginTop: 25.5 },
  error: { flex: 1, fontFamily: TV_FONT.body, fontSize: 12, lineHeight: 16, color: TV_COLOR.danger },
  button: { width: 135, height: 42, alignItems: "center", justifyContent: "center", borderRadius: TV_RADII.pill },
  ghost: { borderWidth: 0.75, borderColor: "#3b3e54" },
  next: { backgroundColor: TV_COLOR.amber },
  label: { fontFamily: TV_FONT.body, fontSize: 15, fontWeight: "700" },
  ghostLabel: { color: TV_COLOR.text },
  nextLabel: { color: "#1b1b22" },
  // Disabled = the idle look at half opacity.
  disabled: { opacity: 0.5 },
});
