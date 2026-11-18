/**
 * React side of the sky's scroll hold (UX-SKY-01, see `mobile-sky-covers.ts`):
 * the shell frame provides one registry and `useSkyScroll` reports a scroll in
 * motion so the sky holds still.
 *
 * `SkyCover` and `SkyRegion` used to measure opaque blocks so the shooting star
 * flew around them. Like the site's hero (UX-SKY-02), shooting stars now fly
 * anywhere and pass behind opaque content: both are plain Views, kept because
 * many screens wrap their panels in them.
 */
import { createContext, useContext, useEffect, useMemo } from "react";
import { View } from "react-native";
import { createSkyScrollHandlers, type SkyCoverRegistry, type SkyScrollHandlers } from "./mobile-sky-covers";

const SkyCoversContext = createContext<SkyCoverRegistry | null>(null);

export const SkyCoversProvider = SkyCoversContext.Provider;

/** The registry of the enclosing shell frame, or null outside one (scrolls then hold nothing). */
export const useSkyCovers = (): SkyCoverRegistry | null => useContext(SkyCoversContext);

/** An opaque block of the screen (panel, poster row, banner): a plain View. */
export const SkyCover = View;

/** A container of covered blocks: a plain View. */
export const SkyRegion = View;

const NO_SCROLL_HANDLERS: Partial<SkyScrollHandlers> = {};

/** Spread on a ScrollView / FlatList: a drag or momentum in motion holds the sky still. */
export const useSkyScroll = (): Partial<SkyScrollHandlers> => {
  const covers = useSkyCovers();
  const handlers = useMemo(() => (covers ? createSkyScrollHandlers(covers) : NO_SCROLL_HANDLERS), [covers]);
  // A list that unmounts mid-scroll never reports its end: release it so the sky is not held for good.
  useEffect(() => () => handlers.onScrollEndDrag?.(), [handlers]);
  return handlers;
};
