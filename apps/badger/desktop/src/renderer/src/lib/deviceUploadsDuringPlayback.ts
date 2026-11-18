/**
 * Renderer access to THIS computer's "uploads while a video plays" value (#25,
 * Chris 2026-10-13): full / throttle / pause. The value lives in main
 * (`<userData>/device-settings.json`, main/deviceSettings.ts); a change made in
 * Settings is sent to the runtime at once, even while a video is playing.
 */
import { useCallback, useEffect, useState } from "react";
import { rendererLogger } from "@/logger";
import type { UploadsDuringPlayback } from "../../../shared/uploadPlaybackDefault";

const log = rendererLogger.child({ scope: "uploads-playback-default" });

/**
 * `value`: undefined = no device-settings bridge for this setting (web build /
 * tests / older preload), null = still loading, else this computer's value.
 */
export const useDeviceUploadsDuringPlayback = (source: string) => {
  const [value, setValue] = useState<UploadsDuringPlayback | null | undefined>(() =>
    window.sf?.deviceSettings?.getUploadsDuringPlayback ? null : undefined,
  );

  useEffect(() => {
    const bridge = window.sf?.deviceSettings;
    if (!bridge?.getUploadsDuringPlayback) return;
    let cancelled = false;
    bridge
      .getUploadsDuringPlayback()
      .then((stored) => {
        if (cancelled) return;
        log.info(
          { source, mode: stored.mode, answered: stored.answered, answer: stored.answer },
          "[uploads-playback-default] loaded this computer's value",
        );
        setValue(stored.mode);
      })
      .catch((err: unknown) => {
        log.error({ source, err: String(err) }, "[uploads-playback-default] could not read this computer's value");
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const set = useCallback(
    (next: UploadsDuringPlayback) => {
      const bridge = window.sf?.deviceSettings;
      if (!bridge?.setUploadsDuringPlayback) return;
      const previous = value;
      setValue(next);
      log.info({ source, from: previous, to: next }, "[uploads-playback-default] change requested");
      bridge
        .setUploadsDuringPlayback(next)
        .then((stored) => setValue(stored.mode))
        .catch((err: unknown) => {
          log.error({ source, err: String(err), to: next }, "[uploads-playback-default] could not save this computer's value");
          setValue(previous);
        });
    },
    [source, value],
  );

  return { value, set };
};
