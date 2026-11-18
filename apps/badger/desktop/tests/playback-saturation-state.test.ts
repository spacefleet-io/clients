/**
 * @req STOR-BW-07
 * @req STOR-BW-08
 * @req PLAY-QUAL-07
 *
 * The desktop state of a saturated silo: the quality cap of the silo serving the playback, how many new playbacks were
 * refused and how many viewers were stopped. It is fed only by the reports of that playback's own requests and there
 * is no resume: a stopped viewer stays stopped until the user presses play again.
 */
import { describe, expect, it, vi } from "vitest";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import { createPlaybackSaturation } from "../src/main/playbackSaturation";
import type { PlaybackSaturationState } from "../src/shared/playbackSaturation";

const traffic = (patch: Partial<StorageTraffic> = {}): StorageTraffic => ({
  state: "high",
  playbackBufferSeconds: 30,
  saturated: true,
  qualityCap: "480p",
  playbackStopped: false,
  ...patch,
});

const setup = () => {
  const changes: PlaybackSaturationState[] = [];
  const onChange = vi.fn((state: PlaybackSaturationState) => changes.push(state));
  return { saturation: createPlaybackSaturation(onChange), changes, onChange };
};

describe("playback saturation state (STOR-BW-07, STOR-BW-08)", () => {
  it("starts without a cap and without any refusal or stop", () => {
    expect(setup().saturation.getState()).toEqual({ qualityCap: null, refusals: 0, stops: 0 });
  });

  it("takes the quality cap of the silo's report and drops it when the silo lifts", () => {
    const { saturation, changes } = setup();
    saturation.observe(traffic({ qualityCap: "1080p" }));
    expect(saturation.getState().qualityCap).toBe("1080p");
    saturation.observe(traffic({ saturated: false, qualityCap: null }));
    expect(changes.map((state) => state.qualityCap)).toEqual(["1080p", null]);
  });

  it("does not notify when a report changes nothing", () => {
    const { saturation, onChange } = setup();
    saturation.observe(traffic());
    saturation.observe(traffic());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("follows the silo of the latest report, never merging two silos", () => {
    const { saturation } = setup();
    saturation.observe(traffic({ qualityCap: "480p" }));
    saturation.observe(traffic({ saturated: false, qualityCap: null, state: "normal", playbackBufferSeconds: null }));
    expect(saturation.getState().qualityCap).toBeNull();
  });

  it("counts a stop, once for the requests that fail together", () => {
    const { saturation } = setup();
    const stopped = traffic({ playbackStopped: true });
    saturation.noteStopped(stopped);
    saturation.noteStopped(stopped);
    saturation.observe(stopped);
    expect(saturation.getState().stops).toBe(1);
  });

  it("counts the next stop once a report says the viewer is no longer stopped", () => {
    const { saturation } = setup();
    saturation.noteStopped(traffic({ playbackStopped: true }));
    saturation.observe(traffic());
    saturation.noteStopped(traffic({ playbackStopped: true }));
    expect(saturation.getState().stops).toBe(2);
  });

  it("counts a stop the player decides itself, without a report", () => {
    const { saturation } = setup();
    saturation.observe(traffic());
    saturation.noteStopped(null);
    expect(saturation.getState()).toEqual({ qualityCap: "480p", refusals: 0, stops: 1 });
  });

  it("counts a refusal with the silo's cap and does not count a stop", () => {
    const { saturation } = setup();
    saturation.noteRefused(traffic());
    expect(saturation.getState()).toEqual({ qualityCap: "480p", refusals: 1, stops: 0 });
  });

  it("keeps the cap when a refusal carries no report", () => {
    const { saturation } = setup();
    saturation.observe(traffic());
    saturation.noteRefused(null);
    expect(saturation.getState()).toEqual({ qualityCap: "480p", refusals: 1, stops: 0 });
  });

  it("does not count a stop again for a viewer the silo already stopped, when its new playback is refused", () => {
    const { saturation } = setup();
    saturation.noteStopped(traffic({ playbackStopped: true }));
    saturation.noteRefused(traffic({ playbackStopped: true }));
    saturation.noteStopped(traffic({ playbackStopped: true }));
    expect(saturation.getState().stops).toBe(1);
    expect(saturation.getState().refusals).toBe(1);
  });

  it("drops the cap when a new playback opens and keeps the counters", () => {
    const { saturation } = setup();
    saturation.noteStopped(traffic({ playbackStopped: true }));
    saturation.noteRefused(traffic());
    saturation.reset();
    expect(saturation.getState()).toEqual({ qualityCap: null, refusals: 1, stops: 1 });
  });

  it("never resumes: a report that lifts the stop does not change the state the dialogs read", () => {
    const { saturation, changes } = setup();
    saturation.noteStopped(traffic({ playbackStopped: true }));
    const before = changes.length;
    saturation.observe(traffic({ playbackStopped: false }));
    expect(changes.slice(before).every((state) => state.stops === 1)).toBe(true);
    expect(saturation.getState().stops).toBe(1);
  });
});
