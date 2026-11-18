/**
 * STOR-BW-01 on the playback side: while the played media's silo is in the high-traffic state the viewer keeps only
 * the next `playbackBufferSeconds` buffered, so JS hands that number to the native proxy and mpv
 * (`PlaybackBridge.setBufferCap`). 0 = traffic is normal, the full look-ahead applies. The native side shrinks the
 * proxy's segment look-ahead and mpv's `cache-secs` / `demuxer-readahead-secs` to it.
 */
import type { StorageTraffic } from "@space/shared/storageTunnel";

/** The buffer cap in seconds that applies now; 0 = none (also when the silo reported nothing or no seconds). */
export const playbackBufferCap = (traffic: StorageTraffic | null): number => {
  if (!traffic || traffic.state !== "high") return 0;
  const seconds = traffic.playbackBufferSeconds;
  return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
};
