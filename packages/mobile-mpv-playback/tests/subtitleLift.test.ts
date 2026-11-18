/**
 * @test-id MPV-SUBS-LIFT-001
 * @level unit
 * @why While the TV player's controls show, the subtitle line must sit above the bottom control bar (progress bar and
 *   timecodes), never behind it, and go back to the user's place when the controls hide — both for the line the app
 *   draws under direct rendering (text subtitles and the OCR text copies of picture subtitles) and for the lines mpv
 *   draws itself (`vo=gpu` fallback, Apple TV) through `sub-pos`. Bugs here hide dialogue behind the seekbar, or leave
 *   the subtitles stranded mid-screen after the controls hide.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
}));

import { overlayPaddingBottom, subtitleOverlayModel, type MpvSubtitleEvent, type SubtitleOverlayModel } from "../src/subtitleOverlay";
import {
  controlsBottomInset,
  createOverlayLift,
  createSubPosLift,
  liftedSubPos,
  overlayLift,
  SUBTITLE_LIFT_GAP,
  type SubPosTarget,
} from "../src/subtitleLift";

const T = "[MPV-SUBS-LIFT-001]";
const log = (...parts: unknown[]) => console.info(T, ...parts);

/** An Android TV box: 1920x1080 px = 960x540 dp; the controls' bottom bar layer is 48 dp tall, 16 dp above the bottom. */
const BOX_HEIGHT = 540;
const BAR_TOP = BOX_HEIGHT - 16 - 48;

const event = (over: Partial<MpvSubtitleEvent> = {}): MpvSubtitleEvent => ({
  text: "How you doin'?",
  visible: true,
  directRender: true,
  x: 0,
  y: 0,
  width: 960,
  height: 540,
  ...over,
});

/** Bottom edge (dp from the box top) of the drawn line: the frame's bottom, minus its padding, minus the lift. */
const lineBottom = (model: SubtitleOverlayModel, lift: number): number => {
  const frameBottom = model.width > 0 && model.height > 0 ? model.y + model.height : BOX_HEIGHT;
  return frameBottom - overlayPaddingBottom(model) - lift;
};

describe("controlsBottomInset — @req MPV-OSC-02[badger-tv]", () => {
  it("is the distance from the player box bottom up to the measured top of the bottom bar", () => {
    const inset = controlsBottomInset(BOX_HEIGHT, BAR_TOP);
    log("inset", { boxHeight: BOX_HEIGHT, barTop: BAR_TOP, inset });
    expect(inset).toBe(64);
    expect(controlsBottomInset(0, BAR_TOP)).toBe(0);
    expect(controlsBottomInset(BOX_HEIGHT, -1)).toBe(0);
  });
});

describe("overlayLift (app-drawn subtitles, direct rendering) — @req MPV-OSC-02[badger-tv]", () => {
  const inset = controlsBottomInset(BOX_HEIGHT, BAR_TOP);

  it("lifts the line above the controls' top while they show, and puts it back when they hide", () => {
    const model = subtitleOverlayModel(event())!;
    const shown = overlayLift({ subtitle: model, boxHeight: BOX_HEIGHT, controlsInset: inset });
    const hidden = overlayLift({ subtitle: model, boxHeight: BOX_HEIGHT, controlsInset: 0 });
    log("16:9 full frame", { padding: overlayPaddingBottom(model), shown, hidden, bottomShown: lineBottom(model, shown), barTop: BAR_TOP });
    expect(lineBottom(model, shown)).toBeLessThanOrEqual(BAR_TOP - SUBTITLE_LIFT_GAP);
    expect(hidden).toBe(0);
    expect(lineBottom(model, hidden)).toBe(BOX_HEIGHT - overlayPaddingBottom(model));
  });

  it("measures from the letterboxed picture, moving the line just enough", () => {
    // A slightly wider picture: thin black bars, the line still ends behind the bar → lifted to just above it.
    const model = subtitleOverlayModel(event({ x: 0, y: 20, width: 960, height: 500 }))!;
    const shown = overlayLift({ subtitle: model, boxHeight: BOX_HEIGHT, controlsInset: inset });
    log("thin bars", { padding: overlayPaddingBottom(model), shown, bottomShown: lineBottom(model, shown) });
    expect(shown).toBeGreaterThan(0);
    expect(lineBottom(model, shown)).toBeLessThanOrEqual(BAR_TOP - SUBTITLE_LIFT_GAP);
    expect(lineBottom(model, shown)).toBeGreaterThan(BAR_TOP - SUBTITLE_LIFT_GAP - 1);
    // A 2.39:1 film: the line already ends above the bar, inside the picture → not moved.
    const scope = subtitleOverlayModel(event({ y: 69, height: 402 }))!;
    const scopeLift = overlayLift({ subtitle: scope, boxHeight: BOX_HEIGHT, controlsInset: inset });
    log("2.39:1", { padding: overlayPaddingBottom(scope), scopeLift, bottom: lineBottom(scope, scopeLift) });
    expect(scopeLift).toBe(0);
    expect(lineBottom(scope, 0)).toBeLessThanOrEqual(BAR_TOP - SUBTITLE_LIFT_GAP);
  });

  it("lifts the line drawn before the video rect is known (fills the player box)", () => {
    const model = subtitleOverlayModel(event({ width: 0, height: 0 }))!;
    const shown = overlayLift({ subtitle: model, boxHeight: BOX_HEIGHT, controlsInset: inset });
    log("unknown rect", { padding: overlayPaddingBottom(model), shown, bottomShown: lineBottom(model, shown) });
    expect(lineBottom(model, shown)).toBeLessThanOrEqual(BAR_TOP - SUBTITLE_LIFT_GAP);
  });

  it("never moves a line that already sits above the controls (no lift when not needed)", () => {
    const model = subtitleOverlayModel(event())!;
    expect(overlayLift({ subtitle: model, boxHeight: BOX_HEIGHT, controlsInset: 5 })).toBe(0);
    expect(overlayLift({ subtitle: null, boxHeight: BOX_HEIGHT, controlsInset: inset })).toBe(0);
    expect(overlayLift({ subtitle: model, boxHeight: 0, controlsInset: inset })).toBe(0);
  });
});

