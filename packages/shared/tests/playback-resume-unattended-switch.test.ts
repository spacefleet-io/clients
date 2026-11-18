import { describe, expect, it } from "vitest";
import { episodeSwitchStartAt } from "../src/playbackResume";

/**
 * @why A next or previous pressed on the phone's lock screen or notification (PLAY-OSMEDIA-01 item 4) opened the
 *   next episode's "Resume at … / Start over" prompt (PLAY-RESUME-01) with nobody there to answer it: no source
 *   loaded, the parked media card expired after its hold and playback stopped until the user came back.
 */
describe("@req PLAY-OSMEDIA-01 @req PLAY-RESUME-01 episodeSwitchStartAt", () => {
  it.each([
    ["background", "resume"],
    ["inactive", "resume"],
    ["active", null],
    [null, null],
  ] as const)("@bugfix app state %s → %s", (appState, expected) => {
    const startAt = episodeSwitchStartAt(appState);
    console.info("[OSMEDIA-SWITCH-START]", JSON.stringify({ appState, startAt }));
    expect(startAt).toBe(expected);
  });
});
