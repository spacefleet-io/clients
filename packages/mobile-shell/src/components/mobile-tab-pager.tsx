/**
 * The phone's main pages side by side (UX-PHONE-09): a swipe left or right moves to the next or previous bottom tab,
 * a tab tap scrolls the pager there. Badger's `MobileShellFrame` and Parrot's main screen both use it, so the two
 * phone apps swipe the same way.
 *
 * Only the open page renders on first paint; the others mount once the first interactions settle (or as soon as
 * they are opened), so startup is not held up by off-screen lists. A page that has mounted stays mounted, which keeps
 * its scroll position and lets the next swipe show it at once.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, useWindowDimensions, View, type ScrollViewInstance, type StyleProp, type ViewStyle } from "react-native";
import { useSkyScroll } from "./mobile-sky-cover";

export type MobileTabPagerProps = {
  /** The pages, in tab-bar order (the tabs that can open right now; a disabled tab has no page). */
  tabIds: readonly string[];
  activeTab: string;
  /** Called with the page a swipe settled on. */
  onTabChange: (id: string) => void;
  /** Each page's own style (padding), on top of its width. */
  pageStyle?: StyleProp<ViewStyle>;
  children: (tabId: string) => React.ReactNode;
};

export const MobileTabPager = ({ tabIds, activeTab, onTabChange, pageStyle, children }: MobileTabPagerProps) => {
  const { width: pageWidth } = useWindowDimensions();
  const pagerRef = useRef<ScrollViewInstance | null>(null);
  // A page swipe is a scroll too: it holds the sky still (UX-SKY-01).
  const sky = useSkyScroll();
  const [idle, setIdle] = useState(false);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set([activeTab]));
  const activeIndex = tabIds.indexOf(activeTab);

  useEffect(() => {
    const handle = requestIdleCallback(() => setIdle(true), { timeout: 1000 });
    return () => cancelIdleCallback(handle);
  }, []);

  useEffect(() => {
    setMounted((previous) => (previous.has(activeTab) ? previous : new Set(previous).add(activeTab)));
  }, [activeTab]);

  // Keyed on the index (not the per-render `tabIds` array) so unrelated re-renders cannot restart an in-flight
  // animated scroll and strand the pager between two pages.
  useEffect(() => {
    if (activeIndex === -1) return;
    pagerRef.current?.scrollTo({ x: activeIndex * pageWidth, animated: true });
  }, [activeIndex, pageWidth]);

  const onMomentumEnd = useCallback(
    (offsetX: number) => {
      const next = tabIds[Math.round(offsetX / pageWidth)];
      if (next && next !== activeTab) {
        console.info("mobile.tabPager.swiped", JSON.stringify({ from: activeTab, to: next }));
        onTabChange(next);
      }
    },
    [pageWidth, tabIds, activeTab, onTabChange],
  );

  return (
    <ScrollView
      ref={pagerRef}
      testID="tab-pager"
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentOffset={{ x: Math.max(activeIndex, 0) * pageWidth, y: 0 }}
      onScrollBeginDrag={sky.onScrollBeginDrag}
      onScrollEndDrag={sky.onScrollEndDrag}
      onMomentumScrollBegin={sky.onMomentumScrollBegin}
      onMomentumScrollEnd={(event) => {
        // A tab tap scrolls the pager in code and raises no begin event: count it as a scroll so the sky holds.
        sky.onMomentumScrollBegin?.();
        sky.onMomentumScrollEnd?.();
        onMomentumEnd(event.nativeEvent.contentOffset.x);
      }}
    >
      {tabIds.map((id) => (
        <View key={id} testID={`tab-page-${id}`} style={[styles.page, pageStyle, { width: pageWidth }]}>
          {idle || mounted.has(id) || id === activeTab ? children(id) : null}
        </View>
      ))}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  page: { flex: 1 },
});