describe("createOverlayLift (lift held between lines) — @req MPV-OSC-02[badger-tv]", () => {
  const inset = controlsBottomInset(BOX_HEIGHT, BAR_TOP);

  it("keeps the lift through the gap between two lines while the controls show, so the next line does not slide up from the bar", () => {
    const lift = createOverlayLift();
    const first = subtitleOverlayModel(event({ text: "Line one" }))!;
    const second = subtitleOverlayModel(event({ text: "Line two" }))!;
    const steps = [
      { name: "line 1, controls shown", subtitle: first, controlsInset: inset },
      { name: "gap, controls shown", subtitle: null, controlsInset: inset },
      { name: "line 2, controls shown", subtitle: second, controlsInset: inset },
      { name: "gap, controls hidden", subtitle: null, controlsInset: 0 },
      { name: "line 2 again, controls hidden", subtitle: second, controlsInset: 0 },
    ];
    const lifts = steps.map((s) => {
      const value = lift.next({ subtitle: s.subtitle, boxHeight: BOX_HEIGHT, controlsInset: s.controlsInset });
      log("phase", s.name, { lift: value });
      return value;
    });
    const shownLift = overlayLift({ subtitle: first, boxHeight: BOX_HEIGHT, controlsInset: inset });
    expect(shownLift).toBeGreaterThan(0);
    expect(lifts).toEqual([shownLift, shownLift, shownLift, 0, 0]);
  });

  it("stays at 0 before any line has been drawn", () => {
    const lift = createOverlayLift();
    const value = lift.next({ subtitle: null, boxHeight: BOX_HEIGHT, controlsInset: inset });
    log("phase", "no line yet", { lift: value });
    expect(value).toBe(0);
  });
});

describe("liftedSubPos (mpv-drawn subtitles) — @req MPV-OSC-02[badger-tv]", () => {
  it("is the sub-pos (% of the player height) whose bottom sits at the controls' top, never below the user's", () => {
    const inset = controlsBottomInset(BOX_HEIGHT, BAR_TOP);
    const pos = liftedSubPos({ boxHeight: BOX_HEIGHT, controlsInset: inset, userPos: 100 });
    log("sub-pos", { inset, pos, bottomDp: (pos / 100) * BOX_HEIGHT });
    expect((pos / 100) * BOX_HEIGHT).toBeLessThanOrEqual(BAR_TOP - SUBTITLE_LIFT_GAP);
    expect(pos).toBeGreaterThan(80);
    expect(liftedSubPos({ boxHeight: BOX_HEIGHT, controlsInset: inset, userPos: 50 })).toBe(50);
  });

  it("is the same at every TV scale: 960x540 at 1 and an Apple TV's 1920x1080 points at 2 (bar and gap twice as large)", () => {
    const design = liftedSubPos({ boxHeight: BOX_HEIGHT, controlsInset: controlsBottomInset(BOX_HEIGHT, BAR_TOP), userPos: 100 });
    const appleTvBox = BOX_HEIGHT * 2;
    const appleTvInset = controlsBottomInset(appleTvBox, appleTvBox - (16 + 48) * 2);
    const appleTv = liftedSubPos({ boxHeight: appleTvBox, controlsInset: appleTvInset, userPos: 100, scale: 2 });
    log("sub-pos by scale", { design, appleTvInset, appleTv });
    expect(appleTvInset).toBe(128);
    expect(design).toBe(85);
    expect(appleTv).toBe(design);
  });
});

