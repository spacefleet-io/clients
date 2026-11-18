/**
 * React wiring for PLAY-OSMEDIA-01, shared by every browser-based player (the Electron renderers and the web players):
 * one binder on the page's own media session for as long as the player is mounted, updated whenever the player state
 * changes, released on unmount. `keepAlive` adds the silent audio element a player needs when its media plays outside
 * the page (Badger desktop's external mpv), so Chromium still holds a session to show.
 */
import { useEffect, useRef, useState } from "react";
import { browserMediaSession, createMediaSessionBinder, type MediaSessionHandlers } from "./browser";
import { createSilentKeepAlive, type AudioElementLike } from "./keepAlive";
import type { MediaSessionState } from "./plan";

export type UseMediaSessionOptions = {
  /** Loop a silent audio element while playing: for players whose media plays outside the page. */
  keepAlive?: boolean;
  log?: (message: string, detail?: Record<string, unknown>) => void;
};

type Session = { update(state: MediaSessionState): void; release(): void };

const defaultLog = (message: string, detail?: Record<string, unknown>) =>
  // eslint-disable-next-line no-console -- intentional media-session diagnostic (keep-diagnostic-logs)
  console.info(`[media-session] ${message}`, detail ?? {});

const createSession = (handlers: () => MediaSessionHandlers, options: UseMediaSessionOptions): Session | null => {
  const log = options.log ?? defaultLog;
  const browser = browserMediaSession();
  if (!browser) {
    log("navigator.mediaSession unavailable: OS media controls off");
    return null;
  }
  const binder = createMediaSessionBinder({ ...browser, handlers, log });
  if (!options.keepAlive) return binder;
  // The page's own `Audio`, read through `globalThis` as the package has no DOM lib.
  const AudioElement = Reflect.get(globalThis, "Audio") as
    | (new () => AudioElementLike & { dataset?: Record<string, string> })
    | undefined;
  if (typeof AudioElement !== "function") {
    log("Audio unavailable: OS media controls off");
    return binder;
  }
  const keepAlive = createSilentKeepAlive({
    createAudio: () => {
      const audio = new AudioElement();
      if (audio.dataset) audio.dataset.testid = "os-media-keepalive";
      return audio;
    },
    createUrl: (wav) => URL.createObjectURL(new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" })),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    log,
  });
  return {
    update(state) {
      if (state.status === "none") {
        binder.release();
        keepAlive.set("none");
        return;
      }
      // The element first: Chromium creates the session when audible media plays, then takes the metadata.
      keepAlive.set(state.status);
      binder.update(state);
    },
    release() {
      binder.release();
      keepAlive.dispose();
    },
  };
};

/** Hands the player to the OS media controls while mounted; `status: "none"` releases the session. */
export const useMediaSession = (
  state: MediaSessionState,
  handlers: MediaSessionHandlers,
  options: UseMediaSessionOptions = {}
): void => {
  const session = useRef<Session | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;
  const { keepAlive = false } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const created = createSession(() => latest.current, { ...optionsRef.current, keepAlive });
    session.current = created;
    created?.update(stateRef.current);
    return () => {
      session.current = null;
      created?.release();
    };
  }, [keepAlive]);

  const { status, info, positionS, durationS, rate, canNext, canPrevious, canSeek } = state;
  useEffect(() => {
    session.current?.update({ status, info, positionS, durationS, rate, canNext, canPrevious, canSeek });
    // `info` is rebuilt every render; its fields are the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, info?.title, info?.artist, info?.album, info?.artworkUrl, positionS, durationS, rate, canNext, canPrevious, canSeek]);
};

/**
 * A local artwork URL (`blob:` of a decrypted cover or poster, or a `data:` image) for `key`, resolved asynchronously;
 * null while it resolves, when it fails, or for another key.
 */
export const useLocalArtwork = (
  key: string | null | undefined,
  resolve: (key: string) => Promise<string | null>
): string | null => {
  const [artwork, setArtwork] = useState<{ key: string; url: string | null } | null>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void resolveRef
      .current(key)
      .catch(() => null)
      .then((url) => {
        if (!cancelled) setArtwork({ key, url });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return key && artwork?.key === key ? artwork.url : null;
};
