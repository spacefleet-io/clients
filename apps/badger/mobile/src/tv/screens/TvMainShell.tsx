import React, { useEffect, useState } from "react";
import { AppState, BackHandler, StyleSheet, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { SkyCover, SkyRegion } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useNoticeQueue } from "@space/mobile-shell/notice-queue";
import { founderNoticeText, founderWatch, useFounderWatch } from "@space/mobile-shell/founder";
import { UnpaidAccessBanner } from "@space/mobile-shell/unpaid-access-banner";
import { checkForNewDevices, markDeviceSeen } from "../../lib/pairing/deviceWatch";
import {
  newDeviceKey,
  newDeviceMessage,
  subscribeNewDevice,
  subscribeOpenDevices,
  type NewDeviceInfo,
} from "../../lib/pairing/newDevice";
import { useAuth } from "../../store/auth";
import { useLibraryData, useLibraryStatus } from "../../store/library";
import { theme } from "../../theme/theme";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
import { TvOfflineNotice } from "../components/TvOfflineNotice";
import { TV_SAFE_MARGIN_X, TV_SAFE_MARGIN_Y } from "@space/mobile-shell/tv/layout";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { setCurrentTvSection, subscribeTvSectionRequest, type TvSectionId } from "@space/mobile-shell/tv/tvSection";
import { TvSky } from "@space/mobile-shell/tv/TvSky";
import { BadgerTvTopBar } from "../ui/BadgerTvTopBar";
import { TvHomeScreen } from "./TvHomeScreen";
import { TvLibraryScreen } from "./TvLibraryScreen";
import { TvPlaylistsScreen } from "./TvPlaylistsScreen";
import { TvSearchScreen } from "./TvSearchScreen";
import { TvSettingsScreen } from "./TvSettingsScreen";
import { useTvMenuKeyHold } from "@space/mobile-shell/tv/useTvMenuKey";

const DISABLED_WITHOUT_MEDIA: readonly TvSectionId[] = ["library", "playlists"];

/** The shell's one notice slot (UX-NOTICE-01): a new device, or the one-time founder notice (WAIT-FOUND-04). */
type TvNotice = { kind: "device"; info: NewDeviceInfo } | { kind: "founder" };
const FOUNDER_NOTICE_KEY = "founder";

/** The TV's `Main` screen: the top bar over the open section, on the family's night sky. */
export const TvMainShell = () => {
  const { t } = useTranslation();
  const { loadStatus, reload } = useLibraryStatus();
  const { media } = useLibraryData();
  const hasLibraryMedia = media.length > 0;
  const isFocused = useIsFocused();
  const { token, user } = useAuth();
  const [activeTab, setActiveTab] = useState<TvSectionId>("home");
  // UX-LIBTAB-01: an empty library cannot be opened, nor its playlists, as on the phone; a request for either (a title
  // page's tab) lands on Home.
  useEffect(() => {
    if (!hasLibraryMedia && DISABLED_WITHOUT_MEDIA.includes(activeTab)) setActiveTab("home");
  }, [activeTab, hasLibraryMedia]);
  // ACCT-PAIR-03 / UX-NOTICE-01: the "New device added" notice floats over the top-right corner of the page, never between
  // the tabs and the rows. It leaves on its own after a fixed time (held while it has the remote's focus), at once when
  // selected (it opens Settings) or on Back; however it leaves, the device counts as seen. It is drawn in this shell, so
  // while another screen (the player, a title page) covers the shell it waits, unseen and without a timer.
  // WAIT-FOUND-04: the one-time "Founder ticket recognised" notice takes the same slot; it takes the remote's focus (so
  // it stays until read), OK or Back closes it, and however it leaves no device shows it again.
  const notices = useNoticeQueue<TvNotice>({
    keyOf: (notice) => (notice.kind === "device" ? newDeviceKey(notice.info) : FOUNDER_NOTICE_KEY),
    onDismiss: (notice, reason) => {
      if (notice.kind === "founder") {
        console.info("tv.founder.dismissed", JSON.stringify({ reason }));
        if (token) void founderWatch.noticeSeen(token);
        return;
      }
      console.info("tv.newDevice.dismissed", JSON.stringify({ reason, deviceType: notice.info.deviceType }));
      void markDeviceSeen(notice.info.sessionId);
    },
  });
  const notice = notices.current;
  const showNotice = notices.show;
  const dismissNotice = notices.dismiss;
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);

  // A title page opened from here names this section on its Back button (UX-TV-06).
  useEffect(() => setCurrentTvSection(activeTab), [activeTab]);
  // The title page shows the top bar too; a tab picked there opens that section here before it goes back.
  useEffect(() => subscribeTvSectionRequest(setActiveTab), []);

  // Back closes the notice while it shows; otherwise, on a section other than Home it returns to Home, and on Home it
  // leaves the app as usual.
  const backHandled = isFocused && (notice !== null || activeTab !== "home");
  useEffect(() => {
    if (!backHandled) return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (notice !== null) dismissNotice("back");
      else setActiveTab("home");
      return true;
    });
    return () => subscription.remove();
  }, [backHandled, notice, dismissNotice]);
  // Apple TV delivers Menu to the handler above only while the key is held; on Home the system keeps it (-> Apple TV home).
  useTvMenuKeyHold("tv-tab", backHandled);

  const holdNotices = notices.setHeld;
  useEffect(() => holdNotices(!isFocused), [holdNotices, isFocused]);
  useEffect(() => subscribeNewDevice((info) => showNotice({ kind: "device", info })), [showNotice]);
  useEffect(() => subscribeOpenDevices(() => setActiveTab("settings")), []);
  useEffect(() => {
    if (!token) return undefined;
    void checkForNewDevices(token);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void checkForNewDevices(token);
    });
    return () => subscription.remove();
  }, [token]);
  useFounderWatch(token, () => showNotice({ kind: "founder" }));

  // UX-SKY-02: the site hero's sky behind the TV screens (TvSky); it is still while a screen covers the shell (player,
  // details).
  return (
    <TvSky active={isFocused}>
      <View style={styles.shell}>
        <BadgerTvTopBar
          active={activeTab}
          onSelect={setActiveTab}
          disabledTabs={hasLibraryMedia ? undefined : DISABLED_WITHOUT_MEDIA}
          beforeSettings={
            loadStatus.kind === "offline" ? (
              <SkyCover style={styles.offline}>
                <TvOfflineNotice variant={loadStatus.reason} pendingOps={loadStatus.pendingOps} onRetry={reload} />
              </SkyCover>
            ) : null
          }
        />
        {/* ACCT-UNPAID-03: while the account is unpaid, every main screen says playback is stopped and when the files
            go. It only informs and is not focusable: nothing on the TV links to paying (ACCT-PAY-02). */}
        <View style={styles.unpaid}>
          <UnpaidAccessBanner access={user?.access} scale={scale} />
        </View>
        <SkyRegion style={styles.content}>
          {activeTab === "home" ? (
            <TvHomeScreen />
          ) : activeTab === "library" ? (
            <TvLibraryScreen />
          ) : activeTab === "playlists" ? (
            <TvPlaylistsScreen />
          ) : activeTab === "search" ? (
            <TvSearchScreen />
          ) : (
            <TvSettingsScreen />
          )}
        </SkyRegion>
        {notice?.kind === "device" ? (
          <View pointerEvents="box-none" style={styles.noticeLayer}>
            <TvFocusable
              testID="tv-new-device-banner"
              style={styles.newDevice}
              scale={1.02}
              onFocus={() => notices.setPaused(true)}
              onBlur={() => notices.setPaused(false)}
              onPress={() => {
                dismissNotice("opened");
                setActiveTab("settings");
              }}
              accessibilityLabel={t("pairing.newDevice.accessibility")}
            >
              <Text style={styles.newDeviceText}>{newDeviceMessage(notice.info)}</Text>
              <Text style={styles.newDeviceHint}>{t("pairing.newDevice.tvHint")}</Text>
            </TvFocusable>
          </View>
        ) : notice?.kind === "founder" ? (
          <TvFounderNotice
            onPress={() => dismissNotice("closed")}
            onFocus={() => notices.setPaused(true)}
            onBlur={() => notices.setPaused(false)}
          />
        ) : null}
      </View>
    </TvSky>
  );
};

