// @bugfix @regression-proof issue #25 P2 (ultimate run 1791529129542: S1 x019,
// S2 c020/x019, S4 x002/x036 — resume-mismatch / resume-prompt-missing).
//
// Evidence: after a scrub early in an episode and a close, the saved position
// was short by exactly one scrub target:
//   s1 x019  766.85 → 456.43  gap 310.4, scrub target 310.2
//            (shard-1/logs/mpv-22-1791541282760.log:2080)
//   x036     gap 202.25, scrub target 201.4
//   x002     gap  68.6,  scrub target  67.8
//
// Cause: the startup ABR reload restarts at 0, and its "start at zero" path
// inferred a timeline offset from mpv's time-pos (`offset = time-pos ≥ 0.5`)
// with no in-flight-seek guard. The user's scrub had already moved time-pos
// to 310.2, so 310.2 became the offset and every later save was
// `time − 310.2`.
//
// Fix (Chris, 2026-10-09): our VOD HLS streams are 0-based, so mpv's clock IS
// movie time. The offset inference is removed entirely: the polled time-pos
// is the display time and the saved position, and no reload reads time-pos
// to guess a coordinate shift.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LOG = "[scrub-during-reload-keeps-progress]";
const LIB = resolve(__dirname, "../src/renderer/src/lib");

describe("a scrub during the startup reload is saved as-is (@bugfix @regression-proof issue #25 P2)", () => {
  it("there is no timeline offset to infer: the module is gone", () => {
    const present = existsSync(resolve(LIB, "useTimelineOffset.ts"));
    console.info(`${LOG} phase=module useTimelineOffset.ts present=${present}`);
    expect(present).toBe(false);
  });

  it("the engine never derives an offset from time-pos and saves mpv's time-pos as the position", () => {
    const engine = readFileSync(resolve(LIB, "useMpvPlaybackEngine.ts"), "utf8");
    const forbidden = [
      "useTimelineOffset",
      "syncTimelineOffset",
      "markStartAtZeroPending",
      "fromPlayerTime",
      "toPlayerTime",
      "getTimelineOffset",
      "timelineOffset",
    ];
    for (const needle of forbidden) {
      const present = engine.includes(needle);
      console.info(`${LOG} phase=engine forbidden=${JSON.stringify(needle)} present=${present}`);
      expect(present).toBe(false);
    }
    // x019: time-pos 766.85 must be saved as 766.85, not 766.85 − 310.2.
    const saveCall = /void setProgress\(media\.id, pct, episodeId \?\? null, \{\s*positionSeconds: time,/.test(engine);
    const pctFromTime = /const pct = \(time \/ progressDuration\) \* 100;/.test(engine);
    console.info(`${LOG} phase=engine saveCall=${saveCall} pctFromTime=${pctFromTime}`);
    expect(saveCall).toBe(true);
    expect(pctFromTime).toBe(true);
  });

  it("the OSC/app seek facade sends the display time to mpv unchanged", () => {
    const facade = readFileSync(resolve(LIB, "useExternalMpvCommands.ts"), "utf8");
    for (const needle of ["toPlayerTimeRef", "fromPlayerTimeRef"]) {
      const present = facade.includes(needle);
      console.info(`${LOG} phase=facade forbidden=${JSON.stringify(needle)} present=${present}`);
      expect(present).toBe(false);
    }
  });
});
