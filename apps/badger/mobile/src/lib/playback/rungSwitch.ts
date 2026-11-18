/**
 * Mobile-only plumbing around a rung switch (the auto-quality decisions themselves live in `@space/playback-abr`).
 *
 * ffmpeg's HLS demuxer exposes one video track per master and never switches variants by itself, so mobile owns rung
 * selection: every rung has its own master (`rungMasterUrl`) and a switch is a reload of that master at the current
 * position (`planSwitchRestore` keeps position, audio/subtitle choice and pause state across it).
 */
import type { CacheConfig } from "@space/playback-abr";

/**
 * The mpv cache the Android surface configures (`MpvSurfaceView.kt`: `cache-secs`, `demuxer-max-bytes`). The ABR upshift
 * gate is derived from it so the gate is always reachable; `tests/playback-cache-config.test.ts` pins this constant
 * against the Kotlin source.
 */
export const MOBILE_DEFAULT_CACHE_CONFIG: CacheConfig = { cacheSecs: 30, demuxerMaxBytes: 32 * 1024 * 1024 };

/**
 * lavf's HLS demuxer exposes ONE video track per master (the highest-bandwidth variant, or the one `hls-bitrate`
 * picks), so mpv's `vid` can never address the other rungs and a live `vid` switch is a no-op. The app owns rung
 * selection instead: the playback proxy serves `master-<variantId>.m3u8` (that variant + every audio/subtitle
 * rendition), and a quality change is a `loadfile` of that URL at the current position.
 */
export const rungMasterUrl = (masterUrl: string, variantId: string): string => {
  if (!/\/master\.m3u8$/.test(masterUrl)) throw new Error(`not a session master playlist url: ${masterUrl}`);
  return masterUrl.replace(/master\.m3u8$/, `master-${variantId}.m3u8`);
};

/**
 * What to re-apply after a variant switch so position and audio/subtitle choice survive it.
 * `sid` is `"no"` when the viewer turned subtitles Off (PLAY-TRACK-03): `loadfile` would otherwise re-run mpv's own
 * subtitle choice and bring a track back. `null` = unknown (nothing loaded yet): leave mpv's defaults.
 */
export type SwitchRestore = { startSeconds: number; aid: number | null; sid: number | "no" | null; paused: boolean };

/**
 * Restore plan from a FRESH native read taken at the instant of the switch (never the 0.5-1 Hz polled snapshot, which can
 * predate the viewer's last track pick). `pendingStart` (a start or seek mpv has not reached yet) wins over the reported
 * position: before the start seek lands mpv reports 0, and while a seek is in flight it still reports the old spot.
 * A missing subtitle id means Off only once a frame is up (`voConfigured`): before that mpv reports no ids at all.
 */
export const planSwitchRestore = (
  snapshot: { position: number; paused: boolean; aid: number | null; sid: number | null; voConfigured: boolean },
  pendingStart: number | null = null,
): SwitchRestore => {
  const reported = Number.isFinite(snapshot.position) ? snapshot.position : 0;
  const subtitle = snapshot.sid !== null && snapshot.sid > 0 ? snapshot.sid : snapshot.voConfigured ? "no" : null;
  return {
    startSeconds: Math.max(0, pendingStart ?? reported),
    aid: snapshot.aid !== null && snapshot.aid > 0 ? snapshot.aid : null,
    sid: subtitle,
    paused: snapshot.paused,
  };
};

/**
 * Per-file lavf option of a reload through the Android proxy: lavf's HLS demuxer opens ONE segment at a time.
 *
 * By default (`http_multiple`, on for an HTTP/1.1 server) it opens segment k+1 as soon as it opens k, before reading
 * any of k, and the open waits for k+1's response headers. The Android proxy sends them only once it has the whole
 * object, so the first frame of a reload waited on the next segment's download even with k fetched in advance (OnePlus 6
 * test phone, `abr-recovery` 2026-11-13: 31 s for the 2.1 MB 420p segment at 1 Mbit/s). The proxy reads ahead itself, so the
 * second connection buys nothing there. `-append` keeps the surface's `seg_max_retry`; per-file, so it ends with the file.
 */
export const SWITCH_ONE_SEGMENT_AT_A_TIME = "demuxer-lavf-o-append=http_multiple=0";

/**
 * Per-file mpv options of the reload. `loadfile replace` drops sidecar (`sub-add`) subtitles, so with an active sidecar
 * no `sid` is restored (its id no longer exists) and the caller re-adds the sidecar after the reload instead.
 * `throughProxy`: the reload reads the Android proxy (`SWITCH_ONE_SEGMENT_AT_A_TIME`).
 */
export const buildSwitchLoadOptions = (restore: SwitchRestore, hasActiveSidecar: boolean, throughProxy = false): string =>
  [
    restore.aid ? `aid=${restore.aid}` : null,
    restore.sid && !hasActiveSidecar ? `sid=${restore.sid}` : null,
    restore.paused ? "pause=yes" : null,
    throughProxy ? SWITCH_ONE_SEGMENT_AT_A_TIME : null,
  ]
    .filter(Boolean)
    .join(",");
