/**
 * The one sideways row a phone page may hold (UX-PHONE-09): every rail of Badger's and Parrot's phone screens is a
 * `MobileRail` (a list) or a `MobileRailScroll` (a few fixed children), so a swipe that starts on a rail scrolls the
 * rail and never the tab pager around the page.
 *
 * What makes the rail win is `nestedScrollEnabled` on its horizontal scroll view. On Android the pager's
 * `ReactHorizontalScrollView` looks, at the finger's first touch, for a nested-scroll-enabled horizontal scroll view
 * under it; when it finds one it lets the whole gesture go (it never starts tracking that pointer), so the rail keeps
 * the swipe to the end, even once it has reached its last item, and the page never flips mid-gesture. Without the
 * flag the pager takes the swipe as soon as it moves sideways. On iOS the deepest scroll view's pan wins on its own.
 * A swipe that starts outside a rail still moves the pager, and a vertical swipe still scrolls the page.
 *
 * The flag is applied after the caller's props, so no screen can turn it off.
 */
import React from "react";
import { FlatList, ScrollView, type FlatListProps, type ScrollViewProps } from "react-native";

/** The props that make a sideways row keep its own swipe; applied last on every rail. */
export const MOBILE_RAIL_SCROLL = { horizontal: true, nestedScrollEnabled: true, showsHorizontalScrollIndicator: false } as const;

type RailOwned = keyof typeof MOBILE_RAIL_SCROLL;

export type MobileRailProps<T> = Omit<FlatListProps<T>, RailOwned>;

/** A virtualised sideways row (posters, album tiles, artists). */
export const MobileRail = <T,>(props: MobileRailProps<T>) => <FlatList<T> {...props} {...MOBILE_RAIL_SCROLL} />;

export type MobileRailScrollProps = Omit<ScrollViewProps, RailOwned>;

/** A sideways row of a few fixed children (chips, season picker, cast). */
export const MobileRailScroll = (props: MobileRailScrollProps) => <ScrollView {...props} {...MOBILE_RAIL_SCROLL} />;
