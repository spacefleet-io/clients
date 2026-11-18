import type { UploadPlaybackGate } from "@space/content-core/storageTransport";
import type { EncodePlaybackGate } from "@space/ffmpeg/playbackGate";

/**
 * One playback policy for everything that competes with a playing video
 * (#25). The desktop already renews a lease (`badger.playback.set_upload_policy`,
 * 1 s tick, 5 s heartbeat, 15 s lease) that the upload pool obeys; transcode
 * ffmpegs obey the SAME lease through this binding, so there is no second
 * mechanism: whatever the lease says the effective policy is (including
 * `full` once playback stops, or the app dies and the lease runs out) is what
 * the encode gate applies, live, to running and new transcodes.
 *
 * Returns the unsubscribe.
 */
export const bindEncodeGateToPlaybackLease = (lease: UploadPlaybackGate, encode: EncodePlaybackGate): (() => void) => {
  const apply = (reason: string) => {
    const state = lease.getState();
    encode.setPolicy(state.effective, { reason, mode: state.mode, playbackActive: state.playbackActive });
  };
  apply("bind");
  return lease.subscribe(() => apply("lease-changed"));
};
