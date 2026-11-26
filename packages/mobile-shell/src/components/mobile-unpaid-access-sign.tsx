import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AlertTriangle } from "lucide-react-native";
import type { AccountAccess } from "@space/shared/accountAccess";
import { getCurrentLanguage, useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { getUnpaidAccessInfo, unpaidMessage } from "../unpaidAccess";
import { TV_SAFE_MARGIN_Y } from "../tv/layout";

/** Where the TV's sign sits: just under the top bar (54 design dp tall, UX-TV-09), centred under its tabs. */
const TV_SIGN_TOP = 58;
/** Room between the phone's bottom edge (above its navigation bar) and the sign. */
const PHONE_SIGN_GAP = 6;

/**
 * The unpaid sign (UX-NOTICE-08, ACCT-UNPAID-03): a small pill that takes no room and never moves the page, the same
 * pattern as the offline sign. On the phone's tab pages it sits on the tab bar's top edge where the offline sign sits
 * (`inline`, passed as the bar's badge); on every other phone screen it floats at the bottom, just above the navigation
 * bar, because the top of each screen holds its own title and buttons, which a top sign would cover. On the TV it sits
 * under the top bar. One word on screen; its spoken label is the whole notice (playback and uploads stopped, the wipe
 * date). The full explanation sits where the state blocks something: Settings' plan panel and the player's failure
 * message. It only informs: nothing to press and no word about paying (ACCT-PAY-02), and it lets touches through to
 * the page. Renders nothing for free and paid accounts. `access` is the app's last `GET /auth/me` answer, re-evaluated
 * against the clock at render time; no polling.
 */
export const UnpaidAccessSign = ({
  access,
  tv = false,
  underBar = true,
  inline = false,
  scale = 1,
}: {
  access: AccountAccess | null | undefined;
  /** On the TV the sign sits under the top bar instead of at the bottom. */
  tv?: boolean;
  /** TV only: false on a full-screen page without the top bar (the profiles), where it keeps the TV's safe margin. */
  underBar?: boolean;
  /** Phone only: the pill alone, for the tab bar's badge slot, which places it; no floating layer of its own. */
  inline?: boolean;
  /** Multiplies every size; the TV passes its screen scale (UX-TV-13), phones 1. */
  scale?: number;
}) => {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const { unpaid, wipeAt } = getUnpaidAccessInfo(access);
  if (!unpaid) return null;
  const styles = stylesFor(scale);
  const pill = (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={unpaidMessage(t, "unpaidBanner", wipeAt, getCurrentLanguage())}
      pointerEvents="none"
      testID="unpaid-access-sign"
      style={[styles.pill, { borderColor: theme.colors.warning }]}
    >
      <AlertTriangle size={12 * scale} color={theme.colors.warning} />
      <Text style={[styles.text, { color: theme.colors.warning }]} numberOfLines={1}>
        {t("account.access.unpaidSign")}
      </Text>
    </View>
  );
  if (inline && !tv) return pill;
  return (
    <View
      pointerEvents="none"
      testID="unpaid-access-sign-layer"
      style={[
        styles.layer,
        tv ? { top: (underBar ? TV_SIGN_TOP : TV_SAFE_MARGIN_Y) * scale } : { bottom: insets.bottom + PHONE_SIGN_GAP },
      ]}
    >
      {pill}
    </View>
  );
};

/**
 * The navigator's place for the sign (ACCT-UNPAID-05): wraps every screen of a stack (`screenLayout`), so a screen
 * pushed over the tabs or opened from a link or a notification shows it as the tab pages do. `playing` (the player)
 * leaves it out; `onTabBar` (the phone's tab pages) too, since their tab bar carries it (`UnpaidAccessSign inline`).
 * The sign floats over the screen, so the screen keeps its size and its safe-area insets, and the tree has the same
 * shape for every account: nothing remounts when the account becomes unpaid or paid again.
 */
export const UnpaidScreenLayout = ({
  access,
  playing = false,
  onTabBar = false,
  tv = false,
  scale = 1,
  children,
}: {
  access: AccountAccess | null | undefined;
  playing?: boolean;
  /** The phone's tab pages: their tab bar shows the sign, so none floats here. */
  onTabBar?: boolean;
  tv?: boolean;
  /** The TV's screen scale (UX-TV-13); phones 1. */
  scale?: number;
  children: React.ReactNode;
}) => (
  <View style={layoutStyles.fill}>
    {children}
    {playing || (onTabBar && !tv) ? null : <UnpaidAccessSign access={access} tv={tv} scale={scale} />}
  </View>
);

const layoutStyles = StyleSheet.create({ fill: { flex: 1 } });

const makeStyles = (s: number) =>
  StyleSheet.create({
    layer: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 30, elevation: 30 },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5 * s,
      height: 22 * s,
      paddingHorizontal: 9 * s,
      borderRadius: 11 * s,
      borderWidth: 1 * s,
      backgroundColor: "rgba(18, 20, 33, 0.96)",
    },
    text: { fontSize: 11 * s, fontWeight: "700" },
  });

/** One sheet per scale, built on first use (phones and Android TV only ever ask for 1). */
const sheets = new Map<number, ReturnType<typeof makeStyles>>();
const stylesFor = (scale: number) => {
  let sheet = sheets.get(scale);
  if (!sheet) {
    sheet = makeStyles(scale);
    sheets.set(scale, sheet);
  }
  return sheet;
};