/**
 * WAIT-FOUND-04: "🎫 Founder ticket recognised." over "Your 30% for life is applied to your plan." and "Got it", in the
 * app's language. It takes the remote's focus as it shows (so its timer waits until the user has read it); OK or Back
 * closes it.
 */
const TvFounderNotice = ({ onPress, onFocus, onBlur }: { onPress: () => void; onFocus: () => void; onBlur: () => void }) => {
  const { i18n } = useTranslation();
  const styles = useTvStyles(baseStyles);
  const text = founderNoticeText(i18n.language);
  return (
    <View pointerEvents="box-none" style={styles.noticeLayer}>
      <TvFocusable
        testID="tv-founder-banner"
        style={styles.newDevice}
        scale={1.02}
        hasTVPreferredFocus
        onFocus={onFocus}
        onBlur={onBlur}
        onPress={onPress}
        accessibilityLabel={`${text.title} ${text.body} ${text.dismiss}`}
      >
        <Text style={styles.newDeviceText}>{text.title}</Text>
        <Text style={styles.founderBody}>{text.body}</Text>
        <Text style={styles.newDeviceHint}>{text.dismiss}</Text>
      </TvFocusable>
    </View>
  );
};

const baseStyles = StyleSheet.create({
  shell: { flex: 1 },
  // Margins, not paddings, around covered blocks: a `SkyCover` hides the sky over its whole box.
  unpaid: { paddingHorizontal: TV_SAFE_MARGIN_X - 4 },
  // The offline notice may shrink (its title then ends in "…"), so it never reaches the centred tabs (UX-TV-14).
  offline: { flexShrink: 1, minWidth: 0 },
  // UX-NOTICE-01: over the page's top-right corner, under Settings (DOWN from it reaches the notice), out of the flow.
  noticeLayer: { position: "absolute", top: TV_SAFE_MARGIN_Y + 44, right: TV_SAFE_MARGIN_X, maxWidth: 560, zIndex: 20 },
  newDevice: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: theme.colors.accentSoft,
    gap: 2,
    elevation: 8,
  },
  newDeviceText: { fontSize: 16, fontWeight: "800", color: theme.colors.accent },
  newDeviceHint: { fontSize: 13, color: theme.colors.textMuted },
  founderBody: { fontSize: 15, color: theme.colors.text },
  content: { flex: 1 },
});
