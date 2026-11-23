import React, { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import {
  createSkyCoverRegistry,
  createUserInputSignal,
  MobileAppBackdrop,
  SkyCoversProvider,
  useMobileSkyMode,
  useSkyRemoteInput,
} from "@space/mobile-shell/components";
import { TV_COLOR } from "./tokens";

export type TvSkyProps = {
  /** Whether the screen is on top: the sky moves and listens to the remote only then (UX-SKY-04). */
  active: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * The family's night sky behind a TV screen (UX-SKY-02, UX-TV-36): the site hero's stars and shooting stars on the night
 * blue, with Badger's glows (amber top left, yellow top right, violet below; `packages/shared` `SKY_NEBULAS.badger`).
 * Remote keys hold it still until the remote is quiet (`useSkyRemoteInput`); it is still while another screen covers this
 * one, and static with the still-sky setting, on a low-RAM box or with reduced motion. Cards inside mark themselves with
 * `SkyCover` so shooting stars pass behind them.
 */
export const TvSky = ({ active, children, style }: TvSkyProps) => {
  const skyMode = useMobileSkyMode();
  const [covers] = useState(createSkyCoverRegistry);
  const [touchInput] = useState(createUserInputSignal);
  const comets = useMemo(() => ({ input: touchInput, covers }), [touchInput, covers]);
  useSkyRemoteInput(covers, active);
  return (
    <SkyCoversProvider value={skyMode === "static" ? null : covers}>
      <View style={[styles.sky, style]}>
        <MobileAppBackdrop paused={!active} comets={comets} />
        {children}
      </View>
    </SkyCoversProvider>
  );
};

const styles = StyleSheet.create({
  sky: { flex: 1, backgroundColor: TV_COLOR.background },
});
