// The fleet's bottom tab bar (Badger: Home / Library / Settings; Parrot: Library / Settings): icons with upper-case
// labels and a glowing dot that slides to the active tab. React Native's own Animated (native driver), not
// react-native-reanimated, so apps that do not ship reanimated (Parrot) can use it, as `MobileAuthBrand` does.
import React, { useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, Vibration, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileShellTheme } from "../theme";
import { tabIndicatorCenter } from "./mobile-tab-bar-geometry";
import { SkyCover } from "./mobile-sky-cover";

export type MobileTabDefinition = {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
};

type MobileTabBarProps = {
  tabs: MobileTabDefinition[];
  activeTab: string;
  onTabChange: (id: string) => void;
  disabledTabs?: string[];
  style?: ViewStyle;
  /**
   * "classic" (default): upper-case extra-bold labels, 24 dp icons, a glowing 6 dp dot. "badger": the Badger design's bar
   * (UX-PHONE-06): labels as written in semibold, 22 dp icons, a flat 5 dp dot.
   */
  look?: MobileTabBarLook;
  /**
   * A small status sign (Badger: the offline pill, UX-NOTICE-02) floating centred on the bar's top edge, in its own
   * absolute layer: the bar keeps its height and no tab moves.
   */
  badge?: React.ReactNode;
};

export type MobileTabBarLook = "classic" | "badger";

/**
 * A disabled tab (UX-LIBTAB-01: Library and Playlists while the library is empty) is the idle colour at this opacity,
 * the same treatment as the desktop nav (`desktopTopNavDisabledClassName`) and the TV top bar: clearly greyed, never just
 * a slightly darker grey.
 */
export const MOBILE_TAB_DISABLED_OPACITY = 0.5;

/** The springs of the sliding dot and of a pressed tab (the same physics the reanimated version used). */
export const MOBILE_TAB_BAR_SPRINGS = {
  indicator: { damping: 22, stiffness: 240, mass: 0.35 },
  press: { damping: 15, stiffness: 350, mass: 0.3 },
} as const;
const BAR_PADDING_X = 12;
const DOT_SIZE: Record<MobileTabBarLook, number> = { classic: 6, badger: 5 };
/** Space between the bar's top border and the tab icons; the active dot sits in its vertical middle. */
const BAR_PADDING_TOP = 16;

const spring = (value: Animated.Value, toValue: number, config: { damping: number; stiffness: number; mass: number }) =>
  Animated.spring(value, { toValue, ...config, useNativeDriver: true });

const TabButton = ({
  tab,
  isActive,
  isDisabled,
  color,
  fontFamily,
  look,
  onPress,
}: {
  tab: MobileTabDefinition;
  isActive: boolean;
  isDisabled: boolean;
  color: string;
  fontFamily: string;
  look: MobileTabBarLook;
  onPress: () => void;
}) => {
  const scale = useRef(new Animated.Value(1)).current;

  return (
    <Animated.View style={[styles.tabButton, { transform: [{ scale }] }]}>
      <Pressable
        onPressIn={() => {
          if (!isDisabled) spring(scale, 0.9, MOBILE_TAB_BAR_SPRINGS.press).start();
        }}
        onPressOut={() => spring(scale, 1, MOBILE_TAB_BAR_SPRINGS.press).start()}
        onPress={() => {
          Vibration.vibrate(10);
          onPress();
        }}
        disabled={isDisabled}
        accessibilityRole="tab"
        testID={`tab-${tab.id}`}
        accessibilityLabel={tab.label}
        accessibilityState={{ selected: isActive, disabled: isDisabled }}
        style={[styles.tabButtonInner, isDisabled && styles.tabButtonDisabled]}
      >
        <tab.icon size={look === "badger" ? 22 : 24} color={color} />
        <Text numberOfLines={1} style={[styles.tabLabel, look === "badger" && styles.tabLabelBadger, { color, fontFamily }]}>
          {look === "badger" ? tab.label : tab.label.toUpperCase()}
        </Text>
      </Pressable>
    </Animated.View>
  );
};

