import React, { useEffect, useState } from "react";
import { AppState, Platform, requireNativeComponent, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { loadSourceInBackground } from "../backgroundSource";
import { MpvControl } from "../MpvControl";
import { createSubPosLift } from "../subtitleLift";
import { configureTvAudioOutput } from "../tvAudioOutput";
import { MpvSubtitleLayer } from "./MpvSubtitleOverlay";

export type MpvSurfaceTapEvent = {
  nativeEvent: {
    x: number;
    y: number;
    surfaceWidth: number;
    surfaceHeight: number;
  };
};

export type MpvPlayerProps = {
  /** Master.m3u8 URL returned by `PlaybackBridge.startProxy(...)`. */
  source?: string | null;
  /** Per-file mpv options for the initial load, e.g. `start=123.4,vid=2`. */
  startOptions?: string | null;
  style?: StyleProp<ViewStyle>;
  onSurfaceTap?: (event: MpvSurfaceTapEvent) => void;
  /**
   * Distance (dp) from the bottom of the player box up to the top of the player controls while they show, 0 while they
   * are hidden (`PlayerControls` `onControlsBottomInset`). Subtitles move above it (MPV-OSC-02); 0 = never moved.
   */
  controlsInset?: number;
  /** The controls' `uiScale` (`PlayerControls`, UX-TV-13): multiplies the gap kept between subtitles and controls. Default 1. */
  uiScale?: number;
};

// View name is registered by MpvSurfaceViewManager in the autolinked
// android module — see com.spacefleet.mpvplayback.mpv.MpvSurfaceViewManager.
const NativeMpvView = requireNativeComponent<MpvPlayerProps>("MpvPlayerView");

/**
 * The video surface, plus the subtitle line the app draws over it while mpv renders straight from the hardware
 * decoder (Android TV, PLAT-TV-06), where mpv draws none itself. `style` sizes the whole player box. While
 * `controlsInset` is set, subtitles sit above the controls (MPV-OSC-02): the app-drawn line moves up, and mpv's own
 * subtitles (`vo=gpu`, Apple TV) through `sub-pos`.
 */
export const MpvPlayer = ({ source, startOptions, style, onSurfaceTap, controlsInset = 0, uiScale = 1 }: MpvPlayerProps) => {
  const [boxHeight, setBoxHeight] = useState(0);
  const [subPosLift] = useState(() => createSubPosLift(MpvControl));
  // TV: which formats go to the receiver untouched and how many channels decoded sound uses, from the box's audio sink
  // (MPV-TV-03), read again per player so a receiver plugged in since the last one counts. Phones keep mpv's defaults.
  useEffect(() => {
    if (Platform.isTV) void configureTvAudioOutput(MpvControl);
  }, []);
  useEffect(() => {
    void subPosLift.update({ boxHeight, controlsInset, scale: uiScale });
  }, [subPosLift, boxHeight, controlsInset, uiScale]);
  // PLAY-OSMEDIA-01 item 4: a source picked from the lock screen or the notification while the app is in the background
  // plays now; React Native would hold the prop below until the app is back in front.
  useEffect(() => {
    void loadSourceInBackground(MpvControl, {
      source,
      startOptions,
      appState: AppState.currentState,
      platformOs: Platform.OS,
      isTv: Platform.isTV === true,
    });
  }, [source, startOptions]);
  return (
    <View style={style} pointerEvents="box-none" onLayout={(e) => setBoxHeight(e.nativeEvent.layout.height)}>
      <NativeMpvView
        source={source ?? undefined}
        startOptions={startOptions ?? undefined}
        style={StyleSheet.absoluteFill}
        onSurfaceTap={onSurfaceTap}
      />
      <MpvSubtitleLayer boxHeight={boxHeight} controlsInset={controlsInset} uiScale={uiScale} />
    </View>
  );
};
