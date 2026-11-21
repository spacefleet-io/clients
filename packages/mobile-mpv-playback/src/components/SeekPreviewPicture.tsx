import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { previewPictureLayout, type SeekPreviewFrame } from "../seekPreview";
import { scaleStyle, scaleStyleSheet } from "@space/shared/uiScale";

/**
 * The seek-bar preview picture (MPV-PREV-01), drawn above the bar: one picture clipped out of its sheet, with the time it
 * shows underneath. `left` is from the bar's left edge; `bottom` lifts it over the bar (both on screen). `displayWidth`
 * is in design dp: the picture, its frame and its time are drawn at `uiScale` (UX-TV-13; default 1).
 */
export const SeekPreviewPicture = ({ frame, displayWidth, uiScale = 1, left, bottom, time, borderColor }: {
  frame: SeekPreviewFrame;
  displayWidth: number;
  uiScale?: number;
  left: number;
  bottom: number;
  time: string;
  borderColor: string;
}) => {
  const layout = scaleStyle(previewPictureLayout(frame, displayWidth), uiScale);
  const styles = scaleStyleSheet(baseStyles, uiScale);
  return (
    <View testID="player-seek-preview" pointerEvents="none" style={[styles.wrap, { left, bottom, width: layout.box.width }]}>
      <View
        testID="player-seek-preview-picture"
        style={[styles.box, { width: layout.box.width, height: layout.box.height, borderColor }]}
      >
        <Image source={{ uri: frame.uri }} resizeMode="stretch" fadeDuration={0} style={[styles.sheet, layout.image]} />
      </View>
      <Text style={styles.time}>{time}</Text>
    </View>
  );
};

const baseStyles = StyleSheet.create({
  wrap: { position: "absolute", alignItems: "center" },
  box: { overflow: "hidden", borderWidth: 1, borderRadius: 6, backgroundColor: "#000" },
  sheet: { position: "absolute" },
  time: {
    marginTop: 4, color: "#fff", fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"],
    textShadowColor: "rgba(0, 0, 0, 0.8)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
});
