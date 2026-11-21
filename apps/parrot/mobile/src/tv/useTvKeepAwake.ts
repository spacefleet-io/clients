// PAR-TV-12: while `on` (Now playing or the lyrics on top, `tvPageKeepsAwake`) the TV stays awake as during a film;
// otherwise its screensaver starts as usual and the music plays on under it. The system drops the hold while the app is
// in the background, so the screensaver also starts there.
import { useEffect } from "react";
import { AudioPlayback } from "@space/mobile-audio-playback";
import { scopeLogger } from "@space/mobile-shell/logger";

const log = scopeLogger("parrot.tv.awake");

const apply = (on: boolean) => {
  AudioPlayback.setKeepScreenOn(on)
    .then((applied) => log.info("keep_awake", { on, applied }))
    .catch((error: unknown) => log.warn("keep_awake_failed", { on, message: error instanceof Error ? error.message : String(error) }));
};

export const useTvKeepAwake = (on: boolean): void => {
  useEffect(() => {
    if (!on) return undefined;
    apply(true);
    return () => apply(false);
  }, [on]);
};
