import React, { memo, useCallback, useEffect, useState } from "react";
import { FlatList, StyleSheet, TVFocusGuideView, useWindowDimensions } from "react-native";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import type { MediaRow } from "@space/shared/libraryTypes";
import { TV_LIBRARY_COLUMNS, TV_LIBRARY_GAP_X, TV_LIBRARY_GAP_Y, TV_SAFE_MARGIN_Y, TV_SCREEN_X, tvLibraryCardWidth } from "../lib/layout";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { TvPosterCard } from "./TvPosterCard";

const keyExtractor = (item: MediaRow) => item.id;

/**
 * The poster grid on the sky, shared by Library and Playlists: eight captioned posters across at the screen margin
 * (UX-TV-09, UX-TV-11). It sits in a full-width focus guide, so DOWN from the band above it lands on its first poster
 * (then the last one focused).
 */
export const TvPosterGrid = memo(({ items, onOpenMedia }: { items: readonly MediaRow[]; onOpenMedia: (mediaId: string) => void }) => {
  const { width } = useWindowDimensions();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const skyScroll = useSkyScroll();
  const cardWidth = tvLibraryCardWidth(width, scale);
  const [gridHeight, setGridHeight] = useState(0);

  const renderItem = useCallback(
    // Each poster hides the sky behind it (UX-SKY-01): the shooting star flies only between and around the cards.
    ({ item }: { item: MediaRow }) => (
      <SkyCover>
        {/* UX-CRASH-01: a poster that throws shows a placeholder in its place; the rest of the list stays. */}
        <MobileRenderBoundary name={`library-card:${item.id}`} variant="item" style={{ width: cardWidth, margin: 0 }}>
          {() => <TvPosterCard item={item} width={cardWidth} onPress={onOpenMedia} showProgress />}
        </MobileRenderBoundary>
      </SkyCover>
    ),
    [cardWidth, onOpenMedia],
  );

  useEffect(() => {
    console.info("tv.library.layout", JSON.stringify({ items: items.length, columns: TV_LIBRARY_COLUMNS, cardWidth, gridHeight, scale }));
  }, [cardWidth, gridHeight, items.length, scale]);

  return (
    // A vertical FlatList sized only by flex collapses to one pixel on react-native-tvos, so measure the free space and give the list that height.
    <TVFocusGuideView autoFocus style={styles.grid} onLayout={(e) => setGridHeight(e.nativeEvent.layout.height)}>
      <FlatList
        style={{ height: gridHeight }}
        removeClippedSubviews={false}
        {...skyScroll}
        data={items}
        numColumns={TV_LIBRARY_COLUMNS}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.gridContent}
        showsVerticalScrollIndicator={false}
        // Focus search only finds mounted cards, so render a long way ahead of the viewport.
        initialNumToRender={TV_LIBRARY_COLUMNS * 6}
        maxToRenderPerBatch={TV_LIBRARY_COLUMNS * 4}
        windowSize={21}
      />
    </TVFocusGuideView>
  );
});
TvPosterGrid.displayName = "TvPosterGrid";

/** Sizes in design dp (mockup `.grid` px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  grid: { flex: 1 },
  // The posters start at the screen margin; the room above the first row also holds a focused poster's grow and ring.
  gridContent: { paddingHorizontal: TV_SCREEN_X, paddingTop: 17, paddingBottom: TV_SAFE_MARGIN_Y, gap: TV_LIBRARY_GAP_Y },
  row: { gap: TV_LIBRARY_GAP_X },
});