export const MobileTabBar = ({ tabs, activeTab, onTabChange, disabledTabs = [], style, look = "classic", badge }: MobileTabBarProps) => {
  const theme = useMobileShellTheme();
  const insets = useSafeAreaInsets();
  const indicatorX = useRef(new Animated.Value(0)).current;
  const [barWidth, setBarWidth] = useState(0);
  const placedRef = useRef(false);

  const tabCount = tabs.length;

  useEffect(() => {
    const tabIndex = tabs.findIndex((tab) => tab.id === activeTab);
    if (tabIndex < 0 || barWidth <= 0) return undefined;
    const target = tabIndicatorCenter({ width: barWidth, padding: BAR_PADDING_X, count: tabCount, index: tabIndex }) - DOT_SIZE[look] / 2;
    // First placement snaps; later tab changes slide.
    if (!placedRef.current) {
      placedRef.current = true;
      indicatorX.setValue(target);
      return undefined;
    }
    const slide = spring(indicatorX, target, MOBILE_TAB_BAR_SPRINGS.indicator);
    slide.start();
    return () => slide.stop();
  }, [activeTab, barWidth, indicatorX, look, tabCount, tabs]);

  return (
    <SkyCover
      style={[
        styles.tabBar,
        {
          backgroundColor: Platform.select({
            ios: "rgba(18, 20, 33, 0.78)",
            default: "rgba(18, 20, 33, 0.94)",
          }),
          borderTopColor: "#44475a",
          paddingBottom: Math.max(insets.bottom, 10),
        },
        style,
      ]}
      onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
    >
      <Animated.View
        testID="mobile-tab-dot"
        style={[
          styles.tabDot,
          look === "badger" && styles.tabDotBadger,
          {
            backgroundColor: theme.colors.accent,
            shadowColor: theme.colors.accent,
          },
          { transform: [{ translateX: indicatorX }] },
          barWidth > 0 ? null : styles.tabDotHidden,
        ]}
      />
      {tabs.map((tab) => {
        const isDisabled = disabledTabs.includes(tab.id);
        const isActive = activeTab === tab.id;
        const color = isActive && !isDisabled ? theme.colors.accent : theme.colors.textMuted;

        return (
          <TabButton
            key={tab.id}
            tab={tab}
            isActive={isActive}
            isDisabled={isDisabled}
            color={color}
            fontFamily={theme.font.family.sans}
            look={look}
            onPress={() => onTabChange(tab.id)}
          />
        );
      })}
      {badge ? (
        <View pointerEvents="box-none" style={styles.badgeLayer} testID="mobile-tab-bar-badge">
          {badge}
        </View>
      ) : null}
    </SkyCover>
  );
};

const styles = StyleSheet.create({
  tabBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    minHeight: 78,
    paddingTop: BAR_PADDING_TOP,
    paddingHorizontal: BAR_PADDING_X,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    // Icons hug the top padding (extra bar height goes below the labels), so the gap the dot is centred in is exactly BAR_PADDING_TOP.
    justifyContent: "flex-start",
  },
  tabButtonInner: {
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  tabButtonDisabled: {
    opacity: MOBILE_TAB_DISABLED_OPACITY,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.9,
  },
  tabLabelBadger: {
    fontWeight: "600",
    letterSpacing: 0,
  },
  tabDot: {
    position: "absolute",
    left: 0,
    top: (BAR_PADDING_TOP - DOT_SIZE.classic) / 2,
    width: DOT_SIZE.classic,
    height: DOT_SIZE.classic,
    borderRadius: 999,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
    elevation: 6,
  },
  tabDotBadger: {
    top: (BAR_PADDING_TOP - DOT_SIZE.badger) / 2,
    width: DOT_SIZE.badger,
    height: DOT_SIZE.badger,
    shadowOpacity: 0,
    elevation: 0,
  },
  tabDotHidden: {
    opacity: 0,
  },
  // Centred on the top border (the pill is 22 dp tall), over the gap the active dot sits in.
  badgeLayer: {
    position: "absolute",
    left: 0,
    right: 0,
    top: -11,
    alignItems: "center",
  },
});
