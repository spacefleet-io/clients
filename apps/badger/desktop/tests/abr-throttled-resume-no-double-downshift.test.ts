// @bugfix @regression-proof issue #25 N4 (ultimate M1 vs before, seed 1791529129542): on throttled resumes the ttff p95 went
// from 11.5 s to 17.6 s and 28 resumes took 2+ downshifts.
//
// The simulation of the throttled resume (no downshift while the resume waits for its seek-target segment; a dead link still
// steps down after DOWNSHIFT_HOLD_AWAITING_FRAME_MAX_MS) is shared and lives in
// packages/playback-abr/tests/throttled-resume.test.ts. This file pins the desktop side of the fix: the first-frame clock is
// mpv's first playback-restart of the current file (`firstFrameFrom: "event"`), and every reload resets it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LOG = "[abr-throttled-resume]";

describe("ABR on a throttled resume: the engine drives the clock (@bugfix @regression-proof issue #25 N4)", () => {
  it("the engine drives the first-frame clock from mpv's first playback-restart and resets it on every reload", () => {
    const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");
    const engine = read("../src/renderer/src/lib/useMpvPlaybackEngine.ts");
    const main = read("../src/main/externalMpv.ts");
    const socket = read("../src/main/mpvSocketClient.ts");
    const needles: Array<[string, string, string]> = [
      ["engine", engine, 'msg.type !== "playback_restart"'],
      ["engine", engine, "noteFirstFrame(abrCtrl, Date.now());"],
      ["engine", engine, "noteReloadStarted(abrCtrl);"],
      ["engine", engine, "noteSwitchSettled(abrCtrl, Date.now());"],
      ["engine", engine, "noteLaunch(abrCtrl);"],
      ["engine", engine, 'firstFrameFrom: "event"'],
      ["main", main, 'sendMpvExternalMessage({ type: "playback_restart" });'],
      ["socket", socket, 'this.emitter.emit("first-playback-restart");'],
    ];
    for (const [where, src, needle] of needles) {
      const present = src.includes(needle);
      console.info(`${LOG} phase=source where=${where} needle=${JSON.stringify(needle)} present=${present}`);
      expect(present).toBe(true);
    }
    // Both launch paths (backdrop handoff + direct) start the load clock.
    expect(engine.match(/noteLoadStarted\(abrCtrl, Date\.now\(\)\);/g)?.length).toBe(2);
  });
});
