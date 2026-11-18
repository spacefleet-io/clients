import { useEffect, useState } from "react";
import { DeviceEventEmitter, Platform } from "react-native";
import {
  MPV_SUBTITLE_EVENT,
  type MpvSubtitleEvent,
  sameSubtitleOverlay,
  subtitleOverlayModel,
  type SubtitleOverlayModel,
} from "../subtitleOverlay";

/** The part of `DeviceEventEmitter` the subscription needs. */
export type SubtitleEventSource = {
  addListener: (event: string, handler: (payload: MpvSubtitleEvent) => void) => { remove: () => void };
};

/**
 * Listens to the native `MpvSubtitle` event and reports the overlay to draw, only when it changes (one call per
 * subtitle line at most, never per frame — PLAT-TV-07). Returns the unsubscribe.
 */
export const subscribeMpvSubtitles = (
  source: SubtitleEventSource,
  onChange: (model: SubtitleOverlayModel | null) => void,
): (() => void) => {
  let current: SubtitleOverlayModel | null = null;
  let directRender: boolean | null = null;
  let visible: boolean | null = null;
  let lines = 0;
  const subscription = source.addListener(MPV_SUBTITLE_EVENT, (event) => {
    if (event.directRender !== directRender || event.visible !== visible) {
      directRender = event.directRender;
      visible = event.visible;
      console.info(
        `[mpv-subtitles] state directRender=${event.directRender} visible=${event.visible} ` +
          `rect=${event.x},${event.y} ${event.width}x${event.height}`,
      );
    }
    const next = subtitleOverlayModel(event);
    if (sameSubtitleOverlay(current, next)) return;
    current = next;
    if (next) {
      lines += 1;
      // Proof on a box whose screen capture hides the video plane: the first lines, then one in 25 (length only).
      if (lines <= 3 || lines % 25 === 0) console.info(`[mpv-subtitles] line n=${lines} chars=${event.text?.length ?? 0}`);
    }
    onChange(next);
  });
  return () => subscription.remove();
};

/**
 * The subtitle line the app draws over the video while mpv renders straight from the hardware decoder (Android TV,
 * PLAT-TV-06). `null` when nothing is to be drawn: subtitles off, between lines, or mpv drawing them itself.
 */
export const useMpvSubtitle = (): SubtitleOverlayModel | null => {
  const [model, setModel] = useState<SubtitleOverlayModel | null>(null);
  useEffect(() => {
    // Only the Android view emits the event; elsewhere mpv draws its own subtitles.
    if (Platform.OS !== "android") return;
    return subscribeMpvSubtitles(DeviceEventEmitter, setModel);
  }, []);
  return model;
};
