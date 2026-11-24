/**
 * A titled sideways row of a phone page (UX-PHONE-01): a heading with an optional "See all", then a `MobileRail` of
 * fixed-width items. Badger's Home poster rows and Parrot's Home album and artist rows are this one component, so the
 * row keeps its swipe from the tab pager the same way in both apps (UX-PHONE-09), every item gets its own crash
 * placeholder (UX-CRASH-01), and "See all" names its row to a screen reader.
 *
 * The apps keep their own heading type (Badger's display font, Parrot's larger heading and accent "See all") through
 * `titleStyle` / `seeAllStyle`; everything that moves, measures or is read aloud lives here.
 */
import React, { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useMobileShellTheme } from "../theme";
import { MobileRail } from "./mobile-rail";
import { MobileRenderBoundary } from "./mobile-render-boundary";
import { useSkyScroll } from "./mobile-sky-cover";

export type MobileHomeRailProps<T> = {
  title: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Every item's width; the row measures and snaps by it. */
  itemWidth: number;
  /** A fixed item height: the size of an item's crash placeholder. */
  itemHeight?: number;
  /** A fixed row height (Badger's posters); omitted, the row is as tall as its items. */
  rowHeight?: number;
  /** Space between items. */
  gap?: number;
  /** Side padding of the heading and the row. */
  inset?: number;
  /** Stop each fling on an item's edge. */
  snap?: boolean;
  /** "See all" at the end of the heading; omitted, the heading has none. */
  seeAll?: { label: string; onPress: () => void };
  /** The crash placeholder's name prefix (`<boundaryName>:<key>`, UX-CRASH-01). */
  boundaryName: string;
  /** The row's own scroll holds the page's sky still, as the page scroll does (a page under `SkyCover`s). */
  followSky?: boolean;
  /** The row and, with `-see-all`, its "See all" button. */
  testID?: string;
  style?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
  seeAllStyle?: StyleProp<TextStyle>;
};

const DEFAULT_GAP = 12;

export const MobileHomeRail = <T,>({
  title,
  items,
  keyOf,
  renderItem,
  itemWidth,
  itemHeight,
  rowHeight,
  gap = DEFAULT_GAP,
  inset = 0,
  snap = false,
  seeAll,
  boundaryName,
  followSky = false,
  testID,
  style,
  titleStyle,
  seeAllStyle,
}: MobileHomeRailProps<T>) => {
  const theme = useMobileShellTheme();
  const sky = useSkyScroll();
  const itemLength = itemWidth + gap;
  const getItemLayout = useCallback(
    (_: ArrayLike<T> | null | undefined, index: number) => ({ length: itemLength, offset: inset + itemLength * index, index }),
    [itemLength, inset],
  );
  const itemStyle = useMemo(() => ({ width: itemWidth, height: itemHeight, margin: 0 }), [itemWidth, itemHeight]);
  const renderRailItem = useCallback(
    ({ item }: { item: T }) => (
      // UX-CRASH-01: an item that throws shows a placeholder in its place; the rest of the row stays.
      <MobileRenderBoundary name={`${boundaryName}:${keyOf(item)}`} variant="item" style={itemStyle}>
        {() => renderItem(item)}
      </MobileRenderBoundary>
    ),
    [boundaryName, keyOf, itemStyle, renderItem],
  );
  const Separator = useMemo(() => {
    const RailGap = () => <View style={{ width: gap }} />;
    return RailGap;
  }, [gap]);

  return (
    <View style={[styles.rail, style]} testID={testID}>
      <View style={[styles.head, { paddingHorizontal: inset }]}>
        <Text style={[styles.title, { color: theme.colors.text }, titleStyle]} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        {seeAll ? (
          <Pressable
            onPress={seeAll.onPress}
            accessibilityRole="button"
            accessibilityLabel={`${seeAll.label}, ${title}`}
            hitSlop={10}
            testID={testID ? `${testID}-see-all` : undefined}
          >
            <Text style={[styles.seeAll, { color: theme.colors.textMuted }, seeAllStyle]}>{seeAll.label}</Text>
          </Pressable>
        ) : null}
      </View>
      <MobileRail
        {...(followSky ? sky : null)}
        data={items}
        keyExtractor={keyOf}
        renderItem={renderRailItem}
        getItemLayout={getItemLayout}
        ItemSeparatorComponent={Separator}
        style={rowHeight === undefined ? undefined : { height: rowHeight }}
        contentContainerStyle={inset ? { paddingHorizontal: inset } : undefined}
        snapToInterval={snap ? itemLength : undefined}
        decelerationRate={snap ? "fast" : undefined}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={5}
        removeClippedSubviews
      />
    </View>
  );
};

const styles = StyleSheet.create({
  rail: { gap: 10 },
  head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  title: { flex: 1, fontSize: 18, fontWeight: "800" },
  seeAll: { fontSize: 13, fontWeight: "600" },
});
