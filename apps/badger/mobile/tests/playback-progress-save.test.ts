/**
 * @test-id MOBILE-PLAYBACK-PROGRESS-SAVE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists (PlayerScreen progress writer):
 *  1. "Start over" armed `allowZeroRef.current = start?.startOver` DURING RENDER,
 *     so the one-shot reset after the first write was undone by the next poll
 *     re-render. If mpv then went idle (position reads 0) and the user closed or
 *     backgrounded the app, the final save wrote `progressPct 0` over the real
 *     position (and desktop synced the 0). The arm is now an explicit one-shot.
 *  2. "Next episode" saved 100 %, then `setParams` remounted the screen and the
 *     unmount cleanup saved the REAL position (30 %) over it: tapping Next at 30 %
 *     left the episode at 30 %. A completed save now finalizes the episode.
 */
import { describe, expect, it } from "vitest";
import {
  armStartOver,
  commitProgressSave,
  createProgressGate,
  planProgressSave,
  type ProgressSaveInput,
} from "../src/lib/playback/progressSave";

const TAG = "[playback-progress-save]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const input = (over: Partial<ProgressSaveInput>): ProgressSaveInput => ({
  positionSeconds: 0,
  durationSeconds: 1000,
  lastSavedPositionSeconds: null,
  final: false,
  completed: false,
  creditsStartSeconds: null,
  ...over,
});

// @req PLAY-RESUME-04[badger-mobile,badger-tv]
describe("start over is a one-shot, armed only by the user action", () => {
  it("@bugfix @regression-proof after the first start-over write, an idle position of 0 never overwrites real progress", () => {
    const gate = createProgressGate();
    armStartOver(gate); // user tapped "Start over"
    const first = planProgressSave(gate, input({ positionSeconds: 0, final: true }));
    log("first save after start over", first);
    expect(first, "start over may write 0 once").not.toBeNull();
    if (first) commitProgressSave(gate, first);

    // Playback ran (a real position was saved), then mpv went idle: position reads 0.
    const played = planProgressSave(gate, input({ positionSeconds: 300, lastSavedPositionSeconds: 0 }));
    if (played) commitProgressSave(gate, played);
    const idleExit = planProgressSave(gate, input({ positionSeconds: 0, lastSavedPositionSeconds: 300, final: true }));
    log("exit save with idle position", idleExit);
    expect(idleExit, "a re-render must not re-arm allowZero").toBeNull();
  });

  it("@bugfix @regression-proof without start over a position of 0 is never written", () => {
    const gate = createProgressGate();
    expect(planProgressSave(gate, input({ positionSeconds: 0, final: true }))).toBeNull();
  });
});

// @req PLAY-RESUME-02[badger-mobile,badger-tv] @req PLAY-RESUME-04[badger-mobile,badger-tv]
describe("a completed episode is final", () => {
  it("@bugfix @regression-proof the unmount save after 'Next episode' cannot overwrite the completed 100 %", () => {
    const gate = createProgressGate();
    // Playing at 30 %, user taps Next: completed save.
    const completed = planProgressSave(gate, input({ positionSeconds: 300, lastSavedPositionSeconds: 295, final: true, completed: true }));
    log("completed save", completed);
    expect(completed?.progressPct).toBe(100);
    if (completed) commitProgressSave(gate, completed);

    // setParams remounts the screen: cleanup saves the real position.
    const unmount = planProgressSave(gate, input({ positionSeconds: 300, lastSavedPositionSeconds: 1000, final: true }));
    log("unmount save after completion", unmount);
    expect(unmount, "the unmount/background save must be a no-op once completed").toBeNull();
  });

  it("@bugfix @regression-proof real playback after a completed save (replay) unlocks final saves again", () => {
    const gate = createProgressGate();
    const completed = planProgressSave(gate, input({ positionSeconds: 990, final: true, completed: true }));
    if (completed) commitProgressSave(gate, completed);
    const periodic = planProgressSave(gate, input({ positionSeconds: 120, lastSavedPositionSeconds: 1000 }));
    expect(periodic, "periodic saves are never blocked").not.toBeNull();
    if (periodic) commitProgressSave(gate, periodic);
    const exit = planProgressSave(gate, input({ positionSeconds: 180, lastSavedPositionSeconds: 120, final: true }));
    expect(exit?.progressPct).toBe(18);
  });

  it("@bugfix @regression-proof a completed save needs a known duration", () => {
    expect(planProgressSave(createProgressGate(), input({ durationSeconds: 0, completed: true, final: true }))).toBeNull();
  });
});
