/**
 * @test-id PARROT-MOBILE-AUDIO-FOCUS-001
 * @level unit
 * @req PLAY-FOCUS-01[parrot]
 * @why The Parrot phone player gives way to calls and other apps' sound and stops when the headphones go away. Media3
 *   ExoPlayer does the work in `AudioPlaybackService` (items 1-4): it asks for the sound as music, pauses for good when
 *   another app takes it, holds back for a moment's loss and plays again afterwards (keeping `playWhenReady`, so a
 *   pause pressed meanwhile stays), ducks for a short sound and pauses when the headphones are unplugged. Item 5: a
 *   moment's hold shows play on the app's own buttons, like on the operating system's card, through `showsPause`.
 *   Hand-tried on an Android emulator (incoming call, another app taking the sound).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { showsPause } from "@space/mobile-audio-playback";

vi.mock("react-native", () => ({ NativeModules: {}, DeviceEventEmitter: { addListener: () => ({ remove: () => undefined }) } }));

const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-AUDIO-FOCUS-001] ${step}`, JSON.stringify(detail));

const service = readFileSync(
  path.resolve(__dirname, "../../../../packages/mobile-audio-playback/android/src/main/java/com/spacefleet/audioplayback/AudioPlaybackService.kt"),
  "utf8",
);
const module = readFileSync(
  path.resolve(__dirname, "../../../../packages/mobile-audio-playback/android/src/main/java/com/spacefleet/audioplayback/AudioPlaybackModule.kt"),
  "utf8",
);

describe("Parrot phone player and the phone's sound", () => {
  it("lets ExoPlayer ask for the sound as music, give way and pause when the headphones go away", () => {
    const checks = {
      musicUsage: /setUsage\(C\.USAGE_MEDIA\)\.setContentType\(C\.AUDIO_CONTENT_TYPE_MUSIC\)/.test(service),
      handlesFocus: /\/\* handleAudioFocus= \*\/ true/.test(service),
      becomingNoisy: /setHandleAudioBecomingNoisy\(true\)/.test(service),
      reportsHold: /putBoolean\("suppressed", player\.playbackSuppressionReason != Player\.PLAYBACK_SUPPRESSION_REASON_NONE\)/.test(module),
    };
    log("native config", checks);
    expect(checks).toEqual({ musicUsage: true, handlesFocus: true, becomingNoisy: true, reportsHold: true });
  });

  it("shows play while a call holds the music back or the queue has ended, and pause only while it plays or is about to", () => {
    const cases = {
      playing: showsPause({ playWhenReady: true, suppressed: false, state: "ready" }),
      buffering: showsPause({ playWhenReady: true, suppressed: false, state: "buffering" }),
      heldByCall: showsPause({ playWhenReady: true, suppressed: true, state: "ready" }),
      pausedByUser: showsPause({ playWhenReady: false, suppressed: false, state: "ready" }),
      pausedDuringCall: showsPause({ playWhenReady: false, suppressed: true, state: "ready" }),
      queueEnded: showsPause({ playWhenReady: true, suppressed: false, state: "ended" }),
    };
    log("play/pause button", cases);
    expect(cases).toEqual({
      playing: true,
      buffering: true,
      heldByCall: false,
      pausedByUser: false,
      pausedDuringCall: false,
      queueEnded: false,
    });
  });
});
