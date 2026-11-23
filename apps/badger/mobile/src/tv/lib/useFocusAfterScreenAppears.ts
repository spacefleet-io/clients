import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Platform } from "react-native";
import type { TvViewInstance } from "./tvViewInstance";
import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

/**
 * How long after the hook's request a lost focus still counts as UIKit's own focus update rather than the user's move
 * (TV-SHELL-FOCUS-002: seen 14 ms apart on the Apple TV simulator; nobody presses a remote key within half a second of a
 * screen appearing).
 */
export const SETTLE_MS = 500;

/**
 * Gives the focus back to `ref` once its screen has finished appearing (tvOS only). Returns the `onBlur` handler to pass to
 * the focusable view.
 *
 * `hasTVPreferredFocus` focuses the view while it mounts, but when the screen's view controller then finishes
 * appearing, UIKit runs its own focus update for that controller and lands on the first focusable view on screen
 * (the TV's top tabs), taking the focus away. This re-requests it once, on the screen's first appearance; later
 * appearances (back from a pushed screen) keep the focus UIKit restores. Android keeps the preferred focus as is.
 *
 * UIKit's update and this request race (TV-SHELL-FOCUS-002): when the request lands first, UIKit moves the focus to the
 * tabs right after it. So a blur within SETTLE_MS of the request takes the focus back once more.
 */
export function useFocusAfterScreenAppears(ref: RefObject<TvViewInstance | null>, enabled: boolean): () => void {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const requestedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled || Platform.OS !== "ios") return undefined;
    const unsubscribe = navigation.addListener("transitionEnd", (event) => {
      if (event.data.closing) return;
      unsubscribe();
      requestedAt.current = Date.now();
      console.info("tv.focus.after_appear", JSON.stringify({ step: "request" }));
      ref.current?.requestTVFocus();
    });
    return unsubscribe;
  }, [enabled, navigation, ref]);
  return useCallback(() => {
    const at = requestedAt.current;
    if (at === null) return;
    requestedAt.current = null;
    const sinceMs = Date.now() - at;
    if (sinceMs > SETTLE_MS) return;
    console.info("tv.focus.after_appear", JSON.stringify({ step: "retake", sinceMs }));
    ref.current?.requestTVFocus();
  }, [ref]);
}
