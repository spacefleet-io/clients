/**
 * Renderer access to THIS computer's "fallback 360p copy" value (#25). The
 * value lives in main (`<userData>/device-settings.json`, main/deviceSettings.ts)
 * and main enforces it on every ingest submit; the renderer reads it to show
 * Settings → Transcoding and to make the ingest preview match.
 */
import { useCallback, useEffect, useState } from "react";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "transcode-default" });

/**
 * `value`: undefined = no device-settings bridge (web build / tests),
 * null = still loading, else this computer's value.
 */
export const useDeviceFallbackCopy = (source: string) => {
  const [value, setValue] = useState<boolean | null | undefined>(() =>
    window.sf?.deviceSettings ? null : undefined,
  );

  useEffect(() => {
    const bridge = window.sf?.deviceSettings;
    if (!bridge) return;
    let cancelled = false;
    bridge
      .getTranscode()
      .then((stored) => {
        if (cancelled) return;
        log.info(
          { source, fallbackCopy: stored.fallbackCopy, answered: stored.answered, answer: stored.answer },
          "[transcode-default] loaded this computer's value",
        );
        setValue(stored.fallbackCopy);
      })
      .catch((err: unknown) => {
        log.error({ source, err: String(err) }, "[transcode-default] could not read this computer's value");
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const set = useCallback(
    (next: boolean) => {
      const bridge = window.sf?.deviceSettings;
      if (!bridge) return;
      const previous = value;
      setValue(next);
      log.info({ source, from: previous, to: next }, "[transcode-default] change requested");
      bridge
        .setFallbackCopy(next)
        .then((stored) => setValue(stored.fallbackCopy))
        .catch((err: unknown) => {
          log.error({ source, err: String(err), to: next }, "[transcode-default] could not save this computer's value");
          setValue(previous);
        });
    },
    [source, value],
  );

  return { value, set };
};
