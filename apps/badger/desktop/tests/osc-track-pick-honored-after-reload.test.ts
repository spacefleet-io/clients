// @bugfix @regression-proof issue #25 P18-aid2 (ultimate run 1791422679313,
// S1 c061, osc-audio-signal FAIL expected aid 2 / 660 Hz).
//
// Evidence (shard-1/logs/mpv-16-1791428477094.log + timeline.jsonl):
//   443.635  osc track pick recorded (carried on reloads) {property: aid, value: 2}
//   444.496  loadStream: reload loadfile track options {audioTrack: 2}
//   [21.824] Setting option 'aid' = '2' (flags = 16)
//   [22.470] ● Audio --aid=1 …   ○ Audio --aid=2 (aac 6ch)   ← pick ignored
//   445.278  prop:aid 1, kept until the next OSC pick at [29.173]
//
// The renderer carried the pick; mpv did not apply the per-load option. Fix:
// after the reload loads, compare the live aid/sid with the carried picks and
// set any pick mpv did not honor.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OscTrackPicks } from "../src/renderer/src/lib/oscTrackPicks";

const LOG = "[osc-track-pick-honored-after-reload]";
const FILE = "file-s01e18";

describe("OSC track pick is enforced after a reload (@bugfix @regression-proof issue #25 P18-aid2)", () => {
  it("replays c061: picked aid 2, mpv came back on aid 1 → aid 2 is set again", () => {
    const picks = new OscTrackPicks();
    picks.record(FILE, { property: "aid", value: 2 });
    const unhonored = picks.unhonored(FILE, { aid: 1, sid: false });
    console.info(`${LOG} phase=c061 unhonored=${JSON.stringify(unhonored)}`);
    expect(unhonored).toEqual([{ property: "aid", value: 2 }]);
  });

  it("an honored pick, an unreadable live value, or another file's pick needs nothing", () => {
    const picks = new OscTrackPicks();
    picks.record(FILE, { property: "aid", value: 3 });
    picks.record(FILE, { property: "sid", value: "no" });
    const honored = picks.unhonored(FILE, { aid: 3, sid: false });
    const unreadable = picks.unhonored(FILE, { aid: null, sid: null });
    const otherFile = picks.unhonored("file-s01e19", { aid: 1, sid: 1 });
    console.info(`${LOG} phase=no-op honored=${JSON.stringify(honored)} unreadable=${JSON.stringify(unreadable)} otherFile=${JSON.stringify(otherFile)}`);
    expect(honored).toEqual([]);
    expect(unreadable).toEqual([]);
    expect(otherFile).toEqual([]);
  });

  it("a carried raw sid that mpv dropped is set again too", () => {
    const picks = new OscTrackPicks();
    picks.record(FILE, { property: "sid", value: 4 });
    expect(picks.unhonored(FILE, { aid: 1, sid: false })).toEqual([{ property: "sid", value: 4 }]);
  });

  it("the reload branch reads the live aid/sid and re-sets unhonored picks", () => {
    const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const needles = [
      'getProperty(sendExternalRequest, "aid")',
      "oscTrackPicksRef.current.unhonored(fileIdRef.current",
      "buildSetPropertyCommand(pick.property, pick.value)",
    ];
    for (const needle of needles) {
      console.info(`${LOG} phase=source needle=${JSON.stringify(needle)} present=${engine.includes(needle)}`);
      expect(engine.includes(needle)).toBe(true);
    }
  });
});

// @bugfix @regression-proof issue #25 P3 (ultimate run 1791529129542, S2 x007
// subs-not-rendered). Evidence (shard-2/timeline.jsonl):
//   473.379  loadStream: reload loadfile track options {audioTrack: null, subtitleTrack: null}
//   474.250  osc track pick recorded (carried on reloads) {property: sid, value: 1}
//            ("no app subtitle option; reloads carry the raw sid")
//   474.510  mpv file-loaded — the new file comes up with sid "no"
//   479.331  violation subs-not-rendered
// The re-check after the load ran only when the PRE-load snapshot carried a
// pick, so a pick made while the loadfile was in flight was never applied.
describe("a track pick made during a reload is honored (@bugfix @regression-proof issue #25 P3)", () => {
  it("replays x007: pick recorded after the snapshot, live sid off → sid 1 is set again", () => {
    const picks = new OscTrackPicks();
    const snapshot = picks.reloadOptions(FILE);
    picks.record(FILE, { property: "sid", value: 1 });
    const unhonored = picks.unhonored(FILE, { aid: 1, sid: false });
    console.info(`${LOG} phase=x007 snapshot=${JSON.stringify(snapshot)} unhonored=${JSON.stringify(unhonored)}`);
    expect(snapshot).toEqual({ audioTrack: null, subtitleTrack: null });
    expect(unhonored).toEqual([{ property: "sid", value: 1 }]);
  });

  it("the reload re-checks the CURRENT picks after the load, whatever the pre-load snapshot held", () => {
    const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const snapshotGate = /if \(reloadTrackOptions\.audioTrack !== null \|\| reloadTrackOptions\.subtitleTrack !== null\)/.test(engine);
    const currentGate = engine.includes("oscTrackPicksRef.current.hasPicks(fileIdRef.current)");
    console.info(`${LOG} phase=x007-source snapshotGate=${snapshotGate} currentGate=${currentGate}`);
    expect(snapshotGate).toBe(false);
    expect(currentGate).toBe(true);
  });

  it("hasPicks reflects the picks held now for that file", () => {
    const picks = new OscTrackPicks();
    expect(picks.hasPicks(FILE)).toBe(false);
    picks.record(FILE, { property: "sid", value: 1 });
    expect(picks.hasPicks(FILE)).toBe(true);
    expect(picks.hasPicks("file-s01e19")).toBe(false);
    picks.clearSubtitle();
    expect(picks.hasPicks(FILE)).toBe(false);
  });
});
