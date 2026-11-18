/**
 * Silent keep-alive for players whose sound does not come from the page
 * (Badger desktop: video plays in an external mpv). Chromium only creates a
 * media session (MPRIS / SMTC / Now Playing) for an audible media element that
 * is playing, so the renderer loops a silent, unmuted WAV while mpv plays,
 * pauses it while mpv is paused (the session stays, the keys can resume) and
 * unloads it when mpv stops (the session is released). PLAY-OSMEDIA-01 item 3.
 */

/**
 * Builds a silent PCM WAV (8-bit unsigned mono, silence = 0x80). Longer than
 * five seconds because Chromium ignores shorter clips for media controls.
 */
export const silentWav = (seconds = 6, sampleRate = 8000): Uint8Array => {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate = rate * channels * 1 byte
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(0x80, 44);
  return bytes;
};

export interface AudioElementLike {
  src: string;
  loop: boolean;
  muted: boolean;
  volume: number;
  readonly paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}

export interface SilentKeepAliveOptions {
  createAudio: () => AudioElementLike;
  /** Returns an object URL for the WAV bytes (`URL.createObjectURL(new Blob([...]))`). */
  createUrl: (wav: Uint8Array) => string;
  revokeUrl?: (url: string) => void;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export type KeepAliveStatus = "playing" | "paused" | "none";

export interface SilentKeepAlive {
  /** Mirrors the external player: playing claims the session, paused keeps it, none releases it. */
  set(status: KeepAliveStatus): void;
  readonly status: KeepAliveStatus;
  dispose(): void;
}

export const createSilentKeepAlive = (options: SilentKeepAliveOptions): SilentKeepAlive => {
  let audio: AudioElementLike | null = null;
  let url: string | null = null;
  let status: KeepAliveStatus = "none";

  const ensure = (): AudioElementLike => {
    if (audio) return audio;
    audio = options.createAudio();
    url ??= options.createUrl(silentWav());
    audio.loop = true;
    // Muted or zero-volume elements get no media session in Chromium; the WAV itself is silent.
    audio.muted = false;
    audio.volume = 1;
    audio.src = url;
    return audio;
  };

  const unload = () => {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio = null;
  };

  return {
    get status() {
      return status;
    },
    set(next) {
      if (next === status) return;
      status = next;
      if (next === "none") {
        unload();
        return;
      }
      const el = ensure();
      if (next === "paused") {
        el.pause();
        return;
      }
      try {
        const played = el.play();
        if (played && typeof played.catch === "function") {
          played.catch((error: unknown) => options.log?.("media-session: keep-alive play rejected", { error: String(error) }));
        }
      } catch (error) {
        options.log?.("media-session: keep-alive play threw", { error: String(error) });
      }
    },
    dispose() {
      unload();
      status = "none";
      if (url) options.revokeUrl?.(url);
      url = null;
    },
  };
};
