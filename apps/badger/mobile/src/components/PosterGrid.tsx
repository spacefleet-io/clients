import React, { memo, useCallback, useMemo } from "react";
import { Dimensions, FlatList, RefreshControl, StyleSheet } from "react-native";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import type { MediaRow } from "@space/shared/libraryTypes";
import { PosterCard, posterCardHeight } from "./PosterCard";
import { PosterGridSkeleton } from "./Skeleton";
import { theme } from "../theme/theme";
import { usePullRefreshScroll, type PullToRefresh } from "../lib/usePullToRefresh";

const COLUMNS = 3;
const GAP = 12;
/** Space between rows: the mockup's grid is `gap: 16px 12px` (UX-PHONE-06). */
const ROW_GAP = 16;
/** The shell page pads 16dp each side. */
const PAGE_PADDING = 32;

export const gridCardWidth = (containerPadding = PAGE_PADDING) =>
  Math.floor((Dimensions.get("window").width - containerPadding - GAP * (COLUMNS - 1)) / COLUMNS);

type GridRow = { key: string; items: MediaRow[] };

const chunk = (items: MediaRow[]): GridRow[] => {
  const rows: GridRow[] = [];
  for (let i = 0; i < items.length; i += COLUMNS) {
    const slice = items.slice(i, i + COLUMNS);
    rows.push({ key: slice[0]!.id, items: slice });
  }
  return rows;
};

const keyExtractor = (row: GridRow) => row.key;

type PosterGridProps = {
  items: MediaRow[];
  onOpenMedia: (mediaId: string) => void;
  pull?: PullToRefresh;
  loading?: boolean;
  empty?: React.ReactNode;
  header?: React.ReactNode;
  bottomInset?: number;
  containerPadding?: number;
  /** Draw each poster's watch progress bar and watched check (the Library, UX-PHONE-06). */
  showProgress?: boolean;
};

/**
 * Virtualised poster grid. Items are chunked into fixed-height rows so
 * `getItemLayout` is exact (FlatList's numColumns makes the index semantics
 * ambiguous); each row is a memoised component.
 */
export const PosterGrid = memo(({ items, onOpenMedia, pull, loading = false, empty, header, bottomInset = 24, containerPadding, showProgress }: PosterGridProps) => {
  const cardWidth = useMemo(() => gridCardWidth(containerPadding), [containerPadding]);
  const rowHeight = posterCardHeight(cardWidth);
  const rowLength = rowHeight + ROW_GAP;
  const rows = useMemo(() => chunk(items), [items]);
  const skyScroll = usePullRefreshScroll(pull, useSkyScroll());

  const getItemLayout = useCallback(
    (_: ArrayLike<GridRow> | null | undefined, index: number) => ({ length: rowLength, offset: rowLength * index, index }),
    [rowLength],
  );
  const renderRow = useCallback(
    ({ item }: { item: GridRow }) => (
      <SkyCover style={[styles.row, { height: rowHeight, marginBottom: ROW_GAP }]}>
        {/* UX-CRASH-01: a poster that throws shows a placeholder in its place; the rest of the grid stays. */}
        {item.items.map((media) => (
          <MobileRenderBoundary key={media.id} name={`library-card:${media.id}`} variant="item" style={{ width: cardWidth, margin: 0 }}>
            {() => <PosterCard item={media} width={cardWidth} onPress={onOpenMedia} showProgress={showProgress} />}
          </MobileRenderBoundary>
        ))}
      </SkyCover>
    ),
    [cardWidth, onOpenMedia, rowHeight, showProgress],
  );

  const refreshControl = pull ? (
    <RefreshControl
      refreshing={pull.refreshing}
      onRefresh={pull.onRefresh}
      tintColor={theme.colors.accent}
      colors={[theme.colors.accent]}
      progressBackgroundColor={theme.colors.surface}
    />
  ) : undefined;

  const showSkeleton = loading && items.length === 0;

  return (
    <FlatList
      data={showSkeleton ? [] : rows}
      keyExtractor={keyExtractor}
      renderItem={renderRow}
      getItemLayout={getItemLayout}
      ListHeaderComponent={(header ?? undefined) as React.ReactElement | undefined}
      ListEmptyComponent={
        showSkeleton ? <PosterGridSkeleton columns={COLUMNS} cardWidth={cardWidth} rows={4} gap={GAP} rowGap={ROW_GAP} /> : ((empty ?? undefined) as React.ReactElement | undefined)
      }
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingBottom: bottomInset, flexGrow: 1 }}
      showsVerticalScrollIndicator={false}
      initialNumToRender={4}
      maxToRenderPerBatch={4}
      updateCellsBatchingPeriod={32}
      windowSize={7}
      removeClippedSubviews
      keyboardShouldPersistTaps="handled"
      {...skyScroll}
    />
  );
});
PosterGrid.displayName = "PosterGrid";

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: GAP },
});