/** mpv stand-in: `sub-pos` with a change history. */
const fakeMpv = (initial: number) => {
  let pos = initial;
  const writes: number[] = [];
  const target: SubPosTarget = {
    getSubPos: vi.fn(async () => pos),
    setSubPos: vi.fn(async (value: number) => {
      pos = value;
      writes.push(value);
      return true;
    }),
  };
  return { target, writes, read: () => pos, userSets: (value: number) => { pos = value; } };
};

describe("createSubPosLift — @req MPV-OSC-02[badger-tv]", () => {
  const inset = controlsBottomInset(BOX_HEIGHT, BAR_TOP);

  it("lowers sub-pos above the bar while the controls show and restores the user's value on hide", async () => {
    const mpv = fakeMpv(100);
    const lift = createSubPosLift(mpv.target);
    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: inset });
    const lifted = mpv.read();
    log("shown", { lifted, writes: mpv.writes, state: lift.dump() });
    expect((lifted / 100) * BOX_HEIGHT).toBeLessThanOrEqual(BAR_TOP - SUBTITLE_LIFT_GAP);

    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: inset });
    expect(mpv.writes).toHaveLength(1);

    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: 0 });
    log("hidden", { pos: mpv.read(), writes: mpv.writes, state: lift.dump() });
    expect(mpv.read()).toBe(100);
    expect(lift.dump().raised).toBe(false);
  });

  it("keeps a user who placed subtitles higher where they are", async () => {
    const mpv = fakeMpv(40);
    const lift = createSubPosLift(mpv.target);
    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: inset });
    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: 0 });
    log("user high", { pos: mpv.read(), writes: mpv.writes });
    expect(mpv.read()).toBe(40);
  });

  it("takes a sub-pos the user set while lifted as their new place (95, below the lift: the lift stays)", async () => {
    const mpv = fakeMpv(100);
    const lift = createSubPosLift(mpv.target);
    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: inset });
    const lifted = mpv.read();
    mpv.userSets(95);
    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: inset });
    log("user moved while lifted (95)", { lifted, pos: mpv.read(), state: lift.dump() });
    expect(lifted).toBeLessThan(95);
    expect(mpv.read()).toBe(Math.min(lifted, 95));
    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: 0 });
    log("hidden after 95", { pos: mpv.read(), state: lift.dump() });
    expect(mpv.read()).toBe(95);
  });

  it("takes a sub-pos the user set while lifted as their new place (40, above the lift: min(lift, 40) = 40)", async () => {
    const mpv = fakeMpv(100);
    const lift = createSubPosLift(mpv.target);
    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: inset });
    const lifted = mpv.read();
    mpv.userSets(40);
    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: inset });
    log("user moved while lifted (40)", { lifted, pos: mpv.read(), writes: mpv.writes, state: lift.dump() });
    expect(lifted).toBeGreaterThan(40);
    expect(mpv.read()).toBe(40);
    await lift.update({ boxHeight: BOX_HEIGHT, controlsInset: 0 });
    log("hidden after 40", { pos: mpv.read(), writes: mpv.writes, state: lift.dump() });
    expect(mpv.read()).toBe(40);
    expect(lift.dump().raised).toBe(false);
  });

  it("applies a show and a hide fired back to back (not awaited) in call order", async () => {
    const mpv = fakeMpv(100);
    const lift = createSubPosLift(mpv.target);
    const shown = lift.update({ boxHeight: BOX_HEIGHT, controlsInset: inset });
    const hidden = lift.update({ boxHeight: BOX_HEIGHT, controlsInset: 0 });
    await Promise.all([shown, hidden]);
    log("show+hide not awaited", { pos: mpv.read(), writes: mpv.writes, state: lift.dump() });
    expect(mpv.writes).toHaveLength(2);
    expect(mpv.writes[0]).toBeLessThan(100);
    expect(mpv.writes[1]).toBe(100);
    expect(mpv.read()).toBe(100);
    expect(lift.dump().raised).toBe(false);

    const hiddenAgain = lift.update({ boxHeight: BOX_HEIGHT, controlsInset: 0 });
    const shownAgain = lift.update({ boxHeight: BOX_HEIGHT, controlsInset: inset });
    await Promise.all([hiddenAgain, shownAgain]);
    log("hide+show not awaited", { pos: mpv.read(), writes: mpv.writes, state: lift.dump() });
    expect(mpv.read()).toBe(mpv.writes[0]);
    expect(lift.dump().raised).toBe(true);
  });
});
