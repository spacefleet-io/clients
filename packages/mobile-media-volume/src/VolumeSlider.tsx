// A horizontal slider (0..1) for touch screens: tap or drag anywhere on the track, and the screen reader's swipe up /
// down steps it. The app passes its own colours (Parrot: its green accent).
import React, { useRef, useState } from "react";
import { PanResponder, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { levelAt, percentOf, stepLevel } from "./level";

export type VolumeSliderColors = { fill: string; track: string; thumb: string };

export type VolumeSliderProps = {
  value: number;
  /** `drag` while the finger moves, `end` on release, tap or accessibility step. */
  onChange: (level: number, phase: "drag" | "end") => void;
  colors: VolumeSliderColors;
  accessibilityLabel: string;
  /** Fraction moved by one accessibility increment (default 1/15, Android's media volume step on most phones). */
  step?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const THUMB = 18;

export const VolumeSlider = ({ value, onChange, colors, accessibilityLabel, step = 1 / 15, style, testID }: VolumeSliderProps) => {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const startX = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // A horizontal drag stays on the slider even inside a scroll view or a swipe-to-dismiss screen.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        startX.current = event.nativeEvent.locationX;
        onChangeRef.current(levelAt(startX.current, widthRef.current), "drag");
      },
      onPanResponderMove: (_, gesture) => onChangeRef.current(levelAt(startX.current + gesture.dx, widthRef.current), "drag"),
      onPanResponderRelease: (_, gesture) => onChangeRef.current(levelAt(startX.current + gesture.dx, widthRef.current), "end"),
      onPanResponderTerminate: (_, gesture) => onChangeRef.current(levelAt(startX.current + gesture.dx, widthRef.current), "end"),
    }),
  ).current;

  const onLayout = (event: LayoutChangeEvent) => {
    widthRef.current = event.nativeEvent.layout.width;
    setWidth(event.nativeEvent.layout.width);
  };
  const filled = Math.max(0, Math.min(1, value)) * width;

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: percentOf(value), text: `${percentOf(value)} %` }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) =>
        onChange(stepLevel(value, event.nativeEvent.actionName === "increment" ? 1 : -1, step), "end")
      }
      onLayout={onLayout}
      hitSlop={{ top: 12, bottom: 12 }}
      style={[styles.hit, style]}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={[styles.track, { backgroundColor: colors.track }]}>
        <View style={[styles.fill, { width: filled, backgroundColor: colors.fill }]} />
      </View>
      <View
        pointerEvents="none"
        style={[styles.thumb, { left: Math.max(0, filled - THUMB / 2), backgroundColor: colors.thumb }]}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  hit: { height: 32, justifyContent: "center" },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4 },
  thumb: { position: "absolute", width: THUMB, height: THUMB, borderRadius: THUMB / 2, top: (32 - THUMB) / 2 },
});
