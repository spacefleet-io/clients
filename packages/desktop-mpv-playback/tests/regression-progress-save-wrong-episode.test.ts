// @bugfix @regression-proof issue #25 NEW-resume-wrong-episode (ultimate run
// 1791422679313, S2 c060 and S1 x005).
//
// Evidence (shard-2/timeline.jsonl, c060):
//   764015  progress poll save {pct: 87.63, episodeId: afeeeae6 (E2)}
//   764579  [osc-action] navigating to next episode {from: afeeeae6, to: 5743e771}
//   764579  build payload: begin {episodeId: 5743e771 (E3)}   ← new target committed
//   764753  external offset set {timeStart: 0, timePos: 631.354}
//   764753  progress poll save {pct: 0, episodeId: afeeeae6}  ← E2 overwritten
//   767320  mpv file-loaded (E3)
//   relaunch: build payload {episodeId: afeeeae6}, resume-prompt-missing, plays E2 from 0:00
//
// A poll tick for E2 resolved after the switch and saved the old file's
// position (offset-zeroed to 0) to E2. Fix: a save belongs to the target its
// tick was started for, and no save runs while the switch's load is in flight.
import { describe, expect, it } from "vitest";
import { decidePolledProgressSave } from "../src/index";

const TAG = "[regression-progress-save-wrong-episode]";
const SHOW = "3292dffe-696e-4d30-b90b-038b7606b224";
const E2 = { mediaId: SHOW, episodeId: "afeeeae6-0c04-4df2-9c54-570f5ad0ae8a" };
const E3 = { mediaId: SHOW, episodeId: "5743e771-ee88-47cc-936b-8b1ccb2b77e3" };

describe("polled progress save targets (@bugfix @regression-proof issue #25 NEW-resume-wrong-episode)", () => {
  it("replays c060: an E2 tick resolving after the switch to E3 does not save to E2", () => {
    const decision = decidePolledProgressSave({ pollTarget: E2, liveTarget: E3, loadInFlight: true });
    console.info(`${TAG} phase=stale-tick decision=${JSON.stringify(decision)}`);
    expect(decision).toEqual({ save: false, reason: "target-changed" });
  });

  it("the E3 poll does not save the old file's position while the switch's load is in flight", () => {
    const decision = decidePolledProgressSave({ pollTarget: E3, liveTarget: E3, loadInFlight: true });
    console.info(`${TAG} phase=switch-in-flight decision=${JSON.stringify(decision)}`);
    expect(decision).toEqual({ save: false, reason: "load-in-flight" });
  });

  it("saves normally once the new file is loaded, and for movies (no episode)", () => {
    expect(decidePolledProgressSave({ pollTarget: E3, liveTarget: E3, loadInFlight: false })).toEqual({ save: true });
    const movie = { mediaId: "movie-1", episodeId: null };
    expect(decidePolledProgressSave({ pollTarget: movie, liveTarget: movie, loadInFlight: false })).toEqual({ save: true });
    expect(
      decidePolledProgressSave({ pollTarget: movie, liveTarget: { mediaId: "movie-2", episodeId: null }, loadInFlight: false }),
    ).toEqual({ save: false, reason: "target-changed" });
  });
});
