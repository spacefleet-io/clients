import React, { useCallback, useRef, useState, type ReactNode } from "react";
import { FlatList, StyleSheet, Text, TVFocusGuideView, View, useWindowDimensions } from "react-native";
import { SkyCover } from "../components";
import { MobileRenderBoundary } from "../components/mobile-render-boundary";
import { railScrollOffset } from "./focusOrder";
import { TvFocusable } from "./TvFocusable";
import { focusDestination, type TvViewInstance } from "./tvViewInstance";
import { TvTitle } from "./TvText";
import { useTvScale, useTvStyles } from "./tvScale";
import { TV_COLOR, TV_SPACE, TV_TYPE } from "./tokens";

/** Design dp (scaled with the TV, UX-TV-13). Room above and below a row's cards for the focused card's grow and ring, which the list would otherwise clip. */
export const TV_CARD_GROW_ROOM = 12;

export type TvCardRowProps<T> = {
  title: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  /** Card width on screen (already scaled). */
  cardWidth: number;
  /** Card height on screen (already scaled), its caption and focus shift included. */
  cardHeight: number;
  /** Gap between cards in design dp. */
  gap: number;
  /** Draws one card; the card calls `onFocus` when it takes the focus, so the row scrolls it into view. */
  renderCard: (item: T, index: number, onFocus: () => void) => ReactNode;
  /**
   * Shows "See all" at the heading's right end; Right past the last card goes to it. The app gives the label in its own
   * words (Parrot's family shell `shell.home.seeAll`, REL-FAM-02), as `MobileHomeRail` does.
   */
  seeAll?: { label: string; onPress: () => void };
  /** testID of the row; "See all" gets `<testID>-see-all`. */
  testID?: string;
  /** testID of the heading, so an e2e harness finds a row without reading its (localised) title. */
  titleTestID?: string;
};

/**
 * One row of cards straight on the sky, shared by Badger TV's Home and Parrot TV's Home, Library and artist pages
 * (UX-TV-05, UX-TV-11, PAR-TV-03; quality audit #3350 S58): a Title-case heading at the screen's side margin, with
 * "See all" at its right when given, and the cards under it. Everything is mounted (focus search only finds mounted
 * cards; a row holds a few dozen at most) and the row scrolls itself to keep the focused card in view.
 * The cards sit in a full-width focus guide with `autoFocus` (TV-RAIL-FOCUS-001): tvOS only moves the focus to what
 * lies in the pressed direction, so Up or Down into the row from anywhere along its width lands on its last focused card
 * (the first one at first). Each card hides the sky behind it (UX-SKY-01) and a card that throws shows a placeholder in
 * its place (UX-CRASH-01).
 */
export const TvCardRow = <T,>({ title, items, keyOf, cardWidth, cardHeight, gap, renderCard, seeAll, testID, titleTestID }: TvCardRowProps<T>) => {
  const { width: windowWidth } = useWindowDimensions();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const listRef = useRef<FlatList<T>>(null);
  const [seeAllView, setSeeAllView] = useState<TvViewInstance | null>(null);
  const itemLength = cardWidth + gap * scale;

  const focusAt = useCallback(
    (focusedIndex: number) => {
      const offset = railScrollOffset({ focusedIndex, itemLength, itemCount: items.length, viewportWidth: windowWidth - TV_SPACE.screenX * scale });
      // Badger TV's e2e harness waits on this event to follow the focus along a row.
      console.info("tv.rail.focus", JSON.stringify({ title, focusedIndex, offset }));
      listRef.current?.scrollToOffset({ offset, animated: true });
    },
    [itemLength, items.length, scale, title, windowWidth],
  );

  return (
    <View testID={testID}>
      <View style={styles.head}>
        <TvTitle size="section" numberOfLines={1} style={styles.title} testID={titleTestID}>
          {title}
        </TvTitle>
        {seeAll ? (
          <TvFocusable ref={setSeeAllView} onPress={seeAll.onPress} style={styles.seeAll} testID={testID ? `${testID}-see-all` : undefined} accessibilityLabel={`${seeAll.label}, ${title}`}>
            <Text style={styles.seeAllText}>{seeAll.label}</Text>
          </TvFocusable>
        ) : null}
      </View>
      {/* Full width: the row's column stretches it (default alignItems). */}
      <TVFocusGuideView autoFocus>
        <FlatList
          ref={listRef}
          horizontal
          data={items}
          keyExtractor={keyOf}
          // The row scrolls itself, without scroll events: the shell measures the sky covers again once the remote is quiet.
          renderItem={({ item, index }) => (
            <SkyCover>
              <MobileRenderBoundary name={`tv-card:${keyOf(item)}`} variant="item" style={{ width: cardWidth, margin: 0 }}>
                {() => renderCard(item, index, () => focusAt(index))}
              </MobileRenderBoundary>
            </SkyCover>
          )}
          ItemSeparatorComponent={() => <View style={{ width: gap * scale }} />}
          ListFooterComponent={
            seeAll ? <TVFocusGuideView destinations={focusDestination(seeAllView)} style={{ width: cardWidth, height: cardHeight }} testID={testID ? `${testID}-to-see-all` : undefined} /> : undefined
          }
          style={{ height: cardHeight + TV_CARD_GROW_ROOM * 2 * scale }}
          contentContainerStyle={styles.content}
          showsHorizontalScrollIndicator={false}
          initialNumToRender={items.length}
          windowSize={21}
        />
      </TVFocusGuideView>
    </View>
  );
};

/** Sizes in design dp (mockup `.rowhead` / `.row` px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  // The heading sits the heading gap over the cards; the list's grow room above the cards is part of that gap.
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: TV_SPACE.screenX, marginBottom: TV_SPACE.headingGap - TV_CARD_GROW_ROOM },
  title: { flex: 1 },
  seeAll: { paddingHorizontal: 6, paddingVertical: 2 },
  seeAllText: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 10, fontWeight: "600", color: TV_COLOR.muted },
  // The first card lines up with the heading's left edge.
  content: { paddingHorizontal: TV_SPACE.screenX, paddingVertical: TV_CARD_GROW_ROOM },
});
