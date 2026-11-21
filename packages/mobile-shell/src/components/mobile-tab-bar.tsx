// The fleet's bottom tab bar (Badger: Home / Library / Settings; Parrot: Library / Settings): icons with upper-case
// labels and a glowing dot that slides to the active tab. React Native's own Animated (native driver), not
// react-native-reanimated, so apps that do not ship reanimated (Parrot) can use it, as `MobileAuthBrand` does.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, Vibration, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileShellTheme } from "../theme";
import { TAB_BAR_ACTION_SLOT, TAB_BAR_PADDING_X, TAB_BAR_PADDING_X_WITH_ACTION, tabBarHalfGuess, tabIndicatorCenter } from "./mobile-tab-bar-geometry";
import { SkyCover } from "./mobile-sky-cover";

export type MobileTabDefinition = {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
};

/**
 * A button drawn among the tabs that opens something over the page instead of being a page (UX-PHONE-12: the phone's
 * Search, between Library and Playlists). Never active, the dot never goes to it, and the tab pager does not know it, so
 * a swipe goes from the tab before it straight to the tab after it. It is its icon alone, in the accent colour, level
 * with the tabs' icons: `label` is what VoiceOver and TalkBack say, never drawn, so the labelled tabs keep the room.
 */
export type MobileTabBarAction = {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
  /** The tab it follows. */
  after: string;
  onPress: () => void;
  disabled?: boolean;
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
  /** An icon-only button among the tabs (`MobileTabBarAction`), right after the tab it names. */
  action?: MobileTabBarAction;
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
  tight,
  onPress,
  onLayout,
}: {
  tab: MobileTabDefinition;
  isActive: boolean;
  isDisabled: boolean;
  color: string;
  fontFamily: string;
  look: MobileTabBarLook;
  /** The bar also holds an action (UX-PHONE-12): the capitals drop their extra letter spacing so each half fits its two labels. */
  tight: boolean;
  onPress: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) => {
  const scale = useRef(new Animated.Value(1)).current;

  return (
    <Animated.View style={[styles.tabButton, { transform: [{ scale }] }]} onLayout={onLayout}>
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
        <Text
          numberOfLines={1}
          style={[styles.tabLabel, look === "badger" ? styles.tabLabelBadger : tight && styles.tabLabelTight, { color, fontFamily }]}
        >
          {look === "badger" ? tab.label : tab.label.toUpperCase()}
        </Text>
      </Pressable>
    </Animated.View>
  );
};

/**
 * The action is a filled accent circle with a dark icon, level with the tab icons (centred on them, no lift, no shadow),
 * so it reads apart from the plain tabs. Its slot is the circle and no more: the tabs' labels keep the rest of the bar;
 * `hitSlop` widens the touch area to ACTION_TOUCH_WIDTH.
 */
const ACTION_SIZE = 36;
const ACTION_SLOT_WIDTH = TAB_BAR_ACTION_SLOT;
const ACTION_TOUCH_WIDTH = 48;

const ActionButton = ({ action, look }: { action: MobileTabBarAction; look: MobileTabBarLook }) => {
  const theme = useMobileShellTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const disabled = action.disabled === true;
  const iconSize = look === "badger" ? 22 : 24; // the tabs' icon size: the circle centres on their icons
  const slop = (ACTION_TOUCH_WIDTH - ACTION_SLOT_WIDTH) / 2;
  return (
    <Animated.View style={[styles.actionSlot, { transform: [{ scale }] }]}>
      <Pressable
        onPressIn={() => {
          if (!disabled) spring(scale, 0.9, MOBILE_TAB_BAR_SPRINGS.press).start();
        }}
        onPressOut={() => spring(scale, 1, MOBILE_TAB_BAR_SPRINGS.press).start()}
        onPress={() => {
          Vibration.vibrate(10);
          console.info("tab-bar.action", JSON.stringify({ id: action.id }));
          action.onPress();
        }}
        disabled={disabled}
        hitSlop={{ left: slop, right: slop, top: BAR_PADDING_TOP, bottom: 24 }}
        accessibilityRole="button"
        testID={`tab-${action.id}`}
        accessibilityLabel={action.label}
        accessibilityState={{ disabled }}
        style={[
          styles.actionCircle,
          { backgroundColor: theme.colors.accent, marginTop: -(ACTION_SIZE - iconSize) / 2 },
          disabled && styles.tabButtonDisabled,
        ]}
      >
        <action.icon size={iconSize - 2} color={theme.accentTextHex} />
      </Pressable>
    </Animated.View>
  );
};

