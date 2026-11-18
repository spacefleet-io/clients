// react-native-tvos 0.85 ships its TV typings as a `declare module "react-native"` augmentation inside a file that
// `react-native`'s own index re-exports; TypeScript does not apply it, so the TV-only exports the player's remote
// support uses are declared here (they exist at runtime on react-native-tvos; the phone build never calls them).
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type { View, ViewProps } from "react-native";

declare module "react-native" {
  interface NativeMethods {
    requestTVFocus(): void;
  }

  interface TvHardwareEvent {
    eventType: string;
    eventKeyAction?: number;
  }

  interface TvFocusGuideProps extends ViewProps {
    /** A move into the guide lands on its last focused child (the first one at first). */
    autoFocus?: boolean;
    trapFocusUp?: boolean;
    trapFocusDown?: boolean;
    trapFocusLeft?: boolean;
    trapFocusRight?: boolean;
    /** A move into the guide lands on these views (react-native-tvos `FocusGuideProps.destinations`). */
    destinations?: View[];
  }

  export const useTVEventHandler: (handleEvent: (event: TvHardwareEvent) => void) => void;
  export const TVFocusGuideView: ForwardRefExoticComponent<TvFocusGuideProps & RefAttributes<View>>;
}
