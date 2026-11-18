type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number }>;

/**
 * Makes the loopback proxy fetch a subtitle sidecar before mpv is told about it. The proxy answers only once it has
 * the whole object (fetched through the tunnel and decrypted to its spool), and every later request is served from
 * that spool, so asking for a single byte warms it without carrying the file over the React Native bridge.
 */
export const warmSidecar = async (url: string, fetchImpl: FetchLike = fetch): Promise<void> => {
  const started = Date.now();
  const res = await fetchImpl(url, { headers: { Range: "bytes=0-0" } });
  if (!res.ok) throw new Error(`sidecar warm-up failed: HTTP ${res.status}`);
  console.info("[subtitles] sidecar.warmed", JSON.stringify({ url, ms: Date.now() - started }));
};

type AddsSubtitles = {
  addSubtitle: (url: string, language: string | null, title: string | null) => Promise<boolean>;
};

/**
 * mpv holds the picture while it waits for an external subtitle file, because that file is not interleaved with the
 * video. Handing it a sidecar the proxy still has to fetch (a PGS track runs to tens of MB) froze the picture for
 * seconds and the catch-up dropped frames. Every `addSubtitle` therefore waits for [warm] first, so the video keeps
 * playing and the subtitle appears once it is ready. A failed warm-up still lets mpv try, so a dead sidecar is
 * reported as a subtitle load failure (PLAY-TRACK-06). Every other method of `native` is left as it is.
 */
export const withSidecarWarmup = <T extends AddsSubtitles>(
  native: T,
  warm: (url: string) => Promise<void> = warmSidecar,
): T => {
  const addSubtitle = async (url: string, language: string | null, title: string | null): Promise<boolean> => {
    try {
      await warm(url);
    } catch (e) {
      console.warn("[subtitles] sidecar.warm_failed", JSON.stringify({ url, error: String(e) }));
    }
    return native.addSubtitle(url, language, title);
  };
  return new Proxy(native, {
    get: (target, prop) => (prop === "addSubtitle" ? addSubtitle : Reflect.get(target, prop)),
  });
};
