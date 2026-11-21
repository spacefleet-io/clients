// How a form with text fields keeps clear of the on-screen keyboard, shared by Badger and Parrot.
//
// - iOS: React Native's `KeyboardAvoidingView` with "padding" lifts the form.
// - Android 15 (API 35) and later: an app built for Android 15+ (target SDK 35+) is drawn edge to edge, so the window
//   no longer shrinks for the keyboard (`adjustResize` does nothing). `KeyboardAvoidingView` cannot stand in there: its
//   "keyboard hidden" event reports the keyboard at the top of the screen, so "padding" or "height" squeezed the whole
//   form out of sight once the keyboard closed. The form instead takes the keyboard's height as bottom padding while
//   the keyboard is up, and none once it is down; the form's scroll view then keeps the focused field in sight.
// - Older Android: the window still shrinks for the keyboard, so the form does nothing (lifting it too moved it twice).
import React, { useEffect, useState, type ReactNode } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, View, type KeyboardEvent, type StyleProp, type ViewStyle } from "react-native";

const FIRST_EDGE_TO_EDGE_API = 35;

export type KeyboardLift = "avoiding-view" | "keyboard-inset" | "window-resize";

/** Which way this phone keeps a form above the keyboard. */
export const keyboardLiftFor = (os: string, version: string | number): KeyboardLift => {
  if (os === "ios") return "avoiding-view";
  if (os === "android" && Number(version) >= FIRST_EDGE_TO_EDGE_API) return "keyboard-inset";
  return "window-resize";
};

/** The bottom padding after a keyboard event: the keyboard's height while it is shown, none once it is hidden. */
export const keyboardInsetAfter = (shown: boolean, event?: Pick<KeyboardEvent, "endCoordinates">): number =>
  shown ? Math.max(0, event?.endCoordinates.height ?? 0) : 0;

/** The on-screen keyboard's height while `active` and the keyboard is shown, else 0. */
export const useKeyboardInset = (active: boolean): number => {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const subscriptions = [
      Keyboard.addListener("keyboardDidShow", (event) => setInset(keyboardInsetAfter(true, event))),
      Keyboard.addListener("keyboardDidHide", () => setInset(keyboardInsetAfter(false))),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [active]);
  return active ? inset : 0;
};

/** True while the on-screen keyboard is shown (the phone shell hides its tab bar then). */
export const useKeyboardOpen = (): boolean => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const subscriptions = [
      Keyboard.addListener("keyboardDidShow", () => setOpen(true)),
      Keyboard.addListener("keyboardDidHide", () => setOpen(false)),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);
  return open;
};

/** Wraps a form (usually its scroll view and buttons) so its fields stay above the on-screen keyboard. */
export const KeyboardAvoidingForm = ({
  style,
  iosOffset,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  /** Height of anything above the form on iOS (a navigation header) that the keyboard maths must skip. */
  iosOffset?: number;
  children: ReactNode;
}) => {
  const lift = keyboardLiftFor(Platform.OS, Platform.Version);
  const inset = useKeyboardInset(lift === "keyboard-inset");
  if (lift === "avoiding-view") {
    return (
      <KeyboardAvoidingView style={style} behavior="padding" keyboardVerticalOffset={iosOffset}>
        {children}
      </KeyboardAvoidingView>
    );
  }
  return <View style={[style, { paddingBottom: inset }]}>{children}</View>;
};
