import React, { memo, useCallback } from "react";
import { StyleSheet } from "react-native";
import type { MediaRow } from "@space/shared/libraryTypes";
import { MobileHomeRail } from "@space/mobile-shell/components";
import { PosterCard, posterCardHeight } from "./PosterCard";
import { theme } from "../theme/theme";

const keyOf = (item: MediaRow) => item.id;

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

/** A Home row of posters, straight on the sky (no panel): the shell's titled rail (UX-PHONE-01, UX-PHONE-09). */
export const PosterRail = memo(({ title, items, cardWidth, onOpenMedia, showProgress, seeAll, testID }: PosterRailProps) => {
  const renderItem = useCallback(
    (item: MediaRow) => <PosterCard item={item} width={cardWidth} onPress={onOpenMedia} showProgress={showProgress} />,
    [cardWidth, onOpenMedia, showProgress],
  );
  return (
    <MobileHomeRail
      title={title}
      items={items}
      keyOf={keyOf}
      renderItem={renderItem}
      itemWidth={cardWidth}
      rowHeight={posterCardHeight(cardWidth)}
      snap
      seeAll={seeAll}
      boundaryName="home-card"
      testID={testID}
      titleStyle={styles.title}
      seeAllStyle={styles.seeAll}
    />
  );
});
PosterRail.displayName = "PosterRail";

const styles = StyleSheet.create({
  title: { color: theme.colors.text, fontFamily: theme.font.family.display },
  seeAll: { color: theme.colors.textMuted },
});
