// Map between the app's formats (quality rungs) and mpv's video tracks.
//
// @bugfix @regression-proof issue #25 P19 (c004): the HLS master lists every
// rung as a `#EXT-X-STREAM-INF` variant (playbackServer, in `formats` order),
// and mpv exposes each one as a video track with its `hls-bitrate` = the
// variant's BANDWIDTH. A reload that does not name its rung lands on the one
// the launch-time `--hls-bitrate` picks; an OSC video pick only knows the
// mpv `vid`. Both directions go through the BANDWIDTH, with the order in the
// master breaking ties between rungs of the same bandwidth.

import type { LoadfileTrackSelection, MpvTrack } from "@space/mpv-protocol";

export type HlsVariantFormat = { id: string; bitrateKbps?: number | null };

/**
 * A rung's BANDWIDTH as mpv reads it from the HLS master: playbackServer
 * writes `(bitrateKbps ?? 5000) * 1000` and FFmpeg parses it with atoi, so a
 * fractional value truncates.
 */
export const hlsVariantBandwidthBps = (bitrateKbps: number | null | undefined): number =>
  Math.max(1, Math.trunc((bitrateKbps ?? 5000) * 1000));

const hlsVideoTracks = (trackList: ReadonlyArray<MpvTrack>) =>
  trackList.filter(
    (track): track is MpvTrack & { id: number; "hls-bitrate": number } =>
      track?.type === "video" && typeof track.id === "number" && typeof track["hls-bitrate"] === "number",
  );

/** The rank of `formatId` among the formats sharing its bandwidth, or null. */
const rankAmongSameBandwidth = (formats: ReadonlyArray<HlsVariantFormat>, formatId: string) => {
  const format = formats.find((entry) => entry.id === formatId);
  if (!format) return null;
  const bandwidth = hlsVariantBandwidthBps(format.bitrateKbps);
  const rank = formats
    .filter((entry) => hlsVariantBandwidthBps(entry.bitrateKbps) === bandwidth)
    .findIndex((entry) => entry.id === formatId);
  return { bandwidth, rank };
};

/** The mpv `vid` of `formatId`'s variant, or null when mpv lists no such HLS track. */
export const findHlsVariantVid = (
  trackList: ReadonlyArray<MpvTrack>,
  formats: ReadonlyArray<HlsVariantFormat>,
  formatId: string,
): number | null => {
  const target = rankAmongSameBandwidth(formats, formatId);
  if (!target) return null;
  const track = hlsVideoTracks(trackList).filter((entry) => entry["hls-bitrate"] === target.bandwidth)[target.rank];
  return track?.id ?? null;
};

/** The format whose variant is mpv video track `vid`; null for "no" or an unknown track. */
export const resolvePickedVideoFormatId = (params: {
  vid: LoadfileTrackSelection;
  trackList: ReadonlyArray<MpvTrack>;
  formats: ReadonlyArray<HlsVariantFormat>;
}): string | null => {
  if (params.vid === "no") return null;
  const tracks = hlsVideoTracks(params.trackList);
  const picked = tracks.find((track) => track.id === params.vid);
  if (!picked) return null;
  const bandwidth = picked["hls-bitrate"];
  const rank = tracks.filter((track) => track["hls-bitrate"] === bandwidth).indexOf(picked);
  const format = params.formats.filter((entry) => hlsVariantBandwidthBps(entry.bitrateKbps) === bandwidth)[rank];
  return format?.id ?? null;
};
