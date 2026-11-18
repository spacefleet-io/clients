/**
 * Launch-time subtitle sidecars for the desktop's external mpv (PLAY-TRACK-07 interim).
 *
 * mpv reads an external subtitle file up to the playing moment before it shows the next frame, so a sidecar handed
 * to it as a raw proxy URL holds the picture while the file downloads (a 30 MB PGS track, resumed late in the film,
 * froze the bundled mpv ~2 s and dropped 50 frames in a probe). The main process caches each sidecar on disk; from
 * there `sub-add` takes milliseconds. So launch never waits on a download: sidecars already on disk go in the launch
 * payload, the others are fetched in the background and handed to mpv (through sf.lua) once each is on disk. A
 * sidecar whose fetch fails is logged and left out; mpv never gets a raw proxy URL from this path.
 */

export type SubtitleSidecar = {
  url: string;
  title?: string | null;
  lang?: string | null;
  format?: string | null;
  selected?: boolean;
};

/**
 * The main-process disk cache (`sf-mpv-cache-subtitles`). Answers one entry per input, in order; an entry's `url` is
 * the cached file path, or "" when the file is not on disk (with `cachedOnly`, nothing is fetched).
 */
export type SubtitleSidecarCache = (
  entries: SubtitleSidecar[],
  options: { cachedOnly: boolean },
) => Promise<ReadonlyArray<{ url: string } | null | undefined>>;

type SidecarLog = {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
};

/** `/playback/object/<key>`: the part of a proxy URL that survives a runtime restart (its port changes). */
const sidecarKey = (url: string): string => {
  const index = url.indexOf("/playback/object/");
  return index >= 0 ? url.slice(index) : url;
};

/** Splits the launch sidecars into those already on disk (cached path) and those still to fetch (raw URL). */
export const splitLaunchSidecars = async (
  entries: SubtitleSidecar[],
  cache: SubtitleSidecarCache,
): Promise<{ ready: SubtitleSidecar[]; pending: SubtitleSidecar[] }> => {
  if (entries.length === 0) return { ready: [], pending: [] };
  const onDisk = await cache(entries, { cachedOnly: true });
  const ready: SubtitleSidecar[] = [];
  const pending: SubtitleSidecar[] = [];
  entries.forEach((entry, index) => {
    const path = onDisk[index]?.url;
    if (path) ready.push({ ...entry, url: path });
    else pending.push(entry);
  });
  return { ready, pending };
};

export type LateSubtitleSidecars = {
  /**
   * True while this fill is fetching the sidecar at `url` (raw proxy URL): nobody else should `sub-add` it. Released
   * once the sidecar is in mpv or its fetch failed, so a later pick goes through the normal path.
   */
  owns: (url: string) => boolean;
  /** Resolves once every pending sidecar has landed or failed. */
  settled: Promise<void>;
  /** Stops handing sidecars to mpv (a newer launch payload replaced this one). */
  cancel: () => void;
};

/**
 * Fetches each pending sidecar onto disk and, as each lands, re-sends the whole list (ready + landed so far) to mpv;
 * sf.lua adds only entries it does not have yet. A landed sidecar is selected exactly when `stillSelected` says it is
 * the user's current choice, so a pick made during the download is honoured and never overridden.
 */
export const fillLateSidecars = (params: {
  ready: SubtitleSidecar[];
  pending: SubtitleSidecar[];
  cache: SubtitleSidecarCache;
  stillSelected: (entry: SubtitleSidecar) => boolean;
  isCurrent: () => boolean;
  send: (sidecars: SubtitleSidecar[]) => Promise<unknown>;
  log: SidecarLog;
}): LateSubtitleSidecars => {
  const { ready, pending, cache, stillSelected, isCurrent, send, log } = params;
  const owned = new Set(pending.map((entry) => sidecarKey(entry.url)));
  const landed: SubtitleSidecar[] = [];
  let cancelled = false;
  const startedAt = Date.now();
  const fillOne = async (entry: SubtitleSidecar) => {
    let path = "";
    try {
      path = (await cache([entry], { cachedOnly: false }))[0]?.url ?? "";
    } catch (error) {
      owned.delete(sidecarKey(entry.url));
      log.warn({ url: entry.url, error: error instanceof Error ? error.message : String(error) }, "sidecar.late_failed");
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    if (!path) {
      owned.delete(sidecarKey(entry.url));
      log.warn({ url: entry.url, lang: entry.lang ?? null, selected: entry.selected ?? false, elapsedMs }, "sidecar.late_failed");
      return;
    }
    if (cancelled || !isCurrent()) {
      owned.delete(sidecarKey(entry.url));
      log.info({ url: entry.url, elapsedMs, cancelled }, "sidecar.late_dropped (playback moved on)");
      return;
    }
    const selected = stillSelected(entry);
    landed.push({ ...entry, url: path, selected });
    log.info({ url: entry.url, path, lang: entry.lang ?? null, selected, elapsedMs }, "sidecar.late_added");
    try {
      await send([...ready, ...landed]);
    } finally {
      owned.delete(sidecarKey(entry.url));
    }
  };
  log.info({ ready: ready.length, pending: pending.length }, "sidecar.launch_split");
  const settled = Promise.all(pending.map(fillOne)).then(() => undefined);
  return {
    owns: (url) => owned.has(sidecarKey(url)),
    settled,
    cancel: () => {
      cancelled = true;
    },
  };
};