export const MobileTabBar = ({ tabs, activeTab, onTabChange, disabledTabs = [], style, look = "classic", badge, action }: MobileTabBarProps) => {
  const theme = useMobileShellTheme();
  const insets = useSafeAreaInsets();
  const indicatorX = useRef(new Animated.Value(0)).current;
  const [barWidth, setBarWidth] = useState(0);
  // Where each tab landed (its x from its row's left edge and its width): the tabs are as wide as their labels, so the
  // dot centres on the measured tab, and on the equal-share guess until it is measured (UX-PHONE-11). With an action the
  // tabs sit in two halves either side of it, so a tab's x counts from its half, whose own x is in `halfX`.
  const [tabSpans, setTabSpans] = useState<Record<string, { x: number; width: number }>>({});
  const [halfX, setHalfX] = useState<{ left?: number; right?: number }>({});
  const placedRef = useRef(false);

  // The action sits right after its tab, in the bar's exact centre: the tabs up to it fill the left half, the rest the right.
  const actionSlot = action ? tabs.findIndex((tab) => tab.id === action.after) : -1;
  const halves = useMemo(() => (actionSlot >= 0 ? ([tabs.slice(0, actionSlot + 1), tabs.slice(actionSlot + 1)] as const) : null), [actionSlot, tabs]);

  useEffect(() => {
    const tabIndex = tabs.findIndex((tab) => tab.id === activeTab);
    if (tabIndex < 0 || barWidth <= 0) return undefined;
    const span = tabSpans[activeTab];
    const side = halves && tabIndex > actionSlot ? "right" : "left";
    const offset = halves ? halfX[side] : 0;
    const center =
      span && offset !== undefined
        ? offset + span.x + span.width / 2
        : halves
          ? tabBarHalfGuess({ width: barWidth, padding: TAB_BAR_PADDING_X_WITH_ACTION, action: ACTION_SLOT_WIDTH, half: halves[side === "left" ? 0 : 1].length, side, index: side === "left" ? tabIndex : tabIndex - actionSlot - 1 })
          : tabIndicatorCenter({ width: barWidth, padding: TAB_BAR_PADDING_X, count: tabs.length, index: tabIndex });
    const target = center - DOT_SIZE[look] / 2;
    // First placement snaps; later tab changes slide.
    if (!placedRef.current) {
      placedRef.current = true;
      indicatorX.setValue(target);
      return undefined;
    }
    const slide = spring(indicatorX, target, MOBILE_TAB_BAR_SPRINGS.indicator);
    slide.start();
    return () => slide.stop();
  }, [actionSlot, activeTab, barWidth, halfX, halves, indicatorX, look, tabSpans, tabs]);

  const renderTab = (tab: MobileTabDefinition) => {
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
        tight={action !== undefined}
        onPress={() => onTabChange(tab.id)}
        onLayout={(event) => {
          const { x, width } = event.nativeEvent.layout;
          setTabSpans((spans) => (spans[tab.id]?.x === x && spans[tab.id]?.width === width ? spans : { ...spans, [tab.id]: { x, width } }));
        }}
      />
    );
  };
  const renderHalf = (side: "left" | "right", half: readonly MobileTabDefinition[]) => (
    <View
      style={styles.half}
      testID={`mobile-tab-half-${side}`}
      onLayout={(event) => {
        const { x } = event.nativeEvent.layout;
        setHalfX((current) => (current[side] === x ? current : { ...current, [side]: x }));
      }}
    >
      {half.map(renderTab)}
    </View>
  );

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
          paddingHorizontal: halves ? TAB_BAR_PADDING_X_WITH_ACTION : TAB_BAR_PADDING_X,
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
      {halves && action ? (
        <>
          {renderHalf("left", halves[0])}
          <ActionButton action={action} look={look} />
          {renderHalf("right", halves[1])}
        </>
      ) : (
        tabs.map(renderTab)
      )}
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
  },
  // Each tab is as wide as its label plus an equal share of the room left in its row, so a long label (FR
  // "BIBLIOTHÈQUE", DE "EINSTELLUNGEN") takes room from a short one (FR "ACCUEIL", DE "START") instead of ending in "…"
  // at the phone's text size (UX-PHONE-11), and the label is centred in its share; the label never shrinks below the
  // phone's text size (UX-A11Y-05).
  tabButton: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    alignItems: "center",
    // Icons hug the top padding (extra bar height goes below the labels), so the gap the dot is centred in is exactly BAR_PADDING_TOP.
    justifyContent: "flex-start",
  },
  // With an action, each side of it is an equal half holding its tabs, so the action sits exactly in the bar's centre
  // whatever the labels' lengths (UX-PHONE-12); inside a half the tabs split the room by label width (`tabButton`).
  half: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    flexDirection: "row",
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
  tabLabelTight: {
    letterSpacing: 0,
  },
  tabLabelBadger: {
    fontWeight: "600",
    letterSpacing: 0,
  },
  actionSlot: {
    width: ACTION_SLOT_WIDTH,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  actionCircle: {
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    borderRadius: ACTION_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
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
