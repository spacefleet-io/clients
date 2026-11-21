import React, { memo, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MediaRow } from "@space/shared/libraryTypes";
import { MobileRail } from "@space/mobile-shell/components";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { PosterCard, posterCardHeight } from "./PosterCard";
import { theme } from "../theme/theme";

const GAP = 12;
const keyExtractor = (item: MediaRow) => item.id;
const Separator = () => <View style={styles.separator} />;

type PosterRailProps = {
  title: string;
  items: MediaRow[];
  cardWidth: number;
  onOpenMedia: (mediaId: string) => void;
  showProgress?: boolean;
  /** "See all" at the end of the heading (UX-PHONE-01); omitted, the heading has none. */
  seeAll?: { label: string; onPress: () => void };
  testID?: string;
};

/** A Home row: a heading with "See all", then a horizontal virtualised row of posters, straight on the sky (no panel). */
export const PosterRail = memo(({ title, items, cardWidth, onOpenMedia, showProgress, seeAll, testID }: PosterRailProps) => {
  const itemLength = cardWidth + GAP;
  const getItemLayout = useCallback(
    (_: ArrayLike<MediaRow> | null | undefined, index: number) => ({ length: itemLength, offset: itemLength * index, index }),
    [itemLength],
  );
  const renderItem = useCallback(
    ({ item }: { item: MediaRow }) => (
      // UX-CRASH-01: a poster that throws shows a placeholder in its place; the rest of the rail stays.
      <MobileRenderBoundary name={`home-card:${item.id}`} variant="item" style={{ width: cardWidth, margin: 0 }}>
        {() => <PosterCard item={item} width={cardWidth} onPress={onOpenMedia} showProgress={showProgress} />}
      </MobileRenderBoundary>
    ),
    [cardWidth, onOpenMedia, showProgress],
  );

  return (
    <View style={styles.rail} testID={testID}>
      <View style={styles.head}>
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        {seeAll ? (
          <Pressable onPress={seeAll.onPress} accessibilityRole="button" accessibilityLabel={`${seeAll.label}, ${title}`} hitSlop={10} testID={testID ? `${testID}-see-all` : undefined}>
            <Text style={styles.seeAll}>{seeAll.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {/* The shared rail keeps a sideways swipe from the tab pager (UX-PHONE-09). */}
      <MobileRail
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        ItemSeparatorComponent={Separator}
        style={{ height: posterCardHeight(cardWidth) }}
        snapToInterval={itemLength}
        decelerationRate="fast"
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={5}
        removeClippedSubviews
      />
    </View>
  );
});
PosterRail.displayName = "PosterRail";

const styles = StyleSheet.create({
  rail: { gap: 10 },
  head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  title: { flex: 1, fontSize: 18, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  seeAll: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  separator: { width: GAP },
});
