// @bugfix @regression-proof issue #25 P8 (ultimate run 1791529129542: 430 downshifts, cascades 70 ms apart).
//
// The hold windows themselves (5 s after a reload, 3 s after the first frame) are shared rules and are pinned in
// packages/playback-abr/tests/downshift-hysteresis.test.ts. This file pins what is desktop-only: that the engine stamps the
// first frame and every reload on the shared controller, so those windows get their clocks.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LOG = "[abr-downshift-hysteresis]";

describe("ABR downshift hysteresis wiring (@bugfix @regression-proof issue #25 P8)", () => {
  it("the engine stamps the first frame and every reload on the shared controller and steps it with them", () => {
    const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const needles = [
      "noteFirstFrame(abrCtrl, Date.now());",
      "noteSwitchSettled(abrCtrl, Date.now());",
      "noteLaunch(abrCtrl);",
      "stepNetworkAbr(abrCtrl, variants, sample)",
    ];
    for (const needle of needles) {
      console.info(`${LOG} phase=source needle=${JSON.stringify(needle)} present=${engine.includes(needle)}`);
      expect(engine.includes(needle)).toBe(true);
    }
    // Both launch paths (backdrop handoff + direct) open the load clock.
    expect(engine.match(/noteLoadStarted\(abrCtrl, Date\.now\(\)\);/g)?.length).toBe(2);
  });
});
