import React, { memo, useCallback, useRef } from "react";
import { FlatList, StyleSheet, TVFocusGuideView, View, useWindowDimensions } from "react-native";
import { SkyCover } from "@space/mobile-shell/components";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import type { MediaRow } from "@space/shared/libraryTypes";
import { railScrollOffset } from "../lib/focusOrder";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { TvTitle } from "../ui/TvText";
import { TV_SPACE } from "../ui/tokens";
import { TvPosterCard, tvPosterCardHeight } from "./TvPosterCard";

/** Design dp (scaled with the TV, UX-TV-13). Room above and below the cards for the focused poster's grow and ring, which the list would otherwise clip. */
export const TV_RAIL_GROW_ROOM = 12;
const keyExtractor = (item: MediaRow) => item.id;
const Separator = () => {
  const styles = useTvStyles(baseStyles);
  return <View style={styles.separator} />;
};

type TvRailProps = {
  title: string;
  items: readonly MediaRow[];
  cardWidth: number;
  onOpenMedia: (mediaId: string) => void;
  showProgress?: boolean;
  /** Index of the card that takes the focus when the rail mounts (null = none). */
  preferredFocusIndex?: number | null;
  /** testID of the heading, so the e2e harness finds a row without reading its (localised, capitalised) title. */
  titleTestID?: string;
};

/**
 * One Home row of posters straight on the sky (UX-TV-05, UX-TV-11, mockup `.rows`): a Title-case heading ("Recently
 * added") and the posters under it, both at the screen's side margin; no panel and no count. A plain horizontal list:
 * the row holds at most a dozen titles, so everything is mounted (focus search only finds mounted cards) and nothing
 * snaps or clips; the list scrolls itself to keep the focused card in view.
 * The cards sit in a full-width focus guide with `autoFocus` (TV-RAIL-FOCUS-001): tvOS only moves the focus to what lies
 * in the pressed direction, so UP or DOWN into the row from anywhere along its width lands on its last focused card (the
 * first one at first).
 */
export const TvRail = memo(({ title, items, cardWidth, onOpenMedia, showProgress, preferredFocusIndex = null, titleTestID }: TvRailProps) => {
  const { width: windowWidth } = useWindowDimensions();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const listRef = useRef<FlatList<MediaRow>>(null);
  const itemLength = cardWidth + TV_SPACE.posterGap * scale;

  const handleFocusItem = useCallback(
    (mediaId: string) => {
      const focusedIndex = items.findIndex((item) => item.id === mediaId);
      if (focusedIndex < 0) return;
      const offset = railScrollOffset({
        focusedIndex,
        itemLength,
        itemCount: items.length,
        viewportWidth: windowWidth - TV_SPACE.screenX * scale,
      });
      console.info("tv.rail.focus", JSON.stringify({ title, focusedIndex, offset }));
      listRef.current?.scrollToOffset({ offset, animated: true });
    },
    [items, itemLength, scale, title, windowWidth],
  );

  const renderItem = useCallback(
    // Each poster hides the sky behind it (UX-SKY-01). The rail scrolls itself, without scroll events: the shell
    // measures the covers again once the remote is quiet (`createSkyRemoteInput`).
    ({ item, index }: { item: MediaRow; index: number }) => (
      <SkyCover>
        {/* UX-CRASH-01: a poster that throws shows a placeholder in its place; the rest of the rail stays. */}
        <MobileRenderBoundary name={`home-card:${item.id}`} variant="item" style={{ width: cardWidth, margin: 0 }}>
          {() => (
            <TvPosterCard
              item={item}
              width={cardWidth}
              onPress={onOpenMedia}
              showProgress={showProgress}
              hasTVPreferredFocus={index === preferredFocusIndex}
              onFocusItem={handleFocusItem}
            />
          )}
        </MobileRenderBoundary>
      </SkyCover>
    ),
    [cardWidth, handleFocusItem, onOpenMedia, preferredFocusIndex, showProgress],
  );

  return (
    <View style={styles.rail}>
      <TvTitle size="section" style={styles.title} numberOfLines={1} testID={titleTestID}>
        {title}
      </TvTitle>
      {/* Full width: the rail's column stretches it (default alignItems). */}
      <TVFocusGuideView autoFocus>
        <FlatList
          ref={listRef}
          horizontal
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ItemSeparatorComponent={Separator}
          style={{ height: tvPosterCardHeight(cardWidth, scale) + TV_RAIL_GROW_ROOM * 2 * scale }}
          contentContainerStyle={styles.content}
          showsHorizontalScrollIndicator={false}
          initialNumToRender={items.length}
          windowSize={21}
        />
      </TVFocusGuideView>
    </View>
  );
});
TvRail.displayName = "TvRail";

/** Sizes in design dp (mockup `.rowhead` / `.row` px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  rail: {},
  // The heading sits 11 dp over the posters; the list's grow room above the posters is part of that gap.
  title: { paddingHorizontal: TV_SPACE.screenX, marginBottom: TV_SPACE.headingGap - TV_RAIL_GROW_ROOM },
  // The first poster lines up with the heading's left edge.
  content: { paddingHorizontal: TV_SPACE.screenX, paddingVertical: TV_RAIL_GROW_ROOM },
  separator: { width: TV_SPACE.posterGap },
});
