import type { ComponentProps } from "react";
import type { TVFocusGuideView, ViewInstance } from "react-native";

/**
 * A mounted react-native-tvos View (or Pressable): its native element, which react-native-tvos extends at runtime with
 * `requestTVFocus()`. React Native's TypeScript API (the default since 0.87) types a View ref as the bare element.
 */
export type TvViewInstance = ViewInstance & { requestTVFocus(): void };

type FocusDestinations = NonNullable<ComponentProps<typeof TVFocusGuideView>["destinations"]>;

/**
 * `TVFocusGuideView`'s `destinations` for one mounted view, or none. react-native-tvos types the entries as
 * `ComponentRef<ElementType>`, which no mounted view matches, while at runtime it takes exactly these views.
 */
export const focusDestination = (view: TvViewInstance | null): FocusDestinations | undefined =>
  view ? ([view] as unknown as FocusDestinations) : undefined;
