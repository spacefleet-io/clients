// Parrot's sky behind its phone screens (UX-SKY-01, PAR-LOOK-01): the theme's green nebula, the star field and the idle
// shooting star of the shared `MobileAppBackdrop`. The star never flies while music plays (the playback mark), while
// the screen is covered by another one, or over the opaque blocks the screen registers with `SkyCover`.
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  MobileAppBackdrop,
  SkyCoversProvider,
  createSkyCoverRegistry,
  createUserInputSignal,
  useMobileSkyMode,
} from "@space/mobile-shell/components";
import { usePlayerState } from "../state/usePlayerState";
import { colors } from "../theme";

/** The player's teal wash over the sky (the approved player picture). */
export const PLAYER_TINT = "rgba(28, 140, 128, 0.16)";

export const ParrotSky = ({ tint, children }: { tint?: string; children: React.ReactNode }) => {
  const [input] = useState(createUserInputSignal);
  const [covers] = useState(createSkyCoverRegistry);
  const skyMode = useMobileSkyMode();
  const focused = useIsFocused();
  const playing = usePlayerState(1000)?.playing ?? false;
  const comets = useMemo(() => ({ input, covers }), [input, covers]);
  return (
    <SkyCoversProvider value={skyMode === "static" ? null : covers}>
      <View style={styles.fill} {...input.touchHandlers}>
        <MobileAppBackdrop paused={playing || !focused} comets={comets} />
        {tint ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} /> : null}
        {children}
      </View>
    </SkyCoversProvider>
  );
};

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: colors.bg } });
