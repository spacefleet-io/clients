import { useEffect, useRef } from "react";
import type { MediaSessionHandlers, MediaSessionState } from "@space/media-session";
import { createNativeMediaSessionBinder, type NativeMediaSessionBinder } from "@space/mobile-media-session";

const log = (message: string, detail?: Record<string, unknown>) => console.info(message, JSON.stringify(detail ?? {}));

/**
 * Hands what plays to the phone's notification-shade and lock-screen card and its headset buttons (PLAY-OSMEDIA-01):
 * every `state` change updates the card, a `none` state or unmount releases it. `handlers` are read at press time.
 */
export const useOsMediaSession = (state: MediaSessionState, handlers: MediaSessionHandlers, enabled = true) => {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const binderRef = useRef<NativeMediaSessionBinder | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const binder = createNativeMediaSessionBinder({ handlers: () => handlersRef.current, log });
    binderRef.current = binder;
    return () => {
      binder.release();
      binderRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    binderRef.current?.update(state);
  }, [state]);
};
