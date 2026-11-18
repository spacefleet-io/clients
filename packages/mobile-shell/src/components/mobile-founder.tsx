import React, { useEffect } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { founderCopy } from "@space/shared/founder";
import { founderBadgeText, founderNoticeText, founderWatch, useFounderStatus, useFounderWatch, type FounderWatch } from "../founder";
import { useTranslation } from "../i18n";
import { useNoticeQueue } from "../notice-queue";
import { useMobileShellTheme } from "../theme";
import { MobileNoticeToast } from "./mobile-notice-toast";

type MobileFounderNoticeProps = {
  language: string;
  /** Tapping the card: the shell opens Settings, where the badge is. */
  onOpen: () => void;
  onClose: () => void;
};

/**
 * The one-time "🎫 Founder ticket recognised. Your 30% for life is applied to your plan." notice (WAIT-FOUND-04) on the
 * phone, drawn as the shell's floating notice (UX-NOTICE-01). The shell's queue owns the timer and marks it seen.
 */
export const MobileFounderNotice = ({ language, onOpen, onClose }: MobileFounderNoticeProps) => {
  const text = founderNoticeText(language);
  return (
    <MobileNoticeToast
      testID="founder-notice"
      title={text.title}
      hint={text.body}
      accessibilityLabel={`${text.title} ${text.body}`}
      closeLabel={text.dismiss}
      onOpen={onOpen}
      onClose={onClose}
    />
  );
};

type MobileFounderNoticeHostProps = {
  /** The signed-in session's token; null when signed out. */
  token: string | null | undefined;
  /** True while another screen covers the shell (the player): the notice waits, unseen and without a timer. */
  held?: boolean;
  /** The card was tapped: the shell opens Settings, where the badge is. */
  onOpen: () => void;
  watch?: FounderWatch;
};

/**
 * The founder notice for a shell with no other notices (Parrot's phone), in the app's language: keeps the founder watch
 * current for `token`, shows the notice once in its own queue (UX-NOTICE-01: it leaves after the fixed time, on tap or
 * on the cross), and however it leaves marks it seen on the API, so no device shows it again (WAIT-FOUND-04).
 */
export const MobileFounderNoticeHost = ({ token, held = false, onOpen, watch = founderWatch }: MobileFounderNoticeHostProps) => {
  const { i18n } = useTranslation();
  const notices = useNoticeQueue<"founder">({
    keyOf: (kind) => kind,
    onDismiss: (_kind, reason) => {
      console.info("[founder] notice dismissed", JSON.stringify({ reason }));
      if (token) void watch.noticeSeen(token);
    },
  });
  const { show, setHeld } = notices;
  useEffect(() => setHeld(held), [setHeld, held]);
  useFounderWatch(token, () => show("founder"), watch);
  if (!notices.current) return null;
  return (
    <MobileFounderNotice
      language={i18n.language}
      onOpen={() => {
        notices.dismiss("opened");
        onOpen();
      }}
      onClose={() => notices.dismiss("closed")}
    />
  );
};

/**
 * "Founder 🎫 · since the waitlist, {date}" on the account in Settings, in the app's language, only for a founder
 * (WAIT-FOUND-04). `showPriceLabel` adds "Founder price, −30% for life" where the plan is shown (the phone and TV never
 * show prices, ACCT-PAY-02).
 */
export const MobileFounderBadge = ({ showPriceLabel = false, style }: { showPriceLabel?: boolean; style?: ViewStyle }) => {
  const { i18n } = useTranslation();
  const language = i18n.language;
  const theme = useMobileShellTheme();
  const status = useFounderStatus();
  if (!status?.founder) return null;
  return (
    <View testID="settings-founder-badge" style={[styles.badge, style]}>
      <Text style={[styles.label, { color: theme.colors.accent }]}>{founderBadgeText(language, status.since)}</Text>
      {showPriceLabel ? (
        <Text testID="settings-founder-price" style={[styles.price, { color: theme.colors.textMuted }]}>
          {founderCopy(language).priceLabel}
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  badge: { gap: 2 },
  label: { fontSize: 13, fontWeight: "700" },
  price: { fontSize: 12 },
});
