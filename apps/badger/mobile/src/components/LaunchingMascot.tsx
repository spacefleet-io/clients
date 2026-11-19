import React from "react";
import { StyleSheet, View } from "react-native";
import { MobileMascotLoader } from "@space/mobile-shell/mascot-loader";
import { IS_TV } from "../tv/lib/tvRuntime";

const MASCOT = require("../assets/mascot.webp");
const SIZE = IS_TV ? 180 : 120;

/**
 * The hovering badger of the launch screens, at the exact centre of whatever it covers, with its text just under it
 * and no card (UX-WAIT-02, Chris 2026-11-18). The player's pre-first-frame wait and the "Preparing playback…"
 * modal above it both draw it; centred the same way and on the same loop, the two badgers sit on top of each other
 * as one. Decorative: the text stays the status.
 */
export const LaunchingMascot = ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
  <View style={styles.fill} pointerEvents="none" testID={testID}>
    <MobileMascotLoader app="badger" source={MASCOT} size={SIZE} />
    {children ? <View style={styles.text}>{children}</View> : null}
  </View>
);

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  text: { position: "absolute", top: "50%", left: 0, right: 0, marginTop: SIZE / 2 + 12, alignItems: "center", gap: 4, paddingHorizontal: 24 },
});
