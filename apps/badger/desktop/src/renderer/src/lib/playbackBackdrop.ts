/**
 * The still mpv shows while the stream loads, as a `data:` URI the main process writes to a file (the bundled mpv
 * has no https). Where it comes from:
 *  - a library asset (`asset:` / `assets/` key): the user's own decrypted copy, read back from its object URL;
 *  - anything else (a title whose copy is not made yet): nothing. Playing is browsing: it never asks the metadata
 *    service for a picture (META-ART-01/02), the copy queue makes the copy.
 * Playback must not wait on a slow read: past `timeoutMs` the answer is null and mpv launches straight on the
 * stream, as it does when a title has no backdrop.
 */
export const PLAYBACK_BACKDROP_TIMEOUT_MS = 1500;

export interface PlaybackBackdropDeps {
  isAssetKey: (path: string) => boolean;
  /** Decrypted library asset as an object URL; null when the library key or the asset is missing. */
  getAssetUrl: (assetRef: string) => Promise<string | null>;
  /** Reads a library asset's object URL back as a data URI. */
  toDataUrl: (objectUrl: string) => Promise<string | null>;
  timeoutMs?: number;
}

export const resolvePlaybackBackdrop = async (
  backdropPath: string | null | undefined,
  deps: PlaybackBackdropDeps
): Promise<string | null> => {
  if (!backdropPath) return null;
  if (!deps.isAssetKey(backdropPath)) return null;
  const load = async (): Promise<string | null> => {
    const objectUrl = await deps.getAssetUrl(backdropPath);
    return objectUrl ? await deps.toDataUrl(objectUrl) : null;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.timeoutMs ?? PLAYBACK_BACKDROP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([load().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Object URL (blob:) to data URI, in the renderer. */
export const objectUrlToDataUrl = async (objectUrl: string): Promise<string | null> => {
  try {
    const blob = await (await fetch(objectUrl)).blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
};
