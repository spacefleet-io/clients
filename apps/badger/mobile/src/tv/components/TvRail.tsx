import React, { memo } from "react";
import type { MediaRow } from "@space/shared/libraryTypes";
import { TvCardRow } from "@space/mobile-shell/tv/TvCardRow";
import { useTvScale } from "@space/mobile-shell/tv/tvScale";
import { TV_SPACE } from "../ui/tokens";
import { TvPosterCard, tvPosterCardHeight } from "./TvPosterCard";

const keyOf = (item: MediaRow) => item.id;

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
 * One Home row of posters straight on the sky (UX-TV-05, UX-TV-11, mockup `.rows`): the family's `TvCardRow`
 * (TV-RAIL-FOCUS-001) with Badger's posters, no "See all" and no count.
 */
export const TvRail = memo(({ title, items, cardWidth, onOpenMedia, showProgress, preferredFocusIndex = null, titleTestID }: TvRailProps) => {
  const scale = useTvScale();
  return (
    <TvCardRow
      title={title}
      items={items}
      keyOf={keyOf}
      cardWidth={cardWidth}
      cardHeight={tvPosterCardHeight(cardWidth, scale)}
      gap={TV_SPACE.posterGap}
      titleTestID={titleTestID}
      renderCard={(item, index, onFocus) => (
        <TvPosterCard item={item} width={cardWidth} onPress={onOpenMedia} showProgress={showProgress} hasTVPreferredFocus={index === preferredFocusIndex} onFocusItem={onFocus} />
      )}
    />
  );
});
TvRail.displayName = "TvRail";
