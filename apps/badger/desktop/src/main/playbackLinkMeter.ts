// Upstream link meter for desktop Auto quality (issue #25).
//
// The renderer used to estimate bandwidth from mpv's `fw-bytes`, which is the
// bytes cached AHEAD of the play position: flat once the cache is full, so the
// estimate collapsed to the media bitrate and Auto quality could never climb
// back after a network drop. The real link is upstream: Electron main fetching
// HLS segments through the tunnel (`PlaybackServer.fetchObjectViaTunnel`,
// on-demand + prefetch). This meter measures it there.
//
// * Busy time: the union of the intervals with at least one metered fetch in
//   flight. Idle time (cache full, nothing to fetch) never dilutes the
//   estimate, and concurrent fetches (prefetch runs 2 at once) aggregate: their
//   bytes add up over one shared busy window instead of each fetch seeing half
//   the link.
// * Sample: on every completed fetch, Δbytes (received by every metered fetch,
//   including still-running ones) / Δbusy-ms since the previous sample. A
//   completion with no busy time elapsed since the previous sample (two fetches
//   finishing at the same instant) takes no sample: its bytes carry into the
//   next one. A failed fetch takes no sample either, but its bytes and busy
//   time were real link use and carry over the same way.
// * Estimate: EWMA (alpha 0.3) over the samples, seeded by the first.
// * Metered objects: HLS video media segments only. Init segments are tiny and
//   latency-bound; audio is a fixed side stream; playlists never hit the tunnel.

export const PLAYBACK_LINK_EWMA_ALPHA = 0.3;

export type PlaybackLinkSnapshot = {
  /** Upstream throughput EWMA in bits per second; 0 before the first sample. */
  bps: number;
  sampleCount: number;
  /** Clock time of the last sample; null before the first. */
  updatedAtMs: number | null;
};

/** IPC payload of `sf-playback-link-estimate`. */
export type PlaybackLinkEstimate = PlaybackLinkSnapshot & {
  /** Test throttle rate on the mpv-facing responses; 0 when off. */
  throttleKbps: number;
};

export type PlaybackLinkFetchOutcome = "complete" | "failed";

export type PlaybackLinkFetch = {
  addBytes(bytes: number): void;
  /** Ends the fetch (once; later calls are ignored). Returns the sample taken in bps, or null. */
  end(outcome: PlaybackLinkFetchOutcome): number | null;
};

export type PlaybackLinkMeter = {
  begin(): PlaybackLinkFetch;
  snapshot(): PlaybackLinkSnapshot;
  /** Forget every sample. Fetches begun before the reset are ignored from then on. */
  reset(): void;
};

export type PlaybackLinkMeterOptions = {
  nowMs?: () => number;
};

export type MeteredHlsObjectMeta = {
  kind: "video" | "audio";
  isInit: boolean;
};

export const isMeteredHlsObject = (meta: MeteredHlsObjectMeta | undefined): boolean =>
  meta?.kind === "video" && !meta.isInit;

/**
 * The link Auto quality may plan on. The test throttle paces the mpv-facing
 * responses, which the upstream fetches cannot see, so while it is active the
 * effective link is the slower of the two. No upstream sample → bps 0.
 */
export const effectiveLinkEstimate = (upstream: PlaybackLinkSnapshot, throttleKbps: number): PlaybackLinkEstimate => {
  const bps =
    throttleKbps > 0 && upstream.sampleCount > 0 ? Math.min(upstream.bps, throttleKbps * 1000) : upstream.bps;
  return { ...upstream, bps, throttleKbps };
};

export const createPlaybackLinkMeter = (options: PlaybackLinkMeterOptions = {}): PlaybackLinkMeter => {
  const nowMs = options.nowMs ?? (() => Date.now());

  let generation = 0;
  let inFlight = 0;
  // Busy time accumulated over closed busy intervals, plus the start of the open one.
  let closedBusyMs = 0;
  let busySinceMs = 0;
  // Busy time and bytes not yet folded into a sample.
  let sampledBusyMs = 0;
  let pendingBytes = 0;
  let ewmaBps = 0;
  let sampleCount = 0;
  let updatedAtMs: number | null = null;

  const takeSample = (now: number): number | null => {
    const busyMs = closedBusyMs + (inFlight > 0 ? Math.max(0, now - busySinceMs) : 0);
    const deltaBusyMs = busyMs - sampledBusyMs;
    if (deltaBusyMs <= 0 || pendingBytes <= 0) return null;
    const sampleBps = (pendingBytes * 8 * 1000) / deltaBusyMs;
    ewmaBps = sampleCount === 0 ? sampleBps : PLAYBACK_LINK_EWMA_ALPHA * sampleBps + (1 - PLAYBACK_LINK_EWMA_ALPHA) * ewmaBps;
    sampleCount += 1;
    updatedAtMs = now;
    sampledBusyMs = busyMs;
    pendingBytes = 0;
    return sampleBps;
  };

  const begin = (): PlaybackLinkFetch => {
    const fetchGeneration = generation;
    const now = nowMs();
    if (inFlight === 0) busySinceMs = now;
    inFlight += 1;
    let ended = false;
    return {
      addBytes: (bytes) => {
        if (ended || fetchGeneration !== generation || bytes <= 0) return;
        pendingBytes += bytes;
      },
      end: (outcome) => {
        const stale = ended || fetchGeneration !== generation;
        ended = true;
        if (stale) return null;
        const endNow = nowMs();
        const sample = outcome === "complete" ? takeSample(endNow) : null;
        if (inFlight === 1) closedBusyMs += Math.max(0, endNow - busySinceMs);
        inFlight -= 1;
        return sample;
      },
    };
  };

  const reset = () => {
    generation += 1;
    inFlight = 0;
    closedBusyMs = 0;
    busySinceMs = 0;
    sampledBusyMs = 0;
    pendingBytes = 0;
    ewmaBps = 0;
    sampleCount = 0;
    updatedAtMs = null;
  };

  return {
    begin,
    snapshot: () => ({ bps: sampleCount > 0 ? ewmaBps : 0, sampleCount, updatedAtMs }),
    reset,
  };
};
