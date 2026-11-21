import React, { useEffect, useRef } from "react";
import { BackHandler, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { ProfileAvatarImage } from "@space/mobile-shell/profile-avatar";
import { UPDATE_FEATURES } from "@space/mobile-shell/profile-setup";
import type { AppFeatureId } from "@space/shared/appFeatures";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { useTvMenuKeyHold } from "@space/mobile-shell/tv/useTvMenuKey";
import type { TvViewInstance } from "@space/mobile-shell/tv/tvViewInstance";
import { TV_COLOR, TV_FONT, TV_RADII } from "../ui/tokens";

const log = scopeLogger("tv.whats_new");

/** One avatar of the window's art, in design dp (the design's 64 px at 1280 wide). */
export const TV_WHATS_NEW_ART = 48;

/**
 * How often the window checks that the remote's focus is in its card (ms). The home under it keeps the focus when the
 * window opens and may take it later (UIKit's own update, a `hasTVPreferredFocus` that mounts late such as the empty
 * library's), which `hasTVPreferredFocus` and the card's focus traps do not stop.
 */
export const TV_WHATS_NEW_HOLD_MS = 250;

/** Stands for the profile's name while the text is split around it (drawn in bold). */
const NAME_MARK = "\u0000";

export type TvWhatsNewWindowProps = {
  feature: AppFeatureId;
  profileName: string;
  /** The main button: opens the feature's setup screen. */
  onChoose: () => void;
  /** "Later" (and the remote's Back key): this profile is not asked again on any app. */
  onLater: () => void;
};

/**
 * "New in this update" on the TV (UX-UPDATE-01, design `desktop-modal.png`): the desktop window over the dimmed app,
 * shown once to a profile made before the feature arrived. The badge, the feature's art (five avatars, overlapping),
 * its title, one line with the profile's name in bold, then Later and the main button, which takes the remote's focus.
 * Back answers Later, as the window has no other way out.
 */
export const TvWhatsNewWindow = ({ feature, profileName, onChoose, onLater }: TvWhatsNewWindowProps) => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const copy = UPDATE_FEATURES[feature];
  const onLaterRef = useRef(onLater);
  onLaterRef.current = onLater;
  // While the window is up the focus is in its card: the arrows are trapped, and focus held or taken by the home under
  // it goes to the main button.
  const chooseRef = useRef<TvViewInstance>(null);
  const inside = useRef<"later" | "choose" | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      if (inside.current !== null) return;
      log.info("focus.claim", { feature });
      chooseRef.current?.requestTVFocus();
    }, TV_WHATS_NEW_HOLD_MS);
    return () => clearInterval(timer);
  }, [feature]);
  const focusIn = (button: "later" | "choose") => {
    inside.current = button;
  };
  const focusOut = (button: "later" | "choose") => {
    if (inside.current === button) inside.current = null;
  };

  useEffect(() => {
    log.info("shown", { feature });
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      log.info("back", { feature });
      onLaterRef.current();
      return true;
    });
    return () => subscription.remove();
  }, [feature]);
  // Apple TV: Menu answers Later instead of leaving the app.
  useTvMenuKeyHold("tv-whats-new", true);

  const [before, after = ""] = t(copy.textKey, { name: NAME_MARK }).split(NAME_MARK);
  return (
    <View style={styles.dim} testID="tv-whats-new">
      {/* The home stays mounted under the window: the remote's focus is held inside the card. */}
      <TVFocusGuideView
        style={styles.card}
        autoFocus
        trapFocusUp
        trapFocusDown
        trapFocusLeft
        trapFocusRight
        accessibilityViewIsModal
        testID="tv-whats-new-card"
      >
        <View style={styles.badge}>
          <Text style={styles.badgeLabel}>{t("profiles.whatsNew.badge")}</Text>
        </View>
        <View style={styles.art} testID="whats-new-art">
          {copy.art.map((id) => (
            <ProfileAvatarImage
              key={id}
              avatarId={id}
              size={TV_WHATS_NEW_ART * scale}
              style={styles.artAvatar}
              testID={`whats-new-art-${id}`}
            />
          ))}
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          {t(copy.titleKey)}
        </Text>
        <Text style={styles.text} testID="whats-new-text">
          {before}
          <Text style={styles.name}>{profileName}</Text>
          {after}
        </Text>
        <View style={styles.actions}>
          <TvFocusable
            testID="whats-new-later"
            accessibilityLabel={t("profiles.whatsNew.later")}
            onFocus={() => focusIn("later")}
            onBlur={() => focusOut("later")}
            onPress={onLater}
            style={[styles.button, styles.later]}
          >
            <Text style={[styles.label, styles.laterLabel]}>{t("profiles.whatsNew.later")}</Text>
          </TvFocusable>
          <TvFocusable
            ref={chooseRef}
            testID="whats-new-choose"
            accessibilityLabel={t(copy.ctaKey)}
            hasTVPreferredFocus
            onFocus={() => focusIn("choose")}
            onBlur={() => focusOut("choose")}
            onPress={onChoose}
            style={[styles.button, styles.choose]}
          >
            <Text style={[styles.label, styles.chooseLabel]} numberOfLines={1}>
              {t(copy.ctaKey)}
            </Text>
          </TvFocusable>
        </View>
      </TVFocusGuideView>
    </View>
  );
};

/** Design `desktop-modal.html` (1280 px wide) times 0.75 for the 960x540 design screen, scaled with the TV (UX-TV-13). */
const baseStyles = StyleSheet.create({
  dim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(10, 11, 20, 0.72)" },
  card: {
    width: 375,
    paddingTop: 25.5,
    paddingHorizontal: 27,
    paddingBottom: 21,
    alignItems: "center",
    borderRadius: 21,
    borderWidth: 0.75,
    borderColor: "#3b3e54",
    backgroundColor: "rgba(37, 39, 56, 0.92)",
  },
  badge: { marginBottom: 12, paddingVertical: 3.75, paddingHorizontal: 9, borderRadius: TV_RADII.pill, backgroundColor: "#3a3020" },
  badgeLabel: {
    fontFamily: TV_FONT.body,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.72,
    textTransform: "uppercase",
    color: TV_COLOR.amber,
  },
  art: { flexDirection: "row", justifyContent: "center", marginTop: 3, marginBottom: 15 },
  // Overlapping avatars, each rimmed in the card's colour (`margin: 0 -6px; border: 3px solid #252738`).
  artAvatar: { marginHorizontal: -4.5, borderRadius: TV_WHATS_NEW_ART / 2, borderWidth: 2.25, borderColor: "#252738", backgroundColor: "#2c2f45" },
  title: { fontFamily: TV_FONT.display, fontSize: 19.5, fontWeight: "600", textAlign: "center", color: "#e6e9f5" },
  text: {
    marginTop: 7.5,
    marginBottom: 19.5,
    fontFamily: TV_FONT.body,
    fontSize: 11.25,
    lineHeight: 16.3,
    textAlign: "center",
    color: TV_COLOR.muted,
  },
  name: { fontWeight: "700", color: TV_COLOR.text },
  actions: { flexDirection: "row", justifyContent: "center", gap: 9 },
  button: { height: 34.5, alignItems: "center", justifyContent: "center", borderRadius: TV_RADII.pill },
  later: { width: 105, borderWidth: 0.75, borderColor: "#3b3e54" },
  choose: { minWidth: 150, paddingHorizontal: 12, backgroundColor: TV_COLOR.amber },
  label: { fontFamily: TV_FONT.body, fontSize: 11.25, fontWeight: "700" },
  laterLabel: { color: TV_COLOR.text },
  chooseLabel: { color: "#1b1b22" },
});
