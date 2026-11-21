import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Home, LibraryBig, ListVideo, Search, Settings } from "lucide-react-native";
import {
  MobileShellFrame,
  MobileFounderNotice,
  MobileNoticeToast,
  MobileOfflineIndicator,
  SkyRegion,
  type MobileOfflineVariant,
  type MobileTabBarAction,
  type MobileTabDefinition,
} from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useNoticeQueue } from "@space/mobile-shell/notice-queue";
import { founderWatch, useFounderWatch } from "@space/mobile-shell/founder";
import { offlineNoticeEdge } from "@space/shared/offlineNotice";
import { phoneSearchStrings } from "@space/shared/searchPaletteStrings";
import { useAuth } from "../store/auth";
import { checkForNewDevices, markDeviceSeen } from "../lib/pairing/deviceWatch";
import { newDeviceKey, newDeviceMessage, subscribeNewDevice, type NewDeviceInfo } from "../lib/pairing/newDevice";
import { useOpenDevices } from "../lib/pairing/useOpenDevices";
import { useLibraryData, useLibraryStatus } from "../store/library";
import { UnpaidAccessBanner } from "../components/UnpaidAccessBanner";
import { PlaylistsPanel } from "../components/PlaylistsPanel";
import { PhoneSearch } from "../components/PhoneSearch";
import { HomeScreen } from "./HomeScreen";
import { LibraryScreen } from "./LibraryScreen";
import type { LibraryScope } from "../lib/libraryScreenState";
import type { SeeAllTarget } from "../lib/phoneHome";
import { SettingsScreen } from "./SettingsScreen";

/**
 * Primary sections, in Parrot's phone order (UX-PHONE-07, PAR-NAV-02): Home, Library, Playlists and Settings, as the
 * desktop's top bar (UX-TOP-01); Playlists is its own destination, not a Library tab. Between Library and Playlists
 * stands the Search button (UX-PHONE-12): it opens the search over the page and is not a page, so a swipe goes from
 * Library straight to Playlists. The bar wears the Badger design's look (UX-PHONE-06). Account & plan lives under
 * Settings (stack screen "Subscription"). Labels are keys, resolved at render so the tabs follow the UI language live.
 */
const TAB_DEFINITIONS = [
  { id: "home", labelKey: "nav.home", icon: Home },
  { id: "library", labelKey: "nav.library", icon: LibraryBig },
  { id: "playlists", labelKey: "nav.playlists", icon: ListVideo },
  { id: "settings", labelKey: "nav.settings", icon: Settings },
] as const;

/** UX-LIBTAB-01: an empty library cannot be opened, nor its playlists. */
const DISABLED_WITHOUT_MEDIA = ["library", "playlists"];
const NONE: string[] = [];

/**
 * The shell's one notice slot (UX-NOTICE-01): a new device, the passing "you're offline" notice (UX-NOTICE-02), or the
 * one-time "Founder ticket recognised" notice (WAIT-FOUND-04).
 */
type ShellNotice =
  | { kind: "device"; info: NewDeviceInfo }
  | { kind: "offline"; variant: MobileOfflineVariant }
  | { kind: "founder" };
const OFFLINE_NOTICE_KEY = "offline";
const FOUNDER_NOTICE_KEY = "founder";

