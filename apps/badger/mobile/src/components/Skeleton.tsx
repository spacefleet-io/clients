import React, { memo } from "react";
import { StyleSheet, View } from "react-native";
import { MobileSkeletonBlock, MobileSkeletonPulse, SkyCover } from "@space/mobile-shell/components";
import { POSTER_ASPECT, POSTER_FOOTER_HEIGHT } from "./PosterCard";

/** Placeholder poster tiles in the exact geometry of `PosterCard`. */
const PosterTileSkeleton = memo(({ width }: { width: number }) => (
  <View style={{ width }}>
    <MobileSkeletonBlock width={width} height={Math.round(width * POSTER_ASPECT)} radius={12} />
    <MobileSkeletonBlock width="70%" height={10} radius={5} style={styles.titleLine} />
  </View>
));
PosterTileSkeleton.displayName = "PosterTileSkeleton";

export const PosterGridSkeleton = memo(
  ({ columns, cardWidth, rows = 3, gap, rowGap = gap }: { columns: number; cardWidth: number; rows?: number; gap: number; rowGap?: number }) => (
  <MobileSkeletonPulse style={{ gap: rowGap }}>
    {Array.from({ length: rows }, (_, row) => (
      <SkyCover key={row} style={[styles.row, { gap, height: Math.round(cardWidth * POSTER_ASPECT) + POSTER_FOOTER_HEIGHT }]}>
        {Array.from({ length: columns }, (_, col) => (
          <PosterTileSkeleton key={col} width={cardWidth} />
        ))}
      </SkyCover>
    ))}
  </MobileSkeletonPulse>
  ),
);
PosterGridSkeleton.displayName = "PosterGridSkeleton";

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  titleLine: { marginTop: 12 },
});
