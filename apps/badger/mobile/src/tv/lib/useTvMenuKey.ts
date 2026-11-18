import { useEffect } from "react";
import * as ReactNative from "react-native";
import { Platform } from "react-native";
import { createMenuKeyHolds } from "./menuKey";

// react-native-tvos ships TVEventControl at runtime (Libraries/Components/TV/TVEventControl, exported from index.js), but its
// type augmentation (types/public/ReactNativeTVTypes.d.ts) does not reach this package's `react-native` module type.
type TvEventControl = {
  enableTVMenuKey(): void;
  disableTVMenuKey(): void;
  /** Only some react-native-tvos versions ship the pan switch: callers check before use. */
  enableTVPanGesture?: () => void;
  disableTVPanGesture?: () => void;
};
export const tvEventControl = (): TvEventControl | undefined =>
  (ReactNative as unknown as { TVEventControl?: TvEventControl }).TVEventControl;

/**
 * The app's one menu-key registry (see `menuKey.ts`). Only Apple TV has the native switch: on Android TV Back is always
 * delivered, so the control is a no-op there.
 */
const holds = createMenuKeyHolds(
  {
    enable: () => {
      if (Platform.isTV && Platform.OS === "ios") tvEventControl()?.enableTVMenuKey();
    },
    disable: () => {
      if (Platform.isTV && Platform.OS === "ios") tvEventControl()?.disableTVMenuKey();
    },
  },
  (event, payload) => {
    if (Platform.isTV) console.info(event, JSON.stringify(payload));
  },
);

/** Hold or release the Menu key for `reason` (outside React, e.g. from the navigation container's state callback). */
export const setTvMenuKeyHold = (reason: string, active: boolean): void => holds.set(reason, active);

/** While `active`, the screen that calls this wants Menu delivered as Back (it has something to go back to). */
export const useTvMenuKeyHold = (reason: string, active: boolean): void => {
  useEffect(() => {
    holds.set(reason, active);
    return () => holds.set(reason, false);
  }, [reason, active]);
};
