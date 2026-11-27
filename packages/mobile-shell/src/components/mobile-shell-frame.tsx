import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardOpen } from "../keyboard";
import { useMobileShellTheme } from "../theme";
import MobileAppBackdrop from "./mobile-app-backdrop";
import { SkyCoversProvider } from "./mobile-sky-cover";
import { useMobileSkyMode } from "./mobile-sky-mode";
import { createSkyCoverRegistry } from "./mobile-sky-covers";
import { createUserInputSignal } from "./mobile-user-input";
import { MobileTabBar, type MobileTabBarAction, type MobileTabBarLook, type MobileTabDefinition } from "./mobile-tab-bar";
import { MobileTabPager } from "./mobile-tab-pager";

type MobileShellFrameProps = {
  tabs: MobileTabDefinition[];
  activeTab: string;
  onTabChange: (id: string) => void;
  disabledTabs?: string[];
  showBackdrop?: boolean;
  /**
   * When true, the starfield backdrop pauses its animations. Pass true while
   * the shell is covered by another navigation stack screen (Player,
   * MediaDetails) so the backdrop doesn't burn UI-thread cycles offscreen.
   */
  backdropPaused?: boolean;
  /** The bottom bar's look (`MobileTabBar`'s `look`); Badger passes "badger" (UX-PHONE-06). */
  tabBarLook?: MobileTabBarLook;
  /** Drawn on top of every page (absolutely positioned by itself), e.g. a `MobileNoticeToast`. Never in the page flow. */
  overlay?: React.ReactNode;
  /** A small lasting status sign on the tab bar's top edge (`MobileTabBar`'s `badge`), e.g. `MobileOfflineIndicator`. */
  tabBarBadge?: React.ReactNode;
  /** A button among the tabs that is not a page (`MobileTabBar`'s `action`, UX-PHONE-12): the pager never stops on it. */
  tabBarAction?: MobileTabBarAction;
  children: (activeTab: string) => React.ReactNode;
};

export const MobileShellFrame = ({
  tabs,
  activeTab,
  onTabChange,
  disabledTabs = [],
  showBackdrop = true,
  backdropPaused = false,
  tabBarLook,
  overlay,
  tabBarBadge,
  tabBarAction,
  children,
}: MobileShellFrameProps) => {
  const theme = useMobileShellTheme();
  const insets = useSafeAreaInsets();
  const [input] = useState(createUserInputSignal);
  const [covers] = useState(createSkyCoverRegistry);
  // The still sky never moves: without a registry scrolls hold nothing.
  const skyMode = useMobileSkyMode();
  // Touch and scrolls in motion hold the sky still (UX-SKY-01).
  const comets = useMemo(() => ({ input, covers }), [input, covers]);
  const keyboardOpen = useKeyboardOpen();

  const visibleTabIds = useMemo(
    () => tabs.filter((t) => !disabledTabs.includes(t.id)).map((t) => t.id),
    [tabs, disabledTabs],
  );

  return (
    <SkyCoversProvider value={skyMode === "static" ? null : covers}>
      {/* A plain View, not SafeAreaView: the pager pads the top inset itself and the tab bar pads the bottom one, so
          a SafeAreaView here doubled both on iOS (Dynamic Island / home indicator) and kept the backdrop off the top. */}
      <View style={[styles.safeArea, { backgroundColor: theme.colors.bg }]} {...input.touchHandlers}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.bg }]} />
        {showBackdrop ? <MobileAppBackdrop paused={backdropPaused} comets={comets} /> : null}

        <View style={[styles.main, { paddingTop: insets.top + 4 }]}>
          <MobileTabPager tabIds={visibleTabIds} activeTab={activeTab} onTabChange={onTabChange} pageStyle={styles.page}>
            {children}
          </MobileTabPager>
        </View>

        {/* Hidden while typing: the keyboard would push it up over the field being typed in (UX-PHONE-01). */}
        {keyboardOpen ? null : (
          <MobileTabBar
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={onTabChange}
            disabledTabs={disabledTabs}
            look={tabBarLook}
            badge={tabBarBadge}
            action={tabBarAction}
          />
        )}
        {/* UX-NOTICE-01: notices float over the pages and the bar, never inside them, so no page moves. */}
        {overlay ?? null}
      </View>
    </SkyCoversProvider>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  main: {
    flex: 1,
  },
  page: {
    paddingHorizontal: 16,
    paddingBottom: 82,
  },
});