export const MainShellScreen = () => {
  const { t, i18n } = useTranslation();
  const tabs = useMemo<MobileTabDefinition[]>(
    () => TAB_DEFINITIONS.map(({ id, labelKey, icon }) => ({ id, label: t(labelKey), icon })),
    [t],
  );
  const { media } = useLibraryData();
  const { loadStatus, reload } = useLibraryStatus();
  const isFocused = useIsFocused();
  const { token } = useAuth();
  const [activeTab, setActiveTab] = useState("home");
  // Home's "See all" opens the Library on that row's scope, or Playlists for Favorites (UX-PHONE-01, UX-PHONE-07).
  const [libraryScopeRequest, setLibraryScopeRequest] = useState<{ scope: LibraryScope } | null>(null);
  const seeAll = useCallback((target: SeeAllTarget) => {
    if (target.tab === "library") setLibraryScopeRequest({ scope: target.scope });
    setActiveTab(target.tab);
  }, []);

  const hasLibraryMedia = media.length > 0;
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const searchAction = useMemo<MobileTabBarAction>(
    () => ({
      id: "search",
      label: phoneSearchStrings("badger", i18n.language).button,
      icon: Search,
      after: "library",
      // UX-LIBTAB-01: nothing to search in an empty library.
      disabled: !hasLibraryMedia,
      onPress: () => setSearchOpen(true),
    }),
    [hasLibraryMedia, i18n.language],
  );
  // UX-NOTICE-02: offline is a normal state. It shows as a small sign on the tab bar while it lasts and is said once in
  // a passing notice; no banner and no line in the pages.
  const offlineVariant: MobileOfflineVariant | null = loadStatus.kind === "offline" ? loadStatus.reason : null;

  useEffect(() => {
    if (!hasLibraryMedia && DISABLED_WITHOUT_MEDIA.includes(activeTab)) setActiveTab("home");
  }, [activeTab, hasLibraryMedia]);

  // ACCT-PAIR-03: tell the user when another device joined the account, and open the device list
  // (Settings) when they tap the notification. UX-NOTICE-01: the notice floats over the page and leaves on its own
  // after a fixed time, or at once when tapped or closed; however it leaves, the device counts as seen. It is drawn in
  // this shell, so while another screen (the player) covers the shell it waits, unseen and without a timer.
  const notices = useNoticeQueue<ShellNotice>({
    keyOf: (notice) =>
      notice.kind === "device" ? newDeviceKey(notice.info) : notice.kind === "offline" ? OFFLINE_NOTICE_KEY : FOUNDER_NOTICE_KEY,
    onDismiss: (notice, reason) => {
      if (notice.kind === "offline") {
        console.info("offline.notice.dismissed", JSON.stringify({ reason, variant: notice.variant }));
        return;
      }
      if (notice.kind === "founder") {
        // WAIT-FOUND-04: however it left, it was on screen, so no device shows it again.
        console.info("founder.notice.dismissed", JSON.stringify({ reason }));
        if (token) void founderWatch.noticeSeen(token);
        return;
      }
      console.info("pairing.newDevice.dismissed", JSON.stringify({ reason, deviceType: notice.info.deviceType }));
      void markDeviceSeen(notice.info.sessionId);
    },
  });
  const current = notices.current;
  const { show: showNotice, withdraw: withdrawNotice, setHeld: holdNotices } = notices;
  useEffect(() => holdNotices(!isFocused), [holdNotices, isFocused]);
  useEffect(() => subscribeNewDevice((info) => showNotice({ kind: "device", info })), [showNotice]);
  // Said once when the app goes offline (or the cause changes), taken back when the connection returns; a re-render
  // while the state lasts says nothing (`offlineNoticeEdge`).
  const lastOfflineVariant = useRef<MobileOfflineVariant | null>(null);
  useEffect(() => {
    const edge = offlineNoticeEdge(lastOfflineVariant.current, offlineVariant);
    lastOfflineVariant.current = offlineVariant;
    if (!edge) return;
    console.info("offline.notice.edge", JSON.stringify(edge));
    withdrawNotice(OFFLINE_NOTICE_KEY);
    if (edge.kind === "show") showNotice({ kind: "offline", variant: edge.variant });
  }, [offlineVariant, showNotice, withdrawNotice]);
  // The notice and the notification open Settings scrolled to "Your devices" with the list open.
  const showSettings = useCallback(() => setActiveTab("settings"), []);
  const { devicesRequest, openDevices } = useOpenDevices(showSettings);
  useEffect(() => {
    if (!token) return undefined;
    void checkForNewDevices(token);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void checkForNewDevices(token);
    });
    return () => subscription.remove();
  }, [token]);
  // WAIT-FOUND-04: founder status at start, sign-in and each return to the foreground; the notice once after a claim.
  useFounderWatch(token, () => showNotice({ kind: "founder" }));

  const offlineCopy =
    current?.kind === "offline"
      ? {
          title: t(current.variant === "sync_error" ? "offline.notice.syncError.title" : "offline.notice.network.title"),
          hint: t(current.variant === "sync_error" ? "offline.notice.syncError.hint" : "offline.notice.network.hint"),
        }
      : null;
  return (
    <MobileShellFrame
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      disabledTabs={hasLibraryMedia ? NONE : DISABLED_WITHOUT_MEDIA}
      showBackdrop
      backdropPaused={!isFocused}
      tabBarLook="badger"
      tabBarAction={searchAction}
      tabBarBadge={
        loadStatus.kind === "offline" ? (
          <MobileOfflineIndicator pendingOps={loadStatus.pendingOps} variant={loadStatus.reason} onRetry={reload} />
        ) : null
      }
      overlay={
        <>
        <PhoneSearch visible={searchOpen} onClose={closeSearch} />
        {current?.kind === "device" ? (
          <MobileNoticeToast
            testID="new-device-notice"
            title={newDeviceMessage(current.info)}
            hint={t("pairing.newDevice.hint")}
            accessibilityLabel={t("pairing.newDevice.accessibility")}
            closeLabel={t("pairing.newDevice.close")}
            onOpen={() => {
              notices.dismiss("opened");
              openDevices();
            }}
            onClose={() => notices.dismiss("closed")}
          />
        ) : current?.kind === "founder" ? (
          <MobileFounderNotice
            language={i18n.language}
            onOpen={() => {
              notices.dismiss("opened");
              showSettings();
            }}
            onClose={() => notices.dismiss("closed")}
          />
        ) : offlineCopy ? (
          <MobileNoticeToast
            testID="offline-notice"
            title={offlineCopy.title}
            hint={offlineCopy.hint}
            accessibilityLabel={`${offlineCopy.title}. ${offlineCopy.hint} ${t("offline.indicator.retry")}`}
            closeLabel={t("offline.notice.close")}
            onOpen={() => {
              notices.dismiss("opened");
              reload();
            }}
            onClose={() => notices.dismiss("closed")}
          />
        ) : null}
        </>
      }
    >
      {(tabId) => (
        <View style={styles.tab}>
          <UnpaidAccessBanner />
          <SkyRegion style={styles.content}>
            {tabId === "home" ? (
              <HomeScreen onSeeAll={seeAll} />
            ) : tabId === "library" ? (
              <LibraryScreen active={activeTab === "library"} scopeRequest={libraryScopeRequest} />
            ) : tabId === "playlists" ? (
              <PlaylistsPanel />
            ) : tabId === "settings" ? (
              <SettingsScreen devicesRequest={devicesRequest} />
            ) : null}
          </SkyRegion>
        </View>
      )}
    </MobileShellFrame>
  );
};

const styles = StyleSheet.create({
  tab: { flex: 1 },
  content: { flex: 1 },
});
