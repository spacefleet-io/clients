import { describe, expect, it } from "vitest";
import type { MpvExternalMessage } from "@space/mpv-protocol";

import { shouldForwardMpvMessage } from "../src/main/externalMpvMessageRouting";

/**
 * @bugfix @regression-proof issue #25 run 7950 playback.e2e "start over with
 * prior progress": a renderer-requested stop (sf-mpv-external-stop) detaches
 * `currentClient` BEFORE disposing it, so the disposed client's
 * user_stop → stopping and process_exited → idle lifecycle pushes were dropped
 * by the `currentClient !== client` guard. The renderer's lifecycle mirror
 * stayed "playing" on a dead mpv; Start Over then took startFrom's
 * "zero-seek on alive mpv" branch (seek only, no launch) and mpv never came
 * back (isExternalMpvAlive=false for 30 s).
 */
const clientA = { id: "A" };
const clientB = { id: "B" };

const lifecycle = (kind: "stopping" | "idle"): MpvExternalMessage =>
  ({ type: "lifecycle", state: { kind } }) as unknown as MpvExternalMessage;
const propertyChange: MpvExternalMessage = { type: "property_change", name: "time-pos", value: 1 } as MpvExternalMessage;

describe("shouldForwardMpvMessage", () => {
  it("forwards every message type from the current client", () => {
    for (const message of [lifecycle("stopping"), propertyChange]) {
      expect(shouldForwardMpvMessage({ client: clientA, currentClient: clientA, lifecycleOwner: clientA, message })).toBe(true);
    }
  });

  it("forwards the stopping/idle lifecycle of a client detached by a stop while it is still the newest launch", () => {
    for (const kind of ["stopping", "idle"] as const) {
      expect(
        shouldForwardMpvMessage({ client: clientA, currentClient: null, lifecycleOwner: clientA, message: lifecycle(kind) }),
        `lifecycle ${kind} after stop`,
      ).toBe(true);
    }
  });

  it("drops non-lifecycle messages from a detached client", () => {
    expect(shouldForwardMpvMessage({ client: clientA, currentClient: null, lifecycleOwner: clientA, message: propertyChange })).toBe(false);
  });

  it("drops a replaced client's late lifecycle so it cannot clobber the newer launch", () => {
    expect(shouldForwardMpvMessage({ client: clientA, currentClient: clientB, lifecycleOwner: clientB, message: lifecycle("idle") })).toBe(false);
    expect(shouldForwardMpvMessage({ client: clientA, currentClient: null, lifecycleOwner: clientB, message: lifecycle("idle") })).toBe(false);
  });
});
