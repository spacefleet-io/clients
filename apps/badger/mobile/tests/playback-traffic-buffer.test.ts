/**
 * @test-id MOBILE-PLAYBACK-TRAFFIC-BUFFER-001
 * @level unit
 *
 * Why exists: in the high-traffic state a playing viewer keeps only the next `playbackBufferSeconds` buffered
 * (STOR-BW-01). The silo's report reaches JS (the proxy's `SpacePlaybackTraffic` events, else `GET /storage/traffic`),
 * and JS hands the cap to the native proxy and mpv through `PlaybackBridge.setBufferCap`. This pins the cap decision
 * from the silo's wire report; what the native side does with the cap is not tested here.
 */
import { describe, expect, it } from "vitest";
import { parseStorageTraffic, type StorageTraffic } from "@space/shared/storageTunnel";
import { playbackBufferCap } from "../src/lib/playback/trafficBuffer";

const traffic = (wire: unknown): StorageTraffic | null => parseStorageTraffic(wire);

describe("playback buffer cap from the silo's report", () => {
  /** @req STOR-BW-01[badger-mobile] */
  it("high traffic caps the buffer at playbackBufferSeconds; normal, unknown or secondless reports lift it", () => {
    const cases: Array<[string, unknown, number]> = [
      ["high 15s", { state: "high", playbackBufferSeconds: 15 }, 15],
      ["high no seconds", { state: "high" }, 0],
      ["high zero", { state: "high", playbackBufferSeconds: 0 }, 0],
      ["normal ignores seconds", { state: "normal", playbackBufferSeconds: 15 }, 0],
      ["unknown state", { state: "weird", playbackBufferSeconds: 15 }, 0],
    ];
    for (const [name, wire, want] of cases) {
      const cap = playbackBufferCap(traffic(wire));
      console.info("[playback-traffic-buffer]", name, "->", cap);
      expect(cap).toBe(want);
    }
    expect(playbackBufferCap(null)).toBe(0);
  });
});
